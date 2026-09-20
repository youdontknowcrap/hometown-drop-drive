/**
 * Nominatim / Overpass / OSRM helpers.
 * Prefer the Vite `/api/*` proxy in dev; fall back to public endpoints so
 * `vite preview` / static hosts still get real streets when CORS allows.
 */

import type { LatLng } from './geo'

async function fetchFirstOk(
  attempts: Array<{ url: string; init?: RequestInit }>,
  label = 'request',
): Promise<Response> {
  let lastErr: Error | null = null
  for (const { url, init } of attempts) {
    try {
      const res = await fetch(url, init)
      if (res.ok) return res
      lastErr = new Error(`${label} failed (${res.status})`)
      console.warn(`[osmApi] ${label} ${res.status} via ${url}`)
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
      console.warn(`[osmApi] ${label} error via ${url}:`, lastErr.message)
    }
  }
  throw lastErr ?? new Error(`${label} unreachable`)
}

export async function nominatimSearch(query: string): Promise<Response> {
  const qs = `format=json&limit=1&q=${encodeURIComponent(query)}`
  return fetchFirstOk(
    [
      {
        url: `/api/nominatim/search?${qs}`,
        init: { headers: { Accept: 'application/json' } },
      },
      {
        url: `https://nominatim.openstreetmap.org/search?${qs}`,
        init: { headers: { Accept: 'application/json' } },
      },
    ],
    'Geocode',
  )
}

export async function overpassInterpreter(query: string): Promise<Response> {
  const postInit: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      Accept: 'application/json',
    },
    body: query,
  }
  const getQs = `data=${encodeURIComponent(query)}`
  return fetchFirstOk(
    [
      { url: '/api/overpass', init: postInit },
      { url: 'https://overpass-api.de/api/interpreter', init: postInit },
      {
        url: `https://overpass-api.de/api/interpreter?${getQs}`,
        init: { headers: { Accept: 'application/json' } },
      },
      { url: 'https://lz4.overpass-api.de/api/interpreter', init: postInit },
      {
        url: `https://lz4.overpass-api.de/api/interpreter?${getQs}`,
        init: { headers: { Accept: 'application/json' } },
      },
    ],
    'Overpass',
  )
}

export async function osrmRouteResponse(start: LatLng, end: LatLng): Promise<Response> {
  const coords = `${start.lng},${start.lat};${end.lng},${end.lat}`
  const path = `/route/v1/driving/${coords}?overview=full&geometries=geojson`
  return fetchFirstOk(
    [{ url: `/api/osrm${path}` }, { url: `https://router.project-osrm.org${path}` }],
    'OSRM',
  )
}
