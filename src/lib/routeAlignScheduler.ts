/**
 * Idle-deferred / coalesced route align (Forge remount + Page Unresponsive fix).
 *
 * LEARNING — why not useMemo(alignRouteToLoadedWays)?
 *   Arch snap runs buildStreetGraph + densify + per-sample snap + Dijkstra hops.
 *   Doing that synchronously on every ways fingerprint (tile stream) blocks the
 *   main thread in the same tick as Road mesh apply → Chrome “Page Unresponsive”,
 *   rAF stalls, and classic remount symptoms (speed blip / camera intro) when
 *   Canvas Suspense recovers from a long freeze.
 *
 *   This scheduler:
 *     1) Paints raw OSRM immediately (blue line + AP keep working).
 *     2) Coalesces fingerprint storms (latest wins).
 *     3) Runs align after rAF + idle/timeout so mesh apply paints first.
 *     4) Passes a soft time budget so one align never monopolizes the tab.
 */

import {
  alignRouteToLoadedWays,
  type AlignOptions,
  type LoadedWayPoly,
} from './streetGraph'
import type { XzPoint } from './roadMesh'

export type RouteAlignScheduler = {
  /** Queue an align. Repeated calls before run replace the pending job. */
  schedule: (job: {
    rawPath: XzPoint[]
    ways: LoadedWayPoly[]
    fingerprint: string
    /**
     * Optional: paint raw immediately (new destination). Omit on fingerprint-
     * only replans so AP keeps the previous aligned path until idle finishes.
     */
    onRaw?: (raw: XzPoint[]) => void
    onAligned: (aligned: XzPoint[], fingerprint: string) => void
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
    onAligned: (aligned: XzPoint[], fingerprint: string) => void
  } | null = null
  let coalesceTimer = 0
  let raf = 0
  let idleId = 0
  let timeoutId = 0
  let disposed = false
  let gen = 0
  let lastFp = ''

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

  const runAlign = () => {
    raf = 0
    idleId = 0
    timeoutId = 0
    if (disposed || !pending) return
    const job = pending
    pending = null
    if (job.fingerprint === lastFp) return
    const myGen = ++gen
    const alignOpts: AlignOptions = { timeBudgetMs }
    const aligned = alignRouteToLoadedWays(job.rawPath, job.ways, alignOpts)
    if (disposed || myGen !== gen) return
    lastFp = job.fingerprint
    job.onAligned(aligned, job.fingerprint)
  }

  const armIdle = () => {
    if (disposed) return
    // After paint: prefer idle; fall back to a short timeout so AP still snaps.
    if (typeof requestIdleCallback === 'function') {
      idleId = requestIdleCallback(() => runAlign(), { timeout: 280 })
    } else {
      timeoutId = window.setTimeout(runAlign, 0)
    }
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
        lastFp = ''
        job.onAligned([], '')
        return
      }

      if (job.fingerprint === lastFp && pending == null) {
        // Already aligned this geometry — skip redundant graph work.
        return
      }

      // Seed raw only when asked (new destination) — fingerprint-only replans
      // keep the previous aligned path until the idle job finishes (no AP thrash).
      if (job.onRaw) job.onRaw(rawCopy)

      pending = {
        rawPath: job.rawPath,
        ways: job.ways,
        fingerprint: job.fingerprint,
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
          armIdle()
        })
      }, coalesceMs)
    },
    dispose() {
      disposed = true
      pending = null
      clearArms()
    },
  }
}
