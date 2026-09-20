/**
 * Offline / CORS-fallback demo route around Ridgecrest, CA.
 * A short scenic loop so the prototype always has a blue guidance line
 * even when Nominatim/OSRM are blocked or offline.
 */
import type { LatLng } from './geo'

/** Rough downtown / China Lake Blvd area — family-friendly demo. */
export const DEMO_ORIGIN: LatLng = { lat: 35.6225, lng: -117.6709 }

/**
 * Hand-authored polyline (degrees). Not a real street-perfect path —
 * just enough points for a visible driveable guidance ribbon.
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

export const DEMO_START_LABEL = 'Ridgecrest CA (demo start)'
export const DEMO_STOP_LABEL = 'Ridgecrest CA (demo loop)'
