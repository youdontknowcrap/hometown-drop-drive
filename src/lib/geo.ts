/**
 * Tiny geo helpers: convert lat/lng ↔ local XZ meters for the play space.
 * Origin is the route start (or demo origin). Y is up in Three.js.
 */

export type LatLng = { lat: number; lng: number }

/** Approximate meters per degree at a given latitude (good enough for a toy). */
export function metersPerDegree(lat: number): { mPerDegLat: number; mPerDegLng: number } {
  const mPerDegLat = 111_320
  const mPerDegLng = 111_320 * Math.cos((lat * Math.PI) / 180)
  return { mPerDegLat, mPerDegLng }
}

/** Project a lat/lng into local XZ meters relative to an origin. */
export function latLngToLocal(
  point: LatLng,
  origin: LatLng,
): { x: number; z: number } {
  const { mPerDegLat, mPerDegLng } = metersPerDegree(origin.lat)
  const x = (point.lng - origin.lng) * mPerDegLng
  // Negate so "north" maps to -Z (common Three.js convention).
  const z = -(point.lat - origin.lat) * mPerDegLat
  return { x, z }
}

/** Inverse of latLngToLocal — GPS dash. */
export function localToLatLng(
  x: number,
  z: number,
  origin: LatLng,
): LatLng {
  const { mPerDegLat, mPerDegLng } = metersPerDegree(origin.lat)
  return {
    lng: origin.lng + x / mPerDegLng,
    lat: origin.lat - z / mPerDegLat,
  }
}

/** Convert a polyline of lat/lng into local XZ points. */
export function polylineToLocal(
  points: LatLng[],
  origin: LatLng,
): Array<[number, number, number]> {
  return points.map((p) => {
    const { x, z } = latLngToLocal(p, origin)
    return [x, 0.15, z] as [number, number, number]
  })
}

/** Great-circle meters between two WGS84 points. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6_371_000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)))
}

/** Path length in real meters (Earth), not screen units. */
export function polylineLengthMeters(points: LatLng[]): number {
  let d = 0
  for (let i = 1; i < points.length; i++) {
    d += haversineMeters(points[i - 1], points[i])
  }
  return d
}

/** Distance between two XZ points (ignore Y). */
export function xzDistance(
  a: [number, number, number] | { x: number; z: number },
  b: [number, number, number] | { x: number; z: number },
): number {
  const ax = Array.isArray(a) ? a[0] : a.x
  const az = Array.isArray(a) ? a[2] : a.z
  const bx = Array.isArray(b) ? b[0] : b.x
  const bz = Array.isArray(b) ? b[2] : b.z
  const dx = ax - bx
  const dz = az - bz
  return Math.hypot(dx, dz)
}
