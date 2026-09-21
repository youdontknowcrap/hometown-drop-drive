/**
 * OSM building footprints → simple extruded boxes (issue #5 unparked).
 *
 * LEARNING NOTE:
 *   Overpass returns building ways with lat/lng rings. We do NOT import
 *   game-city assets. Each footprint becomes an axis-aligned box in local
 *   XZ (min/max of vertices) extruded to a guessed height — solid collider
 *   so Joey’s car actually bumps into big boxes.
 *
 * Performance caps:
 *   - Query only near the loaded street bbox (same Drop radius family).
 *   - Keep the largest N footprints by area (skip sheds / tiny tags).
 *   - Simplify to AABB (no CSG, no interiors, no LODs).
 */

import { latLngToLocal, metersPerDegree, type LatLng } from './geo'
import { overpassInterpreter } from './osmApi'

/** Soft cap — neighborhood scenery, not a full city download. */
export const MAX_BUILDINGS = 150
/** Ignore footprints smaller than this (m²) — sheds / porch noise. */
const MIN_AREA_M2 = 40
/** Default eaves height when OSM has no `height` / `building:levels`. */
const DEFAULT_HEIGHT_M = 6
const MAX_HEIGHT_M = 40
const LEVEL_HEIGHT_M = 3.0

export type BuildingBox = {
  /** Local-space center XZ. */
  x: number
  z: number
  /** Full width (X) and depth (Z) in meters. */
  width: number
  depth: number
  /** Extrusion height in meters. */
  height: number
  /** Optional OSM building tag for teaching HUD. */
  building: string
}

export type BuildingWorld = {
  boxes: BuildingBox[]
  source: 'osm' | 'none'
  message: string
}

type OverpassBuilding = {
  type: string
  tags?: {
    building?: string
    height?: string
    'building:levels'?: string
    levels?: string
  }
  geometry?: Array<{ lat: number; lon: number }>
}

function bboxAround(origin: LatLng, radiusM: number) {
  const { mPerDegLat, mPerDegLng } = metersPerDegree(origin.lat)
  return {
    south: origin.lat - radiusM / mPerDegLat,
    west: origin.lng - radiusM / mPerDegLng,
    north: origin.lat + radiusM / mPerDegLat,
    east: origin.lng + radiusM / mPerDegLng,
  }
}

/** Parse OSM height tags → meters (best-effort). */
function heightFromTags(tags: OverpassBuilding['tags']): number {
  if (!tags) return DEFAULT_HEIGHT_M
  if (tags.height) {
    const m = parseFloat(tags.height)
    if (Number.isFinite(m) && m > 1) return Math.min(MAX_HEIGHT_M, m)
  }
  const levels = parseFloat(tags['building:levels'] ?? tags.levels ?? '')
  if (Number.isFinite(levels) && levels > 0) {
    return Math.min(MAX_HEIGHT_M, levels * LEVEL_HEIGHT_M)
  }
  // Soft heuristic by building class.
  const b = (tags.building ?? '').toLowerCase()
  if (b === 'garage' || b === 'shed' || b === 'carport') return 3
  if (b === 'apartments' || b === 'commercial' || b === 'retail') return 10
  if (b === 'industrial' || b === 'warehouse') return 9
  if (b === 'church' || b === 'cathedral') return 14
  return DEFAULT_HEIGHT_M
}

/**
 * Footprint ring → local AABB box. Returns null if degenerate / too small.
 */
function ringToBox(
  ring: Array<{ lat: number; lon: number }>,
  origin: LatLng,
  tags: OverpassBuilding['tags'],
): (BuildingBox & { area: number }) | null {
  if (ring.length < 3) return null
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const p of ring) {
    const { x, z } = latLngToLocal({ lat: p.lat, lng: p.lon }, origin)
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minZ = Math.min(minZ, z)
    maxZ = Math.max(maxZ, z)
  }
  const width = maxX - minX
  const depth = maxZ - minZ
  if (!(width > 1 && depth > 1)) return null
  const area = width * depth
  if (area < MIN_AREA_M2) return null
  return {
    x: (minX + maxX) * 0.5,
    z: (minZ + maxZ) * 0.5,
    width,
    depth,
    height: heightFromTags(tags),
    building: tags?.building ?? 'yes',
    area,
  }
}

/**
 * Fetch building footprints near Drop and return capped AABB boxes.
 * On failure returns empty list (roads still driveable — scenery optional).
 */
export async function fetchBuildings(
  origin: LatLng,
  radiusM = 900,
): Promise<BuildingWorld> {
  const b = bboxAround(origin, radiusM)
  // Only ways with building=* and geometry — relations/multipolygons skipped
  // on purpose (simpler, fewer holes, better for a learning AABB pass).
  const query = `[out:json][timeout:25];
(
  way["building"](${b.south},${b.west},${b.north},${b.east});
);
out tags geom;`

  try {
    const res = await overpassInterpreter(query)
    const data = (await res.json()) as { elements?: OverpassBuilding[] }
    const scored: Array<BuildingBox & { area: number }> = []

    for (const el of data.elements ?? []) {
      if (!el.geometry || el.geometry.length < 3) continue
      // Skip explicit non-buildings if tagged oddly.
      const tag = (el.tags?.building ?? '').toLowerCase()
      if (tag === 'no') continue
      const box = ringToBox(el.geometry, origin, el.tags)
      if (box) scored.push(box)
    }

    // Keep the biggest footprints first — malls / schools over doghouses.
    scored.sort((a, b) => b.area - a.area)
    const boxes: BuildingBox[] = scored.slice(0, MAX_BUILDINGS).map((b) => ({
      x: b.x,
      z: b.z,
      width: b.width,
      depth: b.depth,
      height: b.height,
      building: b.building,
    }))

    const msg =
      boxes.length > 0
        ? `Buildings: ${boxes.length}/${scored.length} boxes (capped ${MAX_BUILDINGS})`
        : 'Buildings: none in bbox'
    console.info('[buildings]', { kept: boxes.length, found: scored.length })
    return { boxes, source: boxes.length ? 'osm' : 'none', message: msg }
  } catch (err) {
    const why = err instanceof Error ? err.message : 'unknown'
    console.warn('[buildings] fetch failed', why)
    return {
      boxes: [],
      source: 'none',
      message: `Buildings skipped (${why})`,
    }
  }
}
