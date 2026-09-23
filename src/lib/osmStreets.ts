/**
 * Drop pin → OSM highway grid. Address is a spawn, not a route.
 * Ways keep `name` / `ref` for floating 3D street labels (StreetLabels).
 */
import {
  metersPerDegree,
  polylineLengthMeters,
  type LatLng,
} from './geo'
import {
  DEMO_ARTERIAL,
  DEMO_CROSS,
  DEMO_DIRT,
  DEMO_ORIGIN,
  DEMO_POLYLINE,
  DEMO_START_LABEL,
} from './demoRoute'
import { nominatimSearch, overpassInterpreter } from './osmApi'

export const DROP_RADIUS_M = 3000

/** Visual / width class for ribbons (playtest #19). */
export type StreetKind = 'paved' | 'service' | 'dirt'

export type StreetWay = {
  points: LatLng[]
  kind: StreetKind
  highway: string
  /**
   * OSM `name` tag when present (e.g. "China Lake Boulevard").
   * Empty / missing → no floating 3D label (cull unnamed stubs).
   */
  name?: string
  /**
   * OSM `ref` tag fallback for numbered roads (e.g. "CA 178") when name is absent.
   */
  ref?: string
}

export type StreetWorld = {
  origin: LatLng
  ways: StreetWay[]
  source: 'osm' | 'demo'
  message: string
  dropLabel: string
  streetMeters: number
  wayCount: number
}

type NominatimHit = { lat: string; lon: string; display_name: string }

type OverpassWay = {
  type: string
  /** Overpass returns whatever tags exist; we only read highway / name / ref. */
  tags?: { highway?: string; name?: string; ref?: string }
  geometry?: Array<{ lat: number; lon: number }>
}

const PAVED = new Set([
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'unclassified',
  'residential',
  'living_street',
  'road',
  'motorway_link',
  'trunk_link',
  'primary_link',
  'secondary_link',
  'tertiary_link',
])

export function classifyHighway(highway: string): StreetKind {
  const h = highway.toLowerCase()
  if (h === 'track' || h === 'path' || h === 'bridleway') return 'dirt'
  if (h === 'service' || h === 'pedestrian' || h === 'footway') return 'service'
  if (PAVED.has(h)) return 'paved'
  return 'service'
}

/** Ribbon width in meters by OSM highway tag. */
export function widthForHighway(highway: string): number {
  switch (highway) {
    case 'motorway':
    case 'trunk':
      return 11
    case 'primary':
    case 'secondary':
      return 8.5
    case 'tertiary':
    case 'unclassified':
    case 'residential':
    case 'living_street':
    case 'road':
      return 7.2
    case 'motorway_link':
    case 'trunk_link':
    case 'primary_link':
    case 'secondary_link':
    case 'tertiary_link':
      return 5.5
    case 'service':
      return 4.2
    case 'track':
    case 'path':
    case 'bridleway':
      return 3.0
    default:
      return 6.0
  }
}


/**
 * Human-readable label for a way: prefer name, else ref (numbered routes).
 * Returns null when neither exists — callers should skip the floating label.
 *
 * LEARNING: Overpass `out geom` already includes all tags on the way. We used
 * to ignore `name`, so GpsDash / 3D had geometry but no street strings. Same
 * query; we just keep more of the JSON.
 */
export function displayNameForWay(way: {
  name?: string
  ref?: string
}): string | null {
  const name = way.name?.trim()
  if (name) return name
  const ref = way.ref?.trim()
  if (ref) return ref
  return null
}

function bboxAround(origin: LatLng, radiusM: number) {
  const { mPerDegLat, mPerDegLng } = metersPerDegree(origin.lat)
  const dLat = radiusM / mPerDegLat
  const dLng = radiusM / mPerDegLng
  return {
    south: origin.lat - dLat,
    west: origin.lng - dLng,
    north: origin.lat + dLat,
    east: origin.lng + dLng,
  }
}

export async function geocodeDrop(query: string): Promise<LatLng & { label: string }> {
  const res = await nominatimSearch(query)
  const data = (await res.json()) as NominatimHit[]
  if (!data.length) throw new Error(`No results for “${query}”`)
  return {
    lat: Number(data[0].lat),
    lng: Number(data[0].lon),
    label: data[0].display_name,
  }
}

async function overpassHighways(origin: LatLng, radiusM: number): Promise<StreetWay[]> {
  const b = bboxAround(origin, radiusM)
  const query = `[out:json][timeout:25];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road|track|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"](${b.south},${b.west},${b.north},${b.east});
);
out geom;`
  const res = await overpassInterpreter(query)
  const data = (await res.json()) as { elements?: OverpassWay[] }
  const ways: StreetWay[] = []
  for (const el of data.elements ?? []) {
    if (!el.geometry || el.geometry.length < 2) continue
    const highway = el.tags?.highway ?? 'road'
    const name = el.tags?.name?.trim() || undefined
    const ref = el.tags?.ref?.trim() || undefined
    ways.push({
      points: el.geometry.map((g) => ({ lat: g.lat, lng: g.lon })),
      kind: classifyHighway(highway),
      highway,
      name,
      ref,
    })
  }
  if (!ways.length) throw new Error('Overpass returned no streets')
  return ways
}

function demoWorld(message: string): StreetWorld {
  // Invent a couple of names so offline demo still teaches floating labels.
  const ways: StreetWay[] = [
    {
      points: DEMO_ARTERIAL,
      kind: 'paved',
      highway: 'primary',
      name: 'China Lake Blvd',
    },
    {
      points: DEMO_CROSS,
      kind: 'paved',
      highway: 'residential',
      name: 'Ridgecrest Blvd',
    },
    {
      points: DEMO_POLYLINE,
      kind: 'paved',
      highway: 'secondary',
      name: 'Demo Loop',
    },
    // Unnamed dirt spur — no floating label (cull unnamed ways).
    { points: DEMO_DIRT, kind: 'dirt', highway: 'track' },
  ]
  let streetMeters = 0
  for (const w of ways) streetMeters += polylineLengthMeters(w.points)
  return {
    origin: DEMO_ORIGIN,
    ways,
    source: 'demo',
    message,
    dropLabel: DEMO_START_LABEL,
    streetMeters,
    wayCount: ways.length,
  }
}


/**
 * Overpass highways inside an explicit WGS84 bbox (south,west,north,east).
 * Used by street-tile streaming so each ~1 km tile has its own request.
 *
 * LEARNING: same highway regex as Drop's first load — we only change *where*
 * we ask, not *what* counts as a driveable way.
 */
export async function fetchWaysInBbox(
  south: number,
  west: number,
  north: number,
  east: number,
  signal?: AbortSignal,
): Promise<StreetWay[]> {
  const query = `[out:json][timeout:25];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road|track|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"](${south},${west},${north},${east});
);
out geom;`
  const res = await overpassInterpreter(query, signal)
  const data = (await res.json()) as { elements?: OverpassWay[] }
  const ways: StreetWay[] = []
  for (const el of data.elements ?? []) {
    if (!el.geometry || el.geometry.length < 2) continue
    const highway = el.tags?.highway ?? 'road'
    const name = el.tags?.name?.trim() || undefined
    const ref = el.tags?.ref?.trim() || undefined
    ways.push({
      points: el.geometry.map((g) => ({ lat: g.lat, lng: g.lon })),
      kind: classifyHighway(highway),
      highway,
      name,
      ref,
    })
  }
  return ways
}

export function getDemoWorld(): StreetWorld {
  return demoWorld(
    'DEMO streets (labeled crossroads) — Drop an address for live OSM. Not live map data.',
  )
}

export async function fetchStreetWorld(dropAddress: string): Promise<StreetWorld> {
  const q = dropAddress.trim()
  if (!q) return getDemoWorld()

  try {
    const drop = await geocodeDrop(q)
    const ways = await overpassHighways(drop, DROP_RADIUS_M)
    let streetMeters = 0
    for (const w of ways) streetMeters += polylineLengthMeters(w.points)
    const km = (streetMeters / 1000).toFixed(1)
    const paved = ways.filter((w) => w.kind === 'paved').length
    const dirt = ways.filter((w) => w.kind === 'dirt').length
    const msg = `Live OSM: ${ways.length} ways (${paved} paved, ${dirt} track), ${km} km within ${(DROP_RADIUS_M / 1000).toFixed(1)} km. Streaming world: soft edge at unloaded tiles (see streetTiles.ts).`
    console.info('[streets]', {
      source: 'osm',
      wayCount: ways.length,
      paved,
      dirt,
      streetMeters,
      origin: drop,
    })
    return {
      origin: drop,
      ways,
      source: 'osm',
      message: msg,
      dropLabel: drop.label,
      streetMeters,
      wayCount: ways.length,
    }
  } catch (err) {
    const why = err instanceof Error ? err.message : 'unknown error'
    console.warn('[streets] load failed, using demo:', why)
    return demoWorld(
      `Street load failed (${why}). Showing labeled DEMO crossroads — not live OSM.`,
    )
  }
}

/** Flatten StreetWay[] → LatLng[][] for callers that only need geometry. */
export function wayPoints(ways: StreetWay[]): LatLng[][] {
  return ways.map((w) => w.points)
}
