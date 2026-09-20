/**
 * Offline / CORS-fallback demo streets around Ridgecrest, CA.
 * A short crossroads + loop so demo mode is obvious on screen
 * (not a single thin ribbon that blends into desert).
 */
import type { LatLng } from './geo'

/** Rough downtown / China Lake Blvd area — family-friendly demo. */
export const DEMO_ORIGIN: LatLng = { lat: 35.6225, lng: -117.6709 }

/**
 * Hand-authored polylines (degrees). Not street-perfect —
 * just enough for a visible driveable ribbon when OSM fails.
 */
export const DEMO_POLYLINE: LatLng[] = [
  { lat: 35.6225, lng: -117.6709 },
  { lat: 35.6240, lng: -117.6685 },
  { lat: 35.6260, lng: -117.6660 },
  { lat: 35.6280, lng: -117.6645 },
  { lat: 35.6300, lng: -117.6655 },
  { lat: 35.6315, lng: -117.6680 },
  { lat: 35.6320, lng: -117.6710 },
  { lat: 35.6310, lng: -117.6740 },
  { lat: 35.6290, lng: -117.6760 },
  { lat: 35.6265, lng: -117.6765 },
  { lat: 35.6240, lng: -117.6750 },
  { lat: 35.6225, lng: -117.6725 },
  { lat: 35.6225, lng: -117.6709 },
]

/** North–south demo arterial through the origin (reads as a real boulevard). */
export const DEMO_ARTERIAL: LatLng[] = [
  { lat: 35.6180, lng: -117.6709 },
  { lat: 35.6225, lng: -117.6709 },
  { lat: 35.6270, lng: -117.6709 },
  { lat: 35.6325, lng: -117.6709 },
]

/** East–west cross street + a short dirt spur for contrast. */
export const DEMO_CROSS: LatLng[] = [
  { lat: 35.6225, lng: -117.6780 },
  { lat: 35.6225, lng: -117.6709 },
  { lat: 35.6225, lng: -117.6635 },
]

export const DEMO_DIRT: LatLng[] = [
  { lat: 35.6225, lng: -117.6635 },
  { lat: 35.6200, lng: -117.6610 },
  { lat: 35.6185, lng: -117.6590 },
]

export const DEMO_START_LABEL = 'Ridgecrest CA (demo start)'
export const DEMO_STOP_LABEL = 'Ridgecrest CA (demo loop)'
