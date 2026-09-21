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
 * HARD GPS RULE (Joey lock — do not weaken):
 *   GpsDash strokes ONLY ways from tiles with status === 'active'.
 *   Prefetch may hit the network and sit in RAM, but must NEVER paint on the
 *   dial until the tile is active in Scene/Road. When a tile activates, 3D
 *   streets and GPS streets appear together — that IS the visual load cue.
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

/** Edge length of one street tile (meters). ~1 km keeps Overpass snappy. */
export const TILE_M = 1000

/** Chebyshev ring kept LIVE in Scene + GpsDash. ring 1 → 3×3 tiles. */
export const ACTIVE_RING = 1

/**
 * Prefetch ring (network / cache only). ring 2 → 5×5 footprint; the outer
 * shell may download but stays off GpsDash until promoted to active.
 */
export const PREFETCH_RING = 2

/** Cap concurrent Overpass tile fetches — public interpreters 429 easily. */
export const MAX_IN_FLIGHT = 2

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
export type StreamSnapshot = {
  origin: LatLng
  dropLabel: string
  activeWays: StreetWay[]
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
  private lastStartMs = 0
  private version = 0
  private disposed = false
  private listeners = new Set<() => void>()
  private carTx = 0
  private carTz = 0
  /** Bumped on dispose / Drop reset so late fetches are ignored. */
  private gen = 0

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

  dispose() {
    this.disposed = true
    this.gen += 1
    this.queue.length = 0
    this.tiles.clear()
    this.listeners.clear()
  }

  snapshot(): StreamSnapshot {
    const all = [...this.tiles.values()]
    const activeTiles = all.filter((t) => t.status === 'active')
    const loadingCount = all.filter((t) => t.status === 'loading').length
    const cachedCount = all.filter((t) => t.status === 'cached').length
    const activeWays = dedupeWays(activeTiles.flatMap((t) => t.ways))
    return {
      origin: this.origin,
      dropLabel: this.dropLabel,
      activeWays,
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
    this.source = 'demo'
    this.tiles.set(key, {
      key,
      tx: 0,
      tz: 0,
      status: 'active',
      ways,
    })
    this.emit()
  }

  /** Drop entry: treat car as tile (0,0); load 3×3 active + prefetch ring. */
  bootstrapAroundDrop() {
    this.carTx = 0
    this.carTz = 0
    this.reconcile(0, 0, true)
  }

  /** Poll from rAF/interval with car local XZ (meters relative to Drop). */
  updateCar(x: number, z: number) {
    if (this.disposed || this.source === 'demo') return
    const { tx, tz } = worldToTile(x, z)
    if (tx !== this.carTx || tz !== this.carTz) {
      this.carTx = tx
      this.carTz = tz
      this.reconcile(tx, tz, false)
    } else {
      this.pumpQueue()
    }
  }

  private reconcile(cx: number, cz: number, bootstrap: boolean) {
    const wantActive = new Set<TileKey>()
    const wantPrefetch = new Set<TileKey>()

    for (let dz = -PREFETCH_RING; dz <= PREFETCH_RING; dz++) {
      for (let dx = -PREFETCH_RING; dx <= PREFETCH_RING; dx++) {
        const tx = cx + dx
        const tz = cz + dz
        const key = makeTileKey(tx, tz)
        const d = chebyshev(cx, cz, tx, tz)
        if (d <= ACTIVE_RING) wantActive.add(key)
        wantPrefetch.add(key)

        if (!this.tiles.has(key)) {
          this.tiles.set(key, {
            key,
            tx,
            tz,
            status: 'empty',
            ways: [],
          })
          this.enqueue(key, bootstrap && d <= ACTIVE_RING)
        }
      }
    }

    let changed = false
    for (const tile of [...this.tiles.values()]) {
      const d = chebyshev(cx, cz, tile.tx, tile.tz)
      if (d > PREFETCH_RING) {
        this.tiles.delete(tile.key)
        changed = true
        continue
      }

      if (wantActive.has(tile.key)) {
        if (tile.status === 'cached') {
          tile.status = 'active'
          changed = true
        } else if (tile.status === 'empty' || tile.status === 'error') {
          this.enqueue(tile.key, bootstrap)
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

  private startFetch(tile: StreetTile) {
    tile.status = 'loading'
    this.inFlight += 1
    this.emit()

    const gen = this.gen
    const bbox = tileToBbox(tile.tx, tile.tz, this.origin)

    void fetchWaysInBbox(bbox.south, bbox.west, bbox.north, bbox.east)
      .then((ways) => {
        if (this.disposed || gen !== this.gen) return
        const live = this.tiles.get(tile.key)
        if (!live) return
        live.ways = ways
        const d = chebyshev(this.carTx, this.carTz, live.tx, live.tz)
        // Only active tiles feed Scene + GpsDash (together).
        live.status = d <= ACTIVE_RING ? 'active' : 'cached'
        this.emit()
      })
      .catch((err: unknown) => {
        if (this.disposed || gen !== this.gen) return
        const live = this.tiles.get(tile.key)
        if (!live) return
        live.status = 'error'
        live.error = err instanceof Error ? err.message : 'tile fetch failed'
        live.ways = []
        this.emit()
      })
      .finally(() => {
        this.inFlight = Math.max(0, this.inFlight - 1)
        this.pumpQueue()
      })
  }
}

/**
 * Soft void edge: if the car leaves the union of active tiles, clamp back
 * into the AABB. Replaces the hard ~200 ft road-corridor walls while streaming.
 */
export function softClampToLoadedAabb(
  x: number,
  z: number,
  aabb: LoadedAabb | null,
  padM = 24,
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
    `at lat ${originLat.toFixed(3)} (active ring ${ACTIVE_RING} → ${n} tiles)`
  )
}

function waitForMinActive(
  streamer: StreetTileStreamer,
  min: number,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    const t0 = performance.now()
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      unsub()
      window.clearInterval(id)
      resolve()
    }
    const unsub = streamer.subscribe(() => {
      const s = streamer.snapshot()
      if (s.activeTileCount >= min || s.source === 'demo') finish()
    })
    const id = window.setInterval(() => {
      const s = streamer.snapshot()
      if (
        s.activeTileCount >= min ||
        s.source === 'demo' ||
        performance.now() - t0 > timeoutMs
      ) {
        finish()
      }
    }, 100)
  })
}

/**
 * Drop entry: geocode → streamer → wait for at least the Drop tile.
 * Failure → demo world seeded into tile (0,0).
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
    streamer.bootstrapAroundDrop()
    await waitForMinActive(streamer, 1, 12_000)
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
