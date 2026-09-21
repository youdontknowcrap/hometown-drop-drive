import { useEffect, useMemo, useRef, useState } from 'react'
import { carPose } from '../lib/carPose'
import { latLngToLocal, localToLatLng, type LatLng } from '../lib/geo'
import type { XzPoint } from '../lib/roadMesh'
import {
  fetchGpsOverlay,
  keepLiveWayAtZoom,
  preferOverlayCartography,
  wantsRegionalOverlay,
  type GpsOverlayData,
  type OverlayWay,
} from '../lib/gpsOverlay'
import {
  formatDriveDistance,
  guidanceFromRoute,
  turnArrow,
  turnLabel,
  type GuidanceSnapshot,
} from '../lib/turnGuidance'

/** One stroked way on the dial — highway tag drives zoom filters. */
export type GpsWay = {
  points: XzPoint[]
  highway: string
  name?: string
}

type GpsDashProps = {
  origin: LatLng
  /** Loaded active ways (3D-mounted). Paint controlled by liveStreetsOn. */
  ways: GpsWay[]
  /** Optional blue GPS route overlay on the mini-map. */
  route?: XzPoint[]
  /** Destination / autopilot active — show distance + turn strip. */
  guidanceActive?: boolean
  /**
   * Paint loaded active ways on the dial (stream load cue). Default ON.
   * Controlled from App so HUD + dial toolbar stay in sync. Dial-only —
   * does not touch 3D Street meshes.
   */
  liveStreetsOn?: boolean
  onLiveStreetsOn?: (on: boolean) => void
}

/** Compact dial size (CSS + backing store). Expanded uses SIZE_EXPANDED. */
const SIZE_COMPACT = 168
const SIZE_EXPANDED = 300

/**
 * How many world meters fit across the mini-map.
 * Teaching: classic car GPS is local; expanded mode is a regional overview
 * (tens of km+) so majors / water / state scraps stay useful.
 */
const DEFAULT_VIEW_METERS = 220
const MIN_VIEW_METERS = 120
/** Compact dial still zooms out past neighborhood (~8 km across). */
const MAX_VIEW_COMPACT = 8_000
/** Expanded: regional overview — tens of km+. */
const MAX_VIEW_EXPANDED = 80_000
const ZOOM_STEP = 1.4
const ZOOM_KEY = 'hdd-gps-view-meters'
const MAP_MODE_KEY = 'hdd-gps-map-mode'
const EXPANDED_KEY = 'hdd-gps-expanded'
const TURNS_OPEN_KEY = 'hdd-gps-turns-open'

type MapMode = 'track' | 'north'

function readViewMeters(max: number): number {
  try {
    const v = Number(localStorage.getItem(ZOOM_KEY))
    if (Number.isFinite(v) && v >= MIN_VIEW_METERS && v <= max) return v
    if (Number.isFinite(v) && v > max) return max
  } catch {
    /* private mode */
  }
  return DEFAULT_VIEW_METERS
}

function writeViewMeters(m: number) {
  try {
    localStorage.setItem(ZOOM_KEY, String(m))
  } catch {
    /* ignore */
  }
}

function readMapMode(): MapMode {
  try {
    const v = localStorage.getItem(MAP_MODE_KEY)
    if (v === 'north') return 'north'
    return 'track'
  } catch {
    return 'track'
  }
}

function writeMapMode(mode: MapMode) {
  try {
    localStorage.setItem(MAP_MODE_KEY, mode)
  } catch {
    /* ignore */
  }
}

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    if (v == null) return fallback
    return v === '1' || v === 'true'
  } catch {
    return fallback
  }
}

function writeBool(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? '1' : '0')
  } catch {
    /* ignore */
  }
}

function overlayToLocal(ways: OverlayWay[], origin: LatLng): XzPoint[][] {
  return ways.map((w) =>
    w.points.map((p) => {
      const { x, z } = latLngToLocal(p, origin)
      return [x, 0, z] as XzPoint
    }),
  )
}

/**
 * Mini map of the loaded street grid + car blip + GPS route + regional
 * overlays (majors / water / state) when zoomed out.
 *
 * Track-up (default, classic dash GPS):
 *   - Car chevron stays fixed in the center, tip pointing *up* on the canvas.
 *   - Streets / route translate with the car and rotate by **+yaw** so the
 *     direction the car is facing is always toward the top of the dial.
 *
 * North-up:
 *   - Map stays north-aligned; car icon rotates with yaw.
 *
 * Yaw convention (from Car / Three.js): yaw = 0 faces world −Z (north);
 * positive yaw is a left turn → forward = (−sin θ, −cos θ) in XZ.
 *
 * JOEY LOCK: zoom / expand / live-streets toggle only touch this component’s
 * state + canvas — never remount Car / FollowCam / Scene.
 */
export function GpsDash({
  origin,
  ways,
  route = [],
  guidanceActive = false,
  liveStreetsOn = true,
  onLiveStreetsOn,
}: GpsDashProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const coordRef = useRef<HTMLParagraphElement>(null)
  const remainRef = useRef<HTMLSpanElement>(null)
  const turnDistRef = useRef<HTMLSpanElement>(null)
  const turnCueRef = useRef<HTMLSpanElement>(null)
  const turnRoadRef = useRef<HTMLSpanElement>(null)

  const [mapMode, setMapMode] = useState<MapMode>(readMapMode)
  const [expanded, setExpanded] = useState(() => readBool(EXPANDED_KEY, false))
  const [turnsOpen, setTurnsOpen] = useState(() => readBool(TURNS_OPEN_KEY, true))
  const maxView = expanded ? MAX_VIEW_EXPANDED : MAX_VIEW_COMPACT
  const [viewMeters, setViewMeters] = useState(() =>
    readViewMeters(expanded ? MAX_VIEW_EXPANDED : MAX_VIEW_COMPACT),
  )
  const size = expanded ? SIZE_EXPANDED : SIZE_COMPACT

  const viewMetersRef = useRef(viewMeters)
  viewMetersRef.current = viewMeters
  const mapModeRef = useRef(mapMode)
  mapModeRef.current = mapMode
  const liveStreetsRef = useRef(liveStreetsOn)
  liveStreetsRef.current = liveStreetsOn
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  const sizeRef = useRef(size)
  sizeRef.current = size
  const waysRef = useRef(ways)
  waysRef.current = ways
  const routeRef = useRef(route)
  routeRef.current = route
  const originRef = useRef(origin)
  originRef.current = origin
  const overlayRef = useRef<GpsOverlayData | null>(null)
  const guidanceActiveRef = useRef(guidanceActive)
  guidanceActiveRef.current = guidanceActive

  const [overlayTick, setOverlayTick] = useState(0)

  useEffect(() => {
    writeMapMode(mapMode)
  }, [mapMode])
  useEffect(() => {
    writeViewMeters(viewMeters)
  }, [viewMeters])
  useEffect(() => {
    writeBool(EXPANDED_KEY, expanded)
    // Clamp zoom into the new max when collapsing.
    setViewMeters((m) => Math.min(m, expanded ? MAX_VIEW_EXPANDED : MAX_VIEW_COMPACT))
  }, [expanded])
  useEffect(() => {
    writeBool(TURNS_OPEN_KEY, turnsOpen)
  }, [turnsOpen])

  // Named ways for turn-road matching (only those with a label).
  const namedWays = useMemo(
    () =>
      ways
        .filter((w) => w.name?.trim())
        .map((w) => ({ points: w.points, name: w.name })),
    [ways],
  )
  const namedWaysRef = useRef(namedWays)
  namedWaysRef.current = namedWays

  // Regional overlay: fetch when zoomed out / expanded. Debounced on center.
  useEffect(() => {
    if (!wantsRegionalOverlay(viewMeters) && !expanded) {
      return
    }
    let cancelled = false
    const radius = Math.max(viewMeters * 0.75, expanded ? 25_000 : 12_000)
    const center = carPose.ready
      ? localToLatLng(carPose.x, carPose.z, origin)
      : origin
    const t = window.setTimeout(() => {
      void fetchGpsOverlay(center, radius).then((data) => {
        if (cancelled) return
        overlayRef.current = data
        setOverlayTick((n) => n + 1)
      })
    }, 280)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [viewMeters, expanded, origin.lat, origin.lng])

  // Re-fetch occasionally as the car drifts into a new coarse cell.
  useEffect(() => {
    if (!wantsRegionalOverlay(viewMeters) && !expanded) return
    const id = window.setInterval(() => {
      const originNow = originRef.current
      const center = carPose.ready
        ? localToLatLng(carPose.x, carPose.z, originNow)
        : originNow
      const radius = Math.max(viewMetersRef.current * 0.75, 25_000)
      void fetchGpsOverlay(center, radius).then((data) => {
        overlayRef.current = data
        setOverlayTick((n) => n + 1)
      })
    }, 45_000)
    return () => window.clearInterval(id)
  }, [expanded, viewMeters])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    /**
     * World (x, z) → canvas pixels, car at dial center.
     * Track-up: rotate by +yaw so car forward = canvas up.
     */
    const worldToPx = (
      x: number,
      z: number,
      cx: number,
      cz: number,
      yaw: number,
      trackUp: boolean,
      mPerPx: number,
      half: number,
    ) => {
      let dx = x - cx
      let dz = z - cz
      if (trackUp) {
        const c = Math.cos(yaw)
        const s = Math.sin(yaw)
        const rx = dx * c - dz * s
        const rz = dx * s + dz * c
        dx = rx
        dz = rz
      }
      return {
        x: half + dx / mPerPx,
        y: half + dz / mPerPx,
      }
    }

    const strokePoly = (
      pts: XzPoint[],
      cx: number,
      cz: number,
      yaw: number,
      trackUp: boolean,
      mPerPx: number,
      half: number,
    ) => {
      if (pts.length < 2) return
      ctx.beginPath()
      const a = worldToPx(pts[0][0], pts[0][2], cx, cz, yaw, trackUp, mPerPx, half)
      ctx.moveTo(a.x, a.y)
      for (let i = 1; i < pts.length; i++) {
        const p = worldToPx(pts[i][0], pts[i][2], cx, cz, yaw, trackUp, mPerPx, half)
        ctx.lineTo(p.x, p.y)
      }
      ctx.stroke()
    }

    const fillPoly = (
      pts: XzPoint[],
      cx: number,
      cz: number,
      yaw: number,
      trackUp: boolean,
      mPerPx: number,
      half: number,
    ) => {
      if (pts.length < 3) return
      ctx.beginPath()
      const a = worldToPx(pts[0][0], pts[0][2], cx, cz, yaw, trackUp, mPerPx, half)
      ctx.moveTo(a.x, a.y)
      for (let i = 1; i < pts.length; i++) {
        const p = worldToPx(pts[i][0], pts[i][2], cx, cz, yaw, trackUp, mPerPx, half)
        ctx.lineTo(p.x, p.y)
      }
      ctx.closePath()
      ctx.fill()
    }

    let raf = 0
    let guideAcc = 0
    let lastGuide: GuidanceSnapshot | null = null

    const draw = () => {
      const trackUp = mapModeRef.current === 'track'
      const S = sizeRef.current
      const half = S / 2
      const cx = carPose.ready ? carPose.x : 0
      const cz = carPose.ready ? carPose.z : 0
      const yaw = carPose.ready ? carPose.yaw : 0
      const viewM = viewMetersRef.current
      const mPerPx = viewM / S
      const liveOn = liveStreetsRef.current
      const regional = wantsRegionalOverlay(viewM)

      // Resize backing store if expand toggled (no React remount of Scene).
      if (canvas.width !== S || canvas.height !== S) {
        canvas.width = S
        canvas.height = S
      }

      ctx.fillStyle = '#0b1c28'
      ctx.fillRect(0, 0, S, S)

      ctx.save()
      ctx.beginPath()
      ctx.arc(half, half, half - 1, 0, Math.PI * 2)
      ctx.clip()

      const ov = overlayRef.current
      const originNow = originRef.current

      // --- Water: soft fills under roads (mid+ / any expanded overlay) ---
      if (ov && (regional || expandedRef.current || viewM > 1_400)) {
        ctx.fillStyle = 'rgba(66, 165, 245, 0.28)'
        for (const poly of overlayToLocal(ov.water, originNow)) {
          fillPoly(poly, cx, cz, yaw, trackUp, mPerPx, half)
        }
      }

      // --- Admin scraps (state boundary bits in bbox) ---
      if (ov && regional) {
        ctx.strokeStyle = 'rgba(255, 213, 79, 0.45)'
        ctx.lineWidth = 1.1
        ctx.setLineDash([4, 4])
        for (const poly of overlayToLocal(ov.admin, originNow)) {
          strokePoly(poly, cx, cz, yaw, trackUp, mPerPx, half)
        }
        ctx.setLineDash([])
      }

      // --- Overlay majors (regional backbone / expanded cartography) ---
      if (ov && (regional || expandedRef.current || viewM > 1_200)) {
        ctx.strokeStyle = '#8fa8b8'
        ctx.lineWidth = regional ? 1.8 : 1.4
        for (const poly of overlayToLocal(ov.majors, originNow)) {
          strokePoly(poly, cx, cz, yaw, trackUp, mPerPx, half)
        }
      }

      // --- Live loaded streets (load heartbeat) — toggleable ---
      // Dual-duty: close zoom paints the stream cue; far/expanded prefers
      // overlay majors + route + markers. If overlay majors are ready, skip
      // live paint entirely so residential spaghetti cannot fight cartography.
      const overlayCartography = preferOverlayCartography(
        viewM,
        expandedRef.current,
      )
      const overlayHasMajors = (ov?.majors.length ?? 0) > 0
      const paintLive =
        liveOn && !(overlayCartography && overlayHasMajors)
      if (paintLive) {
        const liveWays = waysRef.current
        for (const w of liveWays) {
          if (!keepLiveWayAtZoom(w.highway, viewM)) continue
          const major =
            w.highway === 'motorway' ||
            w.highway === 'trunk' ||
            w.highway === 'primary' ||
            w.highway === 'secondary'
          // Far without overlay yet: majors-only accent (keepLiveWayAtZoom).
          ctx.strokeStyle = overlayCartography
            ? major
              ? '#a8c0ce'
              : '#5c7a8a'
            : '#5c7a8a'
          ctx.lineWidth = major ? 1.6 : 1.15
          strokePoly(w.points, cx, cz, yaw, trackUp, mPerPx, half)
        }
      }

      // --- Blue route ---
      const routePts = routeRef.current
      if (routePts.length >= 2) {
        ctx.strokeStyle = '#42a5f5'
        ctx.lineWidth = regional ? 2.8 : 2.4
        strokePoly(routePts, cx, cz, yaw, trackUp, mPerPx, half)
        const end = worldToPx(
          routePts[routePts.length - 1][0],
          routePts[routePts.length - 1][2],
          cx,
          cz,
          yaw,
          trackUp,
          mPerPx,
          half,
        )
        ctx.fillStyle = '#ef5350'
        ctx.beginPath()
        ctx.arc(end.x, end.y, regional ? 5 : 4, 0, Math.PI * 2)
        ctx.fill()
      }

      // --- State label (far zoom only — hide when close) ---
      if (ov?.stateLabel && viewM >= 3_500) {
        const { x, z } = latLngToLocal(ov.stateLabel.at, originNow)
        const p = worldToPx(x, z, cx, cz, yaw, trackUp, mPerPx, half)
        // Keep label readable: only draw if roughly on-dial.
        if (p.x > 8 && p.x < S - 8 && p.y > 8 && p.y < S - 8) {
          ctx.fillStyle = 'rgba(255, 236, 179, 0.85)'
          ctx.font = `bold ${regional ? 13 : 11}px system-ui, sans-serif`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(ov.stateLabel.name, p.x, p.y)
        }
      }

      // Fixed car chevron at center.
      ctx.save()
      ctx.translate(half, half)
      if (!trackUp) {
        ctx.rotate(yaw)
      }
      ctx.fillStyle = '#ffca28'
      ctx.beginPath()
      ctx.moveTo(0, -7)
      ctx.lineTo(5, 6)
      ctx.lineTo(0, 3)
      ctx.lineTo(-5, 6)
      ctx.closePath()
      ctx.fill()
      ctx.restore()

      ctx.restore() // end circle clip

      // North marker
      {
        const nx = trackUp ? Math.sin(yaw) : 0
        const ny = trackUp ? -Math.cos(yaw) : -1
        const rim = half - 14
        const bx = half + nx * rim
        const by = half + ny * rim
        ctx.fillStyle = 'rgba(11, 28, 40, 0.75)'
        ctx.beginPath()
        ctx.arc(bx, by, 9, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#ef5350'
        ctx.font = 'bold 11px system-ui, sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('N', bx, by)
      }

      ctx.strokeStyle = 'rgba(207, 232, 245, 0.35)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(half, half, half - 1.5, 0, Math.PI * 2)
      ctx.stroke()

      if (carPose.ready && coordRef.current) {
        const ll = localToLatLng(carPose.x, carPose.z, originNow)
        coordRef.current.textContent = `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`
      }

      // Guidance strip (~4 Hz) — DOM refs, no setState in rAF.
      guideAcc++
      if (guidanceActiveRef.current && routePts.length >= 2 && guideAcc % 8 === 0) {
        lastGuide = guidanceFromRoute(cx, cz, routePts, namedWaysRef.current)
        if (lastGuide) {
          if (remainRef.current) {
            remainRef.current.textContent = formatDriveDistance(lastGuide.remainingM)
          }
          const turn = lastGuide.nextTurn
          if (turn) {
            if (turnDistRef.current) {
              turnDistRef.current.textContent = formatDriveDistance(turn.distanceM)
            }
            if (turnCueRef.current) {
              turnCueRef.current.textContent = `${turnArrow(turn.kind)} ${turnLabel(turn.kind)}`
            }
            if (turnRoadRef.current) {
              turnRoadRef.current.textContent = turn.roadName?.trim() || ''
            }
          }
        }
      } else if (!guidanceActiveRef.current) {
        lastGuide = null
      }

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
    // overlayTick refreshes overlayRef; size/ways/route read via refs.
  }, [origin, size, overlayTick])

  const toggleMode = () => {
    setMapMode((m) => (m === 'track' ? 'north' : 'track'))
  }

  const zoomIn = () =>
    setViewMeters((m) => Math.max(MIN_VIEW_METERS, Math.round(m / ZOOM_STEP)))
  const zoomOut = () =>
    setViewMeters((m) => Math.min(maxView, Math.round(m * ZOOM_STEP)))

  const viewLabel =
    viewMeters >= 1000
      ? `${(viewMeters / 1000).toFixed(viewMeters >= 10_000 ? 0 : 1)} km`
      : `${Math.round(viewMeters)} m`

  return (
    <div className={`gps${expanded ? ' gps-expanded' : ''}`}>
      <div className="gps-toolbar">
        <button
          type="button"
          className="gps-mode-btn"
          onClick={() => onLiveStreetsOn?.(!liveStreetsOn)}
          title={
            liveStreetsOn
              ? 'Hide live loaded streets on the dial (majors/route/overlays stay)'
              : 'Show live loaded streets on the dial (stream load cue)'
          }
          aria-label={
            liveStreetsOn
              ? 'Live streets on dial: ON. Turn off.'
              : 'Live streets on dial: OFF. Turn on.'
          }
          aria-pressed={liveStreetsOn}
        >
          Streets {liveStreetsOn ? 'ON' : 'OFF'}
        </button>
        <button
          type="button"
          className="gps-mode-btn"
          onClick={toggleMode}
          title={
            mapMode === 'track'
              ? 'Track-up (map rotates). Click for North-up.'
              : 'North-up (map fixed). Click for Track-up.'
          }
          aria-label={
            mapMode === 'track'
              ? 'Map mode: Track-up. Switch to North-up.'
              : 'Map mode: North-up. Switch to Track-up.'
          }
        >
          {mapMode === 'track' ? 'Track-up' : 'North-up'}
        </button>
        <button
          type="button"
          className="gps-mode-btn"
          onClick={zoomIn}
          title="Zoom in (less ground)"
          aria-label="GPS zoom in"
        >
          +
        </button>
        <button
          type="button"
          className="gps-mode-btn"
          onClick={zoomOut}
          title="Zoom out (more ground — expand for tens of km)"
          aria-label="GPS zoom out"
        >
          −
        </button>
        <button
          type="button"
          className="gps-mode-btn"
          onClick={() => setExpanded((v) => !v)}
          title={
            expanded
              ? 'Shrink GPS dial'
              : 'Expand GPS dial (larger + deeper zoom-out)'
          }
          aria-label={expanded ? 'Collapse GPS' : 'Expand GPS'}
          aria-pressed={expanded}
        >
          {expanded ? '▣' : '▢'}
        </button>
      </div>
      <canvas
        ref={canvasRef}
        width={size}
        height={size}
        aria-label="GPS"
        style={{ width: size, height: size }}
      />
      <p className="gps-coord" ref={coordRef}>
        GPS
      </p>
      <p className="gps-zoom-meta" aria-hidden>
        {viewLabel} across
      </p>

      {guidanceActive ? (
        <div className="gps-guide" role="status" aria-live="polite">
          <div className="gps-guide-remain">
            <span className="gps-guide-label">Destination</span>
            <span className="gps-guide-value" ref={remainRef}>
              —
            </span>
          </div>
          <button
            type="button"
            className="gps-guide-toggle"
            onClick={() => setTurnsOpen((v) => !v)}
            aria-expanded={turnsOpen}
            title={turnsOpen ? 'Hide next turn' : 'Show next turn'}
          >
            Next turn {turnsOpen ? '▾' : '▸'}
          </button>
          {turnsOpen ? (
            <div className="gps-guide-turn">
              <span className="gps-guide-cue" ref={turnCueRef}>
                ↑ Continue
              </span>
              <span className="gps-guide-turn-dist" ref={turnDistRef}>
                —
              </span>
              <span className="gps-guide-road" ref={turnRoadRef} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
