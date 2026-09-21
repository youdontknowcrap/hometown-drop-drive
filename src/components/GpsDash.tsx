import { useEffect, useRef, useState } from 'react'
import { carPose } from '../lib/carPose'
import { localToLatLng, type LatLng } from '../lib/geo'
import type { XzPoint } from '../lib/roadMesh'

type GpsDashProps = {
  origin: LatLng
  ways: XzPoint[][]
  /** Optional blue GPS route overlay on the mini-map. */
  route?: XzPoint[]
}

/** Canvas size in CSS pixels (also the backing-store size). */
const SIZE = 168

/**
 * How many world meters fit across the mini-map.
 * Teaching: classic car GPS is a *local* moving map, not a whole-city overview.
 * ~220 m across ≈ a few blocks — enough to see turns coming without zooming out.
 */
const VIEW_METERS = 220

/** localStorage key for north-up vs track-up preference. */
const MAP_MODE_KEY = 'hdd-gps-map-mode'

type MapMode = 'track' | 'north'

function readMapMode(): MapMode {
  try {
    const v = localStorage.getItem(MAP_MODE_KEY)
    if (v === 'north') return 'north'
    // Default Track-up: car chevron stays fixed “up”, map swings under it.
    return 'track'
  } catch {
    return 'track'
  }
}

function writeMapMode(mode: MapMode) {
  try {
    localStorage.setItem(MAP_MODE_KEY, mode)
  } catch {
    /* private mode / blocked storage — ignore */
  }
}

/**
 * Mini map of the loaded street grid + car blip + GPS route.
 *
 * Track-up (default, classic dash GPS):
 *   - Car chevron stays fixed in the center, tip pointing *up* on the canvas.
 *   - Streets / route translate with the car and rotate by **−yaw** so the
 *     direction the car is facing is always toward the top of the dial.
 *   - Feel it: turn left → the map swings *right* under the fixed chevron
 *     (same as a real car GPS).
 *
 * North-up:
 *   - Map stays north-aligned (world +X → right, +Z → down on canvas).
 *   - Car icon rotates with yaw; map still recenters on the car.
 *
 * Yaw convention (from Car / Three.js): yaw = 0 faces world −Z; positive yaw
 * is a left turn. Canvas +Y is down, so −Z maps to “up” on the dial — which
 * is why rotate(−yaw) puts forward at the top in track-up.
 */
export function GpsDash({ origin, ways, route = [] }: GpsDashProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const coordRef = useRef<HTMLParagraphElement>(null)
  const [mapMode, setMapMode] = useState<MapMode>(readMapMode)
  // Ref so the rAF draw loop always sees the latest mode without restarting.
  const mapModeRef = useRef(mapMode)
  mapModeRef.current = mapMode

  useEffect(() => {
    writeMapMode(mapMode)
  }, [mapMode])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const half = SIZE / 2
    // meters → pixels: VIEW_METERS spans the full dial width.
    const mPerPx = VIEW_METERS / SIZE

    /**
     * World (x, z) → canvas pixels, with the car at the dial center.
     * In track-up we also rotate by −yaw so forward = up.
     */
    const worldToPx = (
      x: number,
      z: number,
      cx: number,
      cz: number,
      yaw: number,
      trackUp: boolean,
    ) => {
      // Relative to car in world XZ (Z “south” on a north-up canvas).
      let dx = x - cx
      let dz = z - cz
      if (trackUp) {
        // Rotate the offset by −yaw in the XZ plane.
        // R_−θ (dx, dz) = (dx cosθ + dz sinθ, −dx sinθ + dz cosθ)
        // with θ = yaw. After this, the car’s forward (−sinθ, −cosθ) lands on (0, −1)
        // in canvas space = straight up on the dial.
        const c = Math.cos(yaw)
        const s = Math.sin(yaw)
        const rx = dx * c + dz * s
        const rz = -dx * s + dz * c
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
    ) => {
      if (pts.length < 2) return
      ctx.beginPath()
      const a = worldToPx(pts[0][0], pts[0][2], cx, cz, yaw, trackUp)
      ctx.moveTo(a.x, a.y)
      for (let i = 1; i < pts.length; i++) {
        const p = worldToPx(pts[i][0], pts[i][2], cx, cz, yaw, trackUp)
        ctx.lineTo(p.x, p.y)
      }
      ctx.stroke()
    }

    let raf = 0
    const draw = () => {
      const trackUp = mapModeRef.current === 'track'
      const cx = carPose.ready ? carPose.x : 0
      const cz = carPose.ready ? carPose.z : 0
      const yaw = carPose.ready ? carPose.yaw : 0

      ctx.fillStyle = '#0b1c28'
      ctx.fillRect(0, 0, SIZE, SIZE)

      // Clip to a soft circle so the rotating map doesn’t look like a spinning square.
      ctx.save()
      ctx.beginPath()
      ctx.arc(half, half, half - 1, 0, Math.PI * 2)
      ctx.clip()

      ctx.strokeStyle = '#5c7a8a'
      ctx.lineWidth = 1.2
      for (const way of ways) {
        strokePoly(way, cx, cz, yaw, trackUp)
      }

      if (route.length >= 2) {
        ctx.strokeStyle = '#42a5f5'
        ctx.lineWidth = 2.4
        strokePoly(route, cx, cz, yaw, trackUp)
        const end = worldToPx(
          route[route.length - 1][0],
          route[route.length - 1][2],
          cx,
          cz,
          yaw,
          trackUp,
        )
        ctx.fillStyle = '#ef5350'
        ctx.beginPath()
        ctx.arc(end.x, end.y, 4, 0, Math.PI * 2)
        ctx.fill()
      }

      // Fixed car chevron at center. Track-up: always tip-up. North-up: rotate with yaw.
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

      // North marker: sits near the rim and rotates in track-up so N still means north.
      // Teaching: in track-up the whole map (and this N) spins; in north-up N stays at top.
      {
        // World north is −Z. On a north-up canvas that is straight up.
        // In track-up, worldToPx already rotated by −yaw, so a point due north
        // of the car lands at (sin(yaw), −cos(yaw)) on the dial — put N there.
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
        // Letter stays upright so it’s readable while the badge orbits.
        ctx.fillText('N', bx, by)
      }

      // Thin rim ring so the dial reads as a compass bezel.
      ctx.strokeStyle = 'rgba(207, 232, 245, 0.35)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(half, half, half - 1.5, 0, Math.PI * 2)
      ctx.stroke()

      if (carPose.ready && coordRef.current) {
        const ll = localToLatLng(carPose.x, carPose.z, origin)
        coordRef.current.textContent = `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`
      }

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [origin, ways, route])

  const toggleMode = () => {
    setMapMode((m) => (m === 'track' ? 'north' : 'track'))
  }

  return (
    <div className="gps">
      <div className="gps-toolbar">
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
      </div>
      <canvas ref={canvasRef} width={SIZE} height={SIZE} aria-label="GPS" />
      <p className="gps-coord" ref={coordRef}>
        GPS
      </p>
    </div>
  )
}
