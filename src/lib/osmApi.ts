/**
 * Nominatim / Overpass / OSRM helpers.
 * Prefer the Vite `/api/*` proxy in dev; fall back to public endpoints so
 * `vite preview` / static hosts still get real streets when CORS allows.
 *
 * LEARNING — Overpass blips → perceived jerkiness (not a cam bug):
 *   Public interpreters flap TLS / rate-limit. Naïve “fetch → throw →
 *   streamer clears tile → poll re-enqueues” turns one blip into a stampede
 *   of retries on the main thread + missing asphalt / soft-clamp flicker.
 *   That looks like hitchy drive even though rAF/physics kept ticking.
 *   Fix: coalesce identical in-flight queries, exponential backoff between
 *   upstream attempts, and let the streamer soft-fail (keep last tiles).
 */

import type { LatLng } from './geo'

/** Shared Overpass mirrors (browser direct — CORS may block some hosts). */
const OVERPASS_DIRECT = [
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
] as const

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function isTransientNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /TLS|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket disconnected|network|Failed to fetch|Load failed|proxy|abort/i.test(
    msg,
  )
}

/**
 * Try attempts in order. On transient network/TLS errors, wait with
 * exponential backoff before the next upstream (no stampede).
 */
async function fetchFirstOk(
  attempts: Array<{ url: string; init?: RequestInit }>,
  label = 'request',
): Promise<Response> {
  let lastErr: Error | null = null
  for (let i = 0; i < attempts.length; i++) {
    const { url, init } = attempts[i]
    try {
      const res = await fetch(url, init)
      if (res.ok) return res
      // 429 / 504 / 502 from Overpass — treat as transient, back off.
      const transientHttp = res.status === 429 || res.status >= 500
      lastErr = new Error(`${label} failed (${res.status})`)
      console.warn(`[osmApi] ${label} ${res.status} via ${url}`)
      if (transientHttp && i + 1 < attempts.length) {
        const wait = Math.min(8_000, 400 * 2 ** i)
        await sleep(wait)
        continue
      }
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
      console.warn(`[osmApi] ${label} error via ${url}:`, lastErr.message)
      if (isTransientNetworkError(err) && i + 1 < attempts.length) {
        const wait = Math.min(8_000, 500 * 2 ** i)
        await sleep(wait)
        continue
      }
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

type BufferedResponse = {
  status: number
  statusText: string
  headers: Headers
  body: ArrayBuffer
}

/** Coalesce identical Overpass bodies so Drop + GPS + neighbors don’t stampede. */
const overpassInflight = new Map<string, Promise<BufferedResponse>>()

function responseFromBuffer(buf: BufferedResponse): Response {
  // Fresh ArrayBuffer view per waiter — body can only be read once per Response.
  return new Response(buf.body.slice(0), {
    status: buf.status,
    statusText: buf.statusText,
    headers: buf.headers,
  })
}

/**
 * POST (preferred) then GET mirrors. Dev hits `/api/overpass` first (Vite
 * failover middleware). Identical in-flight queries share one Promise;
 * each waiter gets an independent Response from the buffered body.
 */
export async function overpassInterpreter(query: string): Promise<Response> {
  const key = query
  const existing = overpassInflight.get(key)
  if (existing) {
    return responseFromBuffer(await existing)
  }

  const job = (async (): Promise<BufferedResponse> => {
    const postInit: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        Accept: 'application/json',
      },
      body: query,
    }
    const getQs = `data=${encodeURIComponent(query)}`
    const attempts: Array<{ url: string; init?: RequestInit }> = [
      { url: '/api/overpass', init: postInit },
    ]
    for (const base of OVERPASS_DIRECT) {
      attempts.push({ url: base, init: postInit })
      attempts.push({
        url: `${base}?${getQs}`,
        init: { headers: { Accept: 'application/json' } },
      })
    }
    const res = await fetchFirstOk(attempts, 'Overpass')
    return {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
      body: await res.arrayBuffer(),
    }
  })()

  overpassInflight.set(key, job)
  try {
    return responseFromBuffer(await job)
  } finally {
    overpassInflight.delete(key)
  }
}

export async function osrmRouteResponse(start: LatLng, end: LatLng): Promise<Response> {
  const coords = `${start.lng},${start.lat};${end.lng},${end.lat}`
  const path = `/route/v1/driving/${coords}?overview=full&geometries=geojson`
  return fetchFirstOk(
    [{ url: `/api/osrm${path}` }, { url: `https://router.project-osrm.org${path}` }],
    'OSRM',
  )
}
