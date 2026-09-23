/**
 * Idle-deferred / coalesced near-car route splice (Forge remount + hang fix).
 *
 * LEARNING — why not useMemo(alignRouteToLoadedWays)?
 *   Even near-bubble snap runs buildStreetGraph + densify + Dijkstra hops.
 *   Doing that synchronously on every ways fingerprint (tile stream) blocks the
 *   main thread in the same tick as Road mesh apply → Chrome “Page Unresponsive”,
 *   rAF stalls, and classic remount symptoms (speed blip / camera intro) when
 *   Canvas Suspense recovers from a long freeze.
 *
 * LEARNING — never publish crow-flight to AP while ways loaded:
 *   Hang-budget early-bail used to append raw densified points (or return a
 *   straight fallback) and `onAligned` swapped that into routeLocal mid-drive.
 *   AP look-ahead then aimed along a geodesic → diagonal cross-lots.
 *   This scheduler:
 *     1) Paints **full OSRM** immediately on new destination (long-haul spine).
 *     2) Coalesces fingerprint storms (latest wins).
 *     3) Idle-runs near-car splice under a soft time budget.
 *     4) Publishes only `publishable` results; keeps last good OSRM/spliced
 *        path when align times out, returns geodesic junk, or a near splice
 *        would leave asphalt (soft-fail / thin cache / bad hop).
 *     5) Does NOT replace the entire OSRM course with a local-only graph path.
 */

import {
  alignRouteToLoadedWays,
  type AlignOptions,
  type AlignResult,
  type LoadedWayPoly,
} from './streetGraph'
import type { XzPoint } from './roadMesh'

export type RouteAlignScheduler = {
  /** Queue an align. Repeated calls before run replace the pending job. */
  schedule: (job: {
    rawPath: XzPoint[]
    ways: LoadedWayPoly[]
    fingerprint: string
    /** Car XZ for near-bubble center (live pose). */
    carX?: number
    carZ?: number
    /** True when rawPath is OSRM road-following (not straight fallback). */
    rawIsStreetFollowing?: boolean
    /**
     * Optional: paint raw immediately (new destination). OSRM spine only —
     * omit on fingerprint-only replans so AP keeps the previous path until
     * idle finishes. Caller should skip this for straight-fallback when ways
     * exist near the car.
     */
    onRaw?: (raw: XzPoint[]) => void
    onAligned: (aligned: XzPoint[], meta: AlignResult) => void
  }) => void
  /** Cancel pending work (Drop / clear destination / unmount). */
  dispose: () => void
}

export type RouteAlignSchedulerOptions = {
  /** Quiet window after last schedule before idle align (ms). */
  coalesceMs?: number
  /** Soft wall-clock budget handed to alignRouteToLoadedWays. */
  timeBudgetMs?: number
}

export function createRouteAlignScheduler(
  opts: RouteAlignSchedulerOptions = {},
): RouteAlignScheduler {
  const coalesceMs = opts.coalesceMs ?? 140
  const timeBudgetMs = opts.timeBudgetMs ?? 6
  let pending: {
    rawPath: XzPoint[]
    ways: LoadedWayPoly[]
    fingerprint: string
    carX?: number
    carZ?: number
    rawIsStreetFollowing?: boolean
    onAligned: (aligned: XzPoint[], meta: AlignResult) => void
  } | null = null
  let coalesceTimer = 0
  let raf = 0
  let idleId = 0
  let timeoutId = 0
  let disposed = false
  let gen = 0
  /** Fingerprint of last *published* splice (not merely attempted). */
  let lastPublishedFp = ''
  /** Last publishable path — prefer over geodesic / timed-out junk. */
  let lastGood: XzPoint[] | null = null

  const clearArms = () => {
    if (coalesceTimer) {
      window.clearTimeout(coalesceTimer)
      coalesceTimer = 0
    }
    if (raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }
    if (idleId && typeof cancelIdleCallback === 'function') {
      cancelIdleCallback(idleId)
      idleId = 0
    }
    if (timeoutId) {
      window.clearTimeout(timeoutId)
      timeoutId = 0
    }
  }

  const armIdle = (fn: () => void) => {
    if (disposed) return
    if (typeof requestIdleCallback === 'function') {
      idleId = requestIdleCallback(() => fn(), { timeout: 280 })
    } else {
      timeoutId = window.setTimeout(fn, 0)
    }
  }

  const runAlign = () => {
    raf = 0
    idleId = 0
    timeoutId = 0
    if (disposed || !pending) return
    const job = pending
    // Keep pending when timedOut so we can resume next idle on same fp.
    const myGen = ++gen
    const alignOpts: AlignOptions = {
      timeBudgetMs,
      carX: job.carX,
      carZ: job.carZ,
      rawIsStreetFollowing: job.rawIsStreetFollowing,
    }
    const result = alignRouteToLoadedWays(job.rawPath, job.ways, alignOpts)
    if (disposed || myGen !== gen) return

    if (result.publishable && result.path.length >= 2) {
      lastGood = result.path.map((p) => [p[0], 0, p[2]] as XzPoint)
      job.onAligned(lastGood, result)
      if (!result.timedOut) {
        lastPublishedFp = job.fingerprint
        pending = null
      } else {
        // Partial near-snap under budget — keep OSRM spine publish, resume
        // idle for a fuller splice without marking fp done forever.
        pending = job
        armIdle(() => {
          raf = requestAnimationFrame(() => {
            raf = 0
            runAlign()
          })
        })
      }
      return
    }

    // Not publishable (e.g. straight fallback, empty chase). Keep last good
    // if we have one; otherwise surface nothing new (caller keeps prior UI).
    if (lastGood && lastGood.length >= 2) {
      job.onAligned(lastGood, {
        ...result,
        path: lastGood,
        publishable: true,
        kind: result.kind === 'fallback-raw' ? 'fallback-chase' : result.kind,
      })
    }
    // Only resume on soft timeout — fingerprint change re-schedules when
    // more ways stream in. Do not spin forever on fallback-raw.
    if (result.timedOut) {
      pending = job
      armIdle(() => {
        raf = requestAnimationFrame(() => {
          raf = 0
          runAlign()
        })
      })
      return
    }
    pending = null
    lastPublishedFp = job.fingerprint
  }

  return {
    schedule(job) {
      if (disposed) return
      const rawCopy = job.rawPath.map(
        (p) => [p[0], 0, p[2]] as XzPoint,
      )

      if (job.rawPath.length < 2) {
        clearArms()
        pending = null
        lastPublishedFp = ''
        lastGood = null
        job.onAligned([], {
          path: [],
          timedOut: false,
          didLocalSnap: false,
          publishable: false,
          kind: 'empty',
        })
        return
      }

      if (job.fingerprint === lastPublishedFp && pending == null) {
        // Already published a complete splice for this geometry.
        return
      }

      // New destination / OSRM spine: paint full course immediately so
      // long-haul GPS (cross-country highways) never waits on local tiles.
      if (job.onRaw) job.onRaw(rawCopy)

      // Nav change (different raw) — reset lastGood so we don't keep an old trip.
      if (job.onRaw) {
        lastGood = job.rawIsStreetFollowing === false ? null : rawCopy
        lastPublishedFp = ''
      }

      pending = {
        rawPath: job.rawPath,
        ways: job.ways,
        fingerprint: job.fingerprint,
        carX: job.carX,
        carZ: job.carZ,
        rawIsStreetFollowing: job.rawIsStreetFollowing,
        onAligned: job.onAligned,
      }
      // Coalesce: restart quiet window so tile storms become one align.
      if (coalesceTimer) window.clearTimeout(coalesceTimer)
      if (raf) {
        cancelAnimationFrame(raf)
        raf = 0
      }
      if (idleId && typeof cancelIdleCallback === 'function') {
        cancelIdleCallback(idleId)
        idleId = 0
      }
      if (timeoutId) {
        window.clearTimeout(timeoutId)
        timeoutId = 0
      }
      coalesceTimer = window.setTimeout(() => {
        coalesceTimer = 0
        raf = requestAnimationFrame(() => {
          raf = 0
          armIdle(runAlign)
        })
      }, coalesceMs)
    },
    dispose() {
      disposed = true
      pending = null
      lastGood = null
      clearArms()
    },
  }
}
