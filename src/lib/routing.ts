/**
 * Geocode (Nominatim) + route (OSRM) with a hard fallback so the toy
 * always works offline / behind CORS.
 *
 * Phase 1 GPS: set a destination while driving, then OSRM from the car
 * (or a start address) → destination. Reroute reuses routeBetween.
 */
import { polylineLengthMeters, type LatLng } from './geo'
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
  lengthMeters: number
}

/** Lightweight result for in-drive GPS (car → destination). */
export type NavRoute = {
  polyline: LatLng[]
  destination: LatLng
  destLabel: string
  source: 'osrm' | 'fallback'
  lengthMeters: number
  message: string
}

type NominatimHit = {
  lat: string
  lon: string
  display_name: string
}

export async function geocodeAddress(
  query: string,
): Promise<LatLng & { label: string }> {
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

/** Straight-line fallback when OSRM is unreachable (still shows a blue line). */
function straightFallback(start: LatLng, end: LatLng): LatLng[] {
  return [start, end]
}

/**
 * Route from a known lat/lng (usually the car) to a destination lat/lng.
 * Always resolves — OSRM when possible, straight line otherwise.
 */
export async function routeBetween(
  start: LatLng,
  end: LatLng,
  destLabel: string,
): Promise<NavRoute> {
  try {
    const polyline = await osrmRoute(start, end)
    const lengthMeters = polylineLengthMeters(polyline)
    const km = (lengthMeters / 1000).toFixed(2)
    return {
      polyline,
      destination: end,
      destLabel,
      source: 'osrm',
      lengthMeters,
      message: `Going to ${shortLabel(destLabel)} · ${km} km`,
    }
  } catch (err) {
    const why = err instanceof Error ? err.message : 'unknown error'
    const polyline = straightFallback(start, end)
    const lengthMeters = polylineLengthMeters(polyline)
    return {
      polyline,
      destination: end,
      destLabel,
      source: 'fallback',
      lengthMeters,
      message: `GPS fallback line (${why}).`,
    }
  }
}

/**
 * Geocode a destination address, then route from `from` (car / drop).
 */
export async function routeToAddress(
  from: LatLng,
  destAddress: string,
): Promise<NavRoute> {
  const q = destAddress.trim()
  if (!q) throw new Error('Type a destination address first.')
  const end = await geocodeAddress(q)
  return routeBetween(from, end, end.label)
}

/** Always resolves — live OSM when possible, demo polyline otherwise. */
export async function fetchRoute(
  startAddress: string,
  stopAddress: string,
): Promise<RouteResult> {
  const startQ = startAddress.trim()
  const stopQ = stopAddress.trim()

  if (!startQ || !stopQ) {
    return demoResult('Enter start & stop addresses, or enjoy the Ridgecrest demo loop.')
  }

  try {
    const [start, end] = await Promise.all([
      geocodeAddress(startQ),
      geocodeAddress(stopQ),
    ])
    const polyline = await osrmRoute(start, end)
    const lengthMeters = polylineLengthMeters(polyline)
    const km = (lengthMeters / 1000).toFixed(2)
    return {
      origin: start,
      polyline,
      source: 'osrm',
      message: `Live OSM street: ${km} km (${polyline.length} points).`,
      startLabel: start.label,
      stopLabel: end.label,
      lengthMeters,
    }
  } catch (err) {
    const why = err instanceof Error ? err.message : 'unknown error'
    return demoResult(`Using Ridgecrest demo route (${why}).`)
  }
}

function demoResult(message: string): RouteResult {
  const lengthMeters = polylineLengthMeters(DEMO_POLYLINE)
  return {
    origin: DEMO_ORIGIN,
    polyline: DEMO_POLYLINE,
    source: 'demo',
    message: `${message} ${(lengthMeters / 1000).toFixed(2)} km demo path.`,
    startLabel: DEMO_START_LABEL,
    stopLabel: DEMO_STOP_LABEL,
    lengthMeters,
  }
}

/** Instant demo route — used on first paint so the scene is never empty. */
export function getDemoRoute(): RouteResult {
  return demoResult('Demo loop around Ridgecrest, CA — press Go for a live street.')
}

function shortLabel(label: string): string {
  const first = label.split(',')[0]?.trim()
  return first && first.length > 0 ? first : label
}
