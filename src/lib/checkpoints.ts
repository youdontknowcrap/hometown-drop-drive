/**
 * Destination checkpoint gates along the published on-asphalt path.
 *
 * LEARNING — place by path arc length (not crow-flight). Rebuild only when
 * the destination / path signature changes — not on every near-car splice
 * micro-update. Scoring is in-order: gate i must clear before i+1 counts.
 */

import type { XzPoint } from './roadMesh'

export type CheckpointGate = {
  id: string
  /** Gate center on ribbon (XZ). */
  x: number
  z: number
  /** Incoming route tangent (unit) — gate faces traffic. */
  dirX: number
  dirZ: number
  /** Arc length from path start (meters). */
  sAlong: number
  /** Index 0..N-1 along the trip. */
  index: number
}

/** Opening width between posts (meters) — AP fits on centerline. */
export const GATE_OPENING_M = 7
/** Post height (meters). */
export const GATE_POST_H_M = 4.2
/** First gate distance along path (meters). */
export const GATE_FIRST_M = 100
/** Spacing between subsequent gates (meters). */
export const GATE_SPACING_M = 320
/** Keep last gate at least this far from dest end. */
export const GATE_LAST_END_PAD_M = 40
/** Min gap between last gate and previous. */
export const GATE_MIN_GAP_M = 180

/** Live HUD mirror — Gateways writes, CheckpointHud reads (no React storm). */
export const checkpointHud = {
  active: false,
  score: 0,
  cleared: 0,
  total: 0,
  /** Seconds since dest-set (or first movement after dest). */
  timerSec: 0,
  /** Bumped on new dest / clear so UI resets. */
  nonce: 0,
}

export function resetCheckpointHud(nonce: number) {
  checkpointHud.active = false
  checkpointHud.score = 0
  checkpointHud.cleared = 0
  checkpointHud.total = 0
  checkpointHud.timerSec = 0
  checkpointHud.nonce = nonce
}

/**
 * Signature for rebuild: dest key + coarse path shape.
 * LEARNING — ignore tiny splice wiggles (quantize length + endpoints).
 */
export function pathCheckpointSignature(
  path: XzPoint[],
  destKey: string,
): string {
  if (path.length < 2) return `${destKey}|empty`
  const len = Math.round(pathArcLength(path) / 25) * 25
  const a = path[0]
  const b = path[path.length - 1]
  return `${destKey}|${path.length}|${len}|${a[0].toFixed(0)},${a[2].toFixed(0)}|${b[0].toFixed(0)},${b[2].toFixed(0)}`
}

export function pathArcLength(path: XzPoint[]): number {
  let s = 0
  for (let i = 0; i < path.length - 1; i++) {
    s += Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][2] - path[i][2])
  }
  return s
}

/** Point + tangent at arc length s along path. */
export function pointTangentAtS(
  path: XzPoint[],
  sTarget: number,
): { x: number; z: number; dirX: number; dirZ: number; s: number } | null {
  if (path.length < 2) return null
  let s = 0
  for (let i = 0; i < path.length - 1; i++) {
    const ax = path[i][0]
    const az = path[i][2]
    const bx = path[i + 1][0]
    const bz = path[i + 1][2]
    const seg = Math.hypot(bx - ax, bz - az)
    if (seg < 1e-6) continue
    if (s + seg >= sTarget || i === path.length - 2) {
      const t = seg < 1e-6 ? 0 : Math.max(0, Math.min(1, (sTarget - s) / seg))
      const x = ax + (bx - ax) * t
      const z = az + (bz - az) * t
      let dirX = (bx - ax) / seg
      let dirZ = (bz - az) / seg
      return { x, z, dirX, dirZ, s: s + seg * t }
    }
    s += seg
  }
  const a = path[path.length - 2]
  const b = path[path.length - 1]
  const seg = Math.hypot(b[0] - a[0], b[2] - a[2]) || 1
  return {
    x: b[0],
    z: b[2],
    dirX: (b[0] - a[0]) / seg,
    dirZ: (b[2] - a[2]) / seg,
    s,
  }
}

/**
 * Place archway gates along published path length.
 * First ~100 m out; then every ~320 m; last near dest when runway allows.
 */
export function buildGatesAlongPath(path: XzPoint[]): CheckpointGate[] {
  const total = pathArcLength(path)
  if (total < GATE_FIRST_M + 30 || path.length < 2) return []

  const targets: number[] = []
  // First gate 80–120 m (nominal 100).
  const first = Math.min(
    Math.max(80, GATE_FIRST_M),
    Math.min(120, total * 0.35),
  )
  if (first < total - GATE_LAST_END_PAD_M) targets.push(first)

  let s = first + GATE_SPACING_M
  const lastLimit = total - GATE_LAST_END_PAD_M
  while (s < lastLimit) {
    targets.push(s)
    s += GATE_SPACING_M
  }

  // Ensure a finish-ish gate near dest when the last spacing left a gap.
  if (targets.length === 0) {
    targets.push(Math.min(first, lastLimit))
  } else {
    const last = targets[targets.length - 1]
    if (lastLimit - last >= GATE_MIN_GAP_M) {
      targets.push(lastLimit)
    } else if (last < total * 0.85 && lastLimit > last + 40) {
      targets[targets.length - 1] = lastLimit
    }
  }

  const gates: CheckpointGate[] = []
  for (let i = 0; i < targets.length; i++) {
    const hit = pointTangentAtS(path, targets[i])
    if (!hit) continue
    gates.push({
      id: `g${i}-${hit.s.toFixed(0)}`,
      x: hit.x,
      z: hit.z,
      dirX: hit.dirX,
      dirZ: hit.dirZ,
      sAlong: hit.s,
      index: i,
    })
  }
  return gates
}
