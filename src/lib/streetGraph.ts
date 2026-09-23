/**
 * Loaded-street graph + near-car OSRM splice (Forge / Joey 2026-09-21).
 *
 * PROBLEM: Autopilot following raw OSRM can drift off streamed asphalt; but
 * replacing the *entire* OSRM course with a local-tile graph destroyes
 * long-haul GPS (Ridgecrest → Missouri must stay real highways).
 *
 * DESIGN (corrected):
 *   1) Keep the **full OSRM polyline** as the destination spine (blue line /
 *      GPS / guidance far legs).
 *   2) Street-snap **only near the car** onto loaded (active+cached) ways.
 *   3) Splice: near = asphalt centerlines, far ahead = untouched OSRM.
 *   4) Never publish geodesic straight-fallback as the driven path when a
 *      prior good OSRM spine (or nearby centerline chase) exists.
 *   5) Hang-budget: partial align must NOT wipe the OSRM spine mid-drive.
 *
 * LEARNING — never publish crow-flight to AP while ways are loaded near the
 * car. Prefer last successful spliced/OSRM path until a better near snap
 * finishes under the idle budget.
 *
 * LEARNING (Joey mid-drive peel-off): a rejected Dijkstra hop used to fall
 * through to a ≤64 m crow chord between snap hits → blue left asphalt and AP
 * look-ahead drove into dirt. Now: only accept on-graph hops or short chords
 * that stay within ~10 m of loaded centerlines; otherwise mark the splice
 * non-publishable so the scheduler holds last good blue (soft-fail / thin
 * cache inclusive).
 */

import type { XzPoint } from './roadMesh'

/** Merge nearby way endpoints / crossings into one graph node (meters). */
const NODE_QUANT_M = 6
/** Max distance to accept a snap onto a loaded centerline (meters). */
const SNAP_MAX_M = 48
/** Densify the OSRM polyline to about this spacing before snapping. */
const SAMPLE_SPACING_M = 22
/** Skip near-duplicate output vertices. */
const OUT_MIN_SEP_M = 2.5
/** A* hop budget — keep cheap for per-stream near-car splices. */
const ASTAR_MAX_EXPANSIONS = 1_200
/** Cap densified samples *inside the near-car bubble* only (far OSRM untouched). */
const MAX_NEAR_SAMPLES = 48
/** Default soft wall-clock budget (ms) when callers pass AlignOptions. */
const DEFAULT_TIME_BUDGET_MS = 6
/** Street-snap radius around the car (meters) — local tile bubble, not cross-country. */
const DEFAULT_NEAR_RADIUS_M = 480
/** Reject hop→snap chords longer than this without an on-graph hop (meters). */
const MAX_CROW_CHORD_M = 64
/**
 * LEARNING (Joey playtest peel-off): a 64 m crow between snap hits still leaves
 * asphalt on curved residential. Near-car blue/AP must stay within this lateral
 * distance of a loaded centerline when ways exist (~8–12 m ribbon budget).
 */
/** Public ~10 m off-ribbon reject gate (scheduler / AP / HUD share this). */
export const NEAR_ON_ROAD_MAX_M = 10
/** Max crow between consecutive snap hits when Dijkstra hop is unavailable. */
const MAX_NO_HOP_CROW_M = 12
/** Sample spacing along a candidate chord when testing "stays on asphalt". */
const CHORD_SAMPLE_M = 8

export type LoadedWayPoly = {
  points: XzPoint[]
  /** Optional id for teaching / debug. */
  id?: string
}

type GraphNode = {
  id: string
  x: number
  z: number
}

type GraphEdge = {
  from: string
  to: string
  length: number
  /** Polyline along the edge including endpoints (for path reconstruction). */
  poly: XzPoint[]
}

export type StreetGraph = {
  nodes: Map<string, GraphNode>
  /** adjacency: nodeId → edges leaving that node */
  adj: Map<string, GraphEdge[]>
  /** Flat segment list for nearest-snap queries. */
  segs: Array<{
    ax: number
    az: number
    bx: number
    bz: number
    len: number
    aId: string
    bId: string
    wayIndex: number
  }>
}

function quantKey(x: number, z: number): string {
  const qx = Math.round(x / NODE_QUANT_M) * NODE_QUANT_M
  const qz = Math.round(z / NODE_QUANT_M) * NODE_QUANT_M
  return `${qx},${qz}`
}

function ensureNode(
  nodes: Map<string, GraphNode>,
  x: number,
  z: number,
): GraphNode {
  const id = quantKey(x, z)
  let n = nodes.get(id)
  if (!n) {
    n = { id, x, z }
    nodes.set(id, n)
  }
  return n
}

function addEdge(
  adj: Map<string, GraphEdge[]>,
  from: string,
  to: string,
  length: number,
  poly: XzPoint[],
) {
  if (from === to || length < 0.4) return
  const e: GraphEdge = { from, to, length, poly }
  let list = adj.get(from)
  if (!list) {
    list = []
    adj.set(from, list)
  }
  list.push(e)
}

/**
 * Build an undirected graph from loaded way polylines (world XZ).
 * Teaching: each densified segment becomes a bidirectional edge; nearby
 * endpoints share a quantized node so intersections connect.
 */
export function buildStreetGraph(ways: LoadedWayPoly[]): StreetGraph {
  const nodes = new Map<string, GraphNode>()
  const adj = new Map<string, GraphEdge[]>()
  const segs: StreetGraph['segs'] = []

  for (let wi = 0; wi < ways.length; wi++) {
    const pts = ways[wi].points
    if (pts.length < 2) continue
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i][0]
      const az = pts[i][2]
      const bx = pts[i + 1][0]
      const bz = pts[i + 1][2]
      const len = Math.hypot(bx - ax, bz - az)
      if (len < 0.4) continue
      const a = ensureNode(nodes, ax, az)
      const b = ensureNode(nodes, bx, bz)
      const polyFwd: XzPoint[] = [
        [a.x, 0, a.z],
        [b.x, 0, b.z],
      ]
      const polyBak: XzPoint[] = [
        [b.x, 0, b.z],
        [a.x, 0, a.z],
      ]
      addEdge(adj, a.id, b.id, len, polyFwd)
      addEdge(adj, b.id, a.id, len, polyBak)
      segs.push({
        ax,
        az,
        bx,
        bz,
        len,
        aId: a.id,
        bId: b.id,
        wayIndex: wi,
      })
    }
  }

  return { nodes, adj, segs }
}

export type SnapHit = {
  x: number
  z: number
  dist: number
  /** Closer endpoint node (for A* hops). */
  nodeId: string
  wayIndex: number
  t: number
}

/** Nearest centerline projection within SNAP_MAX_M (or null). */
export function snapToGraph(
  graph: StreetGraph,
  x: number,
  z: number,
  maxDist = SNAP_MAX_M,
): SnapHit | null {
  let best: SnapHit | null = null
  for (const s of graph.segs) {
    const abx = s.bx - s.ax
    const abz = s.bz - s.az
    const abLenSq = abx * abx + abz * abz
    let t = 0
    if (abLenSq > 1e-12) {
      t = ((x - s.ax) * abx + (z - s.az) * abz) / abLenSq
      t = Math.max(0, Math.min(1, t))
    }
    const px = s.ax + abx * t
    const pz = s.az + abz * t
    const d = Math.hypot(x - px, z - pz)
    if (d > maxDist) continue
    if (!best || d < best.dist) {
      const nodeId = t < 0.5 ? s.aId : s.bId
      best = { x: px, z: pz, dist: d, nodeId, wayIndex: s.wayIndex, t }
    }
  }
  return best
}

/**
 * Lateral distance from (x,z) to nearest graph segment (Infinity if no segs).
 */
export function distanceToGraph(
  graph: StreetGraph,
  x: number,
  z: number,
): number {
  if (graph.segs.length === 0) return Infinity
  let best = Infinity
  for (const s of graph.segs) {
    const abx = s.bx - s.ax
    const abz = s.bz - s.az
    const abLenSq = abx * abx + abz * abz
    let t = 0
    if (abLenSq > 1e-12) {
      t = ((x - s.ax) * abx + (z - s.az) * abz) / abLenSq
      t = Math.max(0, Math.min(1, t))
    }
    const px = s.ax + abx * t
    const pz = s.az + abz * t
    const d = Math.hypot(x - px, z - pz)
    if (d < best) best = d
  }
  return best
}

/**
 * True when the straight chord A→B stays within maxDist of loaded centerlines
 * (samples along the chord). Rejects cross-lots diagonals even when endpoints
 * each snap to asphalt.
 */
export function chordStaysOnGraph(
  graph: StreetGraph,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  maxDist = NEAR_ON_ROAD_MAX_M,
): boolean {
  const len = Math.hypot(bx - ax, bz - az)
  if (len < 0.5) return distanceToGraph(graph, ax, az) <= maxDist
  const n = Math.max(1, Math.ceil(len / CHORD_SAMPLE_M))
  for (let k = 0; k <= n; k++) {
    const u = k / n
    const x = ax + (bx - ax) * u
    const z = az + (bz - az) * u
    if (distanceToGraph(graph, x, z) > maxDist) return false
  }
  return true
}

/**
 * Max lateral deviation of a polyline from the graph, optionally only for
 * vertices inside the near-car bubble (far OSRM legs are allowed off local tiles).
 */
export function maxPathDeviationFromGraph(
  graph: StreetGraph,
  path: XzPoint[],
  options: { carX?: number; carZ?: number; nearRadiusM?: number } = {},
): number {
  if (path.length === 0 || graph.segs.length === 0) return Infinity
  const nearR = options.nearRadiusM ?? DEFAULT_NEAR_RADIUS_M
  const carX = options.carX
  const carZ = options.carZ
  let worst = 0
  for (let i = 0; i < path.length; i++) {
    const x = path[i][0]
    const z = path[i][2]
    if (carX != null && carZ != null) {
      if (Math.hypot(x - carX, z - carZ) > nearR) continue
    }
    const d = distanceToGraph(graph, x, z)
    if (d > worst) worst = d
  }
  // Also sample midpoints of near-car segments (catches long chords).
  for (let i = 0; i < path.length - 1; i++) {
    const ax = path[i][0]
    const az = path[i][2]
    const bx = path[i + 1][0]
    const bz = path[i + 1][2]
    const mx = (ax + bx) * 0.5
    const mz = (az + bz) * 0.5
    if (carX != null && carZ != null) {
      if (Math.hypot(mx - carX, mz - carZ) > nearR) continue
    }
    const d = distanceToGraph(graph, mx, mz)
    if (d > worst) worst = d
  }
  return worst
}

/**
 * Nearest centerline hit + segment tangent (for AP off-asphalt re-snap).
 * Scans way polylines directly — no graph build (safe per-frame).
 */
export function nearestCenterlineOnWays(
  ways: LoadedWayPoly[],
  x: number,
  z: number,
  maxDist = SNAP_MAX_M,
): { x: number; z: number; dist: number; dirX: number; dirZ: number } | null {
  let best: {
    x: number
    z: number
    dist: number
    dirX: number
    dirZ: number
  } | null = null
  for (const w of ways) {
    const pts = w.points
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i][0]
      const az = pts[i][2]
      const bx = pts[i + 1][0]
      const bz = pts[i + 1][2]
      const abx = bx - ax
      const abz = bz - az
      const abLenSq = abx * abx + abz * abz
      let t = 0
      if (abLenSq > 1e-12) {
        t = ((x - ax) * abx + (z - az) * abz) / abLenSq
        t = Math.max(0, Math.min(1, t))
      }
      const px = ax + abx * t
      const pz = az + abz * t
      const d = Math.hypot(x - px, z - pz)
      if (d > maxDist) continue
      if (!best || d < best.dist) {
        const len = Math.hypot(abx, abz) || 1e-6
        best = { x: px, z: pz, dist: d, dirX: abx / len, dirZ: abz / len }
      }
    }
  }
  return best
}

function densifyPolyline(path: XzPoint[], spacingM: number): XzPoint[] {
  if (path.length < 2) return path.slice()
  const out: XzPoint[] = [[path[0][0], 0, path[0][2]]]
  for (let i = 0; i < path.length - 1; i++) {
    const ax = path[i][0]
    const az = path[i][2]
    const bx = path[i + 1][0]
    const bz = path[i + 1][2]
    const len = Math.hypot(bx - ax, bz - az)
    if (len < 1e-6) continue
    const n = Math.max(1, Math.ceil(len / spacingM))
    for (let k = 1; k <= n; k++) {
      const u = k / n
      out.push([ax + (bx - ax) * u, 0, az + (bz - az) * u])
    }
  }
  return out
}

function pushUnique(out: XzPoint[], x: number, z: number) {
  if (out.length === 0) {
    out.push([x, 0, z])
    return
  }
  const last = out[out.length - 1]
  if (Math.hypot(last[0] - x, last[2] - z) >= OUT_MIN_SEP_M) {
    out.push([x, 0, z])
  }
}

/**
 * Shortest path between two graph nodes (Dijkstra). Returns intermediate
 * polyline points (excluding start, including end) or null if unreachable.
 */
function dijkstraPoly(
  graph: StreetGraph,
  startId: string,
  goalId: string,
): XzPoint[] | null {
  if (startId === goalId) return []
  if (!graph.adj.has(startId) || !graph.adj.has(goalId)) return null

  const dist = new Map<string, number>()
  const prev = new Map<string, { node: string; edge: GraphEdge }>()
  const heap: Array<{ id: string; d: number }> = []

  dist.set(startId, 0)
  heap.push({ id: startId, d: 0 })

  let expansions = 0
  while (heap.length && expansions < ASTAR_MAX_EXPANSIONS) {
    expansions++
    // Linear pop-min — fine for toy graphs (loaded tiles ≈ few k segs).
    let bestI = 0
    for (let i = 1; i < heap.length; i++) {
      if (heap[i].d < heap[bestI].d) bestI = i
    }
    const cur = heap[bestI]
    heap[bestI] = heap[heap.length - 1]
    heap.pop()
    if (cur.d !== dist.get(cur.id)) continue
    if (cur.id === goalId) break

    const edges = graph.adj.get(cur.id)
    if (!edges) continue
    for (const e of edges) {
      const nd = cur.d + e.length
      const prevD = dist.get(e.to)
      if (prevD == null || nd < prevD) {
        dist.set(e.to, nd)
        prev.set(e.to, { node: cur.id, edge: e })
        heap.push({ id: e.to, d: nd })
      }
    }
  }

  if (!dist.has(goalId)) return null

  // Reconstruct edges start → goal, then flatten polys.
  const chain: GraphEdge[] = []
  let walk: string | undefined = goalId
  while (walk && walk !== startId) {
    const step = prev.get(walk)
    if (!step) return null
    chain.push(step.edge)
    walk = step.node
  }
  chain.reverse()

  const pts: XzPoint[] = []
  for (const e of chain) {
    // Skip first vertex of each edge (shared with previous end).
    for (let i = 1; i < e.poly.length; i++) {
      pts.push(e.poly[i])
    }
  }
  return pts
}

export type AlignOptions = {
  /**
   * Soft wall-clock budget (ms). When exceeded, return the best splice so far
   * **with the OSRM spine intact** — never wipe far legs with raw crow-flight.
   */
  timeBudgetMs?: number
  /** Car world X — near-bubble center. Defaults to rawPath[0]. */
  carX?: number
  /** Car world Z — near-bubble center. Defaults to rawPath[0]. */
  carZ?: number
  /** Street-snap radius (m). Far OSRM beyond this stays untouched. */
  nearRadiusM?: number
  /**
   * True when rawPath is OSRM (road-following). False for Nominatim/straight
   * fallback — geodesic must not drive AP while ways exist near the car.
   */
  rawIsStreetFollowing?: boolean
}

export type AlignResult = {
  path: XzPoint[]
  timedOut: boolean
  /** Local asphalt snap applied inside the near bubble. */
  didLocalSnap: boolean
  /**
   * Safe to hand AP / guidance / blue line.
   * LEARNING — never publish crow-flight to AP while ways are loaded near the
   * car. OSRM spine alone is publishable; straight fallback is not when we
   * still owe a centerline chase.
   */
  publishable: boolean
  kind: 'osrm-spine' | 'osrm-spliced' | 'fallback-chase' | 'fallback-raw' | 'empty'
}

function copyPath(path: XzPoint[]): XzPoint[] {
  return path.map((p) => [p[0], 0, p[2]] as XzPoint)
}

function pathLenM(path: XzPoint[]): number {
  let n = 0
  for (let i = 0; i < path.length - 1; i++) {
    n += Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][2] - path[i][2])
  }
  return n
}

/**
 * True when a polyline is essentially a geodesic (straight fallback / 2-point).
 * OSRM road courses have many vertices and arc length >> crow — keep those.
 */
export function isLikelyCrowFlight(path: XzPoint[]): boolean {
  if (path.length < 2) return true
  if (path.length > 8) return false
  const crow = Math.hypot(
    path[path.length - 1][0] - path[0][0],
    path[path.length - 1][2] - path[0][2],
  )
  const len = pathLenM(path)
  return len <= crow * 1.06 + 8
}

/**
 * Greedy centerline chase toward a goal — used when raw is straight-fallback
 * but loaded ways exist near the car (AP must stay on asphalt, not geodesic).
 */
export function chaseCenterlineToward(
  ways: LoadedWayPoly[],
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
  options: { timeBudgetMs?: number; maxLenM?: number } = {},
): XzPoint[] {
  const usable = ways.filter((w) => w.points.length >= 2)
  if (usable.length === 0) return []
  const t0 = performance.now()
  const budget = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS
  const maxLen = options.maxLenM ?? 2_400
  const graph = buildStreetGraph(usable)
  if (graph.segs.length === 0) return []
  const start = snapToGraph(graph, fromX, fromZ)
  if (!start) return []
  const out: XzPoint[] = [[start.x, 0, start.z]]
  let nodeId = start.nodeId
  let guard = 0
  let travelled = 0
  while (guard++ < 400) {
    if (performance.now() - t0 >= budget) break
    const goalDist = Math.hypot(toX - out[out.length - 1][0], toZ - out[out.length - 1][2])
    if (goalDist < 28) break
    if (travelled > maxLen) break
    const edges = graph.adj.get(nodeId)
    if (!edges || edges.length === 0) break
    let best: GraphEdge | null = null
    let bestScore = Infinity
    for (const e of edges) {
      const end = e.poly[e.poly.length - 1]
      const d = Math.hypot(toX - end[0], toZ - end[2])
      // Prefer edges that reduce remaining crow-flight; tiny length penalty.
      const score = d + e.length * 0.05
      if (score < bestScore) {
        bestScore = score
        best = e
      }
    }
    if (!best) break
    const end = best.poly[best.poly.length - 1]
    // Avoid oscillating on the same node.
    if (best.to === nodeId) break
    for (let i = 1; i < best.poly.length; i++) {
      pushUnique(out, best.poly[i][0], best.poly[i][2])
    }
    travelled += best.length
    nodeId = best.to
    if (Math.hypot(toX - end[0], toZ - end[2]) >= goalDist - 0.5) {
      // Not making progress toward dest — stop (incomplete component).
      break
    }
  }
  return out.length >= 2 ? out : []
}

/**
 * Align / splice a guidance polyline onto loaded streets **near the car only**.
 *
 * Returns an AlignResult. Callers (routeAlignScheduler) must not publish
 * non-publishable results over a prior good OSRM spine.
 *
 * LEARNING — main-thread budget:
 *   Only the near-car bubble is densified + snapped. Cross-country OSRM stays
 *   a cheap copy. Prefer createRouteAlignScheduler; pass timeBudgetMs.
 */
export function alignRouteToLoadedWays(
  rawPath: XzPoint[],
  ways: LoadedWayPoly[],
  options: AlignOptions = {},
): AlignResult {
  if (rawPath.length < 2) {
    return {
      path: [],
      timedOut: false,
      didLocalSnap: false,
      publishable: false,
      kind: 'empty',
    }
  }

  // Explicit flag wins; otherwise infer from vertex density (OSRM vs 2-point).
  const isOsrmLike =
    options.rawIsStreetFollowing === true ||
    (options.rawIsStreetFollowing !== false && !isLikelyCrowFlight(rawPath))

  const spine = copyPath(rawPath)
  const usable = ways.filter((w) => w.points.length >= 2)

  if (usable.length === 0) {
    return {
      path: spine,
      timedOut: false,
      didLocalSnap: false,
      publishable: isOsrmLike,
      kind: isOsrmLike ? 'osrm-spine' : 'fallback-raw',
    }
  }

  const t0 = performance.now()
  const budget = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS
  const overBudget = () => performance.now() - t0 >= budget
  const nearR = options.nearRadiusM ?? DEFAULT_NEAR_RADIUS_M
  const carX = options.carX ?? rawPath[0][0]
  const carZ = options.carZ ?? rawPath[0][2]

  const graph = buildStreetGraph(usable)
  if (graph.segs.length === 0) {
    return {
      path: spine,
      timedOut: false,
      didLocalSnap: false,
      publishable: isOsrmLike,
      kind: isOsrmLike ? 'osrm-spine' : 'fallback-raw',
    }
  }
  if (overBudget()) {
    // Graph ate the budget — keep full OSRM spine (never crow-flight overwrite).
    return {
      path: spine,
      timedOut: true,
      didLocalSnap: false,
      publishable: isOsrmLike,
      kind: isOsrmLike ? 'osrm-spine' : 'fallback-raw',
    }
  }

  // Straight fallback + ways near car → centerline chase (not geodesic AP).
  if (!isOsrmLike) {
    const chase = chaseCenterlineToward(
      usable,
      carX,
      carZ,
      rawPath[rawPath.length - 1][0],
      rawPath[rawPath.length - 1][2],
      { timeBudgetMs: Math.max(1, budget - (performance.now() - t0)) },
    )
    if (chase.length >= 2) {
      return {
        path: chase,
        timedOut: overBudget(),
        didLocalSnap: true,
        publishable: true,
        kind: 'fallback-chase',
      }
    }
    return {
      path: spine,
      timedOut: overBudget(),
      didLocalSnap: false,
      publishable: false,
      kind: 'fallback-raw',
    }
  }

  // --- OSRM spine: snap only vertices inside the near-car bubble ---
  // Find inclusive index range of raw vertices near the car.
  let i0 = -1
  let i1 = -1
  for (let i = 0; i < rawPath.length; i++) {
    const d = Math.hypot(rawPath[i][0] - carX, rawPath[i][2] - carZ)
    if (d <= nearR) {
      if (i0 < 0) i0 = i
      i1 = i
    }
  }
  // Always include a small window around the closest vertex so AP has asphalt
  // even when the car sits slightly off the polyline.
  if (i0 < 0) {
    let bestI = 0
    let bestD = Infinity
    for (let i = 0; i < rawPath.length; i++) {
      const d = Math.hypot(rawPath[i][0] - carX, rawPath[i][2] - carZ)
      if (d < bestD) {
        bestD = d
        bestI = i
      }
    }
    if (bestD > nearR * 1.5) {
      // Car far from route (rare) — keep pure OSRM.
      return {
        path: spine,
        timedOut: false,
        didLocalSnap: false,
        publishable: true,
        kind: 'osrm-spine',
      }
    }
    i0 = Math.max(0, bestI - 1)
    i1 = Math.min(rawPath.length - 1, bestI + 1)
  }

  // Expand one vertex so splice seams are smooth.
  i0 = Math.max(0, i0 - 1)
  i1 = Math.min(rawPath.length - 1, i1 + 1)

  const nearRaw = rawPath.slice(i0, i1 + 1)
  let samples = densifyPolyline(nearRaw, SAMPLE_SPACING_M)
  if (samples.length > MAX_NEAR_SAMPLES) {
    const kept: XzPoint[] = [samples[0]]
    const step = Math.ceil(samples.length / MAX_NEAR_SAMPLES)
    for (let i = step; i < samples.length - 1; i += step) kept.push(samples[i])
    kept.push(samples[samples.length - 1])
    samples = kept
  }

  const snapped: XzPoint[] = []
  let lastNodeId: string | null = null
  let timedOut = false
  let snapHits = 0
  /** True when a sample would force an off-road chord — abort splice publish. */
  let spliceOffRoad = false

  for (let si = 0; si < samples.length; si++) {
    if (overBudget()) {
      timedOut = true
      break
    }
    const s = samples[si]
    const hit = snapToGraph(graph, s[0], s[2])
    if (!hit) {
      // Hole / soft-fail thin cache: only keep OSRM if it still hugs asphalt.
      // LEARNING — inventing a geodesic cut across a way gap peels blue mid-drive.
      if (distanceToGraph(graph, s[0], s[2]) > NEAR_ON_ROAD_MAX_M) {
        spliceOffRoad = true
        break
      }
      const last = snapped.at(-1)
      if (
        last &&
        !chordStaysOnGraph(graph, last[0], last[2], s[0], s[2], NEAR_ON_ROAD_MAX_M)
      ) {
        spliceOffRoad = true
        break
      }
      pushUnique(snapped, s[0], s[2])
      continue
    }
    snapHits++

    let bridgedOnGraph = false
    if (lastNodeId && lastNodeId !== hit.nodeId && !overBudget()) {
      const hop = dijkstraPoly(graph, lastNodeId, hit.nodeId)
      const last = snapped.at(-1)
      const crow = last
        ? Math.hypot(hit.x - last[0], hit.z - last[2])
        : 0
      if (hop && hop.length > 0) {
        let hopLen = 0
        let px = last ? last[0] : hit.x
        let pz = last ? last[2] : hit.z
        for (const p of hop) {
          hopLen += Math.hypot(p[0] - px, p[2] - pz)
          px = p[0]
          pz = p[2]
        }
        if (hopLen <= Math.max(80, crow * 2.8 + 40)) {
          for (const p of hop) pushUnique(snapped, p[0], p[2])
          bridgedOnGraph = true
        }
      }
      if (!bridgedOnGraph) {
        // No usable hop. Only allow a *short* on-asphalt micro-skip; never the
        // old 64 m crow fall-through (that published cross-lots chords).
        if (
          last &&
          crow <= MAX_NO_HOP_CROW_M &&
          chordStaysOnGraph(
            graph,
            last[0],
            last[2],
            hit.x,
            hit.z,
            NEAR_ON_ROAD_MAX_M,
          )
        ) {
          // Micro-skip OK — fall through to push hit.
        } else if (
          last &&
          crow <= MAX_CROW_CHORD_M &&
          distanceToGraph(graph, s[0], s[2]) <= NEAR_ON_ROAD_MAX_M &&
          chordStaysOnGraph(
            graph,
            last[0],
            last[2],
            s[0],
            s[2],
            NEAR_ON_ROAD_MAX_M,
          )
        ) {
          // Prefer OSRM sample when it hugs asphalt better than hit↔hit crow.
          pushUnique(snapped, s[0], s[2])
          lastNodeId = hit.nodeId
          continue
        } else {
          // Would peel blue / AP into dirt — hold last good via scheduler.
          spliceOffRoad = true
          break
        }
      }
    }

    pushUnique(snapped, hit.x, hit.z)
    lastNodeId = hit.nodeId
  }

  // Soft-fail / thin cache: too few snaps → do not invent a near splice.
  if (
    spliceOffRoad ||
    snapped.length < 2 ||
    snapHits === 0 ||
    snapHits < Math.max(2, Math.floor(samples.length * 0.35))
  ) {
    return {
      path: spine,
      timedOut,
      didLocalSnap: false,
      // Mid-drive: not publishable so scheduler keeps last good on-road blue.
      // Fresh dest still has onRaw OSRM spine already painted.
      publishable: false,
      kind: 'osrm-spine',
    }
  }

  // Splice snapped near segment into the full OSRM spine.
  const out: XzPoint[] = []
  for (let i = 0; i < i0; i++) pushUnique(out, rawPath[i][0], rawPath[i][2])
  for (const p of snapped) pushUnique(out, p[0], p[2])
  for (let i = i1 + 1; i < rawPath.length; i++) {
    pushUnique(out, rawPath[i][0], rawPath[i][2])
  }
  if (out.length < 2) {
    return {
      path: spine,
      timedOut,
      didLocalSnap: false,
      publishable: false,
      kind: 'osrm-spine',
    }
  }

  // Final gate: near-car vertices + segment midpoints must hug asphalt.
  const nearDev = maxPathDeviationFromGraph(graph, out, {
    carX,
    carZ,
    nearRadiusM: nearR,
  })
  if (nearDev > NEAR_ON_ROAD_MAX_M) {
    return {
      path: spine,
      timedOut,
      didLocalSnap: false,
      publishable: false,
      kind: 'osrm-spine',
    }
  }

  return {
    path: out,
    timedOut,
    didLocalSnap: true,
    publishable: true,
    kind: 'osrm-spliced',
  }
}


/**
 * Pure publish gate: reject a candidate splice when any near-car chord sits
 * > gateM off loaded centerlines. LEARNING — use everywhere a path is
 * published (scheduler already sets publishable; this is the shared test).
 */
export function pathStaysOnRibbon(
  path: XzPoint[],
  ways: LoadedWayPoly[],
  options: {
    carX?: number
    carZ?: number
    gateM?: number
    nearRadiusM?: number
  } = {},
): boolean {
  if (path.length < 2) return false
  const usable = ways.filter((w) => w.points.length >= 2)
  if (usable.length === 0) return false
  const graph = buildStreetGraph(usable)
  if (graph.segs.length === 0) return false
  const gate = options.gateM ?? NEAR_ON_ROAD_MAX_M
  const nearDev = maxPathDeviationFromGraph(graph, path, {
    carX: options.carX,
    carZ: options.carZ,
    nearRadiusM: options.nearRadiusM,
  })
  return nearDev <= gate
}

/** @deprecated Prefer AlignResult from alignRouteToLoadedWays. */
export function alignRoutePathOnly(
  rawPath: XzPoint[],
  ways: LoadedWayPoly[],
  options: AlignOptions = {},
): XzPoint[] {
  return alignRouteToLoadedWays(rawPath, ways, options).path
}

/**
 * Fingerprint loaded ways so App can skip rebuild when the active set is
 * unchanged (reference can churn even when geometry is stable).
 */
export function loadedWaysFingerprint(ways: LoadedWayPoly[]): string {
  let n = ways.length
  let pts = 0
  let ax = 0
  let az = 0
  for (const w of ways) {
    pts += w.points.length
    if (w.points.length) {
      ax += w.points[0][0]
      az += w.points[0][2]
      const last = w.points[w.points.length - 1]
      ax += last[0]
      az += last[2]
    }
  }
  // Coarse buckets — enough to notice tile adds without float noise.
  return `${n}:${pts}:${Math.round(ax)}:${Math.round(az)}`
}
