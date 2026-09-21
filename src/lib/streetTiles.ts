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
 *   ACTIVE_RING   = 1 → 3×3 tiles LIVE in Scene + GpsDash (~3 km across)
 *   PREFETCH_RING = 2 → outer ring may download into cache ONLY
 *   Distance > PREFETCH_RING → tile disposed
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
 * How far ahead of the car (meters) we treat as “already there” for activate /
 * prefetch. At ~60 mph ≈ 27 m/s, 700 m ≈ 26 s of runway — next tiles promote
 * before soft-clamp can meet a continuing road at the AABB edge.
 */
export const ACTIVATE_LOOKAHEAD_M = 700

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
  /**
   * Stable activeWays reference — only replaced when the active set’s ways
   * content actually changes. Prevents Road / elev thrash on loading-count emits.
   */
  private cachedActiveWays: StreetWay[] = []
  private cachedActiveKey = ''
  /** Bumped on dispose / Drop reset so late fetches are ignored. */
  private gen = 0
  /** After center Drop paint, neighbors may fill (once). */
  private neighborsStarted = false

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

  dispose() {
    this.disposed = true
    this.gen += 1
    this.queue.length = 0
    this.tiles.clear()
    this.cachedActiveWays = []
    this.cachedActiveKey = ''
    this.listeners.clear()
  }

  snapshot(): StreamSnapshot {
    const all = [...this.tiles.values()]
    const activeTiles = all.filter((t) => t.status === 'active')
    const loadingCount = all.filter((t) => t.status === 'loading').length
    const cachedCount = all.filter((t) => t.status === 'cached').length
    // Stable reference when active content unchanged — Road meshes stay put.
    const activeWays = this.refreshActiveWaysCache()
    // Per-tile list for incremental Road groups (sorted for stable React keys).
    const activeTileWays: ActiveTileWays[] = activeTiles
      .map((t) => ({ key: t.key, tx: t.tx, tz: t.tz, ways: t.ways }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    // Buildings follow the same active set (unload when tile demotes/drops).
    const activeBuildings = mergeActiveBuildingBoxes(
      activeTiles.map((t) => t.buildings),
      MAX_BUILDINGS,
    )
    const resN = activeBuildings.filter((b) => b.residential).length
    const buildingsMessage =
      activeBuildings.length > 0
        ? `Buildings: ${activeBuildings.length} active (${resN} residential) · streamed per tile · cap ${MAX_BUILDINGS}`
        : loadingCount > 0
          ? 'Buildings: streaming with tiles…'
          : 'Buildings: none in active tiles'
    return {
      origin: this.origin,
      dropLabel: this.dropLabel,
      activeWays,
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
    }
  }

  /** Offline / failure path — one active demo tile at (0,0). */
  seedDemo(ways: StreetWay[]) {
    const key = makeTileKey(0, 0)
    this.tiles.clear()
    this.queue.length = 0
    this.cachedActiveWays = []
    this.cachedActiveKey = ''
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
      void this.deferBuildings(live, bbox, gen)
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
   * After center ways are painted: enqueue ACTIVE + PREFETCH rings quietly.
   * MAX_IN_FLIGHT=1 → serial neighbor fills, no 9-mesh apply burst.
   */
  fillNeighborsAfterDrop() {
    if (this.disposed || this.source === 'demo' || this.neighborsStarted) return
    this.neighborsStarted = true
    this.reconcile(0, 0, 0, 0, false)
  }

  /**
   * Poll with car local XZ. Optional yaw + speedMph drive look-ahead so the
   * next tiles activate *before* soft-clamp meets a continuing road.
   * Yaw 0 = world −Z (same as Car / GpsDash).
   */
  updateCar(x: number, z: number, yaw = 0, speedMph = 0) {
    if (this.disposed || this.source === 'demo') return
    const { tx, tz } = worldToTile(x, z)
    // Look-ahead point along heading; floor speed so even crawling still primes.
    const lookM = ACTIVATE_LOOKAHEAD_M
    const lx = x - Math.sin(yaw) * lookM
    const lz = z - Math.cos(yaw) * lookM
    const look = worldToTile(lx, lz)
    if (
      tx !== this.carTx ||
      tz !== this.carTz ||
      look.tx !== this.lookTx ||
      look.tz !== this.lookTz
    ) {
      this.carTx = tx
      this.carTz = tz
      this.lookTx = look.tx
      this.lookTz = look.tz
      this.reconcile(tx, tz, look.tx, look.tz, false)
    } else {
      // Still pump — urgent look-ahead fetches may be waiting on the gap timer.
      void speedMph
      this.pumpQueue()
    }
  }

  /**
   * Active = union of ACTIVE_RING around the car tile AND around the look-ahead
   * tile. Prefetch ring is relative to the car (unload behind still works).
   */
  private reconcile(
    cx: number,
    cz: number,
    lx: number,
    lz: number,
    bootstrap: boolean,
  ) {
    const wantActive = new Set<TileKey>()
    const wantPrefetch = new Set<TileKey>()

    const consider = (ox: number, oz: number, ring: number, into: Set<TileKey>) => {
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          into.add(makeTileKey(ox + dx, oz + dz))
        }
      }
    }
    consider(cx, cz, ACTIVE_RING, wantActive)
    consider(lx, lz, ACTIVE_RING, wantActive)
    consider(cx, cz, PREFETCH_RING, wantPrefetch)
    // Also prefetch around look-ahead so the outer shell is warm before arrival.
    consider(lx, lz, PREFETCH_RING, wantPrefetch)

    for (const key of wantPrefetch) {
      const [txs, tzs] = key.split(',')
      const txi = Number(txs)
      const tzi = Number(tzs)
      if (!this.tiles.has(key)) {
        this.tiles.set(key, {
          key,
          tx: txi,
          tz: tzi,
          status: 'empty',
          ways: [],
          buildings: [],
        })
        const urgent =
          bootstrap &&
          (chebyshev(cx, cz, txi, tzi) <= ACTIVE_RING ||
            chebyshev(lx, lz, txi, tzi) <= ACTIVE_RING)
        this.enqueue(key, urgent)
      }
    }

    let changed = false
    for (const tile of [...this.tiles.values()]) {
      const dCar = chebyshev(cx, cz, tile.tx, tile.tz)
      const dLook = chebyshev(lx, lz, tile.tx, tile.tz)
      // Keep if within prefetch of car OR look-ahead (don’t dump the path ahead).
      if (dCar > PREFETCH_RING && dLook > PREFETCH_RING) {
        this.tiles.delete(tile.key)
        changed = true
        continue
      }

      if (wantActive.has(tile.key)) {
        if (tile.status === 'cached') {
          tile.status = 'active'
          changed = true
        } else if (tile.status === 'empty' || tile.status === 'error') {
          // Urgent when on the look-ahead active ring — soft edge must not win.
          this.enqueue(tile.key, true)
        }
      } else if (tile.status === 'active') {
        // HARD GPS RULE: demote → disappears from Scene + GpsDash together.
        tile.status = 'cached'
        changed = true
      } else if (tile.status === 'empty' || tile.status === 'error') {
        if (wantPrefetch.has(tile.key)) this.enqueue(tile.key, false)
      }
    }

    if (changed) this.emit()
    this.pumpQueue()
  }

  private enqueue(key: TileKey, urgent: boolean) {
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
    if (urgent) this.queue.unshift(key)
    else this.queue.push(key)
  }

  private pumpQueue() {
    if (this.disposed || this.source === 'demo') return
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
        const dCar = chebyshev(this.carTx, this.carTz, live.tx, live.tz)
        const dLook = chebyshev(this.lookTx, this.lookTz, live.tx, live.tz)
        // Active if near the car OR the look-ahead point (velocity runway).
        live.status =
          dCar <= ACTIVE_RING || dLook <= ACTIVE_RING ? 'active' : 'cached'

        // Ways package first — asphalt / GPS can appear without buildings.
        this.emit()

        // Buildings deferred (second emit). Fail soft.
        await this.deferBuildings(live, bbox, gen)
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
 * active yet — fix with velocity-ahead activate (updateCar look-ahead), not a
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
