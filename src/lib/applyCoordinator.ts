/**
 * Frame-budgeted apply coordinator for streamed tile meshes.
 *
 * LEARNING — why coalesce?
 *   Workers finish fetch/decode off-thread, but main still has to setState and
 *   rebuild Road / Ground / Buildings. If every tile completion (and every
 *   buildings follow-up) calls setState immediately, React + three.js dump
 *   several mesh rebuilds in one frame — Joey feels a “bump” per tile.
 *
 *   This coordinator:
 *     1) Coalesces many schedule() calls into ONE pending job (latest wins).
 *     2) Flushes at most once per animation frame (never 9 Drop tiles in one
 *        synchronous burst of separate React commits).
 *     3) Optionally waits a short coalesce window so ways + buildings that
 *        finish back-to-back become a single apply.
 *
 *   Fetch/decode stays in the worker. Main only applies the budgeted job.
 */

export type ApplyCoordinatorOptions = {
  /**
   * Quiet window (ms) after the first schedule before flush is armed.
   * Lets ways+buildings (or two in-flight tiles) merge into one apply.
   * 0 = arm RAF immediately.
   */
  coalesceMs?: number
}

export type ApplyCoordinator = {
  /** Queue an apply. Repeated calls before flush replace the pending job. */
  schedule: (apply: () => void) => void
  /** Cancel pending work (Drop teardown / unmount). */
  dispose: () => void
}

export function createApplyCoordinator(
  opts: ApplyCoordinatorOptions = {},
): ApplyCoordinator {
  const coalesceMs = opts.coalesceMs ?? 32
  let pending: (() => void) | null = null
  let raf = 0
  let coalesceTimer = 0
  let disposed = false

  const flush = () => {
    raf = 0
    coalesceTimer = 0
    if (disposed || !pending) return
    const job = pending
    pending = null
    job()
  }

  const armRaf = () => {
    if (disposed || raf) return
    raf = requestAnimationFrame(flush)
  }

  return {
    schedule(apply) {
      if (disposed) return
      // Latest snapshot wins — streamer.snapshot() is always current.
      pending = apply
      if (raf) return // already armed for this frame
      if (coalesceMs <= 0) {
        armRaf()
        return
      }
      if (coalesceTimer) return // quiet window already running
      coalesceTimer = window.setTimeout(() => {
        coalesceTimer = 0
        armRaf()
      }, coalesceMs)
    },
    dispose() {
      disposed = true
      pending = null
      if (raf) {
        cancelAnimationFrame(raf)
        raf = 0
      }
      if (coalesceTimer) {
        window.clearTimeout(coalesceTimer)
        coalesceTimer = 0
      }
    },
  }
}
