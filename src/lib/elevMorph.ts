/**
 * Animated elevation adjustment — morph terrain heights instead of hard-swap.
 *
 * LEARNING — why morph / lerp elev?
 *   Worker Terrarium decode is cheap off-thread, but the MAIN cost of “elevation
 *   adjusting” was React + Three hard-swapping HeightGrid → Ground/FarGround
 *   recreating PlaneGeometry + computeVertexNormals, Road re-drape clones, and
 *   Buildings re-pin — one frame storm that freezes the tab and can look like
 *   a camera remount (hitch ≠ remount, but both feel like a bump).
 *
 *   Prefer: keep Car / FollowCam / Scene mounted. When a new grid lands, copy
 *   it as a *target* and lerp the live Float32 heights over a short window.
 *   Ground mutates vertex Y in place (budgeted chunks). Car pin Y lerps toward
 *   the live sample. Far recenter morphs the same way — no hard cut.
 *
 *   Topology change (cols/rows or coverage jump): one geometry rebuild is OK,
 *   then morph Y from resampled-old → new so the swap still eases in.
 *
 * VERTICAL_EXAGGERATION stays 1 (Joey fidelity lock) — we only animate *when*
 * samples apply, never stretch relief.
 */

import { sampleHeight, type HeightGrid } from './terrarium'

/** Wall-clock blend for near/far elev settles (ms). Short = snappy, long = soft. */
export const ELEV_BLEND_MS = 520

/**
 * Main-thread vert apply budget per rAF (ms). Digging 96×96 + normals in one
 * go was a Page Unresponsive culprit — chunk across frames instead.
 */
export const ELEV_APPLY_BUDGET_MS = 5

/** How many height samples (or mesh verts) to touch per budget slice. */
export const ELEV_APPLY_CHUNK = 512

export function sameElevTopology(a: HeightGrid, b: HeightGrid): boolean {
  return (
    a.cols === b.cols &&
    a.rows === b.rows &&
    Math.abs(a.cellSize - b.cellSize) < 1e-6 &&
    Math.abs(a.originX - b.originX) < 1e-3 &&
    Math.abs(a.originZ - b.originZ) < 1e-3
  )
}

/** Coverage-compatible: same sample count (PlaneGeometry segment count reusable). */
export function sameElevResolution(a: HeightGrid, b: HeightGrid): boolean {
  return a.cols === b.cols && a.rows === b.rows
}

/**
 * Build a heights array for `target` topology by sampling `from` (or 0).
 * Used when the sliding window grows / far recenters — start morph from a
 * continuous surface instead of popping from flat zero.
 */
export function resampleHeightsOnto(
  from: HeightGrid,
  target: HeightGrid,
): Float32Array {
  const out = new Float32Array(target.cols * target.rows)
  for (let r = 0; r < target.rows; r++) {
    for (let c = 0; c < target.cols; c++) {
      const x = target.originX + c * target.cellSize
      const z = target.originZ + r * target.cellSize
      out[r * target.cols + c] = sampleHeight(from, x, z)
    }
  }
  return out
}

function cloneGridMeta(grid: HeightGrid, heights: Float32Array): HeightGrid {
  return {
    originX: grid.originX,
    originZ: grid.originZ,
    cellSize: grid.cellSize,
    cols: grid.cols,
    rows: grid.rows,
    heights,
    minRel: grid.minRel,
    maxRel: grid.maxRel,
    spawnElevMsl: grid.spawnElevMsl,
    source: grid.source,
    message: grid.message,
  }
}

function recomputeMinMax(heights: Float32Array): { minRel: number; maxRel: number } {
  let minRel = Infinity
  let maxRel = -Infinity
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i]
    if (!Number.isFinite(h)) continue
    if (h < minRel) minRel = h
    if (h > maxRel) maxRel = h
  }
  if (!Number.isFinite(minRel)) {
    minRel = 0
    maxRel = 0
  }
  return { minRel, maxRel }
}

export type ElevMorphState = {
  /** Mutable live grid — Car / Ground sample this every frame. */
  live: HeightGrid
  /** True while blendT < 1. */
  blending: boolean
  /**
   * Bumps when PlaneGeometry must rebuild (resolution or first paint).
   * Height-only morphs do NOT bump — avoids React remount storms.
   */
  topologyGen: number
  /**
   * Bumps when morph finishes (or hard-applied). Road re-drape / Buildings
   * can key off this instead of every worker tick.
   */
  settleGen: number
}

/**
 * Own one live HeightGrid; accept async worker targets without setState storms.
 */
export function createElevMorph(initial: HeightGrid): {
  state: ElevMorphState
  /** Queue a new worker grid (near or far). Coalesces — latest wins. */
  setTarget: (grid: HeightGrid) => void
  /** Advance blend; returns true if live.heights changed this tick. */
  tick: (dtSec: number) => boolean
  /** Replace live immediately (Drop reset). */
  hardReset: (grid: HeightGrid) => void
  getLive: () => HeightGrid
} {
  const state: ElevMorphState = {
    live: cloneGridMeta(initial, new Float32Array(initial.heights)),
    blending: false,
    topologyGen: 0,
    settleGen: 0,
  }

  let fromHeights: Float32Array | null = null
  let toGrid: HeightGrid | null = null
  let blendT = 1
  let pending: HeightGrid | null = null

  const beginMorph = (grid: HeightGrid) => {
    const live = state.live
    const topologyChanged = !sameElevResolution(live, grid)
    const coverageChanged = !sameElevTopology(live, grid)

    if (topologyChanged || coverageChanged) {
      // New coverage / segment count — publish new meta once; start from
      // resampled old surface so the window grow does not cliff.
      fromHeights = coverageChanged
        ? resampleHeightsOnto(live, grid)
        : new Float32Array(live.heights)
      const heights = new Float32Array(fromHeights)
      state.live = cloneGridMeta(grid, heights)
      if (topologyChanged || coverageChanged) {
        state.topologyGen += 1
      }
    } else {
      fromHeights = new Float32Array(live.heights)
      // Keep live object identity; only heights morph (Ground in-place path).
      state.live.spawnElevMsl = grid.spawnElevMsl
      state.live.source = grid.source
      state.live.message = grid.message
      state.live.minRel = grid.minRel
      state.live.maxRel = grid.maxRel
    }

    toGrid = grid
    blendT = 0
    state.blending = true
  }

  return {
    state,
    setTarget(grid) {
      if (state.blending) {
        // Coalesce: remember latest; tick will chain when current settles.
        pending = grid
        // If we're early in the blend, jump target to latest for responsiveness.
        if (blendT < 0.35 && toGrid && sameElevResolution(toGrid, grid)) {
          toGrid = grid
          fromHeights = new Float32Array(state.live.heights)
          blendT = 0
          if (!sameElevTopology(state.live, grid)) {
            // Coverage moved mid-blend — restart with resample.
            beginMorph(grid)
            pending = null
          }
        }
        return
      }
      beginMorph(grid)
    },
    tick(dtSec) {
      if (!state.blending || !toGrid || !fromHeights) {
        if (pending) {
          const next = pending
          pending = null
          beginMorph(next)
          return true
        }
        return false
      }

      blendT = Math.min(1, blendT + (dtSec * 1000) / ELEV_BLEND_MS)
      // Smoothstep — ease-in/out so first/last frames aren't snappy.
      const t = blendT * blendT * (3 - 2 * blendT)
      const liveH = state.live.heights
      const toH = toGrid.heights
      const n = liveH.length
      for (let i = 0; i < n; i++) {
        const a = fromHeights[i]
        const b = toH[i]
        liveH[i] = a + (b - a) * t
      }
      const mm = recomputeMinMax(liveH)
      state.live.minRel = mm.minRel
      state.live.maxRel = mm.maxRel

      if (blendT >= 1) {
        // Snap exact target meta (message / spawn lock / source).
        state.live.spawnElevMsl = toGrid.spawnElevMsl
        state.live.source = toGrid.source
        state.live.message = toGrid.message
        state.live.minRel = toGrid.minRel
        state.live.maxRel = toGrid.maxRel
        liveH.set(toH)
        state.blending = false
        fromHeights = null
        toGrid = null
        state.settleGen += 1
        if (pending) {
          const next = pending
          pending = null
          beginMorph(next)
        }
      }
      return true
    },
    hardReset(grid) {
      pending = null
      toGrid = null
      fromHeights = null
      blendT = 1
      state.blending = false
      state.live = cloneGridMeta(grid, new Float32Array(grid.heights))
      state.topologyGen += 1
      state.settleGen += 1
    },
    getLive: () => state.live,
  }
}
