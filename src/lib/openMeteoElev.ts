/**
 * Open-Meteo elevation grid sampler — reliable hills when Terrarium tiles fail.
 *
 * WHY a second elevation path?
 *   Terrarium PNG tiles need the Vite `/api/terrarium` proxy (S3 has no CORS).
 *   Joey keeps seeing flat / scary “could not sample” when that path hiccups.
 *   Open-Meteo’s elevation API is free, no key, CORS `*`, and returns meters
 *   MSL for a list of lat/lng points. Prefer working hills over perfect tiles.
 *
 * API (batch ≤ 100 coords per request):
 *   GET https://api.open-meteo.com/v1/elevation?latitude=a,b&longitude=c,d
 *   → { elevation: [meters, …] }
 *
 * We sample a coarse grid across the street bbox, then bilinear-upsample into
 * the same HeightGrid shape Terrarium builds (relative-to-spawn + 1× fidelity).
 *
 * Dev can hit `/api/open-meteo/...` (Vite proxy) or the public URL directly.
 */

import { localToLatLng } from './geo'
import {
  flatHeightGrid,
  VERTICAL_EXAGGERATION,
  FAR_TERRAIN_RADIUS_M,
  type FarTerrainFetchOpts,
  type HeightGrid,
  type TerrainFetchOpts,
} from './terrarium'

/** Open-Meteo hard-caps latitude/longitude arrays at 100 points. */
const MAX_COORDS = 100
/** Coarse sample resolution (10×10 = 100). Upsampled later. */
const SAMPLE_N = 10
/** Match Terrarium display grid so Ground / Road / Car share one sampler. */
const GRID_RES = 96
/** Shared with terrarium.ts — VERTICAL_EXAGGERATION = 1 (fidelity). */

function elevUrl(lats: number[], lngs: number[]): string[] {
  const qs = `latitude=${lats.map((v) => v.toFixed(5)).join(',')}&longitude=${lngs.map((v) => v.toFixed(5)).join(',')}`
  // Prefer Vite proxy in dev; public URL works in most browsers (CORS *).
  return [`/api/open-meteo/v1/elevation?${qs}`, `https://api.open-meteo.com/v1/elevation?${qs}`]
}

async function fetchElevBatch(lats: number[], lngs: number[]): Promise<number[]> {
  if (lats.length !== lngs.length) throw new Error('lat/lng length mismatch')
  if (lats.length === 0) return []
  if (lats.length > MAX_COORDS) {
    throw new Error(`Open-Meteo elev batch ${lats.length} > ${MAX_COORDS}`)
  }

  let lastErr: Error | null = null
  for (const url of elevUrl(lats, lngs)) {
    try {
      const res = await fetch(url)
      if (!res.ok) {
        lastErr = new Error(`Open-Meteo elev HTTP ${res.status}`)
        continue
      }
      const data = (await res.json()) as { elevation?: number[]; error?: boolean; reason?: string }
      if (data.error || !Array.isArray(data.elevation)) {
        lastErr = new Error(data.reason ?? 'Open-Meteo elev payload missing')
        continue
      }
      if (data.elevation.length !== lats.length) {
        lastErr = new Error(
          `Open-Meteo elev count ${data.elevation.length} ≠ ${lats.length}`,
        )
        continue
      }
      return data.elevation.map((e) => Number(e))
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
    }
  }
  throw lastErr ?? new Error('Open-Meteo elev unreachable')
}

/** Bilinear sample a coarse SAMPLE_N×SAMPLE_N MSL grid. */
function sampleCoarse(
  msl: Float32Array,
  n: number,
  u: number,
  v: number,
): number {
  const c0 = Math.max(0, Math.min(n - 2, Math.floor(u)))
  const r0 = Math.max(0, Math.min(n - 2, Math.floor(v)))
  const tx = Math.max(0, Math.min(1, u - c0))
  const tz = Math.max(0, Math.min(1, v - r0))
  const h00 = msl[r0 * n + c0]
  const h10 = msl[r0 * n + c0 + 1]
  const h01 = msl[(r0 + 1) * n + c0]
  const h11 = msl[(r0 + 1) * n + c0 + 1]
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz
}

/**
 * Build a HeightGrid from Open-Meteo elevation samples across the street bbox.
 * Returns null on hard failure so the caller can quiet-flat without scary HUD.
 */
export async function fetchOpenMeteoHeightGrid(
  opts: TerrainFetchOpts,
): Promise<HeightGrid | null> {
  const { origin, minX, maxX, minZ, maxZ, spawnX, spawnZ } = opts
  // lockedSpawnElevMsl read below when present

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
  const originX = centerX - size * 0.5
  const originZ = centerZ - size * 0.5

  try {
    // Coarse lat/lng grid covering the padded playfield.
    const n = SAMPLE_N
    const lats: number[] = []
    const lngs: number[] = []
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const x = originX + (c / (n - 1)) * size
        const z = originZ + (r / (n - 1)) * size
        const ll = localToLatLng(x, z, origin)
        lats.push(ll.lat)
        lngs.push(ll.lng)
      }
    }

    const elevList = await fetchElevBatch(lats, lngs)
    const coarse = new Float32Array(elevList)
    let finite = 0
    for (const e of elevList) if (Number.isFinite(e)) finite++
    if (finite < 4) {
      console.warn('[open-meteo elev] too few finite samples', finite)
      return null
    }

    // Drop-locked MSL for sliding windows; else bilinear / coarse mean.
    let spawnElevMsl = opts.lockedSpawnElevMsl
    if (spawnElevMsl == null || !Number.isFinite(spawnElevMsl)) {
      const su = ((spawnX - originX) / size) * (n - 1)
      const sv = ((spawnZ - originZ) / size) * (n - 1)
      spawnElevMsl = sampleCoarse(coarse, n, su, sv)
      if (!Number.isFinite(spawnElevMsl)) {
        let sum = 0
        let count = 0
        for (const e of elevList) {
          if (Number.isFinite(e)) {
            sum += e
            count++
          }
        }
        spawnElevMsl = count > 0 ? sum / count : 0
      }
    }

    const cols = GRID_RES
    const rows = GRID_RES
    const cellSize = size / (cols - 1)
    const heights = new Float32Array(cols * rows)
    let minRel = Infinity
    let maxRel = -Infinity

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const u = (c / (cols - 1)) * (n - 1)
        const v = (r / (rows - 1)) * (n - 1)
        const msl = sampleCoarse(coarse, n, u, v)
        const relRaw = Number.isFinite(msl) ? msl - spawnElevMsl : 0
        const rel = relRaw * VERTICAL_EXAGGERATION
        heights[r * cols + c] = rel
        if (rel < minRel) minRel = rel
        if (rel > maxRel) maxRel = rel
      }
    }
    if (!Number.isFinite(minRel)) {
      minRel = 0
      maxRel = 0
    }

    const relief = maxRel - minRel
    const message =
      `Open-Meteo elev · ${n}×${n} samples` +
      ` · spawn ${spawnElevMsl.toFixed(0)} m MSL` +
      ` · relief ${relief.toFixed(0)} m (${VERTICAL_EXAGGERATION}×)`

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
      source: 'open-meteo',
      message,
    }
  } catch (err) {
    console.warn('[open-meteo elev] failed', err)
    return null
  }
}

/** Quiet flat — no “could not sample” scare text. Playable desert slab. */
export function quietFlatGrid(
  opts: Pick<TerrainFetchOpts, 'minX' | 'maxX' | 'minZ' | 'maxZ'>,
): HeightGrid {
  const pad = 40
  const oMinX = opts.minX - pad
  const oMaxX = opts.maxX + pad
  const oMinZ = opts.minZ - pad
  const oMaxZ = opts.maxZ + pad
  const size = Math.max(50, oMaxX - oMinX, oMaxZ - oMinZ)
  const centerX = (oMinX + oMaxX) * 0.5
  const centerZ = (oMinZ + oMaxZ) * 0.5
  return flatHeightGrid(centerX, centerZ, size, 'Flat ground')
}


/**
 * Coarse Open-Meteo far ring when Terrarium far tiles fail (CORS / proxy).
 * One ≤100-point batch over ±radiusM, bilinear-upsampled to FAR_GRID_RES.
 * Visual skyline only — Scene never puts colliders on this mesh.
 */
const FAR_SAMPLE_N = 10
const FAR_UPSAMPLE = 48

export async function fetchOpenMeteoFarHeightGrid(
  opts: FarTerrainFetchOpts,
): Promise<HeightGrid | null> {
  const {
    origin,
    spawnX,
    spawnZ,
    spawnElevMsl,
    radiusM = FAR_TERRAIN_RADIUS_M,
  } = opts

  const size = Math.max(500, radiusM * 2)
  const originX = spawnX - size * 0.5
  const originZ = spawnZ - size * 0.5

  try {
    const n = FAR_SAMPLE_N
    const lats: number[] = []
    const lngs: number[] = []
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const x = originX + (c / (n - 1)) * size
        const z = originZ + (r / (n - 1)) * size
        const ll = localToLatLng(x, z, origin)
        lats.push(ll.lat)
        lngs.push(ll.lng)
      }
    }

    const elevList = await fetchElevBatch(lats, lngs)
    const coarse = new Float32Array(elevList)
    let finite = 0
    for (const e of elevList) if (Number.isFinite(e)) finite++
    if (finite < 4) {
      console.warn('[open-meteo far] too few finite samples', finite)
      return null
    }

    const cols = FAR_UPSAMPLE
    const rows = FAR_UPSAMPLE
    const cellSize = size / (cols - 1)
    const heights = new Float32Array(cols * rows)
    let minRel = Infinity
    let maxRel = -Infinity

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const u = (c / (cols - 1)) * (n - 1)
        const v = (r / (rows - 1)) * (n - 1)
        const msl = sampleCoarse(coarse, n, u, v)
        const relRaw = Number.isFinite(msl) ? msl - spawnElevMsl : 0
        const rel = relRaw * VERTICAL_EXAGGERATION
        heights[r * cols + c] = rel
        if (rel < minRel) minRel = rel
        if (rel > maxRel) maxRel = rel
      }
    }
    if (!Number.isFinite(minRel)) {
      minRel = 0
      maxRel = 0
    }

    const relief = maxRel - minRel
    const radiusKm = (size * 0.5) / 1000
    const message =
      `Far terrain: ${radiusKm.toFixed(0)} km · Open-Meteo ${n}×${n}` +
      ` · relief ${relief.toFixed(0)} m (${VERTICAL_EXAGGERATION}×)`

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
      source: 'open-meteo',
      message,
    }
  } catch (err) {
    console.warn('[open-meteo far] failed', err)
    return null
  }
}
