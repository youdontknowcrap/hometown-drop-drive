import { defineConfig, type Plugin, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Public Overpass mirrors (same interpreter API). Primary is often busy or
 * flaps TLS under load — failover stops Vite from logging endless
 * "http proxy error: /api/interpreter" and the browser from stampeding.
 *
 * LEARNING — why Overpass blips feel like "jerkiness":
 *   The rAF / physics loop is fine; the hitch is secondary. A dead proxy
 *   rejects the tile fetch → streamer marks the tile error → soft-clamp /
 *   missing asphalt / elev wait-for-ways flicker → next poll re-enqueues →
 *   burst of retries. Camera/elev morph then look bumpy even though FollowCam
 *   did nothing wrong. Harden the pipe + soft-fail tiles so drive stays smooth.
 */
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
] as const

const OVERPASS_UA =
  'HometownDropDrive/0.1 (family web toy; contact: local-dev)'

const OVERPASS_TIMEOUT_MS = 55_000

function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer | string) => {
      chunks.push(typeof c === 'string' ? Buffer.from(c) : c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function isTlsOrNetworkBlip(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  const code =
    err && typeof err === 'object' && 'cause' in err
      ? String((err as { cause?: { code?: string } }).cause?.code ?? '')
      : err && typeof err === 'object' && 'code' in err
        ? String((err as { code?: string }).code ?? '')
        : ''
  return /TLS|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket disconnected|network|fetch failed|UND_ERR|CERT/i.test(
    `${msg} ${code}`,
  )
}

/**
 * Dev-only middleware: POST/GET `/api/overpass` → Overpass interpreter with
 * mirror failover on TLS / network blips. Replaces the single-target proxy
 * entry so we can retry the *same* body against the next upstream.
 */
function overpassFailoverProxy(): Plugin {
  return {
    name: 'overpass-failover-proxy',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? ''
        if (!url.startsWith('/api/overpass')) {
          next()
          return
        }

        // Strip query for path match; keep qs for GET passthrough.
        const qsIdx = url.indexOf('?')
        const pathOnly = qsIdx >= 0 ? url.slice(0, qsIdx) : url
        if (pathOnly !== '/api/overpass' && pathOnly !== '/api/overpass/') {
          next()
          return
        }

        try {
          await proxyOverpass(req, res, qsIdx >= 0 ? url.slice(qsIdx) : '')
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.warn('[vite overpass] unhandled:', msg)
          if (!res.headersSent) {
            res.statusCode = 502
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Overpass proxy failed', detail: msg }))
          }
        }
      })
    },
  }
}

async function proxyOverpass(
  req: IncomingMessage,
  res: ServerResponse,
  qs: string,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase()
  let body: Buffer | undefined
  if (method !== 'GET' && method !== 'HEAD') {
    body = await readRequestBody(req)
  }

  let lastErr: Error | null = null
  for (let i = 0; i < OVERPASS_MIRRORS.length; i++) {
    const mirror = OVERPASS_MIRRORS[i]
    const target = method === 'GET' || method === 'HEAD' ? `${mirror}${qs}` : mirror
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), OVERPASS_TIMEOUT_MS)
    try {
      const upstream = await fetch(target, {
        method,
        headers: {
          Accept: 'application/json',
          'User-Agent': OVERPASS_UA,
          ...(body
            ? {
                'Content-Type':
                  (req.headers['content-type'] as string) || 'text/plain',
              }
            : {}),
        },
        body: body && method !== 'GET' && method !== 'HEAD' ? body : undefined,
        signal: ac.signal,
      })
      clearTimeout(timer)

      const buf = Buffer.from(await upstream.arrayBuffer())
      res.statusCode = upstream.status
      const ct = upstream.headers.get('content-type')
      if (ct) res.setHeader('Content-Type', ct)
      res.setHeader('X-Overpass-Mirror', mirror)
      if (i > 0) {
        console.info(
          `[vite overpass] failover ok via ${mirror} (tried ${i} earlier)`,
        )
      }
      res.end(buf)
      return
    } catch (err) {
      clearTimeout(timer)
      lastErr = err instanceof Error ? err : new Error(String(err))
      const blip = isTlsOrNetworkBlip(err)
      console.warn(
        `[vite overpass] ${blip ? 'TLS/network blip' : 'error'} on ${mirror}: ${lastErr.message}${
          i + 1 < OVERPASS_MIRRORS.length ? ' → trying next mirror' : ''
        }`,
      )
      if (!blip && i === 0) {
        // Non-network (e.g. abort after logic bug) — still try mirrors once.
      }
    }
  }

  res.statusCode = 502
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('X-Overpass-Proxy-Error', 'all-mirrors-failed')
  res.end(
    JSON.stringify({
      error: 'All Overpass mirrors failed',
      detail: lastErr?.message ?? 'unknown',
    }),
  )
}

/** Shared long timeouts + quieter error log for other OSM proxies. */
function hardenProxy(label: string, extra: ProxyOptions = {}): ProxyOptions {
  return {
    ...extra,
    changeOrigin: true,
    timeout: 60_000,
    proxyTimeout: 60_000,
    secure: true,
    configure: (proxy) => {
      extra.configure?.(proxy, { ...extra, changeOrigin: true })
      proxy.on('error', (err, _req, _res) => {
        console.warn(`[vite proxy ${label}]`, err.message)
      })
      proxy.on('proxyReq', (proxyReq) => {
        // Avoid hanging sockets when upstream stalls mid-handshake.
        proxyReq.setTimeout(60_000)
      })
    },
  }
}

/**
 * Dev proxy avoids browser CORS when talking to public OSM services
 * and AWS Terrarium elevation tiles (S3 sends no Access-Control-* headers).
 * Open-Meteo already sends CORS *, but we proxy it too so one origin serves
 * elev + weather in dev (and as a belt-and-suspenders fallback).
 * Production builds fall back to demo streets / Open-Meteo direct / quiet flat
 * if APIs are unreachable (see elevation.ts, weather.ts, osmStreets.ts).
 *
 * Overpass uses `overpassFailoverProxy` (not this table) so TLS flaps can
 * rotate mirrors without the browser seeing a 502 stab.
 */
export default defineConfig({
  plugins: [react(), overpassFailoverProxy()],
  server: {
    proxy: {
      '/api/nominatim': hardenProxy('nominatim', {
        target: 'https://nominatim.openstreetmap.org',
        rewrite: (path) => path.replace(/^\/api\/nominatim/, ''),
        headers: {
          'User-Agent': OVERPASS_UA,
        },
      }),
      '/api/osrm': hardenProxy('osrm', {
        target: 'https://router.project-osrm.org',
        rewrite: (path) => path.replace(/^\/api\/osrm/, ''),
      }),
      // Mapzen Terrarium on AWS Open Data — SRTM-family elev for hills.
      // Browser → /api/terrarium/12/709/1613.png
      // Proxy  → https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/709/1613.png
      '/api/terrarium': hardenProxy('terrarium', {
        target: 'https://s3.amazonaws.com/elevation-tiles-prod',
        rewrite: (path) => path.replace(/^\/api\/terrarium/, '/terrarium'),
      }),
      // Open-Meteo — elevation grid + forecast weather (free, no key).
      // Browser → /api/open-meteo/v1/elevation?latitude=…&longitude=…
      // Proxy  → https://api.open-meteo.com/v1/elevation?…
      '/api/open-meteo': hardenProxy('open-meteo', {
        target: 'https://api.open-meteo.com',
        rewrite: (path) => path.replace(/^\/api\/open-meteo/, ''),
      }),
    },
  },
})
