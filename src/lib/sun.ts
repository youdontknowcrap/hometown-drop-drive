/**
 * Approximate sun direction from lat/lng + local clock.
 *
 * LEARNING NOTE — why bother?
 *   A fixed sun at [40,60,20] always looks like “noon in a video game.”
 *   Real places have a sun that arcs with time and latitude. We use a
 *   compact solar-position model (good enough for a STEM racer sky):
 *
 *   1) Day-of-year → solar declination δ (Earth’s tilt ≈ 23.44°).
 *   2) Local solar time → hour angle H (15° per hour from noon).
 *   3) Elevation α and azimuth A from lat φ, δ, H.
 *   4) Convert to a Three.js direction vector (Y-up, −Z = north).
 *
 * Formulae (degrees → radians inside):
 *   δ = 23.44° · sin(2π · (284 + n) / 365)
 *   α = asin( sinφ sinδ + cosφ cosδ cos H )
 *   A = atan2( −cosδ sin H , cosφ sinδ − sinφ cosδ cos H )
 *       (A = 0 south in some conventions; we map to world −Z = north)
 *
 * Optional: pass weather sunrise/sunset ISO strings to dim after dusk.
 */

import type { LatLng } from './geo'

const DEG = Math.PI / 180
const RAD = 180 / Math.PI

export type SunState = {
  /** Unit-ish direction FROM ground TOWARD the sun (world space). */
  direction: [number, number, number]
  /** Solar elevation angle in degrees (−90 night … +90 zenith). */
  elevationDeg: number
  /** 0 = night, 1 = high noon-ish (smooth). */
  daylight: number
  /** Short HUD / debug label. */
  label: string
}

/** Day of year 1…365 (non-leap approximation is fine for toys). */
function dayOfYear(d: Date): number {
  const start = Date.UTC(d.getFullYear(), 0, 0)
  const now = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
  return Math.floor((now - start) / 86_400_000)
}

/**
 * Local solar time in hours (0–24), approximating longitude correction
 * from the Drop’s lng vs the timezone offset already baked into `date`.
 * Good enough — we are not building a navigation sextant.
 */
function localSolarHours(date: Date, lng: number): number {
  const utcHours =
    date.getUTCHours() +
    date.getUTCMinutes() / 60 +
    date.getUTCSeconds() / 3600
  // Equation of time ignored; lng/15 shifts solar noon.
  return (utcHours + lng / 15 + 24) % 24
}

/**
 * Compute sun direction for a Drop lat/lng at `date` (browser local Date,
 * or any Date — we use UTC fields + lng for solar time).
 */
export function sunAt(origin: LatLng, date: Date = new Date()): SunState {
  const n = dayOfYear(date)
  // Declination (Cooper 1969 approximation) — teaching classic.
  const decl = 23.44 * Math.sin(((284 + n) / 365) * 2 * Math.PI)
  const declRad = decl * DEG
  const latRad = origin.lat * DEG

  const solarH = localSolarHours(date, origin.lng)
  const hourAngle = (15 * (solarH - 12)) * DEG // radians west of noon

  // Elevation α
  const sinEl =
    Math.sin(latRad) * Math.sin(declRad) +
    Math.cos(latRad) * Math.cos(declRad) * Math.cos(hourAngle)
  const elevationRad = Math.asin(Math.max(-1, Math.min(1, sinEl)))
  const elevationDeg = elevationRad * RAD

  // Azimuth: 0 = north, clockwise (navigation style).
  const cosEl = Math.cos(elevationRad)
  let azRad = 0
  if (Math.abs(cosEl) > 1e-6) {
    const sinAz =
      (-Math.cos(declRad) * Math.sin(hourAngle)) / Math.max(1e-6, cosEl)
    const cosAz =
      (Math.cos(latRad) * Math.sin(declRad) -
        Math.sin(latRad) * Math.cos(declRad) * Math.cos(hourAngle)) /
      Math.max(1e-6, cosEl)
    azRad = Math.atan2(sinAz, cosAz) // −π…π, 0 = north
  }

  // World: +X east, +Y up, −Z north → sun vector
  // Keep light slightly above horizon so shadows don't vanish at dusk.
  const elForDir = Math.max(elevationRad, -5 * DEG)
  const x = Math.sin(azRad) * Math.cos(elForDir) // east
  const y = Math.sin(elForDir)
  const z = -Math.cos(azRad) * Math.cos(elForDir) // −Z north

  // Daylight factor for sky/fog intensity (smoothstep around horizon).
  const daylight = Math.max(0, Math.min(1, (elevationDeg + 6) / 40))

  const hh = date.getHours().toString().padStart(2, '0')
  const mm = date.getMinutes().toString().padStart(2, '0')
  const label = `Sun el ${elevationDeg.toFixed(0)}° · ${hh}:${mm} local`

  // Normalize direction for directionalLight position (scaled later).
  const len = Math.hypot(x, y, z) || 1
  return {
    direction: [x / len, y / len, z / len],
    elevationDeg,
    daylight,
    label,
  }
}

/** Scale a unit sun direction into a far light position. */
export function sunLightPosition(
  dir: [number, number, number],
  distance = 180,
): [number, number, number] {
  return [dir[0] * distance, Math.max(8, dir[1] * distance), dir[2] * distance]
}
