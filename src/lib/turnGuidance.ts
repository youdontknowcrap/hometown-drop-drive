/**
 * Turn-by-turn cues from the blue GPS route polyline.
 *
 * LEARNING: OSRM gives us a smooth geometry, not always “steps.” We scan
 * bearing deltas along the path ahead of the car — same idea as a cheap
 * nav unit that only has the line. Road names are best-effort: match the
 * turn vertex to a nearby named OSM way when App passes them.
 */
import { projectOntoPath } from './guidance'
import type { XzPoint } from './roadMesh'

export type TurnKind =
  | 'left'
  | 'right'
  | 'slight-left'
  | 'slight-right'
  | 'straight'
  | 'u-turn'
  | 'arrive'

export type TurnCue = {
  kind: TurnKind
  /** Arc meters from the car’s projection to the turn vertex. */
  distanceM: number
  /** Human label when we know it (“China Lake Blvd”). */
  roadName?: string
  /** Signed bearing change at the turn (deg, + = left in our yaw convention). */
  bearingDeltaDeg: number
}

export type GuidanceSnapshot = {
  /** Remaining path length from car projection to destination (m). */
  remainingM: number
  nextTurn: TurnCue | null
}

/** Ignore wobbles smaller than this — OSRM densifies curves. */
const MIN_TURN_DEG = 28
/** Slight vs hard turn split. */
const HARD_TURN_DEG = 55
/** U-turn-ish. */
const U_TURN_DEG = 150
/** Skip tiny segments when measuring bearing (meters). */
const MIN_SEG_M = 6
/** Look this far ahead for the first real turn. */
const LOOK_AHEAD_CAP_M = 12_000
/** Match a named way within this radius of the turn vertex. */
const NAME_MATCH_M = 48

export type NamedWay = {
  points: XzPoint[]
  name?: string
}

/** Bearing of a segment in degrees: 0 = world −Z (north), + = CCW (left). */
function bearingDeg(ax: number, az: number, bx: number, bz: number): number {
  // forward = (bx-ax, bz-az); yaw 0 → (0,−1)
  const dx = bx - ax
  const dz = bz - az
  // atan2(x, −z) so north=0, east=+90 in screen/world terms we use elsewhere
  return (Math.atan2(dx, -dz) * 180) / Math.PI
}

function normDelta(d: number): number {
  let x = d
  while (x > 180) x -= 360
  while (x < -180) x += 360
  return x
}

function kindFromDelta(delta: number): TurnKind {
  const a = Math.abs(delta)
  if (a >= U_TURN_DEG) return 'u-turn'
  if (a < MIN_TURN_DEG) return 'straight'
  if (delta > 0) return a >= HARD_TURN_DEG ? 'left' : 'slight-left'
  return a >= HARD_TURN_DEG ? 'right' : 'slight-right'
}

/** Short arrow-ish label for the dial / guidance strip. */
export function turnArrow(kind: TurnKind): string {
  switch (kind) {
    case 'left':
      return '←'
    case 'right':
      return '→'
    case 'slight-left':
      return '↖'
    case 'slight-right':
      return '↗'
    case 'u-turn':
      return '↩'
    case 'arrive':
      return '⬤'
    default:
      return '↑'
  }
}

export function turnLabel(kind: TurnKind): string {
  switch (kind) {
    case 'left':
      return 'Turn left'
    case 'right':
      return 'Turn right'
    case 'slight-left':
      return 'Keep left'
    case 'slight-right':
      return 'Keep right'
    case 'u-turn':
      return 'U-turn'
    case 'arrive':
      return 'Arrive'
    default:
      return 'Continue'
  }
}

/** Format meters for driving: “120 m” / “1.2 km”. */
export function formatDriveDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return '—'
  if (meters < 1000) return `${Math.round(meters)} m`
  return `${(meters / 1000).toFixed(meters < 10_000 ? 1 : 0)} km`
}

function nameNear(
  x: number,
  z: number,
  namedWays: NamedWay[] | undefined,
): string | undefined {
  if (!namedWays?.length) return undefined
  let best = Infinity
  let label: string | undefined
  for (const w of namedWays) {
    const n = w.name?.trim()
    if (!n || w.points.length < 2) continue
    for (const p of w.points) {
      const d = Math.hypot(p[0] - x, p[2] - z)
      if (d < best && d <= NAME_MATCH_M) {
        best = d
        label = n
      }
    }
  }
  return label
}

/**
 * Snapshot remaining distance + next turn from the blue route.
 * Cheap enough to call from an rAF / 4 Hz poll.
 */
export function guidanceFromRoute(
  carX: number,
  carZ: number,
  path: XzPoint[],
  namedWays?: NamedWay[],
): GuidanceSnapshot | null {
  if (path.length < 2) return null
  const hit = projectOntoPath(carX, carZ, path)
  if (!hit) return null

  // Total path length + remaining from projection.
  let total = 0
  const segLens: number[] = []
  for (let i = 0; i < path.length - 1; i++) {
    const len =
      Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][2] - path[i][2]) ||
      1e-6
    segLens.push(len)
    total += len
  }
  const remainingM = Math.max(0, total - hit.sAlong)

  // Close enough to the pin — show arrive instead of a bogus turn.
  if (remainingM < 35) {
    return {
      remainingM,
      nextTurn: {
        kind: 'arrive',
        distanceM: remainingM,
        bearingDeltaDeg: 0,
      },
    }
  }

  // Walk vertices ahead of the projection; compare successive segment bearings.
  let s = 0
  let prevBearing: number | null = null
  let nextTurn: TurnCue | null = null

  for (let i = 0; i < path.length - 1; i++) {
    const len = segLens[i]
    const segEndS = s + len
    // Skip segments entirely behind the car (except the one we're on).
    if (segEndS < hit.sAlong - 1) {
      s = segEndS
      continue
    }
    if (len < MIN_SEG_M) {
      s = segEndS
      continue
    }

    const b = bearingDeg(path[i][0], path[i][2], path[i + 1][0], path[i + 1][2])
    if (prevBearing != null) {
      const delta = normDelta(b - prevBearing)
      const distToVertex = Math.max(0, s - hit.sAlong)
      if (Math.abs(delta) >= MIN_TURN_DEG && distToVertex <= LOOK_AHEAD_CAP_M) {
        const kind = kindFromDelta(delta)
        if (kind !== 'straight') {
          nextTurn = {
            kind,
            distanceM: distToVertex,
            bearingDeltaDeg: delta,
            roadName: nameNear(path[i][0], path[i][2], namedWays),
          }
          break
        }
      }
    }
    prevBearing = b
    s = segEndS
  }

  // No sharp turn found — “continue” toward destination with remaining dist.
  if (!nextTurn) {
    nextTurn = {
      kind: 'straight',
      distanceM: remainingM,
      bearingDeltaDeg: 0,
      roadName: nameNear(
        path[path.length - 1][0],
        path[path.length - 1][2],
        namedWays,
      ),
    }
  }

  return { remainingM, nextTurn }
}
