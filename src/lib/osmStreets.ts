/**
 * Drop pin → OSM highway grid. Address is a spawn, not a route.
 */
import {
  metersPerDegree,
  polylineLengthMeters,
  type LatLng,
} from './geo'
import {
  DEMO_ORIGIN,
  DEMO_POLYLINE,
  DEMO_START_LABEL,
} from './demoRoute'

export const DROP_RADIUS_M = 3000

export type StreetWorld = {
  origin: LatLng
  ways: LatLng[][]
  source: 'osm' | 'demo'
  message: string
  dropLabel: string
  streetMeters: number
  wayCount: number
}

type NominatimHit = { lat: string; lon: string; display_name: string }

type OverpassWay = {
  type: string
  geometry?: Array<{ lat: number; lon: number }>
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

async function geocode(query: string): Promise<LatLng & { label: string }> {
  const url = `/api/nominatim/search?format=json&limit=1&q=${encodeURIComponent(query)}`
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`Geocode failed (${res.status})`)
  const data = (await res.json()) as NominatimHit[]
  if (!data.length) throw new Error(`No results for “${query}”`)
  return {
    lat: Number(data[0].lat),
    lng: Number(data[0].lon),
    label: data[0].display_name,
  }
}

async function overpassHighways(origin: LatLng, radiusM: number): Promise<LatLng[][]> {
  const b = bboxAround(origin, radiusM)
  const query = `[out:json][timeout:25];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road|track|motorway_link|trunk_link|primary_link|secondary_link)$"](${b.south},${b.west},${b.north},${b.east});
);
out geom;`
  const res = await fetch('/api/overpass', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: query,
  })
  if (!res.ok) throw new Error(`Overpass failed (${res.status})`)
  const data = (await res.json()) as { elements?: OverpassWay[] }
  const ways: LatLng[][] = []
  for (const el of data.elements ?? []) {
    if (!el.geometry || el.geometry.length < 2) continue
    ways.push(el.geometry.map((g) => ({ lat: g.lat, lng: g.lon })))
  }
  if (!ways.length) throw new Error('Overpass returned no streets')
  return ways
}

function demoWorld(message: string): StreetWorld {
  const ways = [DEMO_POLYLINE]
  return {
    origin: DEMO_ORIGIN,
    ways,
    source: 'demo',
    message,
    dropLabel: DEMO_START_LABEL,
    streetMeters: polylineLengthMeters(DEMO_POLYLINE),
    wayCount: 1,
  }
}

export function getDemoWorld(): StreetWorld {
  return demoWorld('Demo loop only — drop at an address for the real street grid.')
}

export async function fetchStreetWorld(dropAddress: string): Promise<StreetWorld> {
  const q = dropAddress.trim()
  if (!q) return getDemoWorld()

  try {
    const drop = await geocode(q)
    const ways = await overpassHighways(drop, DROP_RADIUS_M)
    let streetMeters = 0
    for (const w of ways) streetMeters += polylineLengthMeters(w)
    const km = (streetMeters / 1000).toFixed(1)
    return {
      origin: drop,
      ways,
      source: 'osm',
      message: `${ways.length} streets, ${km} km of road within ${(DROP_RADIUS_M / 1000).toFixed(1)} km. Drive anywhere. No walls.`,
      dropLabel: drop.label,
      streetMeters,
      wayCount: ways.length,
    }
  } catch (err) {
    const why = err instanceof Error ? err.message : 'unknown error'
    return demoWorld(`Street grid failed (${why}). Demo loop instead.`)
  }
}
