/**
 * Hard playable corridor from OSM street centerlines.
 *
 * Buffer every loaded way by CONTAINMENT_M (~200 ft / 61 m), rasterize the
 * union, and emit thin vertical wall segments along the OUTER perimeter only.
 * That lets kids leave the asphalt and poke around, then hit a clean stop —
 * not Autopia rails hugging every residential curb.
 *
 * Soft off-road (leave bump + 50% speed) lives in `roadSurface.ts` — this file
 * is only the last-resort ~200 ft fence. Do not shrink CONTAINMENT_M to ribbon
 * half-width; that would become Autopia again.
 */

import type { XzPoint } from './roadMesh'

/** ~200 feet off the road network (product lock). */
export const CONTAINMENT_M = 61

/** Raster cell size. Smaller = smoother fence, more colliders. */
export const CORRIDOR_CELL_M = 14

const WALL_HEIGHT_M = 5
const WALL_THICKNESS_M = 1.6
/** Soft cap so a huge Drop bbox stays interactive. */
const MAX_CELLS = 420_000

export type ContainmentWall = {
  /** World X of cuboid center. */
  x: number
  /** World Z of cuboid center. */
  z: number
  /** Yaw around Y (radians). Length of the wall runs along local +X after yaw. */
  yaw: number
  /** Full length along the perimeter edge (meters). */
  length: number
  thickness: number
  height: number
}

type EdgeRun = {
  /** 'x' = wall spans along X (faces ±Z). 'z' = spans along Z (faces ±X). */
  axis: 'x' | 'z'
  /** Constant coordinate of the wall plane. */
  fixed: number
  /** Start of the run along the free axis. */
  a: number
  /** End of the run along the free axis. */
  b: number
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
 * Build fixed wall cuboids along the outer edge of the road corridor.
 * Returns [] if there are no usable ways (caller should skip colliders).
 */
export function buildContainmentWalls(
  ways: XzPoint[][],
  radiusM = CONTAINMENT_M,
  cellM = CORRIDOR_CELL_M,
): ContainmentWall[] {
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  let segCount = 0

  for (const way of ways) {
    for (const p of way) {
      minX = Math.min(minX, p[0])
      maxX = Math.max(maxX, p[0])
      minZ = Math.min(minZ, p[2])
      maxZ = Math.max(maxZ, p[2])
    }
    segCount += Math.max(0, way.length - 1)
  }

  if (!Number.isFinite(minX) || segCount === 0) return []

  const pad = radiusM + cellM
  minX -= pad
  maxX += pad
  minZ -= pad
  maxZ += pad

  let cols = Math.max(1, Math.ceil((maxX - minX) / cellM))
  let rows = Math.max(1, Math.ceil((maxZ - minZ) / cellM))
  let useCell = cellM
  if (cols * rows > MAX_CELLS) {
    const scale = Math.sqrt((cols * rows) / MAX_CELLS)
    useCell = cellM * scale
    cols = Math.max(1, Math.ceil((maxX - minX) / useCell))
    rows = Math.max(1, Math.ceil((maxZ - minZ) / useCell))
  }

  const inside = new Uint8Array(cols * rows)
  const r2 = radiusM * radiusM

  for (const way of ways) {
    for (let i = 1; i < way.length; i++) {
      const ax = way[i - 1][0]
      const az = way[i - 1][2]
      const bx = way[i][0]
      const bz = way[i][2]
      const segLen = Math.hypot(bx - ax, bz - az)
      if (segLen < 0.05) continue

      const x0 = Math.min(ax, bx) - radiusM
      const x1 = Math.max(ax, bx) + radiusM
      const z0 = Math.min(az, bz) - radiusM
      const z1 = Math.max(az, bz) + radiusM

      const ix0 = Math.max(0, Math.floor((x0 - minX) / useCell))
      const ix1 = Math.min(cols - 1, Math.floor((x1 - minX) / useCell))
      const iz0 = Math.max(0, Math.floor((z0 - minZ) / useCell))
      const iz1 = Math.min(rows - 1, Math.floor((z1 - minZ) / useCell))

      const mx = (ax + bx) * 0.5
      const mz = (az + bz) * 0.5
      const reject = radiusM + segLen * 0.5
      const reject2 = reject * reject

      for (let iz = iz0; iz <= iz1; iz++) {
        const cz = minZ + (iz + 0.5) * useCell
        for (let ix = ix0; ix <= ix1; ix++) {
          const idx = iz * cols + ix
          if (inside[idx]) continue
          const cx = minX + (ix + 0.5) * useCell
          const dx = cx - mx
          const dz = cz - mz
          if (dx * dx + dz * dz > reject2) continue
          const d = distPointToSegment(cx, cz, ax, az, bx, bz)
          if (d * d <= r2) inside[idx] = 1
        }
      }
    }
  }

  const isIn = (ix: number, iz: number) => {
    if (ix < 0 || iz < 0 || ix >= cols || iz >= rows) return false
    return inside[iz * cols + ix] === 1
  }

  const hEdges: EdgeRun[] = []
  for (let iz = 0; iz <= rows; iz++) {
    let ix = 0
    while (ix < cols) {
      if (isIn(ix, iz - 1) === isIn(ix, iz)) {
        ix++
        continue
      }
      const start = ix
      ix++
      while (ix < cols && isIn(ix, iz - 1) !== isIn(ix, iz)) ix++
      hEdges.push({
        axis: 'x',
        fixed: minZ + iz * useCell,
        a: minX + start * useCell,
        b: minX + ix * useCell,
      })
    }
  }

  const vEdges: EdgeRun[] = []
  for (let ix = 0; ix <= cols; ix++) {
    let iz = 0
    while (iz < rows) {
      if (isIn(ix - 1, iz) === isIn(ix, iz)) {
        iz++
        continue
      }
      const start = iz
      iz++
      while (iz < rows && isIn(ix - 1, iz) !== isIn(ix, iz)) iz++
      vEdges.push({
        axis: 'z',
        fixed: minX + ix * useCell,
        a: minZ + start * useCell,
        b: minZ + iz * useCell,
      })
    }
  }

  const walls: ContainmentWall[] = []

  for (const e of hEdges) {
    const length = e.b - e.a
    if (length < 0.5) continue
    walls.push({
      x: (e.a + e.b) * 0.5,
      z: e.fixed,
      yaw: 0,
      length,
      thickness: WALL_THICKNESS_M,
      height: WALL_HEIGHT_M,
    })
  }

  for (const e of vEdges) {
    const length = e.b - e.a
    if (length < 0.5) continue
    walls.push({
      x: e.fixed,
      z: (e.a + e.b) * 0.5,
      yaw: Math.PI / 2,
      length,
      thickness: WALL_THICKNESS_M,
      height: WALL_HEIGHT_M,
    })
  }

  return walls
}

/** True if (x,z) is within radiusM of any loaded way centerline. */
export function insideRoadCorridor(
  x: number,
  z: number,
  ways: XzPoint[][],
  radiusM = CONTAINMENT_M,
): boolean {
  for (const way of ways) {
    for (let i = 1; i < way.length; i++) {
      const d = distPointToSegment(
        x,
        z,
        way[i - 1][0],
        way[i - 1][2],
        way[i][0],
        way[i][2],
      )
      if (d <= radiusM) return true
    }
  }
  return false
}
