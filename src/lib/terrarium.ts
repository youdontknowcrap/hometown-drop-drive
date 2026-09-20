/**
 * SRTM elevation via Mapzen Terrarium PNG tiles (AWS Open Data).
 *
 * WHY this instead of military DTED files?
 *   DTED is a download / parse / reproject / host pipeline — awkward in a
 *   browser toy. Terrarium tiles are the same elevation *family* (SRTM +
 *   friends) already cut into Web-Mercator PNGs anyone can fetch. Decode
 *   each pixel → meters above sea level. That is the web stand-in for DTED
 *   here, and it works US-wide (CONUS ~30 m), so Ridgecrest → LA → Vegas
 *   hills are already in the same free tile set for a later cross-country
 *   pass. Road *streaming* (issue #11) is separate — elevation tiles follow
 *   lat/lng today; OSM streets still load as a ~3 km Overpass box.
 *
 * Tile URL (via Vite proxy in dev — S3 has no CORS headers):
 *   /api/terrarium/{z}/{x}/{y}.png
 *   → https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
 *
 * Decode (Mapzen Terrarium format):
 *   elev_m = (R * 256 + G + B / 256) - 32768
 *   R = "256s" place, G = ones, B = fraction (1/256 m steps).
 *
 * Heights stored in the grid are RELATIVE to spawn elevation so the car
 * starts near y≈0 and we don't launch the whole playfield into the sky.
 * Absolute MSL is kept only for teaching / HUD sanity.
 */

import { localToLatLng, type LatLng } from './geo'

/** Dev proxy path — see vite.config.ts. Production without proxy → flat fallback. */
const TERRARIUM_URL = (z: number, x: number, y: number) =>
  `/api/terrarium/${z}/${x}/${y}.png`

/** Terrarium PNG edge length. */
const TILE_SIZE = 256

/**
 * Zoom for a ~3 km neighborhood. z=12 ≈ 9.5 km/tile at equator;
 * a few tiles cover the Drop bbox without a huge download.
 */
const DEFAULT_ZOOM = 12

/** Soft caps so a wild bbox can't fetch hundreds of tiles. */
const MAX_TILES = 16
const GRID_RES = 96

export type HeightGrid = {
  /** Local-X of the grid's -X/−Z corner (meters). */
  originX: number
  originZ: number
  /** Cell size in meters (same along X and Z). */
  cellSize: number
  /** Number of samples along X (columns). */
  cols: number
  /** Number of samples along Z (rows). */
  rows: number
  /**
   * Row-major heights[row * cols + col] in meters RELATIVE to spawnElevMsl.
   * Flat fallback = all zeros.
   */
  heights: Float32Array
  /** Absolute MSL (m) under the spawn point — teaching / sanity only. */
  spawnElevMsl: number
  /** Min/max relative height — useful for wall height and HUD. */
  minRel: number
  maxRel: number
  source: 'terrarium' | 'flat'
  message: string
}

/** Bilinear sample of relative height at local (x, z). Outside → nearest edge. */
export function sampleHeight(grid: HeightGrid, x: number, z: number): number {
  const { originX, originZ, cellSize, cols, rows, heights } = grid
  if (cols < 2 || rows < 2 || cellSize <= 0) return 0

  // Continuous grid coords (col along X, row along Z).
  const u = (x - originX) / cellSize
  const v = (z - originZ) / cellSize
  const c0 = Math.max(0, Math.min(cols - 2, Math.floor(u)))
  const r0 = Math.max(0, Math.min(rows - 2, Math.floor(v)))
  const tx = Math.max(0, Math.min(1, u - c0))
  const tz = Math.max(0, Math.min(1, v - r0))

  const h00 = heights[r0 * cols + c0]
  const h10 = heights[r0 * cols + c0 + 1]
  const h01 = heights[(r0 + 1) * cols + c0]
  const h11 = heights[(r0 + 1) * cols + c0 + 1]

  // Bilinear blend — smooth enough for arcade car follow.
  const hx0 = h00 * (1 - tx) + h10 * tx
  const hx1 = h01 * (1 - tx) + h11 * tx
  return hx0 * (1 - tz) + hx1 * tz
}

/** Empty flat grid covering a square playfield (offline / CORS failure). */
export function flatHeightGrid(
  centerX: number,
  centerZ: number,
  size: number,
  message = 'Flat ground (no elevation tiles).',
): HeightGrid {
  const half = size * 0.5
  const cols = 2
  const rows = 2
  return {
    originX: centerX - half,
    originZ: centerZ - half,
    cellSize: size,
    cols,
    rows,
    heights: new Float32Array(cols * rows),
    spawnElevMsl: 0,
    minRel: 0,
    maxRel: 0,
    source: 'flat',
    message,
  }
}

/** Terrarium decode — keep this formula next to the fetch so learners see both. */
export function decodeTerrariumRgb(r: number, g: number, b: number): number {
  // elev_m = (R * 256 + G + B / 256) - 32768
  return r * 256 + g + b / 256 - 32768
}

function clampTile(v: number, z: number): number {
  const n = 2 ** z
  return Math.max(0, Math.min(n - 1, v))
}

/** Lat/lng → XYZ tile indices (Web Mercator, same as OSM slippy map). */
export function latLngToTile(
  lat: number,
  lng: number,
  z: number,
): { x: number; y: number } {
  const n = 2 ** z
  const x = Math.floor(((lng + 180) / 360) * n)
  const latRad = (lat * Math.PI) / 180
  const y = Math.floor(
    ((1 -
      Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) /
      2) *
      n,
  )
  return { x: clampTile(x, z), y: clampTile(y, z) }
}


type TileElev = {
  z: number
  x: number
  y: number
  /** Row-major TILE_SIZE² elevations (MSL meters). */
  elev: Float32Array
}

async function fetchTile(z: number, x: number, y: number): Promise<TileElev> {
  const res = await fetch(TERRARIUM_URL(z, x, y))
  if (!res.ok) {
    throw new Error(`Terrarium ${z}/${x}/${y} → HTTP ${res.status}`)
  }
  const blob = await res.blob()
  const bmp = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bmp.width
  canvas.height = bmp.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('2D canvas unavailable for Terrarium decode')
  ctx.drawImage(bmp, 0, 0)
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height)
  bmp.close()

  const elev = new Float32Array(bmp.width * bmp.height)
  for (let i = 0; i < elev.length; i++) {
    const o = i * 4
    elev[i] = decodeTerrariumRgb(img.data[o], img.data[o + 1], img.data[o + 2])
  }
  return { z, x, y, elev }
}

/** Nearest-pixel elev from a fetched tile (tile-local px/py). */
function sampleTile(tile: TileElev, px: number, py: number): number {
  const ix = Math.max(0, Math.min(TILE_SIZE - 1, Math.round(px)))
  const iy = Math.max(0, Math.min(TILE_SIZE - 1, Math.round(py)))
  return tile.elev[iy * TILE_SIZE + ix]
}

/**
 * Look up MSL at a lat/lng using the tile set we already fetched.
 * Converts lat/lng → tile fractional pixel, then nearest sample.
 */
function elevAtLatLng(tiles: Map<string, TileElev>, lat: number, lng: number, z: number): number {
  const n = 2 ** z
  const fx = ((lng + 180) / 360) * n
  const latRad = (lat * Math.PI) / 180
  const fy =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  const tx = Math.floor(fx)
  const ty = Math.floor(fy)
  const key = `${z}/${tx}/${ty}`
  const tile = tiles.get(key)
  if (!tile) return Number.NaN
  const px = (fx - tx) * TILE_SIZE
  const py = (fy - ty) * TILE_SIZE
  return sampleTile(tile, px, py)
}

export type TerrainFetchOpts = {
  origin: LatLng
  /** Local-space AABB of the loaded street network (meters). */
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  /** Local XZ where the car spawns — height grid is relative to elev here. */
  spawnX: number
  spawnZ: number
  zoom?: number
}

/**
 * Fetch Terrarium tiles covering the street bbox and build a local height grid.
 * On any failure returns flatHeightGrid (playable offline / without proxy).
 */
export async function fetchHeightGrid(opts: TerrainFetchOpts): Promise<HeightGrid> {
  const {
    origin,
    minX,
    maxX,
    minZ,
    maxZ,
    spawnX,
    spawnZ,
    zoom = DEFAULT_ZOOM,
  } = opts

  const pad = 40
  const oMinX = minX - pad
  const oMaxX = maxX + pad
  const oMinZ = minZ - pad
  const oMaxZ = maxZ + pad
  const sizeX = Math.max(50, oMaxX - oMinX)
  const sizeZ = Math.max(50, oMaxZ - oMinZ)
  const size = Math.max(sizeX, sizeZ)
  const centerX = (oMinX + oMaxX) * 0.5
  const centerZ = (oMinZ + oMaxZ) * 0.5

  try {
    // Corners of the padded bbox → lat/lng → tile index range.
    const corners: LatLng[] = [
      localToLatLng(oMinX, oMinZ, origin),
      localToLatLng(oMaxX, oMinZ, origin),
      localToLatLng(oMinX, oMaxZ, origin),
      localToLatLng(oMaxX, oMaxZ, origin),
    ]
    let tMinX = Infinity
    let tMaxX = -Infinity
    let tMinY = Infinity
    let tMaxY = -Infinity
    for (const c of corners) {
      const t = latLngToTile(c.lat, c.lng, zoom)
      tMinX = Math.min(tMinX, t.x)
      tMaxX = Math.max(tMaxX, t.x)
      tMinY = Math.min(tMinY, t.y)
      tMaxY = Math.max(tMaxY, t.y)
    }

    const tileCount =
      (tMaxX - tMinX + 1) * (tMaxY - tMinY + 1)
    if (tileCount > MAX_TILES) {
      return flatHeightGrid(
        centerX,
        centerZ,
        size,
        `Flat fallback — bbox needs ${tileCount} tiles (cap ${MAX_TILES}).`,
      )
    }

    const tiles = new Map<string, TileElev>()
    const jobs: Promise<void>[] = []
    for (let ty = tMinY; ty <= tMaxY; ty++) {
      for (let tx = tMinX; tx <= tMaxX; tx++) {
        jobs.push(
          fetchTile(zoom, tx, ty).then((tile) => {
            tiles.set(`${zoom}/${tx}/${ty}`, tile)
          }),
        )
      }
    }
    await Promise.all(jobs)

    const spawnLl = localToLatLng(spawnX, spawnZ, origin)
    const spawnElevMsl = elevAtLatLng(tiles, spawnLl.lat, spawnLl.lng, zoom)
    if (!Number.isFinite(spawnElevMsl)) {
      return flatHeightGrid(
        centerX,
        centerZ,
        size,
        'Flat fallback — could not sample spawn elevation.',
      )
    }

    // Build a regular local grid; sample each cell from the tile set.
    const cols = GRID_RES
    const rows = GRID_RES
    const cellSize = size / (cols - 1)
    const originX = centerX - size * 0.5
    const originZ = centerZ - size * 0.5
    const heights = new Float32Array(cols * rows)
    let minRel = Infinity
    let maxRel = -Infinity

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = originX + c * cellSize
        const z = originZ + r * cellSize
        const ll = localToLatLng(x, z, origin)
        const msl = elevAtLatLng(tiles, ll.lat, ll.lng, zoom)
        const rel = Number.isFinite(msl) ? msl - spawnElevMsl : 0
        heights[r * cols + c] = rel
        if (rel < minRel) minRel = rel
        if (rel > maxRel) maxRel = rel
      }
    }

    if (!Number.isFinite(minRel)) {
      minRel = 0
      maxRel = 0
    }

    return {
      originX,
      originZ,
      cellSize,
      cols,
      rows,
      heights,
      spawnElevMsl,
      minRel,
      maxRel,
      source: 'terrarium',
      message: `Terrarium/SRTM z${zoom} · spawn ${spawnElevMsl.toFixed(0)} m MSL · relief ${(maxRel - minRel).toFixed(0)} m`,
    }
  } catch (err) {
    const why = err instanceof Error ? err.message : 'unknown error'
    return flatHeightGrid(
      centerX,
      centerZ,
      size,
      `Flat fallback — ${why}`,
    )
  }
}

/** Convenience: AABB from local ways (same space as roadMesh). */
export function waysBounds(ways: Array<Array<[number, number, number]>>): {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
} {
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const way of ways) {
    for (const p of way) {
      minX = Math.min(minX, p[0])
      maxX = Math.max(maxX, p[0])
      minZ = Math.min(minZ, p[2])
      maxZ = Math.max(maxZ, p[2])
    }
  }
  if (!Number.isFinite(minX)) {
    return { minX: -100, maxX: 100, minZ: -100, maxZ: 100 }
  }
  return { minX, maxX, minZ, maxZ }
}

