/**
 * Soft steering hint toward the blue GPS guidance path.
 * Not hard rails — just a gentle pull so kids can stay on the line.
 *
 * Uses nearest-segment projection + look-ahead in meters (not nearest
 * vertex / N verts ahead). Kids who cut corners still get a sensible
 * heading; U-turns don't aim at the previous vertex.
 */
import { xzDistance } from './geo'

export type Hint = {
  /** Desired forward heading in world XZ (unit vector). */
  dirX: number
  dirZ: number
  /** 0..1 how strongly to blend toward the path. */
  strength: number
  /** Distance to nearest path segment (meters). */
  distance: number
}

export type PathProjection = {
  /** Closest point on the polyline (XZ). */
  x: number
  z: number
  /** Perpendicular distance from the car to that point (meters). */
  distance: number
  /** Arc length along the path from the first vertex to the projection. */
  sAlong: number
  /** Segment index [i → i+1] containing the projection. */
  segmentIndex: number
  /** 0..1 param along that segment. */
  t: number
}

/** Soft blend fades by this lateral distance (was 80 m — way too soft). */
const STRENGTH_FADE_M = 32
/** Aim this far ahead along the path from the projection. */
const LOOK_AHEAD_M = 28
/** Cap soft-steer blend so it never becomes rails. */
const STRENGTH_SCALE = 0.45

/**
 * Project (x, z) onto the nearest polyline segment in XZ.
 * Returns null if the path is empty / a single point.
 */
export function projectOntoPath(
  carX: number,
  carZ: number,
  path: Array<[number, number, number]>,
): PathProjection | null {
  if (path.length < 2) return null

  let bestDist = Infinity
  let bestX = path[0][0]
  let bestZ = path[0][2]
  let bestSeg = 0
  let bestT = 0
  let bestS = 0
  let sAtSegStart = 0

  for (let i = 0; i < path.length - 1; i++) {
    const ax = path[i][0]
    const az = path[i][2]
    const bx = path[i + 1][0]
    const bz = path[i + 1][2]
    const abx = bx - ax
    const abz = bz - az
    const abLenSq = abx * abx + abz * abz
    const segLen = Math.sqrt(abLenSq) || 1e-6

    let t = 0
    if (abLenSq > 1e-12) {
      t = ((carX - ax) * abx + (carZ - az) * abz) / abLenSq
      t = Math.max(0, Math.min(1, t))
    }
    const px = ax + abx * t
    const pz = az + abz * t
    const d = Math.hypot(carX - px, carZ - pz)

    if (d < bestDist) {
      bestDist = d
      bestX = px
      bestZ = pz
      bestSeg = i
      bestT = t
      bestS = sAtSegStart + segLen * t
    }
    sAtSegStart += segLen
  }

  return {
    x: bestX,
    z: bestZ,
    distance: bestDist,
    sAlong: bestS,
    segmentIndex: bestSeg,
    t: bestT,
  }
}

/** Lateral distance to the guidance polyline (Infinity if no path). */
export function distanceToPath(
  carX: number,
  carZ: number,
  path: Array<[number, number, number]>,
): number {
  const hit = projectOntoPath(carX, carZ, path)
  return hit ? hit.distance : Infinity
}

/**
 * Walk `lookAheadM` meters forward along the path from arc length `s0`.
 * Clamps to the last vertex.
 */
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
 * Soft heading toward a point LOOK_AHEAD_M along the path from the
 * nearest-segment projection. Strength fades with lateral distance.
 */
export function softSteeringHint(
  carX: number,
  carZ: number,
  path: Array<[number, number, number]>,
): Hint | null {
  const hit = projectOntoPath(carX, carZ, path)
  if (!hit) return null

  const target = pointAtArcLength(path, hit.sAlong, LOOK_AHEAD_M)
  // Prefer aiming from the car toward the look-ahead point so the blend
  // corrects both lateral error and heading in one soft nudge.
  const dx = target.x - carX
  const dz = target.z - carZ
  const len = Math.hypot(dx, dz)
  if (len < 0.5) {
    // Extremely close to the end of the path — no useful heading.
    return {
      dirX: 0,
      dirZ: -1,
      strength: 0,
      distance: hit.distance,
    }
  }

  const strength = Math.max(0, Math.min(1, 1 - hit.distance / STRENGTH_FADE_M))

  return {
    dirX: dx / len,
    dirZ: dz / len,
    strength: strength * STRENGTH_SCALE,
    distance: hit.distance,
  }
}

/** Re-export for callers that already measured a point-to-point distance. */
export { xzDistance }
