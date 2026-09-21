/**
 * Message types for the tile-loader Web Worker.
 *
 * LEARNING — worker vs main (Joey Drop TTI lesson):
 *   Overpass fetch is **network-bound**. Parking it in a Web Worker does not
 *   make the HTTP faster — it only adds postMessage + structured-clone cost,
 *   then the apply coordinator still has to merge on main. So ways/buildings
 *   stay on the **main thread** as plain async fetch (see tileLoaderClient).
 *
 *   The worker *is* worth it for **Terrarium PNG decode** (elevNear / elevFar):
 *   pixel → Float32 work is CPU-bound and used to hitch React Three Fiber /
 *   Rapier / WASD. Main only receives the HeightGrid and setState’s it.
 *
 *   StreetTileStreamer still owns MAX_IN_FLIGHT + OVERPASS_GAP_MS so we never
 *   stampede public Overpass interpreters.
 */

import type { FarTerrainFetchOpts, HeightGrid, TerrainFetchOpts } from './terrarium'

export type TileLoaderRequest =
  | {
      id: number
      type: 'elevNear'
      opts: TerrainFetchOpts
    }
  | {
      id: number
      type: 'elevFar'
      opts: FarTerrainFetchOpts
    }

/** HeightGrid over the wire — heights may be a plain array after structured clone. */
export type TileLoaderElevResult = {
  grid: HeightGrid | null
  /** Near path always returns a playable grid; far may be null. */
}

export type TileLoaderResponse =
  | {
      id: number
      ok: true
      type: 'elevNear'
      result: TileLoaderElevResult
    }
  | {
      id: number
      ok: true
      type: 'elevFar'
      result: TileLoaderElevResult
    }
  | {
      id: number
      ok: false
      type: TileLoaderRequest['type']
      error: string
    }
