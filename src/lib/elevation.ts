/**
 * Elevation orchestrator: Terrarium first, Open-Meteo fallback, quiet flat last.
 *
 * Prefer working hills over perfect Terrarium. Flow (near playfield):
 *   1) Try Mapzen Terrarium PNG tiles (needs Vite `/api/terrarium` proxy).
 *   2) If that returns flat / fails → sample Open-Meteo elevation grid.
 *   3) If BOTH fail after an honest try → quiet flat ground (no scary HUD).
 *
 * Far skyline ring (separate, visual-only):
 *   After near succeeds, fetch a coarse ~12 km grid (Terrarium z8–z9, else
 *   Open-Meteo ≤100 pts). Same spawnElevMsl zero as near. No physics.
 *
 * HUD messages clearly say “Terrarium…”, “Open-Meteo elev…”, or “Flat ground”.
 */

import {
  fetchFarHeightGrid as fetchTerrariumFarHeightGrid,
  fetchHeightGrid as fetchTerrariumHeightGrid,
  type FarTerrainFetchOpts,
  type HeightGrid,
  type TerrainFetchOpts,
} from './terrarium'
import {
  fetchOpenMeteoFarHeightGrid,
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

/**
 * Coarse far LOD height grid for distant mountains / skyline.
 * Returns null when both Terrarium-far and Open-Meteo-far fail (Scene skips mesh).
 */
export async function fetchFarElevationGrid(
  opts: FarTerrainFetchOpts,
): Promise<HeightGrid | null> {
  try {
    const far = await fetchTerrariumFarHeightGrid(opts)
    if (far && far.source === 'terrarium') return far
    console.info('[elevation] Terrarium far failed → Open-Meteo far')
  } catch (err) {
    console.warn('[elevation] Terrarium far threw', err)
  }

  try {
    const om = await fetchOpenMeteoFarHeightGrid(opts)
    if (om) return om
  } catch (err) {
    console.warn('[elevation] Open-Meteo far threw', err)
  }

  return null
}

export type { HeightGrid, TerrainFetchOpts, FarTerrainFetchOpts }
