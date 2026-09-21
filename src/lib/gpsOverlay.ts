/**
 * Sparse GPS overlays for wide zoom: major roads, water, nearby state
 * boundary scraps + a state name label.
 *
 * LEARNING: streamed activeWays only cover ~few km of tiles. Zooming the
 * dial out to tens of km would look empty (or like spaghetti if we painted
 * every residential). One Overpass bbox fetch gives motorway→secondary,
 * lakes, and admin_level=4 *ways that intersect the view* — not the whole
 * California multipolygon.
 *
 * Prefer playable ship over perfect cartography: cache coarse cells, skip
 * on failure, let the blue route + majors carry the regional overview.
 */
import { metersPerDegree, type LatLng } from './geo'
import { overpassInterpreter, nominatimSearch } from './osmApi'

export type OverlayWay = {
  points: LatLng[]
  highway?: string
  name?: string
  kind: 'major' | 'water' | 'admin'
}

export type GpsOverlayData = {
  majors: OverlayWay[]
  water: OverlayWay[]
  admin: OverlayWay[]
  /** e.g. “California” — drawn only at far zoom. */
  stateLabel: { name: string; at: LatLng } | null
  /** Center/radius this payload was fetched for. */
  center: LatLng
  radiusM: number
}

type OverpassEl = {
  type: string
  tags?: Record<string, string>
  geometry?: Array<{ lat: number; lon: number }>
  lat?: number
  lon?: number
}

const MAJOR_RE = '^(motorway|trunk|primary|secondary|motorway_link|trunk_link|primary_link|secondary_link)$'

/** Coarse cache so panning/zooming doesn’t hammer Overpass. */
const cache = new Map<string, GpsOverlayData>()
const inflight = new Map<string, Promise<GpsOverlayData>>()

function cacheKey(center: LatLng, radiusM: number): string {
  // ~0.2° ≈ 20 km cells; radius bucketed to 10 km steps.
  const lat = (Math.round(center.lat * 5) / 5).toFixed(1)
  const lng = (Math.round(center.lng * 5) / 5).toFixed(1)
  const r = Math.round(radiusM / 10_000) * 10
  return `${lat},${lng},${r}`
}

function bboxAround(origin: LatLng, radiusM: number) {
  const { mPerDegLat, mPerDegLng } = metersPerDegree(origin.lat)
  const dLat = radiusM / mPerDegLat
  const dLng = radiusM / Math.max(1e-6, mPerDegLng)
  return {
    south: origin.lat - dLat,
    west: origin.lng - dLng,
    north: origin.lat + dLat,
    east: origin.lng + dLng,
  }
}

function parseWays(
  elements: OverpassEl[] | undefined,
  kind: OverlayWay['kind'],
  highwayFilter?: (h: string) => boolean,
): OverlayWay[] {
  const out: OverlayWay[] = []
  for (const el of elements ?? []) {
    if (!el.geometry || el.geometry.length < 2) continue
    const highway = el.tags?.highway
    if (highwayFilter && (!highway || !highwayFilter(highway))) continue
    out.push({
      points: el.geometry.map((g) => ({ lat: g.lat, lng: g.lon })),
      highway,
      name: el.tags?.name?.trim() || el.tags?.ref?.trim() || undefined,
      kind,
    })
  }
  return out
}

async function reverseStateLabel(center: LatLng): Promise<{ name: string; at: LatLng } | null> {
  // Cheap: Nominatim search for “state near lat,lng” is awkward; use a
  // reverse-style query via search with lat/lng structured fallback.
  // Public Nominatim supports /reverse — our helper only has search, so
  // ask for the state containing the point with a short query.
  try {
    const q = `${center.lat.toFixed(3)},${center.lng.toFixed(3)}`
    const res = await nominatimSearch(q)
    const data = (await res.json()) as Array<{
      display_name?: string
      lat?: string
      lon?: string
      address?: { state?: string }
    }>
    const hit = data[0]
    if (!hit) return null
    // display_name is “road, city, county, state, country…” — pick state-ish token.
    const parts = (hit.display_name ?? '').split(',').map((s) => s.trim())
    // Prefer a part that looks like a US state name (no digits, not country).
    const skip = new Set(['United States', 'USA', 'US'])
    let name = parts.find(
      (p, i) =>
        i >= 1 &&
        !skip.has(p) &&
        !/\d/.test(p) &&
        p.length > 3 &&
        // state-ish: before country, after city
        i >= parts.length - 3,
    )
    // Ridgecrest-style: “…, Kern County, California, United States”
    if (parts.length >= 2) {
      const maybeState = parts[parts.length - 2]
      if (maybeState && !skip.has(maybeState) && !/County/i.test(maybeState)) {
        name = maybeState
      }
    }
    if (!name) return null
    return {
      name,
      at: {
        lat: hit.lat ? Number(hit.lat) : center.lat,
        lng: hit.lon ? Number(hit.lon) : center.lng,
      },
    }
  } catch {
    return null
  }
}

/**
 * Fetch majors + water + local admin scraps for a radius around center.
 * Always resolves — empty layers on failure (dial still works).
 */
export async function fetchGpsOverlay(
  center: LatLng,
  radiusM: number,
): Promise<GpsOverlayData> {
  const r = Math.max(5_000, Math.min(80_000, radiusM))
  const key = cacheKey(center, r)
  const hit = cache.get(key)
  if (hit) return hit
  const pending = inflight.get(key)
  if (pending) return pending

  const job = (async (): Promise<GpsOverlayData> => {
    const empty: GpsOverlayData = {
      majors: [],
      water: [],
      admin: [],
      stateLabel: null,
      center,
      radiusM: r,
    }
    try {
      const b = bboxAround(center, r)
      // Majors + waterways/lakes + admin_level=4 ways that cross the bbox.
      // `waterway=riverbank` / natural=water cover lakes without every puddle.
      const query = `[out:json][timeout:28];
(
  way["highway"~"${MAJOR_RE}"](${b.south},${b.west},${b.north},${b.east});
  way["natural"="water"](${b.south},${b.west},${b.north},${b.east});
  way["landuse"="reservoir"](${b.south},${b.west},${b.north},${b.east});
  way["water"~"^(lake|reservoir|pond)$"](${b.south},${b.west},${b.north},${b.east});
  way["boundary"="administrative"]["admin_level"="4"](${b.south},${b.west},${b.north},${b.east});
);
out geom;`
      const res = await overpassInterpreter(query)
      const data = (await res.json()) as { elements?: OverpassEl[] }
      const els = data.elements ?? []

      const majors = parseWays(els, 'major', (h) =>
        /^(motorway|trunk|primary|secondary|motorway_link|trunk_link|primary_link|secondary_link)$/.test(
          h,
        ),
      )
      const water = parseWays(
        els.filter(
          (e) =>
            e.tags?.natural === 'water' ||
            e.tags?.landuse === 'reservoir' ||
            /^(lake|reservoir|pond)$/.test(e.tags?.water ?? ''),
        ),
        'water',
      )
      const admin = parseWays(
        els.filter(
          (e) =>
            e.tags?.boundary === 'administrative' && e.tags?.admin_level === '4',
        ),
        'admin',
      )

      // Cap densities so a messy Overpass reply can’t freeze the canvas.
      const capped: GpsOverlayData = {
        majors: majors.slice(0, 400),
        water: water.slice(0, 80),
        admin: admin.slice(0, 40),
        stateLabel: await reverseStateLabel(center),
        center,
        radiusM: r,
      }
      cache.set(key, capped)
      return capped
    } catch (err) {
      console.warn('[gpsOverlay] fetch failed', err)
      cache.set(key, empty)
      return empty
    } finally {
      inflight.delete(key)
    }
  })()

  inflight.set(key, job)
  return job
}

/** True when the dial’s view span warrants simplified regional layers. */
export function wantsRegionalOverlay(viewMeters: number): boolean {
  return viewMeters >= 2_200
}

/** Major-class highway tag? (live ways filter at mid/far zoom). */
export function isMajorHighway(highway: string): boolean {
  const h = highway.toLowerCase()
  return (
    h === 'motorway' ||
    h === 'trunk' ||
    h === 'primary' ||
    h === 'secondary' ||
    (h.endsWith('_link') &&
      (h.startsWith('motorway') ||
        h.startsWith('trunk') ||
        h.startsWith('primary') ||
        h.startsWith('secondary')))
  )
}

/** Keep tertiary+ for mid zoom; drop service/dirt/residential at wide. */
export function keepLiveWayAtZoom(highway: string, viewMeters: number): boolean {
  const h = highway.toLowerCase()
  if (viewMeters < 900) return true
  if (viewMeters < 2_200) {
    // Mid: drop service / dirt / footways — keep residential as load cue.
    return !(
      h === 'service' ||
      h === 'track' ||
      h === 'path' ||
      h === 'footway' ||
      h === 'pedestrian' ||
      h === 'bridleway'
    )
  }
  // Far: live tiles only as major accents if overlay is late — else spaghetti.
  return isMajorHighway(h)
}
