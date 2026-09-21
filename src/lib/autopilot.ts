/**
 * Street / GPS autopilot — simple centerline SNAP + SLIDE (Joey 2026-09-21).
 *
 * DESIGN (clarified): AP does NOT obey realistic steering radius / bicycle
 * turn limits. It travels along the blue destination/route polyline by:
 *   1) Projecting the car onto the nearest path segment
 *   2) Looking a short distance ahead along the arc
 *   3) Soft-snapping XZ toward the centerline (slide)
 *   4) Aiming yaw straight at the look-ahead (instant heading, no δ lock)
 *
 * WHY not pure-pursuit + bicycle?
 *   At 200 mph arcade AP, curvature-limited wheel angle fights the toy feel
 *   and still drifts off the blue line. Snap/slide keeps the car *on* the
 *   guidance path; throttle/brake only modulate commanded speed (0–200).
 *
 * Path source: the **driven** route from App — full OSRM spine with a
 * near-car street splice onto loaded (active+cached) ways (streetGraph.ts).
 * Far legs stay untouched OSRM (long-haul highways); near the car, asphalt
 * centerlines. Never engage on geodesic straight-fallback (driveBrain gate).
 *
 * Cruise (A/✕/C) stays independent — engaging AP cancels cruise; reverse /
 * toggle / arrive near destination cancel AP.
 */

import { projectOntoPath } from './guidance'
import {
  nearestCenterlineOnWays,
  type LoadedWayPoly,
} from './streetGraph'

/** On-road AP cap (mph). Manual / cruise stay at MAX_SPEED_MPH (~110). */
export const AUTOPILOT_MAX_SPEED_MPH = 200

/** Arrive / auto-disengage when this close to the path end (meters). */
export const AUTOPILOT_ARRIVE_M = 22

/** Soft lateral pull toward centerline (fraction of error per second). */
export const AUTOPILOT_SNAP_PER_S = 4.5

/** Cap how far one frame may yank XZ toward the line (meters). */
export const AUTOPILOT_SNAP_MAX_M = 3.5

/**
 * If path look-ahead sits farther than this from a loaded centerline,
 * re-snap aim onto asphalt this frame (don't drive into dirt).
 */
export const AP_OFF_ASPHALT_M = 12

/**
 * Look-ahead along the path (meters). Scales a bit with speed so the nose
 * points past the next wiggle, but stays short — we snap, we don't arc.
 */
export function autopilotLookAheadM(speedMs: number): number {
  const v = Math.abs(speedMs)
  return Math.max(10, Math.min(36, 10 + v * 0.35))
}

/** How fast the AP speed *target* rises/falls when gas/brake are held. */
export const AP_TARGET_RAISE_MPH_S = 28
export const AP_TARGET_LOWER_MPH_S = 45

/**
 * HUD → Car command bus (no remount). HUD sets hudToggle; Car consumes the
 * rising edge each frame. forceOff is set when destination is cleared.
 */
export const autopilotControl = {
  hudToggle: false,
  forceOff: false,
}

export type AutopilotFollow = {
  /** Soft-snapped world X (slide toward centerline). */
  x: number
  /** Soft-snapped world Z. */
  z: number
  /** Unit forward in XZ — aim the nose here (bypass bicycle δ). */
  dirX: number
  dirZ: number
  /** Meters to path end (for arrive cancel). */
  distToEnd: number
  /** Lateral distance to centerline before snap. */
  lateralM: number
  /** True when path is usable. */
  ok: boolean
}

/**
 * One AP follow sample: snap toward centerline + heading along look-ahead.
 *
 * LEARNING — geometry (XZ only, Y is terrain-pinned elsewhere):
 *   Hit = nearest point on polyline (see projectOntoPath).
 *   Target = walk lookAheadM forward from hit.sAlong.
 *   dir = normalize(target − car) — or path tangent if extremely close.
 *   Snap: carXZ ← carXZ + clamp(hit − carXZ) * (1 − e^(−k·dt))
 *   (exponential blend ≈ "slide onto the line" without a hard teleport).
 */
export function followPathSnapSlide(
  carX: number,
  carZ: number,
  path: Array<[number, number, number]>,
  speedMs: number,
  dt: number,
  /**
   * Loaded asphalt centerlines near the car. When path look-ahead leaves
   * asphalt vs these, re-snap aim onto the nearest centerline this frame.
   */
  centerlineWays?: LoadedWayPoly[],
): AutopilotFollow {
  const fail: AutopilotFollow = {
    x: carX,
    z: carZ,
    dirX: 0,
    dirZ: -1,
    distToEnd: Infinity,
    lateralM: Infinity,
    ok: false,
  }
  if (path.length < 2) return fail

  const hit = projectOntoPath(carX, carZ, path)
  if (!hit) return fail

  const look = autopilotLookAheadM(speedMs)
  let target = pointAtArcLength(path, hit.sAlong, look)
  const end = path[path.length - 1]
  const distToEnd = Math.hypot(end[0] - carX, end[2] - carZ)

  // LEARNING (Joey peel-off): if blue look-ahead already left asphalt relative
  // to loaded ways, do NOT aim into dirt — re-snap onto nearest centerline and
  // aim along its tangent (preferring the direction of path progress).
  let snapX = hit.x
  let snapZ = hit.z
  let dirX = target.x - carX
  let dirZ = target.z - carZ
  if (centerlineWays && centerlineWays.length > 0) {
    const la = nearestCenterlineOnWays(
      centerlineWays,
      target.x,
      target.z,
      AP_OFF_ASPHALT_M + 24,
    )
    if (la && la.dist > AP_OFF_ASPHALT_M) {
      target = { x: la.x, z: la.z }
      // Flip tangent if it points away from path progress.
      const prog = Math.hypot(dirX, dirZ) > 1e-6
        ? (la.dirX * dirX + la.dirZ * dirZ)
        : 1
      const sign = prog >= 0 ? 1 : -1
      dirX = la.dirX * sign
      dirZ = la.dirZ * sign
    } else if (la) {
      // Look-ahead still near asphalt — keep path aim but pin target to ribbon.
      target = { x: la.x, z: la.z }
      dirX = target.x - carX
      dirZ = target.z - carZ
    }
    const carSnap = nearestCenterlineOnWays(
      centerlineWays,
      carX,
      carZ,
      AP_OFF_ASPHALT_M + 24,
    )
    if (carSnap && carSnap.dist > 1.5) {
      // Soft-slide toward asphalt if the published path itself drifted.
      snapX = carSnap.x
      snapZ = carSnap.z
    }
  } else {
    dirX = target.x - carX
    dirZ = target.z - carZ
  }

  let len = Math.hypot(dirX, dirZ)
  if (len < 0.35) {
    // Past look-ahead (near end) — aim along last segment tangent.
    const a = path[path.length - 2]
    const b = path[path.length - 1]
    dirX = b[0] - a[0]
    dirZ = b[2] - a[2]
    len = Math.hypot(dirX, dirZ)
  }
  if (len < 1e-6) return { ...fail, distToEnd, lateralM: hit.distance, ok: false }
  dirX /= len
  dirZ /= len

  // Soft snap toward centerline projection (not a hard teleport).
  const t = Math.max(0, Math.min(dt, 0.05))
  const blend = 1 - Math.exp(-AUTOPILOT_SNAP_PER_S * t)
  let sx = (snapX - carX) * blend
  let sz = (snapZ - carZ) * blend
  const snapLen = Math.hypot(sx, sz)
  if (snapLen > AUTOPILOT_SNAP_MAX_M && snapLen > 1e-8) {
    const s = AUTOPILOT_SNAP_MAX_M / snapLen
    sx *= s
    sz *= s
  }

  return {
    x: carX + sx,
    z: carZ + sz,
    dirX,
    dirZ,
    distToEnd,
    lateralM: hit.distance,
    ok: true,
  }
}

/** Walk `lookAheadM` meters forward from arc length `s0` (clamps to end). */
function pointAtArcLength(
  path: Array<[number, number, number]>,
  s0: number,
  lookAheadM: number,
): { x: number; z: number } {
  const targetS = s0 + lookAheadM
  let s = 0
  for (let i = 0; i < path.length - 1; i++) {
    const ax = path[i][0]
    const az = path[i][2]
    const bx = path[i + 1][0]
    const bz = path[i + 1][2]
    const segLen = Math.hypot(bx - ax, bz - az) || 1e-6
    if (s + segLen >= targetS) {
      const u = (targetS - s) / segLen
      return { x: ax + (bx - ax) * u, z: az + (bz - az) * u }
    }
    s += segLen
  }
  const last = path[path.length - 1]
  return { x: last[0], z: last[2] }
}

/**
 * Yaw (rad) so forward (−sin θ, −cos θ) matches unit dir (dirX, dirZ).
 * Same convention as Car / GpsDash: yaw 0 faces world −Z (north).
 */
export function yawFromForwardXZ(dirX: number, dirZ: number): number {
  // forward = (−sin θ, −cos θ) = (dirX, dirZ)
  // ⇒ sin θ = −dirX, cos θ = −dirZ ⇒ θ = atan2(−dirX, −dirZ)
  return Math.atan2(-dirX, -dirZ)
}
