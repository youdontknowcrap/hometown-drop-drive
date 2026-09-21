/**
 * OSM building footprints → simple extruded boxes (issue #5 unparked).
 *
 * LEARNING NOTE:
 *   Overpass returns building ways with lat/lng rings. We do NOT import
 *   game-city assets. Each footprint becomes an axis-aligned box in local
 *   XZ (min/max of vertices) extruded to a guessed height — solid collider
 *   so Joey’s car actually bumps into big boxes.
 *
 * WHY stratified keep (not "largest N")?
 *   Sorting ALL footprints by area and slicing MAX_BUILDINGS preferred big
 *   warehouses / malls and DROPPED houses. HUD showed 150/1732 kept — plenty
 *   of OSM buildings existed; selection was biased. Ridgecrest neighborhoods
 *   looked empty from the driver’s seat.
 *
 *   Fix: tag residential, reserve ~70% of the budget for houses nearest Drop,
 *   fill the rest with largest non-residential landmarks. Still AABB boxes —
 *   no ripped city assets.
 *
 * Performance caps:
 *   - Query only near the loaded street bbox (same Drop radius family).
 *   - Cap total boxes (AABB + optional colliders).
 *   - Solid CuboidColliders only for near / large boxes; far small houses
 *     are visual-only so Rapier stays cheap (see Buildings.tsx).
 *
 * "Stuck like a fly" (arcade + AABB):
 *   Car.tsx authors setLinvel every frame. OSM footprints become axis-aligned
 *   boxes — houses near streets often OVERLAP the roadway. Rapier then blocks
 *   translation while yaw still works → spin-in-place flypaper.
 *   Mitigations (Buildings.tsx + clearRoadOverlappingSolidColliders):
 *     1) Inset collider half-extents vs visual (~COLLIDER_INSET_M).
 *     2) Skip solidCollider when the AABB kisses a road ribbon.
 *     3) Car escape hatch if still wedged (authored speed, no displacement).
 */

import { latLngToLocal, metersPerDegree, type LatLng } from './geo'
import { overpassInterpreter } from './osmApi'
import type { RoadSurfaceWay } from './roadSurface'

/** Soft cap — active-tile union; raised so houses survive the budget. */
export const MAX_BUILDINGS = 450

/** Soft cap per ~1 km street tile before union merge. */
export const MAX_BUILDINGS_PER_TILE = 80

/**
 * Share of MAX_BUILDINGS reserved for residential / house-candidates.
 * Remaining slots go to largest non-residential (landmarks / warehouses).
 */
const RESIDENTIAL_BUDGET_FRAC = 0.7

/** Default min footprint (m²) — sheds / porch noise for commercial tags. */
const MIN_AREA_M2 = 40
/** Lower bar for tagged houses so small Ridgecrest homes aren’t culled. */
const MIN_AREA_RESIDENTIAL_M2 = 28

/**
 * Generic `building=yes` / `building=building` under this footprint size are
 * treated as house-candidates (OSM often leaves houses untyped).
 */
const GENERIC_HOUSE_MAX_AREA_M2 = 400

/** Default eaves when OSM has no height / levels — commercial / unknown. */
const DEFAULT_HEIGHT_M = 6
/** Houses read as 1–1.5 stories, not warehouse boxes. */
const HOUSE_HEIGHT_M = 4.75
const MAX_HEIGHT_M = 40
const LEVEL_HEIGHT_M = 3.0

/**
 * Solid collider budget (teaching): every visual box is free; Rapier contacts
 * are not. Prefer nearest N + large footprints so Joey bumps into what he
 * drives past, while far tiny houses stay mesh-only.
 */
export const SOLID_COLLIDER_NEAREST = 140
export const SOLID_COLLIDER_MIN_AREA_M2 = 180

/**
 * Shrink CuboidCollider vs the visual mesh (meters per half-axis).
 * Visual stays full footprint; physics pulls back from the curb so AABB
 * houses that spill onto asphalt don't eat the driveable lane.
 */
export const COLLIDER_INSET_M = 0.85

/**
 * Extra meters beyond roadSurface halfWidth when deciding "this box sits on
 * asphalt." ≈ car half-width + curb slack — prefer clearing a sticky collider
 * over leaving flypaper on the ribbon.
 */
export const BUILDING_ROAD_CLEAR_MARGIN_M = 1.6

/** Explicit residential / house tags (OSM building=* vocabulary). */
const RESIDENTIAL_TAGS = new Set([
  'house',
  'detached',
  'residential',
  'apartments',
  'semidetached_house',
  'terrace',
  'bungalow',
  'static_caravan',
  'cabin',
  'dormitory',
  'houseboat',
])

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
  /** True when tagged (or inferred) residential / house-candidate. */
  residential: boolean
  /**
   * When false, Buildings.tsx skips CuboidCollider (visual-only).
   * Keeps physics cheap for far small houses.
   */
  solidCollider: boolean
}

export type BuildingWorld = {
  boxes: BuildingBox[]
  source: 'osm' | 'none'
  message: string
  /** Raw Overpass count before area / cap filters (for HUD "of N"). */
  found: number
  residentialKept: number
  otherKept: number
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

type ScoredBox = BuildingBox & {
  area: number
  dist2: number
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

/** Is this footprint a house / residential candidate? */
export function isResidentialTag(tag: string, areaM2: number): boolean {
  const b = tag.toLowerCase()
  if (RESIDENTIAL_TAGS.has(b)) return true
  // Untyped small footprints are almost always houses in US suburbs.
  if ((b === 'yes' || b === 'building') && areaM2 < GENERIC_HOUSE_MAX_AREA_M2) {
    return true
  }
  return false
}

/** Parse OSM height tags → meters (best-effort). */
function heightFromTags(tags: OverpassBuilding['tags'], residential: boolean): number {
  if (!tags) return residential ? HOUSE_HEIGHT_M : DEFAULT_HEIGHT_M
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
  if (b === 'apartments') return 10
  if (b === 'commercial' || b === 'retail') return 10
  if (b === 'industrial' || b === 'warehouse') return 9
  if (b === 'church' || b === 'cathedral') return 14
  if (RESIDENTIAL_TAGS.has(b) || residential) return HOUSE_HEIGHT_M
  return DEFAULT_HEIGHT_M
}

/**
 * Footprint ring → local AABB box. Returns null if degenerate / too small.
 * Residential tags get a lower MIN_AREA so small houses survive.
 */
function ringToBox(
  ring: Array<{ lat: number; lon: number }>,
  origin: LatLng,
  tags: OverpassBuilding['tags'],
): ScoredBox | null {
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
  const tag = tags?.building ?? 'yes'
  const residential = isResidentialTag(tag, area)
  const minArea = residential ? MIN_AREA_RESIDENTIAL_M2 : MIN_AREA_M2
  if (area < minArea) return null
  const x = (minX + maxX) * 0.5
  const z = (minZ + maxZ) * 0.5
  return {
    x,
    z,
    width,
    depth,
    height: heightFromTags(tags, residential),
    building: tag,
    residential,
    solidCollider: false, // filled after stratified keep
    area,
    dist2: x * x + z * z,
  }
}

/**
 * Stratified keep:
 *   1. Residential pool → sort by distance to Drop (nearest first), take
 *      ~70% of MAX_BUILDINGS so Joey’s driving view fills with houses.
 *   2. Non-residential leftovers → sort by area descending, fill remaining
 *      slots (landmarks / big boxes).
 *   3. If residential pool is short, leftover budget also pulls nearest
 *      remaining non-res by distance so the neighborhood still looks full.
 */
function stratifiedKeep(scored: ScoredBox[], cap: number): ScoredBox[] {
  const resBudget = Math.max(1, Math.floor(cap * RESIDENTIAL_BUDGET_FRAC))
  const otherBudget = Math.max(0, cap - resBudget)

  const residential = scored.filter((b) => b.residential)
  const other = scored.filter((b) => !b.residential)

  // Distance-weighted within residential: nearest Drop / spawn first.
  residential.sort((a, b) => a.dist2 - b.dist2)
  const keptRes = residential.slice(0, resBudget)

  const keptIds = new Set(keptRes)
  // Landmarks: largest remaining non-residential.
  const otherPool = other.filter((b) => !keptIds.has(b))
  otherPool.sort((a, b) => b.area - a.area)
  let keptOther = otherPool.slice(0, otherBudget)

  // Spill unused residential budget into nearest leftover (any class).
  const used = keptRes.length + keptOther.length
  if (used < cap) {
    const leftover = scored
      .filter((b) => !keptRes.includes(b) && !keptOther.includes(b))
      .sort((a, b) => a.dist2 - b.dist2)
    const fill = leftover.slice(0, cap - used)
    keptOther = keptOther.concat(fill)
  }

  return keptRes.concat(keptOther)
}

/** Mark solid colliders: nearest N OR large footprints. */
function assignSolidColliders(boxes: ScoredBox[]): BuildingBox[] {
  const byDist = [...boxes].sort((a, b) => a.dist2 - b.dist2)
  const solidSet = new Set<ScoredBox>()
  for (let i = 0; i < Math.min(SOLID_COLLIDER_NEAREST, byDist.length); i++) {
    solidSet.add(byDist[i]!)
  }
  for (const b of boxes) {
    if (b.area >= SOLID_COLLIDER_MIN_AREA_M2) solidSet.add(b)
  }

  return boxes.map((b) => ({
    x: b.x,
    z: b.z,
    width: b.width,
    depth: b.depth,
    height: b.height,
    building: b.building,
    residential: b.residential,
    solidCollider: solidSet.has(b),
  }))
}


/** Distance from point to XZ AABB (0 if inside). */
function distPointToAabbXZ(
  px: number,
  pz: number,
  cx: number,
  cz: number,
  halfW: number,
  halfD: number,
): number {
  const dx = Math.max(Math.abs(px - cx) - halfW, 0)
  const dz = Math.max(Math.abs(pz - cz) - halfD, 0)
  return Math.hypot(dx, dz)
}

/**
 * Min distance from a centerline segment to an XZ AABB.
 * Samples ~2 m along the segment (teaching-clear, cheap enough at Drop scale).
 */
function minDistSegToAabb(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  halfW: number,
  halfD: number,
): number {
  const len = Math.hypot(bx - ax, bz - az)
  const steps = Math.max(1, Math.ceil(len / 2))
  let min = Infinity
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const px = ax + (bx - ax) * t
    const pz = az + (bz - az) * t
    min = Math.min(min, distPointToAabbXZ(px, pz, cx, cz, halfW, halfD))
    if (min === 0) return 0
  }
  return min
}

/**
 * True when the building AABB comes within (way.halfWidthM + margin) of any
 * street centerline — i.e. the solid box would block driveable asphalt.
 */
export function buildingAabbOverlapsRoad(
  box: Pick<BuildingBox, 'x' | 'z' | 'width' | 'depth'>,
  ways: RoadSurfaceWay[],
  marginM = BUILDING_ROAD_CLEAR_MARGIN_M,
): boolean {
  const halfW = box.width * 0.5
  const halfD = box.depth * 0.5
  for (const way of ways) {
    const clear = way.halfWidthM + marginM
    const clear2 = clear * clear
    const pts = way.points
    for (let i = 1; i < pts.length; i++) {
      const ax = pts[i - 1]![0]
      const az = pts[i - 1]![2]
      const bx = pts[i]![0]
      const bz = pts[i]![2]
      // Cheap reject: circle around segment midpoint vs AABB circumcircle.
      const mx = (ax + bx) * 0.5
      const mz = (az + bz) * 0.5
      const segHalf = Math.hypot(bx - ax, bz - az) * 0.5
      const aabbR = Math.hypot(halfW, halfD)
      const reject = clear + segHalf + aabbR
      const dx = box.x - mx
      const dz = box.z - mz
      if (dx * dx + dz * dz > reject * reject) continue
      const d = minDistSegToAabb(ax, az, bx, bz, box.x, box.z, halfW, halfD)
      if (d * d <= clear2) return true
    }
  }
  return false
}

/**
 * Turn off solidCollider for boxes that kiss the road ribbon.
 * Visual meshes stay; Joey keeps bumping warehouses set back from the curb.
 * Call from Scene once roadSurfaceWays exist (buildings fetch is fire-and-forget).
 */
export function clearRoadOverlappingSolidColliders(
  boxes: BuildingBox[],
  ways: RoadSurfaceWay[],
  marginM = BUILDING_ROAD_CLEAR_MARGIN_M,
): BuildingBox[] {
  if (!boxes.length || !ways.length) return boxes
  let cleared = 0
  const out = boxes.map((b) => {
    if (!b.solidCollider) return b
    if (!buildingAabbOverlapsRoad(b, ways, marginM)) return b
    cleared++
    return { ...b, solidCollider: false }
  })
  if (cleared > 0) {
    console.info('[buildings] cleared road-overlapping solid colliders', {
      cleared,
      solidLeft: out.filter((b) => b.solidCollider).length,
    })
  }
  return out
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
    const scored: ScoredBox[] = []

    for (const el of data.elements ?? []) {
      if (!el.geometry || el.geometry.length < 3) continue
      // Skip explicit non-buildings if tagged oddly.
      const tag = (el.tags?.building ?? '').toLowerCase()
      if (tag === 'no') continue
      const box = ringToBox(el.geometry, origin, el.tags)
      if (box) scored.push(box)
    }

    const kept = stratifiedKeep(scored, MAX_BUILDINGS)
    const boxes = assignSolidColliders(kept)
    const residentialKept = boxes.filter((x) => x.residential).length
    const otherKept = boxes.length - residentialKept
    const solidCount = boxes.filter((x) => x.solidCollider).length

    const msg =
      boxes.length > 0
        ? `Buildings: ${boxes.length} (${residentialKept} residential / ${otherKept} other) of ${scored.length}`
        : 'Buildings: none in bbox'
    console.info('[buildings]', {
      kept: boxes.length,
      found: scored.length,
      residentialKept,
      otherKept,
      solidColliders: solidCount,
      cap: MAX_BUILDINGS,
    })
    return {
      boxes,
      source: boxes.length ? 'osm' : 'none',
      message: msg,
      found: scored.length,
      residentialKept,
      otherKept,
    }
  } catch (err) {
    const why = err instanceof Error ? err.message : 'unknown'
    console.warn('[buildings] fetch failed', why)
    return {
      boxes: [],
      source: 'none',
      message: `Buildings skipped (${why})`,
      found: 0,
      residentialKept: 0,
      otherKept: 0,
    }
  }
}


/**
 * Buildings inside an explicit WGS84 bbox (one street tile).
 * Same stratified residential preference as fetchBuildings; smaller per-tile cap.
 * Worker + main both call this — Overpass etiquette (gap/queue) lives in the streamer.
 */
export async function fetchBuildingsInBbox(
  south: number,
  west: number,
  north: number,
  east: number,
  origin: LatLng,
  maxBoxes = MAX_BUILDINGS_PER_TILE,
): Promise<BuildingWorld> {
  const query = `[out:json][timeout:25];
(
  way["building"](${south},${west},${north},${east});
);
out tags geom;`

  try {
    const res = await overpassInterpreter(query)
    const data = (await res.json()) as { elements?: OverpassBuilding[] }
    const scored: ScoredBox[] = []

    for (const el of data.elements ?? []) {
      if (!el.geometry || el.geometry.length < 3) continue
      const tag = (el.tags?.building ?? '').toLowerCase()
      if (tag === 'no') continue
      const box = ringToBox(el.geometry, origin, el.tags)
      if (box) scored.push(box)
    }

    const kept = stratifiedKeep(scored, maxBoxes)
    const boxes = assignSolidColliders(kept)
    const residentialKept = boxes.filter((x) => x.residential).length
    const otherKept = boxes.length - residentialKept
    const msg =
      boxes.length > 0
        ? `Tile buildings: ${boxes.length} (${residentialKept} res / ${otherKept} other) of ${scored.length}`
        : 'Tile buildings: none'
    return {
      boxes,
      source: boxes.length ? 'osm' : 'none',
      message: msg,
      found: scored.length,
      residentialKept,
      otherKept,
    }
  } catch (err) {
    const why = err instanceof Error ? err.message : 'unknown'
    return {
      boxes: [],
      source: 'none',
      message: `Tile buildings skipped (${why})`,
      found: 0,
      residentialKept: 0,
      otherKept: 0,
    }
  }
}

/**
 * Merge per-tile boxes for the active set, re-apply total cap + solid flags.
 * Prefer nearer-to-Drop residential the same way stratifiedKeep does.
 */
export function mergeActiveBuildingBoxes(
  perTile: BuildingBox[][],
  cap = MAX_BUILDINGS,
): BuildingBox[] {
  const flat = perTile.flat()
  if (flat.length <= cap) {
    // Re-score solid colliders on the union (nearest across all active tiles).
    const scored: ScoredBox[] = flat.map((b) => ({
      ...b,
      area: b.width * b.depth,
      dist2: b.x * b.x + b.z * b.z,
    }))
    return assignSolidColliders(scored)
  }
  const scored: ScoredBox[] = flat.map((b) => ({
    ...b,
    area: b.width * b.depth,
    dist2: b.x * b.x + b.z * b.z,
  }))
  return assignSolidColliders(stratifiedKeep(scored, cap))
}
