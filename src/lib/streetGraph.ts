/**
 * Loaded-street graph + OSRM→world path alignment (Forge / Joey 2026-09-21).
 *
 * PROBLEM: Autopilot used to follow the raw blue OSRM (or straight) polyline
 * while the 3D ribbons are streamed OSM tiles. Those two geometries disagree
 * enough that AP can "drive the blue line" off the asphalt mesh under the tires.
 *
 * ONE PATH TRUTH: build a cheap graph from **active loaded ways**, snap the
 * OSRM/fallback polyline onto those centerlines, and let AP + GPS guidance +
 * the visible blue line all consume the **same** world-XZ path. Re-run when
 * tiles stream in (caller passes fresh ways).
 *
 * Prefer playable solid over perfect map-matching research:
 *   1) Densify the guidance polyline
 *   2) Project each sample onto the nearest loaded centerline (within SNAP_M)
 *   3) Stitch along the same way when possible; short A* hop between ways
 *   4) If nothing is loaded yet, fall back to the raw polyline (still drives)
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
/** A* hop budget — keep cheap for per-stream replans. */
const ASTAR_MAX_EXPANSIONS = 2_400

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

/**
 * Align a guidance polyline (OSRM / straight fallback, world XZ) onto the
 * loaded street graph. Returns a driven path AP + GPS + guidance share.
 *
 * If the graph is empty / too sparse, returns a copy of `rawPath` so the toy
 * still shows a blue line and AP can follow something.
 */
export function alignRouteToLoadedWays(
  rawPath: XzPoint[],
  ways: LoadedWayPoly[],
): XzPoint[] {
  if (rawPath.length < 2) return rawPath.slice()

  const usable = ways.filter((w) => w.points.length >= 2)
  if (usable.length === 0) return rawPath.map((p) => [p[0], 0, p[2]] as XzPoint)

  const graph = buildStreetGraph(usable)
  if (graph.segs.length === 0) {
    return rawPath.map((p) => [p[0], 0, p[2]] as XzPoint)
  }

  const samples = densifyPolyline(rawPath, SAMPLE_SPACING_M)
  const out: XzPoint[] = []
  let lastNodeId: string | null = null

  for (const s of samples) {
    const hit = snapToGraph(graph, s[0], s[2])
    if (!hit) {
      // Still loading under this sample — keep raw so the corridor progresses.
      pushUnique(out, s[0], s[2])
      continue
    }

    if (lastNodeId && lastNodeId !== hit.nodeId) {
      // Prefer a short on-graph hop so we stay on centerlines between snaps.
      const hop = dijkstraPoly(graph, lastNodeId, hit.nodeId)
      if (hop && hop.length > 0) {
        // Only accept hops that aren't absurd vs crow-flight (avoid city tours).
        let hopLen = 0
        let px = out.length ? out[out.length - 1][0] : hit.x
        let pz = out.length ? out[out.length - 1][2] : hit.z
        for (const p of hop) {
          hopLen += Math.hypot(p[0] - px, p[2] - pz)
          px = p[0]
          pz = p[2]
        }
        const crow = Math.hypot(hit.x - (out.at(-1)?.[0] ?? hit.x), hit.z - (out.at(-1)?.[2] ?? hit.z))
        if (hopLen <= Math.max(80, crow * 2.8 + 40)) {
          for (const p of hop) pushUnique(out, p[0], p[2])
        }
      }
    }

    pushUnique(out, hit.x, hit.z)
    lastNodeId = hit.nodeId
  }

  // Ensure destination end is represented (snap last raw point if possible).
  const end = rawPath[rawPath.length - 1]
  const endHit = snapToGraph(graph, end[0], end[2], SNAP_MAX_M * 1.4)
  if (endHit) {
    if (lastNodeId && lastNodeId !== endHit.nodeId) {
      const hop = dijkstraPoly(graph, lastNodeId, endHit.nodeId)
      if (hop) {
        for (const p of hop) pushUnique(out, p[0], p[2])
      }
    }
    pushUnique(out, endHit.x, endHit.z)
  } else {
    pushUnique(out, end[0], end[2])
  }

  if (out.length < 2) {
    return rawPath.map((p) => [p[0], 0, p[2]] as XzPoint)
  }
  return out
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
