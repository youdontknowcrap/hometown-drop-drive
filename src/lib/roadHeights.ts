/**
 * Shared vertical offsets for asphalt vs desert vs car.
 *
 * LEARNING — keep these in ONE place:
 *   Road ribbons sit at sampleHeight + ROAD_Y_BIAS_M.
 *   Ground verts under ribbons are dug down by ROAD_TRENCH_M (shallow trench).
 *   Car pins Y to sampleHeight + CAR_CLEARANCE_M (same sampler — NOT the ribbon
 *   mesh). Clearance must stay a hair above the bias so the body sits ON the
 *   asphalt, not buried in it, when we raise the curb for arcade readability.
 */

import { widthForHighway } from './osmStreets'
import {
  isOnRoadSurface,
  type RoadSurfaceWay,
} from './roadSurface'
import type { XzPoint } from './roadMesh'

/** Arcade-readable curb: asphalt above the undepressed sampleHeight (meters). */
export const ROAD_Y_BIAS_M = 1.25

/**
 * How deep to dig desert verts under road corridors (meters).
 * sampleHeight() itself is unchanged — only the Ground / FarGround meshes.
 */
export const ROAD_TRENCH_M = 1.4

/**
 * RigidBody center above sampleHeight. Must clear ROAD_Y_BIAS_M so wheels /
 * body read as sitting on the ribbon (pinning still uses the sampler).
 */
export const CAR_CLEARANCE_M = ROAD_Y_BIAS_M + 0.2

/**
 * Densify OSM centerlines to this fraction of heightGrid.cellSize before
 * draping. Tighter than 1× so chords follow 5× hills between coarse cells.
 */
export const ROAD_DENSIFY_CELL_FRAC = 0.5

/** Soft outer pad past visual half-width so trench verts catch the ribbon. */
const TRENCH_CURB_PAD_M = 0.6

/**
 * Build corridor half-widths for the desert trench pass.
 *
 * LEARNING — why widen by ~0.55× cellSize?
 *   Near Ground is ~96² verts over a multi-km Drop, so cellSize is often
 *   40–70 m while asphalt is only ~7 m wide. A strict halfWidth test almost
 *   never hits a grid vertex. Inflating the corridor to ~half a cell ensures
 *   neighboring verts get dug down, forming a shallow valley the ribbon sits in.
 */
export function buildRoadTrenchWays(
  streets: Array<{ points: XzPoint[]; highway: string }>,
  cellSize: number,
): RoadSurfaceWay[] {
  const cellMargin = Math.max(4, cellSize * 0.55)
  return streets.map((s) => ({
    points: s.points,
    halfWidthM: widthForHighway(s.highway) * 0.5 + TRENCH_CURB_PAD_M + cellMargin,
  }))
}

/** Meters to subtract from a desert vertex Y under / near a road ribbon. */
export function trenchDepressionAt(
  x: number,
  z: number,
  trenchWays: RoadSurfaceWay[],
): number {
  if (!trenchWays.length) return 0
  return isOnRoadSurface(x, z, trenchWays) ? ROAD_TRENCH_M : 0
}
