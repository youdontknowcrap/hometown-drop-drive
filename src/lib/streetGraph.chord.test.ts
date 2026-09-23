/**
 * Pure helper check: splice with a >10 m off-ribbon chord is rejected.
 * Run: npm run test:chord
 */
import {
  buildStreetGraph,
  chordStaysOnGraph,
  NEAR_ON_ROAD_MAX_M,
  pathStaysOnRibbon,
  type LoadedWayPoly,
} from './streetGraph.ts'
import type { XzPoint } from './roadMesh.ts'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

/** Straight E–W centerline along z=0 from x=-200..200. */
const WAYS: LoadedWayPoly[] = [
  {
    id: 'main',
    points: [
      [-200, 0, 0],
      [-100, 0, 0],
      [0, 0, 0],
      [100, 0, 0],
      [200, 0, 0],
    ],
  },
]

const onRoad: XzPoint[] = [
  [-50, 0, 0],
  [0, 0, 0],
  [50, 0, 0],
]

/** Midpoint sits ~40 m north of ribbon — must fail the 10 m gate. */
const offChord: XzPoint[] = [
  [-20, 0, 0],
  [0, 0, 40],
  [20, 0, 0],
]

const graph = buildStreetGraph(WAYS)
assert(graph.segs.length > 0, 'graph built')

assert(
  chordStaysOnGraph(graph, -20, 0, 20, 0, NEAR_ON_ROAD_MAX_M),
  'on-ribbon chord should pass',
)
assert(
  !chordStaysOnGraph(graph, -20, 0, 0, 40, NEAR_ON_ROAD_MAX_M),
  'diagonal off-ribbon chord must reject',
)

assert(
  pathStaysOnRibbon(onRoad, WAYS, { carX: 0, carZ: 0 }),
  'on-asphalt path publishable',
)
assert(
  !pathStaysOnRibbon(offChord, WAYS, { carX: 0, carZ: 0 }),
  'splice with >10m off-ribbon chord must be rejected',
)

console.log('streetGraph.chord.test.ts: ok')
