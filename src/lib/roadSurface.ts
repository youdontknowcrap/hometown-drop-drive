/**
 * On-ribbon vs desert — soft off-road feel (Joey playtest).
 *
 * TWO layers of "leaving the road":
 *   1) ROAD SURFACE (this file) — half-width of each OSM way (paved OR track).
 *      Beyond that → desert dirt: arcade leave-bump + ~50% top speed.
 *   2) HARD CORRIDOR (`roadCorridor.ts` / RoadContainment) — ~200 ft / 61 m
 *      buffer around the whole network. Invisible walls so you can't wander
 *      forever. Last-resort fence; do NOT replace it with this soft check.
 *
 * LEARNING NOTE — why distance-to-segment, not a second raster?
 * Containment already rasterizes a big 61 m buffer for wall cuboids. For the
 * thin asphalt/track ribbon we only need a boolean each frame: "am I still on
 * a way?". Scanning centerline segments with early-exit is clear for teaching
 * and cheap enough for a ~3 km Drop (hundreds of segs, not millions).
 */

import type { XzPoint } from './roadMesh'
import { widthForHighway } from './osmStreets'

/** Extra meters past visual half-width so the car body still counts as "on".
 * Slightly generous — OSM centerlines wobble; false leave-bumps felt like
 * a bumpy asphalt ride (Joey). Still well inside the hard ~200 ft wall. */
export const ROAD_SURFACE_SLACK_M = 1.85

/**
 * One way's centerline + half-width (meters from centerline to edge of playable
 * ribbon, already including ROAD_SURFACE_SLACK_M when built via helpers below).
 */
export type RoadSurfaceWay = {
  points: XzPoint[]
  halfWidthM: number
}

function distPointToSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const abx = bx - ax
  const abz = bz - az
  const abLenSq = abx * abx + abz * abz
  if (abLenSq < 1e-12) return Math.hypot(px - ax, pz - az)
  let t = ((px - ax) * abx + (pz - az) * abz) / abLenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + abx * t), pz - (az + abz * t))
}

/**
 * Build surface ways from local streets (paved + service + dirt tracks all count
 * as "road corridor" for speed — only true desert is off-road).
 */
export function buildRoadSurfaceWays(
  streets: Array<{ points: XzPoint[]; highway: string }>,
): RoadSurfaceWay[] {
  return streets.map((s) => ({
    points: s.points,
    halfWidthM: widthForHighway(s.highway) * 0.5 + ROAD_SURFACE_SLACK_M,
  }))
}

/**
 * True if (x,z) is within halfWidth of any way centerline (paved or track).
 * Early-exits on first hit — typical while driving on asphalt.
 */
export function isOnRoadSurface(
  x: number,
  z: number,
  ways: RoadSurfaceWay[],
): boolean {
  for (const way of ways) {
    const hw = way.halfWidthM
    const hw2 = hw * hw
    const pts = way.points
    for (let i = 1; i < pts.length; i++) {
      const ax = pts[i - 1][0]
      const az = pts[i - 1][2]
      const bx = pts[i][0]
      const bz = pts[i][2]
      // Cheap reject: circle around segment midpoint.
      const mx = (ax + bx) * 0.5
      const mz = (az + bz) * 0.5
      const segHalf = Math.hypot(bx - ax, bz - az) * 0.5
      const reject = hw + segHalf
      const dx = x - mx
      const dz = z - mz
      if (dx * dx + dz * dz > reject * reject) continue
      const d = distPointToSegment(x, z, ax, az, bx, bz)
      if (d * d <= hw2) return true
    }
  }
  return false
}
