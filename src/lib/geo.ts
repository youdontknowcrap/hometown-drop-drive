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
