/**
 * Extrude an XZ centerline into a road ribbon with world-meter UVs.
 * Width and length are real meters (same space as latLngToLocal).
 * The car is not constrained to this mesh — it is scenery + speed texture.
 */

export type XzPoint = [number, number, number]

export const LANE_WIDTH_M = 3.6
export const ROAD_WIDTH_M = LANE_WIDTH_M * 2
/** Meters of road per one V tile of asphalt. Smaller = dashes scream past sooner. */
export const ASPHALT_REPEAT_M = 6

export function localPathLengthMeters(path: XzPoint[]): number {
  let d = 0
  for (let i = 1; i < path.length; i++) {
    d += Math.hypot(path[i][0] - path[i - 1][0], path[i][2] - path[i - 1][2])
  }
  return d
}

export function networkBounds(ways: XzPoint[][]): {
  centerX: number
  centerZ: number
  size: number
} {
  return pathBounds(ways.flat())
}

export function nearestOnNetwork(
  x: number,
  z: number,
  ways: XzPoint[][],
): { spawn: XzPoint; yaw: number } {
  let best = { d: Infinity, x: 0, z: 0, yaw: 0 }
  for (const way of ways) {
    for (let i = 0; i < way.length; i++) {
      const p = way[i]
      const d = Math.hypot(p[0] - x, p[2] - z)
      if (d < best.d) {
        const nxt = way[Math.min(way.length - 1, i + 1)]
        const prv = way[Math.max(0, i - 1)]
        const dx = nxt[0] - prv[0]
        const dz = nxt[2] - prv[2]
        best = { d, x: p[0], z: p[2], yaw: Math.atan2(dx, -dz) }
      }
    }
  }
  if (!Number.isFinite(best.d) || best.d === Infinity) {
    return { spawn: [0, 0.6, 0], yaw: 0 }
  }
  return { spawn: [best.x, 0.6, best.z], yaw: best.yaw }
}

export function mergeMeshArrays(parts: MeshArrays[]): MeshArrays | null {
  if (!parts.length) return null
  let pc = 0
  let ic = 0
  let lengthMeters = 0
  for (const p of parts) {
    pc += p.positions.length
    ic += p.indices.length
    lengthMeters += p.lengthMeters
  }
  const positions = new Float32Array(pc)
  const uvs = new Float32Array((pc / 3) * 2)
  const normals = new Float32Array(pc)
  const indices = new Uint32Array(ic)
  let po = 0
  let uo = 0
  let io = 0
  let vertexOffset = 0
  for (const p of parts) {
    positions.set(p.positions, po)
    uvs.set(p.uvs, uo)
    normals.set(p.normals, po)
    for (let i = 0; i < p.indices.length; i++) {
      indices[io + i] = p.indices[i] + vertexOffset
    }
    vertexOffset += p.positions.length / 3
    po += p.positions.length
    uo += p.uvs.length
    io += p.indices.length
  }
  return { positions, uvs, normals, indices, lengthMeters }
}

export function pathBounds(path: XzPoint[]): {
  centerX: number
  centerZ: number
  size: number
} {
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const p of path) {
    minX = Math.min(minX, p[0])
    maxX = Math.max(maxX, p[0])
    minZ = Math.min(minZ, p[2])
    maxZ = Math.max(maxZ, p[2])
  }
  if (!Number.isFinite(minX)) {
    return { centerX: 0, centerZ: 0, size: 2000 }
  }
  const span = Math.max(maxX - minX, maxZ - minZ, 400)
  return {
    centerX: (minX + maxX) / 2,
    centerZ: (minZ + maxZ) / 2,
    size: span + 800,
  }
}

function tangentAt(path: XzPoint[], i: number): { x: number; z: number } {
  const prev = path[Math.max(0, i - 1)]
  const next = path[Math.min(path.length - 1, i + 1)]
  let tx = next[0] - prev[0]
  let tz = next[2] - prev[2]
  const len = Math.hypot(tx, tz) || 1
  return { x: tx / len, z: tz / len }
}

export type MeshArrays = {
  positions: Float32Array
  uvs: Float32Array
  normals: Float32Array
  indices: Uint32Array
  lengthMeters: number
}

/**
 * Subdivide a centerline so no segment is longer than `maxSegLen` meters.
 *
 * LEARNING — why densify before draping?
 *   OSM ways often jump 100–500 m between nodes. Road ribbon verts only exist
 *   at those nodes; after we add sampleHeight, chords between verts are straight
 *   in 3D while the Ground mesh (cellSize ≈ tens of m, 5× arcade hills) follows
 *   the slope. Mid-segment desert then pokes through / buries the asphalt.
 *   Densifying to ~heightGrid.cellSize puts ribbon verts on the same hill
 *   frequency as the terrain mesh so draping actually sticks.
 */
export function densifyPath(path: XzPoint[], maxSegLen: number): XzPoint[] {
  if (path.length < 2 || !(maxSegLen > 0)) return path
  const out: XzPoint[] = [path[0]]
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]
    const b = path[i]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const dz = b[2] - a[2]
    const len = Math.hypot(dx, dz)
    if (len > maxSegLen) {
      const steps = Math.ceil(len / maxSegLen)
      for (let s = 1; s < steps; s++) {
        const t = s / steps
        out.push([a[0] + dx * t, a[1] + dy * t, a[2] + dz * t])
      }
    }
    out.push(b)
  }
  return out
}

/** Two-lane asphalt ribbon. UV.v = meters / ASPHALT_REPEAT_M (world-locked). */
export function buildRoadRibbon(
  path: XzPoint[],
  width = ROAD_WIDTH_M,
  y = 0.08,
): MeshArrays | null {
  if (path.length < 2) return null
  const half = width / 2
  const n = path.length
  const dist = new Array<number>(n)
  dist[0] = 0
  for (let i = 1; i < n; i++) {
    dist[i] =
      dist[i - 1] +
      Math.hypot(path[i][0] - path[i - 1][0], path[i][2] - path[i - 1][2])
  }

  const positions = new Float32Array(n * 2 * 3)
  const uvs = new Float32Array(n * 2 * 2)
  const normals = new Float32Array(n * 2 * 3)
  const indices = new Uint32Array((n - 1) * 6)

  for (let i = 0; i < n; i++) {
    const t = tangentAt(path, i)
    const px = -t.z
    const pz = t.x
    const iL = i * 2
    const iR = i * 2 + 1
    positions[iL * 3] = path[i][0] + px * half
    positions[iL * 3 + 1] = y
    positions[iL * 3 + 2] = path[i][2] + pz * half
    positions[iR * 3] = path[i][0] - px * half
    positions[iR * 3 + 1] = y
    positions[iR * 3 + 2] = path[i][2] - pz * half
    const v = dist[i] / ASPHALT_REPEAT_M
    uvs[iL * 2] = 0
    uvs[iL * 2 + 1] = v
    uvs[iR * 2] = 1
    uvs[iR * 2 + 1] = v
    normals[iL * 3 + 1] = 1
    normals[iR * 3 + 1] = 1
    if (i < n - 1) {
      const o = i * 6
      indices[o] = iL
      indices[o + 1] = iR
      indices[o + 2] = (i + 1) * 2
      indices[o + 3] = iR
      indices[o + 4] = (i + 1) * 2 + 1
      indices[o + 5] = (i + 1) * 2
    }
  }

  return {
    positions,
    uvs,
    normals,
    indices,
    lengthMeters: dist[n - 1] ?? 0,
  }
}

/**
 * Center dashes + edge lines. US-ish: 3 m dash / 9 m gap, 0.12 m wide.
 * Built as a separate mesh so paint stays white on asphalt.
 */
export function buildLanePaint(
  path: XzPoint[],
  roadWidth = ROAD_WIDTH_M,
  y = 0.1,
): MeshArrays | null {
  if (path.length < 2) return null
  const dashLen = 3
  const gapLen = 9
  const period = dashLen + gapLen
  const paintW = 0.18
  const edgeInset = 0.18
  const halfRoad = roadWidth / 2 - edgeInset

  const positions: number[] = []
  const uvs: number[] = []
  const normals: number[] = []
  const indices: number[] = []

  const pushQuad = (
    ax: number,
    az: number,
    bx: number,
    bz: number,
    halfW: number,
  ) => {
    let tx = bx - ax
    let tz = bz - az
    const len = Math.hypot(tx, tz) || 1
    tx /= len
    tz /= len
    const px = -tz * halfW
    const pz = tx * halfW
    const base = positions.length / 3
    positions.push(
      ax + px,
      y,
      az + pz,
      ax - px,
      y,
      az - pz,
      bx + px,
      y,
      bz + pz,
      bx - px,
      y,
      bz - pz,
    )
    uvs.push(0, 0, 1, 0, 0, 1, 1, 1)
    normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0)
    indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2)
  }

  // Continuous edge lines
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]
    const b = path[i]
    let tx = b[0] - a[0]
    let tz = b[2] - a[2]
    const len = Math.hypot(tx, tz) || 1
    tx /= len
    tz /= len
    const px = -tz
    const pz = tx
    pushQuad(
      a[0] + px * halfRoad,
      a[2] + pz * halfRoad,
      b[0] + px * halfRoad,
      b[2] + pz * halfRoad,
      paintW / 2,
    )
    pushQuad(
      a[0] - px * halfRoad,
      a[2] - pz * halfRoad,
      b[0] - px * halfRoad,
      b[2] - pz * halfRoad,
      paintW / 2,
    )
  }

  // Center dashes along cumulative distance
  let traveled = 0
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]
    const b = path[i]
    const seg = Math.hypot(b[0] - a[0], b[2] - a[2])
    if (seg < 0.05) continue
    const ux = (b[0] - a[0]) / seg
    const uz = (b[2] - a[2]) / seg
    let s = 0
    while (s < seg) {
      const world = traveled + s
      const inDash = world % period < dashLen
      const step = Math.min(0.5, seg - s)
      if (inDash) {
        pushQuad(
          a[0] + ux * s,
          a[2] + uz * s,
          a[0] + ux * (s + step),
          a[2] + uz * (s + step),
          paintW / 2,
        )
      }
      s += step
    }
    traveled += seg
  }

  return {
    positions: new Float32Array(positions),
    uvs: new Float32Array(uvs),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    lengthMeters: traveled,
  }
}


/**
 * Dark edge / curb strip just outside the asphalt — helps roads read vs desert.
 */
export function buildEdgeCurb(
  path: XzPoint[],
  roadWidth: number,
  curbWidth = 0.35,
  y = 0.09,
): MeshArrays | null {
  if (path.length < 2) return null
  const half = roadWidth / 2
  const outer = half + curbWidth
  const positions: number[] = []
  const uvs: number[] = []
  const normals: number[] = []
  const indices: number[] = []

  const pushStrip = (
    ax: number,
    az: number,
    bx: number,
    bz: number,
    inward: number,
    outward: number,
  ) => {
    let tx = bx - ax
    let tz = bz - az
    const len = Math.hypot(tx, tz) || 1
    tx /= len
    tz /= len
    const px = -tz
    const pz = tx
    const base = positions.length / 3
    positions.push(
      ax + px * inward, y, az + pz * inward,
      ax + px * outward, y, az + pz * outward,
      bx + px * inward, y, bz + pz * inward,
      bx + px * outward, y, bz + pz * outward,
    )
    uvs.push(0, 0, 1, 0, 0, 1, 1, 1)
    normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0)
    indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2)
  }

  let traveled = 0
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]
    const b = path[i]
    const seg = Math.hypot(b[0] - a[0], b[2] - a[2])
    if (seg < 0.05) continue
    // Left curb (positive perpendicular)
    pushStrip(a[0], a[2], b[0], b[2], half, outer)
    // Right curb (negative perpendicular) — flip by swapping
    pushStrip(a[0], a[2], b[0], b[2], -half, -outer)
    traveled += seg
  }

  if (positions.length < 9) return null
  return {
    positions: new Float32Array(positions),
    uvs: new Float32Array(uvs),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    lengthMeters: traveled,
  }
}
