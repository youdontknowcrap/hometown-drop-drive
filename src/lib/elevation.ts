/**
 * Elevation orchestrator: Terrarium first, Open-Meteo fallback, quiet flat last.
 *
 * Prefer working hills over perfect Terrarium. Flow:
 *   1) Try Mapzen Terrarium PNG tiles (needs Vite `/api/terrarium` proxy).
 *   2) If that returns flat / fails → sample Open-Meteo elevation grid.
 *   3) If BOTH fail after an honest try → quiet flat ground (no scary HUD).
 *
 * HUD messages clearly say “Terrarium…”, “Open-Meteo elev…”, or “Flat ground”.
 */

import {
  fetchHeightGrid as fetchTerrariumHeightGrid,
  type HeightGrid,
  type TerrainFetchOpts,
} from './terrarium'
import {
  fetchOpenMeteoHeightGrid,
  quietFlatGrid,
} from './openMeteoElev'

/**
 * True when Terrarium gave us usable hills (not the flat fallback path).
 * A “success” with source==='flat' still means we should try Open-Meteo.
 */
function terrariumSucceeded(grid: HeightGrid): boolean {
  return grid.source === 'terrarium'
}

/**
 * Fetch elevation for the street bbox.
 * Always returns a playable HeightGrid (never throws to the UI).
 */
export async function fetchElevationGrid(
  opts: TerrainFetchOpts,
): Promise<HeightGrid> {
  // --- 1) Terrarium / SRTM tiles ---
  let terrarium: HeightGrid | null = null
  try {
    terrarium = await fetchTerrariumHeightGrid(opts)
    if (terrariumSucceeded(terrarium)) {
      return terrarium
    }
    console.info(
      '[elevation] Terrarium flat/failed → trying Open-Meteo:',
      terrarium.message,
    )
  } catch (err) {
    console.warn('[elevation] Terrarium threw', err)
  }

  // --- 2) Open-Meteo grid sampler (CORS-friendly, no key) ---
  try {
    const om = await fetchOpenMeteoHeightGrid(opts)
    if (om && om.source === 'open-meteo') {
      return om
    }
  } catch (err) {
    console.warn('[elevation] Open-Meteo threw', err)
  }

  // --- 3) Quiet flat — playable, no “could not sample” noise ---
  return quietFlatGrid(opts)
}

export type { HeightGrid, TerrainFetchOpts }
