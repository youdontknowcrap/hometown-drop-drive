/**
 * Geocode (Nominatim) + route (OSRM) with a hard fallback to the demo
 * Ridgecrest polyline so the toy always works offline / behind CORS.
 */
import type { LatLng } from './geo'
import {
  DEMO_ORIGIN,
  DEMO_POLYLINE,
  DEMO_START_LABEL,
  DEMO_STOP_LABEL,
} from './demoRoute'

export type RouteResult = {
  origin: LatLng
  polyline: LatLng[]
  source: 'osrm' | 'demo'
  message: string
  startLabel: string
  stopLabel: string
}

type NominatimHit = {
  lat: string
  lon: string
  display_name: string
}

async function geocode(query: string): Promise<LatLng & { label: string }> {
  const url =
    `/api/nominatim/search?format=json&limit=1&q=${encodeURIComponent(query)}`
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Geocode failed (${res.status})`)
  const data = (await res.json()) as NominatimHit[]
  if (!data.length) throw new Error(`No results for “${query}”`)
  return {
    lat: Number(data[0].lat),
    lng: Number(data[0].lon),
    label: data[0].display_name,
  }
}

async function osrmRoute(start: LatLng, end: LatLng): Promise<LatLng[]> {
  // OSRM expects lon,lat
  const coords = `${start.lng},${start.lat};${end.lng},${end.lat}`
  const url = `/api/osrm/route/v1/driving/${coords}?overview=full&geometries=geojson`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`OSRM failed (${res.status})`)
  const data = (await res.json()) as {
    code?: string
    routes?: Array<{ geometry: { coordinates: number[][] } }>
  }
  if (data.code !== 'Ok' || !data.routes?.[0]) {
    throw new Error('OSRM returned no route')
  }
  // GeoJSON is [lng, lat]
  return data.routes[0].geometry.coordinates.map(([lng, lat]) => ({ lat, lng }))
}

/** Always resolves — live OSM when possible, demo polyline otherwise. */
export async function fetchRoute(
  startAddress: string,
  stopAddress: string,
): Promise<RouteResult> {
  const startQ = startAddress.trim()
  const stopQ = stopAddress.trim()

  if (!startQ || !stopQ) {
    return {
      origin: DEMO_ORIGIN,
      polyline: DEMO_POLYLINE,
      source: 'demo',
      message: 'Enter start & stop addresses, or enjoy the Ridgecrest demo loop.',
      startLabel: DEMO_START_LABEL,
      stopLabel: DEMO_STOP_LABEL,
    }
  }

  try {
    const [start, end] = await Promise.all([geocode(startQ), geocode(stopQ)])
    const polyline = await osrmRoute(start, end)
    return {
      origin: start,
      polyline,
      source: 'osrm',
      message: `Route ready: ${polyline.length} points (OSRM).`,
      startLabel: start.label,
      stopLabel: end.label,
    }
  } catch (err) {
    const why = err instanceof Error ? err.message : 'unknown error'
    return {
      origin: DEMO_ORIGIN,
      polyline: DEMO_POLYLINE,
      source: 'demo',
      message: `Using Ridgecrest demo route (${why}).`,
      startLabel: DEMO_START_LABEL,
      stopLabel: DEMO_STOP_LABEL,
    }
  }
}

/** Instant demo route — used on first paint so the scene is never empty. */
export function getDemoRoute(): RouteResult {
  return {
    origin: DEMO_ORIGIN,
    polyline: DEMO_POLYLINE,
    source: 'demo',
    message: 'Demo loop around Ridgecrest, CA — press Go anytime.',
    startLabel: DEMO_START_LABEL,
    stopLabel: DEMO_STOP_LABEL,
  }
}
