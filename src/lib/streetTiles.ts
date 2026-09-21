/**
 * Open-world street TILE streaming (issue #11).
 *
 * WHY tiles?
 *   Old Drop pulled ONE ~3 km Overpass box. Fun for a town, useless for
 *   Main → Baja. We grid the world into ~1 km squares, mount the ones near
 *   the car into Scene + GpsDash, and forget the ones you drove away from.
 *
 * MATH (Joey / learning notes):
 *   TILE_M = 1000 meters.
 *   At Drop latitude φ:
 *     mPerDegLat ≈ 111_320
 *     mPerDegLng ≈ 111_320 · cos(φ)
 *   Local XZ meters (origin = Drop) → tile index:
 *     tx = floor(x / TILE_M)
 *     tz = floor(z / TILE_M)
 *   Tile (tx, tz) covers:
 *     x ∈ [tx·TILE_M, (tx+1)·TILE_M)
 *     z ∈ [tz·TILE_M, (tz+1)·TILE_M)
 *   Corners go through localToLatLng → Overpass bbox (south,west,north,east).
 *
 * RINGS (Chebyshev distance = max(|dtx|,|dtz|)):
 *   ACTIVE_RING   = 1 → crawl baseline: 3×3 tiles LIVE in Scene + GpsDash
 *   PREFETCH_RING = 2 → outer ring may download into cache ONLY
 *   Distance > prefetch want-set → tile disposed
 *
 * LEARNING — Variable fetch shape (Joey design):
 *   Crawl (< ~SPEED_CIRCLE_MPH): circular active radius around the car
 *   (current 3×3 is fine). Highway (≥ ~SPEED_CORRIDOR_MPH): thin longer
 *   corridor ahead along heading — NOT a fat circle. Blend look-ahead meters
 *   + lateral half-width by |speedMph|. Queue sort: forward ≫ side ≫ behind
 *   so MAX_IN_FLIGHT=1 still fetches what paints next (load order ≡ render cue).
 *
 * LEARNING — Fast Drop path (TTI / CPU spike fix):
 *   Old path: bootstrap enqueued the whole 3×3 (+ prefetch), waited for ~5
 *   active tiles, and routed Overpass through a Web Worker. That was slower:
 *   Overpass is network-bound (worker can’t help), postMessage+clone added
 *   latency, and clearing busy only after 5 tiles meant a long stall — then
 *   nine Road meshes tried to apply and spiked CPU.
 *
 *   New path:
 *     1) loadCenterTileFast() — tile (0,0) ways on **main thread**, activate,
 *        emit ASAP → streets visible + car driveable. busy clears here.
 *     2) Buildings for center deferred (second emit). Elev stays worker-only
 *        (PNG decode). Far elev / neighbor buildings don’t compete with paint.
 *     3) fillNeighborsAfterDrop() — activate/prefetch ring with MAX_IN_FLIGHT=1
 *        (serial / quiet). applyCoordinator still ≤1 React commit per frame.
 *
 * HARD GPS RULE (Joey lock — do not weaken):
 *   GpsDash strokes ONLY ways from tiles with status === 'active'.
 *   Prefetch may hit the network and sit in RAM, but must NEVER paint on the
 *   dial until the tile is active in Scene/Road. When a tile activates, 3D
 *   streets and GPS streets appear together — that IS the visual load cue.
 *
 * HARD LOCKS (keep):
 *   No camera/car remount on stream (spawnKey = dropNonce only).
 *   VERTICAL_EXAGGERATION = 1. Suspense isolation around Car.
 */

import {
  latLngToLocal,
  localToLatLng,
  metersPerDegree,
  type LatLng,
} from './geo'
import {
  fetchWaysInBbox,
  geocodeDrop,
  getDemoWorld,
  type StreetWay,
  type StreetWorld,
} from './osmStreets'
import { mainFetchBuildings, mainFetchWays } from './tileLoaderClient'
import {
  mergeActiveBuildingBoxes,
  MAX_BUILDINGS,
  MAX_BUILDINGS_PER_TILE,
  type BuildingBox,
} from './osmBuildings'

/** Edge length of one street tile (meters). ~1 km keeps Overpass snappy. */
export const TILE_M = 1000

/** Chebyshev ring kept LIVE in Scene + GpsDash. ring 1 → 3×3 tiles. */
export const ACTIVE_RING = 1

/**
 * Prefetch ring (network / cache only). ring 2 → 5×5 footprint; the outer
 * shell may download but stays off GpsDash until promoted to active.
 */
export const PREFETCH_RING = 2

/**
 * Speed → fetch-shape thresholds (Joey).
 *   |speed| < SPEED_CIRCLE_MPH  → circular 3×3 (crawl / neighborhood)
 *   |speed| ≥ SPEED_CORRIDOR_MPH → long thin corridor along heading
 *   Between: lerp look-ahead meters + lateral tile half-width.
 */
export const SPEED_CIRCLE_MPH = 28
export const SPEED_CORRIDOR_MPH = 58

/** Look-ahead along heading at crawl — tiny; active set stays car-centered. */
export const LOOKAHEAD_CRAWL_M = 80
/**
 * Look-ahead at highway. ~60 mph ≈ 27 m/s → 1600 m ≈ 60 s of runway so the
 * thin corridor promotes before soft-clamp meets a continuing road.
 * (Legacy name ACTIVATE_LOOKAHEAD_M kept as an alias of this highway end.)
 */
export const LOOKAHEAD_HIGHWAY_M = 1600
/** @deprecated Use LOOKAHEAD_HIGHWAY_M — alias for older call sites / docs. */
export const ACTIVATE_LOOKAHEAD_M = LOOKAHEAD_HIGHWAY_M

/** 0 = circle (crawl), 1 = full corridor (highway). */
export function speedCorridorBlend(speedMph: number): number {
  const a = Math.abs(speedMph)
  if (a <= SPEED_CIRCLE_MPH) return 0
  if (a >= SPEED_CORRIDOR_MPH) return 1
  return (a - SPEED_CIRCLE_MPH) / (SPEED_CORRIDOR_MPH - SPEED_CIRCLE_MPH)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/**
 * Cap concurrent Overpass tile fetches.
 * LEARNING — Drop neighbors fill with 1 in flight so we never burst 9 tiles
 * into applyCoordinator right after first paint. Bump to 2 only if Overpass
 * etiquette + hitch budget still feel fine.
 */
export const MAX_IN_FLIGHT = 1

/** Minimum gap between starting Overpass tile requests. */
export const OVERPASS_GAP_MS = 750

export type TileKey = string // `${tx},${tz}`

export type TileStatus = 'empty' | 'loading' | 'cached' | 'active' | 'error'

export type StreetTile = {
  key: TileKey
  tx: number
  tz: number
  status: TileStatus
  ways: StreetWay[]
  /** OSM building AABBs for this tile (empty until deferred fetch returns). */
  buildings: BuildingBox[]
  error?: string
}

/** Axis-aligned bounds of all *active* tiles in local meters. */
export type LoadedAabb = {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

/**
 * Snapshot React reads. `activeWays` is the ONLY list allowed into Scene
 * and GpsDash (hard GPS rule).
 */
/** One active tile’s ways — Scene mounts a Road group per key (incremental). */
export type ActiveTileWays = {
  key: TileKey
  tx: number
  tz: number
  ways: StreetWay[]
}

export type StreamSnapshot = {
  origin: LatLng
  dropLabel: string
  activeWays: StreetWay[]
  /**
   * Per-tile ways for incremental Road meshes. Same ways as activeWays
   * (pre-dedupe within each tile); GPS still uses flattened activeWays.
   */
  activeTiles: ActiveTileWays[]
  /**
   * active + cached ways for route align / AP near-car splice ONLY.
   * LEARNING: GPS dial + Scene still use activeWays (hard GPS rule). Align
   * needs the wider fetched bubble so Dijkstra can bridge thin active-ring gaps
   * without crow-flight chords — without painting prefetch ghosts on the dial.
   */
  alignWays: StreetWay[]
  /** HARD GPS RULE still streets-only — buildings are scenery, not dial ink. */
  activeBuildings: BuildingBox[]
  buildingsMessage: string
  activeTileCount: number
  loadingCount: number
  cachedCount: number
  message: string
  source: 'osm' | 'demo'
  loadedAabb: LoadedAabb | null
  version: number
  /** Teaching HUD: next Overpass tile key (priority queue head), or null. */
  nextQueueKey: TileKey | null
  /** Teaching HUD: pending tile fetches waiting on MAX_IN_FLIGHT / gap. */
  queueDepth: number
  /** 0 = circle crawl, 1 = highway corridor (from last updateCar). */
  corridorBlend: number
  buildingsEnabled: boolean
}

export function makeTileKey(tx: number, tz: number): TileKey {
  return `${tx},${tz}`
}

export function worldToTile(x: number, z: number): { tx: number; tz: number } {
  return { tx: Math.floor(x / TILE_M), tz: Math.floor(z / TILE_M) }
}

export function tileLocalAabb(tx: number, tz: number): LoadedAabb {
  return {
    minX: tx * TILE_M,
    maxX: (tx + 1) * TILE_M,
    minZ: tz * TILE_M,
    maxZ: (tz + 1) * TILE_M,
  }
}

/**
 * WGS84 bbox for one tile. Small pad so centerlines on the seam are not
 * clipped by float edges between neighboring Overpass queries.
 */
export function tileToBbox(
  tx: number,
  tz: number,
  origin: LatLng,
  padM = 8,
): { south: number; west: number; north: number; east: number } {
  const x0 = tx * TILE_M - padM
  const x1 = (tx + 1) * TILE_M + padM
  const z0 = tz * TILE_M - padM
  const z1 = (tz + 1) * TILE_M + padM
  const corners = [
    localToLatLng(x0, z0, origin),
    localToLatLng(x1, z0, origin),
    localToLatLng(x0, z1, origin),
    localToLatLng(x1, z1, origin),
  ]
  let south = Infinity
  let north = -Infinity
  let west = Infinity
  let east = -Infinity
  for (const c of corners) {
    south = Math.min(south, c.lat)
    north = Math.max(north, c.lat)
    west = Math.min(west, c.lng)
    east = Math.max(east, c.lng)
  }
  return { south, west, north, east }
}

function chebyshev(ax: number, az: number, bx: number, bz: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(az - bz))
}

function unionActiveAabb(tiles: Iterable<StreetTile>): LoadedAabb | null {
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  let any = false
  for (const t of tiles) {
    if (t.status !== 'active') continue
    any = true
    const a = tileLocalAabb(t.tx, t.tz)
    minX = Math.min(minX, a.minX)
    maxX = Math.max(maxX, a.maxX)
    minZ = Math.min(minZ, a.minZ)
    maxZ = Math.max(maxZ, a.maxZ)
  }
  return any ? { minX, maxX, minZ, maxZ } : null
}

/**
 * Deduplicate ways across overlapping tile pads so seams do not double-draw.
 * Key = highway + endpoints + point count — good enough for a teaching toy.
 */
function dedupeWays(ways: StreetWay[]): StreetWay[] {
  const seen = new Set<string>()
  const out: StreetWay[] = []
  for (const w of ways) {
    if (w.points.length < 2) continue
    const a = w.points[0]
    const b = w.points[w.points.length - 1]
    const key = `${w.highway}|${a.lat.toFixed(5)},${a.lng.toFixed(5)}|${b.lat.toFixed(5)},${b.lng.toFixed(5)}|${w.points.length}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(w)
  }
  return out
}

function buildMessage(
  source: 'osm' | 'demo',
  active: number,
  loading: number,
  wayCount: number,
): string {
  if (source === 'demo') {
    return `DEMO streets · Tiles: ${active} loaded · streaming idle (offline fallback)`
  }
  const loadBit = loading > 0 ? ` · ${loading} loading` : ''
  return `Live OSM streaming · Tiles: ${active} loaded${loadBit} · ${wayCount} ways · ~${TILE_M} m tiles`
}

/**
 * Framework-free streamer. React hooks subscribe via `subscribe`; the class
 * owns the queue, cache, and active set so the tile math stays testable.
 */
export class StreetTileStreamer {
  readonly origin: LatLng
  readonly dropLabel: string
  source: 'osm' | 'demo' = 'osm'

  private tiles = new Map<TileKey, StreetTile>()
  private queue: TileKey[] = []
  private inFlight = 0
  /** -Infinity so the first pump never waits on OVERPASS_GAP_MS. */
  private lastStartMs = Number.NEGATIVE_INFINITY
  private version = 0
  private disposed = false
  private listeners = new Set<() => void>()
  private carTx = 0
  private carTz = 0
  private lookTx = 0
  private lookTz = 0
  /** Live car pose for corridor samples + priority scores (meters / rad / mph). */
  private carX = 0
  private carZ = 0
  private carYaw = 0
  private speedMph = 0
  private lookM = LOOKAHEAD_CRAWL_M
  private blendQ = 0
  /** Last wantActive from reconcile — startFetch promotes against this set. */
  private lastWantActive = new Set<TileKey>()
  /**
   * Stable activeWays reference — only replaced when the active set’s ways
   * content actually changes. Prevents Road / elev thrash on loading-count emits.
   */
  private cachedActiveWays: StreetWay[] = []
  private cachedActiveKey = ''
  /** Stable active+cached ways for align (not Scene/GPS). */
  private cachedAlignWays: StreetWay[] = []
  private cachedAlignKey = ''
  /** Bumped on dispose / Drop reset so late fetches are ignored. */
  private gen = 0
  /** After center Drop paint, neighbors may fill (once). */
  private neighborsStarted = false
  /**
   * HUD Buildings ON/OFF. When false: skip Overpass building fetches + empty
   * activeBuildings so streets/elev get the network + CPU (Joey A/B).
   */
  private buildingsEnabled = true

  constructor(origin: LatLng, dropLabel: string) {
    this.origin = origin
    this.dropLabel = dropLabel
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private emit() {
    this.version += 1
    for (const fn of this.listeners) fn()
  }

  /** Notify React without bumping ways-version semantics (loading HUD only). */
  private emitMeta() {
    for (const fn of this.listeners) fn()
  }

  /** Fingerprint of which tiles are active + their way counts (not loading). */
  private activeContentKey(): string {
    const parts: string[] = []
    for (const t of this.tiles.values()) {
      if (t.status !== 'active') continue
      parts.push(`${t.key}:${t.ways.length}`)
    }
    parts.sort()
    return parts.join('|')
  }

  private refreshActiveWaysCache(): StreetWay[] {
    const key = this.activeContentKey()
    if (key === this.cachedActiveKey) return this.cachedActiveWays
    const activeTiles = [...this.tiles.values()].filter((t) => t.status === 'active')
    this.cachedActiveWays = dedupeWays(activeTiles.flatMap((t) => t.ways))
    this.cachedActiveKey = key
    return this.cachedActiveWays
  }

  /** Fingerprint active+cached tile way counts (align graph coverage). */
  private alignContentKey(): string {
    const parts: string[] = []
    for (const t of this.tiles.values()) {
      if (t.status !== 'active' && t.status !== 'cached') continue
      parts.push(`${t.key}:${t.ways.length}`)
    }
    parts.sort()
    return parts.join('|')
  }

  /**
   * Ways for near-car route splice — active + cached (fetched) tiles.
   * Not for Scene/GpsDash (hard GPS rule stays on activeWays).
   */
  private refreshAlignWaysCache(): StreetWay[] {
    const key = this.alignContentKey()
    if (key === this.cachedAlignKey) return this.cachedAlignWays
    const tiles = [...this.tiles.values()].filter(
      (t) =>
        (t.status === 'active' || t.status === 'cached') && t.ways.length > 0,
    )
    this.cachedAlignWays = dedupeWays(tiles.flatMap((t) => t.ways))
    this.cachedAlignKey = key
    return this.cachedAlignWays
  }

  dispose() {
    this.disposed = true
    this.gen += 1
    this.queue.length = 0
    this.tiles.clear()
    this.cachedActiveWays = []
    this.cachedActiveKey = ''
    this.cachedAlignWays = []
    this.cachedAlignKey = ''
    this.listeners.clear()
  }

  snapshot(): StreamSnapshot {
    const all = [...this.tiles.values()]
    const activeTiles = all.filter((t) => t.status === 'active')
    const loadingCount = all.filter((t) => t.status === 'loading').length
    const cachedCount = all.filter((t) => t.status === 'cached').length
    // Stable reference when active content unchanged — Road meshes stay put.
    const activeWays = this.refreshActiveWaysCache()
    const alignWays = this.refreshAlignWaysCache()
    // Per-tile list for incremental Road groups (sorted for stable React keys).
    const activeTileWays: ActiveTileWays[] = activeTiles
      .map((t) => ({ key: t.key, tx: t.tx, tz: t.tz, ways: t.ways }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    // Buildings follow the same active set (unload when tile demotes/drops).
    // When HUD toggles Buildings OFF, snapshot is empty (no Scene apply / no GPS).
    const activeBuildings = this.buildingsEnabled
      ? mergeActiveBuildingBoxes(
          activeTiles.map((t) => t.buildings),
          MAX_BUILDINGS,
        )
      : []
    const resN = activeBuildings.filter((b) => b.residential).length
    const buildingsMessage = !this.buildingsEnabled
      ? 'Buildings: OFF (streets + elev only — flip HUD to resume)'
      : activeBuildings.length > 0
        ? `Buildings: ${activeBuildings.length} active (${resN} residential) · streamed per tile · cap ${MAX_BUILDINGS}`
        : loadingCount > 0
          ? 'Buildings: streaming with tiles…'
          : 'Buildings: none in active tiles'
    const blend = speedCorridorBlend(this.speedMph)
    return {
      origin: this.origin,
      dropLabel: this.dropLabel,
      activeWays,
      alignWays,
      activeTiles: activeTileWays,
      activeBuildings,
      buildingsMessage,
      activeTileCount: activeTiles.length,
      loadingCount,
      cachedCount,
      message: buildMessage(
        this.source,
        activeTiles.length,
        loadingCount,
        activeWays.length,
      ),
      source: this.source,
      loadedAabb: unionActiveAabb(all),
      version: this.version,
      nextQueueKey: this.queue[0] ?? null,
      queueDepth: this.queue.length,
      corridorBlend: blend,
      buildingsEnabled: this.buildingsEnabled,
    }
  }

  /** Offline / failure path — one active demo tile at (0,0). */
  seedDemo(ways: StreetWay[]) {
    const key = makeTileKey(0, 0)
    this.tiles.clear()
    this.queue.length = 0
    this.cachedActiveWays = []
    this.cachedActiveKey = ''
    this.cachedAlignWays = []
    this.cachedAlignKey = ''
    this.source = 'demo'
    this.tiles.set(key, {
      key,
      tx: 0,
      tz: 0,
      status: 'active',
      ways,
      buildings: [],
    })
    this.emit()
  }

  /**
   * CRITICAL Drop path — center tile only, main-thread Overpass, paint ASAP.
   *
   * LEARNING: Do NOT enqueue the 3×3 here. Do NOT wait for buildings/elev.
   * Ways on (0,0) → active → emit → busy clears in the React hook. Neighbors
   * start via fillNeighborsAfterDrop() after this resolves.
   */
  async loadCenterTileFast(): Promise<void> {
    if (this.disposed || this.source === 'demo') return
    this.carTx = 0
    this.carTz = 0
    this.lookTx = 0
    this.lookTz = 0
    this.neighborsStarted = false

    const key = makeTileKey(0, 0)
    const tile: StreetTile = {
      key,
      tx: 0,
      tz: 0,
      status: 'loading',
      ways: [],
      buildings: [],
    }
    this.tiles.set(key, tile)
    this.emitMeta()

    const gen = this.gen
    const bbox = tileToBbox(0, 0, this.origin)

    try {
      // Main thread — network-bound; no worker round-trip on the critical path.
      const ways = await fetchWaysInBbox(
        bbox.south,
        bbox.west,
        bbox.north,
        bbox.east,
      )
      if (this.disposed || gen !== this.gen) return
      const live = this.tiles.get(key)
      if (!live) return
      live.ways = ways
      live.status = 'active'
      // FIRST PAINT package: ways only. Buildings deferred below.
      this.emit()
      console.info(
        `[streetTiles] Drop center ready · ${ways.length} ways · neighbors next`,
      )

      // Buildings after first paint — must not compete with Road mesh apply.
      // Respect HUD Buildings OFF (Joey A/B: free Overpass for streets+elev).
      if (this.buildingsEnabled) {
        void this.deferBuildings(live, bbox, gen)
      }
    } catch (err: unknown) {
      if (this.disposed || gen !== this.gen) return
      const live = this.tiles.get(key)
      if (!live) return
      live.status = 'error'
      live.error = err instanceof Error ? err.message : 'center tile fetch failed'
      live.ways = []
      live.buildings = []
      this.emit()
      throw err
    }
  }

  /**
   * After center ways are painted: enqueue ACTIVE + PREFETCH quietly.
   * MAX_IN_FLIGHT=1 → serial neighbor fills, no 9-mesh apply burst.
   * Drop is crawl-shaped (blend 0) so first neighbors are the classic 3×3.
   */
  fillNeighborsAfterDrop() {
    if (this.disposed || this.source === 'demo' || this.neighborsStarted) return
    this.neighborsStarted = true
    this.carX = 0
    this.carZ = 0
    this.carYaw = 0
    this.speedMph = 0
    this.lookM = LOOKAHEAD_CRAWL_M
    this.blendQ = 0
    this.reconcile(0, 0)
  }

  /**
   * HUD Buildings ON/OFF. OFF skips network + clears boxes so Overpass/CPU
   * favor streets+elev; ON resumes deferred fetches for active tiles.
   */
  setBuildingsEnabled(on: boolean) {
    if (this.buildingsEnabled === on) return
    this.buildingsEnabled = on
    if (!on) {
      for (const t of this.tiles.values()) t.buildings = []
      this.emit()
      return
    }
    // Resume: fetch buildings for active tiles that have ways but no boxes yet.
    const gen = this.gen
    for (const t of this.tiles.values()) {
      if (t.status !== 'active' && t.status !== 'cached') continue
      if (t.buildings.length > 0) continue
      if (t.ways.length === 0) continue
      const bbox = tileToBbox(t.tx, t.tz, this.origin)
      void this.deferBuildings(t, bbox, gen)
    }
    this.emit()
  }

  getBuildingsEnabled(): boolean {
    return this.buildingsEnabled
  }

  /**
   * Poll with car local XZ. yaw + speedMph drive the variable fetch shape:
   * crawl → circle; highway → thin longer corridor; blend in between.
   * Yaw 0 = world −Z (same as Car / GpsDash).
   */
  updateCar(x: number, z: number, yaw = 0, speedMph = 0) {
    if (this.disposed || this.source === 'demo') return
    this.carX = x
    this.carZ = z
    this.carYaw = yaw
    this.speedMph = speedMph
    const blend = speedCorridorBlend(speedMph)
    const lookM = lerp(LOOKAHEAD_CRAWL_M, LOOKAHEAD_HIGHWAY_M, blend)
    this.lookM = lookM
    const { tx, tz } = worldToTile(x, z)
    const lx = x - Math.sin(yaw) * lookM
    const lz = z - Math.cos(yaw) * lookM
    const look = worldToTile(lx, lz)
    // Quantize blend so small mph noise doesn’t thrash want-sets every poll.
    const blendQ = Math.round(blend * 10)
    if (
      tx !== this.carTx ||
      tz !== this.carTz ||
      look.tx !== this.lookTx ||
      look.tz !== this.lookTz ||
      blendQ !== this.blendQ
    ) {
      this.carTx = tx
      this.carTz = tz
      this.lookTx = look.tx
      this.lookTz = look.tz
      this.blendQ = blendQ
      this.reconcile(tx, tz)
    } else {
      // Heading may still drift inside the same tile — keep queue forward-biased.
      const before = `${this.queue[0] ?? ''}:${this.queue.length}`
      this.sortQueue()
      this.pumpQueue()
      const after = `${this.queue[0] ?? ''}:${this.queue.length}`
      // Teaching HUD only — avoid 4 Hz React commits when nothing queue-visible changed.
      if (before !== after) this.emitMeta()
    }
  }

  /**
   * Build wantActive / wantPrefetch from speed-blended corridor (or circle).
   *
   * LEARNING — why not only Chebyshev rings around car + look?
   *   Two fat rings make a blob (side tiles compete with the road ahead).
   *   Highway: sample along heading with lateral half-width → 0 so the queue
   *   and activate set match “what paints next out the windshield.”
   */
  private computeWantSets(
    cx: number,
    cz: number,
  ): { wantActive: Set<TileKey>; wantPrefetch: Set<TileKey> } {
    const wantActive = new Set<TileKey>()
    const wantPrefetch = new Set<TileKey>()
    const blend = speedCorridorBlend(this.speedMph)
    const lookM = this.lookM
    const yaw = this.carYaw

    const consider = (ox: number, oz: number, ring: number, into: Set<TileKey>) => {
      const r = Math.max(0, ring)
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          into.add(makeTileKey(ox + dx, oz + dz))
        }
      }
    }

    // Lateral half-width in tiles: 1 at crawl → 0 at highway (one-tile strip).
    const latActive = Math.round(lerp(ACTIVE_RING, 0, blend))
    // Car-centered ring: full 3×3 at crawl; just the car tile at highway.
    const carActiveRing = Math.round(lerp(ACTIVE_RING, 0, blend))
    consider(cx, cz, carActiveRing, wantActive)

    // Corridor samples along heading (yaw 0 = −Z).
    const stepM = TILE_M * 0.5
    const steps = Math.max(1, Math.ceil(lookM / stepM))
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const sx = this.carX - Math.sin(yaw) * lookM * t
      const sz = this.carZ - Math.cos(yaw) * lookM * t
      const s = worldToTile(sx, sz)
      consider(s.tx, s.tz, latActive, wantActive)
    }

    // Prefetch: keep classic shell around the car + a slightly wider/longer
    // corridor so the next promote is often already cached.
    consider(cx, cz, PREFETCH_RING, wantPrefetch)
    const latPref = Math.max(latActive + 1, Math.round(lerp(PREFETCH_RING, 1, blend)))
    const prefLook = lookM * lerp(1, 1.35, blend)
    const prefSteps = Math.max(1, Math.ceil(prefLook / stepM))
    for (let i = 0; i <= prefSteps; i++) {
      const t = i / prefSteps
      const sx = this.carX - Math.sin(yaw) * prefLook * t
      const sz = this.carZ - Math.cos(yaw) * prefLook * t
      const s = worldToTile(sx, sz)
      consider(s.tx, s.tz, latPref, wantPrefetch)
    }
    // Everything active is also prefetch-eligible.
    for (const k of wantActive) wantPrefetch.add(k)

    return { wantActive, wantPrefetch }
  }

  /**
   * Lower score = fetch sooner. Forward / near look-ahead / on-center beat
   * side and behind — matches soft-edge runway + what the driver sees next.
   */
  private tileFetchScore(tx: number, tz: number): number {
    const tcx = (tx + 0.5) * TILE_M
    const tcz = (tz + 0.5) * TILE_M
    const dx = tcx - this.carX
    const dz = tcz - this.carZ
    const fwd = -Math.sin(this.carYaw) * dx - Math.cos(this.carYaw) * dz
    const lat = Math.abs(-Math.cos(this.carYaw) * dx + Math.sin(this.carYaw) * dz)
    const dist = Math.hypot(dx, dz)
    const lx = this.carX - Math.sin(this.carYaw) * this.lookM
    const lz = this.carZ - Math.cos(this.carYaw) * this.lookM
    const dLook = Math.hypot(tcx - lx, tcz - lz)
    // Behind more than ~⅓ tile → hard deprioritize (still prefetch eventually).
    const behind = fwd < -TILE_M * 0.35 ? 50_000 + Math.abs(fwd) : 0
    return behind + lat * 4 + dLook * 0.85 + dist * 0.25 - Math.max(0, fwd) * 0.15
  }

  private sortQueue() {
    if (this.queue.length < 2) return
    this.queue.sort((a, b) => {
      const [ax, az] = a.split(',').map(Number)
      const [bx, bz] = b.split(',').map(Number)
      return this.tileFetchScore(ax, az) - this.tileFetchScore(bx, bz)
    })
  }

  private reconcile(cx: number, cz: number) {
    const { wantActive, wantPrefetch } = this.computeWantSets(cx, cz)
    this.lastWantActive = wantActive
    // Keep lookTx/Tz as the far sample for HUD / legacy readers.
    const lx = this.carX - Math.sin(this.carYaw) * this.lookM
    const lz = this.carZ - Math.cos(this.carYaw) * this.lookM
    const look = worldToTile(lx, lz)
    this.lookTx = look.tx
    this.lookTz = look.tz

    // Create empties for anything in the prefetch want-set (sorted enqueue later).
    const newKeys: TileKey[] = []
    for (const key of wantPrefetch) {
      if (this.tiles.has(key)) continue
      const [txs, tzs] = key.split(',')
      const txi = Number(txs)
      const tzi = Number(tzs)
      this.tiles.set(key, {
        key,
        tx: txi,
        tz: tzi,
        status: 'empty',
        ways: [],
        buildings: [],
      })
      newKeys.push(key)
    }

    let changed = false
    for (const tile of [...this.tiles.values()]) {
      // Unload only when outside the prefetch want-set AND outside car shell.
      const dCar = chebyshev(cx, cz, tile.tx, tile.tz)
      if (!wantPrefetch.has(tile.key) && dCar > PREFETCH_RING) {
        this.tiles.delete(tile.key)
        // Drop from queue if pending.
        const qi = this.queue.indexOf(tile.key)
        if (qi >= 0) this.queue.splice(qi, 1)
        changed = true
        continue
      }

      if (wantActive.has(tile.key)) {
        if (tile.status === 'cached') {
          tile.status = 'active'
          changed = true
        } else if (tile.status === 'empty' || tile.status === 'error') {
          this.enqueue(tile.key)
        }
      } else if (tile.status === 'active') {
        // HARD GPS RULE: demote → disappears from Scene + GpsDash together.
        tile.status = 'cached'
        changed = true
      } else if (tile.status === 'empty' || tile.status === 'error') {
        if (wantPrefetch.has(tile.key)) this.enqueue(tile.key)
      }
    }

    for (const key of newKeys) this.enqueue(key)

    this.sortQueue()
    if (changed) this.emit()
    else this.emitMeta()
    this.pumpQueue()
  }

  /**
   * Enqueue then priority-sort. LEARNING — do NOT unshift “urgent” in ring
   * discovery order (Chebyshev nested loops ≠ distance / forward). Sort so
   * forward/center match what RoadTiles will paint next.
   */
  private enqueue(key: TileKey) {
    if (this.queue.includes(key)) return
    const tile = this.tiles.get(key)
    if (!tile) return
    if (
      tile.status === 'loading' ||
      tile.status === 'active' ||
      tile.status === 'cached'
    ) {
      return
    }
    this.queue.push(key)
  }

  private pumpQueue() {
    if (this.disposed || this.source === 'demo') return
    this.sortQueue()
    const now = performance.now()
    while (
      this.inFlight < MAX_IN_FLIGHT &&
      this.queue.length > 0 &&
      now - this.lastStartMs >= OVERPASS_GAP_MS
    ) {
      const key = this.queue.shift()!
      const tile = this.tiles.get(key)
      if (!tile) continue
      if (
        tile.status === 'active' ||
        tile.status === 'cached' ||
        tile.status === 'loading'
      ) {
        continue
      }
      this.startFetch(tile)
      this.lastStartMs = performance.now()
    }
  }

  /**
   * Neighbor / look-ahead tile fetch (main-thread Overpass).
   * LEARNING — emit WAYS first (driveable asphalt), buildings in a follow-up
   * emit so applyCoordinator never waits on a second Overpass for first paint
   * of that tile. Never apply 9 Road meshes in one synchronous burst — the
   * coordinator + MAX_IN_FLIGHT=1 keep applies frame-budgeted.
   */
  private startFetch(tile: StreetTile) {
    tile.status = 'loading'
    this.inFlight += 1
    // Meta only — loading spinner must NOT bump streamVersion / remount world.
    this.emitMeta()

    const gen = this.gen
    const bbox = tileToBbox(tile.tx, tile.tz, this.origin)

    void mainFetchWays(bbox.south, bbox.west, bbox.north, bbox.east)
      .then(async (ways) => {
        if (this.disposed || gen !== this.gen) return
        const live = this.tiles.get(tile.key)
        if (!live) return
        live.ways = ways
        // Promote against the speed-blended wantActive (corridor or circle).
        live.status = this.lastWantActive.has(live.key) ? 'active' : 'cached'

        // Ways package first — asphalt / GPS can appear without buildings.
        this.emit()

        // Buildings deferred (second emit). Skip entirely when HUD Buildings OFF.
        if (this.buildingsEnabled) {
          await this.deferBuildings(live, bbox, gen)
        }
      })
      .catch((err: unknown) => {
        if (this.disposed || gen !== this.gen) return
        const live = this.tiles.get(tile.key)
        if (!live) return
        live.status = 'error'
        live.error = err instanceof Error ? err.message : 'tile fetch failed'
        live.ways = []
        live.buildings = []
        this.emit()
      })
      .finally(() => {
        this.inFlight = Math.max(0, this.inFlight - 1)
        this.pumpQueue()
      })
  }

  private async deferBuildings(
    tile: StreetTile,
    bbox: { south: number; west: number; north: number; east: number },
    gen: number,
  ) {
    if (!this.buildingsEnabled) return
    try {
      const bw = await mainFetchBuildings(
        bbox.south,
        bbox.west,
        bbox.north,
        bbox.east,
        this.origin,
        MAX_BUILDINGS_PER_TILE,
      )
      if (this.disposed || gen !== this.gen) return
      if (!this.buildingsEnabled) return
      const again = this.tiles.get(tile.key)
      if (!again) return
      again.buildings = bw.boxes
      this.emit()
    } catch (err) {
      console.warn('[streetTiles] tile buildings failed', tile.key, err)
    }
  }
}

/**
 * Soft void edge: clamp ONLY when outside the union AABB of *active* tiles.
 *
 * LEARNING — padM is a small OUTWARD margin (meters past the tile edge), not a
 * shrink. Never use this to fence mid-asphalt: if a road is on a loaded tile it
 * sits inside the AABB. Hitting a “wall on a road” means the next tile was not
 * active yet — fix with speed-blended corridor activate (updateCar), not a
 * tighter clamp. Replaces the hard ~200 ft corridor while streaming.
 */
export function softClampToLoadedAabb(
  x: number,
  z: number,
  aabb: LoadedAabb | null,
  padM = 12,
): { x: number; z: number; outside: boolean } {
  if (!aabb) return { x, z, outside: false }
  const minX = aabb.minX - padM
  const maxX = aabb.maxX + padM
  const minZ = aabb.minZ - padM
  const maxZ = aabb.maxZ + padM
  const cx = Math.min(maxX, Math.max(minX, x))
  const cz = Math.min(maxZ, Math.max(minZ, z))
  return { x: cx, z: cz, outside: cx !== x || cz !== z }
}

export function pointInLoadedAabb(
  x: number,
  z: number,
  aabb: LoadedAabb | null,
  padM = 0,
): boolean {
  if (!aabb) return true
  return (
    x >= aabb.minX - padM &&
    x <= aabb.maxX + padM &&
    z >= aabb.minZ - padM &&
    z <= aabb.maxZ + padM
  )
}

/** HUD / README helper — shows the degree math at the current Drop latitude. */
export function tileMathBlurb(originLat: number): string {
  const { mPerDegLat, mPerDegLng } = metersPerDegree(originLat)
  const dLat = TILE_M / mPerDegLat
  const dLng = TILE_M / mPerDegLng
  const n = (ACTIVE_RING * 2 + 1) ** 2
  return (
    `Tile ≈ ${TILE_M} m → Δlat ${dLat.toFixed(5)}°, Δlng ${dLng.toFixed(5)}° ` +
    `at lat ${originLat.toFixed(3)} (active ring ${ACTIVE_RING} → ${n} tiles; Drop paints center first)`
  )
}

/**
 * Drop entry: geocode → center tile fast path → clear busy → neighbors quiet fill.
 *
 * LEARNING — ready when center ways exist (not “wait for ~5 tiles”). Elev for
 * the center bbox and neighbor streets stream after first paint.
 */
export async function startStreetStream(dropAddress: string): Promise<{
  streamer: StreetTileStreamer
  world: StreetWorld
}> {
  const q = dropAddress.trim()
  if (!q) {
    const demo = getDemoWorld()
    const streamer = new StreetTileStreamer(demo.origin, demo.dropLabel)
    streamer.seedDemo(demo.ways)
    return { streamer, world: demo }
  }

  try {
    const drop = await geocodeDrop(q)
    const streamer = new StreetTileStreamer(drop, drop.label)
    // Center only — paint roads ASAP; do not gate on the full 3×3.
    await streamer.loadCenterTileFast()
    // Neighbors + prefetch: serial (MAX_IN_FLIGHT=1), after busy can clear.
    streamer.fillNeighborsAfterDrop()
    const snap = streamer.snapshot()
    const world: StreetWorld = {
      origin: snap.origin,
      ways: snap.activeWays,
      source: snap.source,
      message: snap.message,
      dropLabel: snap.dropLabel,
      streetMeters: 0,
      wayCount: snap.activeWays.length,
    }
    return { streamer, world }
  } catch (err) {
    const why = err instanceof Error ? err.message : 'unknown error'
    console.warn('[streetTiles] Drop stream failed, demo:', why)
    const demo = getDemoWorld()
    const world: StreetWorld = {
      ...demo,
      message: `Street stream failed (${why}). Showing DEMO crossroads — not live OSM.`,
    }
    const streamer = new StreetTileStreamer(world.origin, world.dropLabel)
    streamer.seedDemo(world.ways)
    return { streamer, world }
  }
}

export { latLngToLocal }
