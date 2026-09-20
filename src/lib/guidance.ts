/**
 * Soft steering hint toward the blue guidance path.
 * Not hard rails — just a gentle pull so kids can stay on the line.
 */
import { xzDistance } from './geo'

export type Hint = {
  /** Desired forward heading in world XZ (unit vector). */
  dirX: number
  dirZ: number
  /** 0..1 how strongly to blend toward the path. */
  strength: number
  /** Distance to nearest path point (meters). */
  distance: number
}

/**
 * Find the nearest polyline segment and return a soft heading toward
 * the next point along the path.
 */
export function softSteeringHint(
  carX: number,
  carZ: number,
  path: Array<[number, number, number]>,
): Hint | null {
  if (path.length < 2) return null

  let bestI = 0
  let bestD = Infinity
  for (let i = 0; i < path.length; i++) {
    const d = xzDistance({ x: carX, z: carZ }, path[i])
    if (d < bestD) {
      bestD = d
      bestI = i
    }
  }

  // Aim a few points ahead so we look down the road, not sideways.
  const lookAhead = Math.min(bestI + 3, path.length - 1)
  const target = path[lookAhead]
  const dx = target[0] - carX
  const dz = target[2] - carZ
  const len = Math.hypot(dx, dz) || 1

  // Soften with distance: strong near the line, fades when far away.
  const strength = Math.max(0, Math.min(1, 1 - bestD / 80))

  return {
    dirX: dx / len,
    dirZ: dz / len,
    strength: strength * 0.45, // keep it gentle (not hard rails)
    distance: bestD,
  }
}
