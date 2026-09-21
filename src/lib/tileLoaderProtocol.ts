/**
 * Message types for the tile-loader Web Worker.
 *
 * LEARNING — worker vs main:
 *   The worker owns fetch + JSON/PNG parse (Overpass, Terrarium decode,
 *   Open-Meteo elev). The main (render/input) thread only merges results into
 *   React state / Three meshes. That keeps WASD + Rapier from hitching when a
 *   ~1 km tile lands. Queue / gap etiquette for public APIs stays on main
 *   (StreetTileStreamer) so the worker never stampeding Overpass.
 */

import type { LatLng } from './geo'
import type { StreetWay } from './osmStreets'
import type { BuildingBox } from './osmBuildings'
import type { FarTerrainFetchOpts, HeightGrid, TerrainFetchOpts } from './terrarium'

export type TileLoaderRequest =
  | {
      id: number
      type: 'ways'
      south: number
      west: number
      north: number
      east: number
    }
  | {
      id: number
      type: 'buildings'
      south: number
      west: number
      north: number
      east: number
      origin: LatLng
      /** Soft cap for this tile (streamer also caps the active union). */
      maxBoxes: number
    }
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

export type TileLoaderWaysResult = { ways: StreetWay[] }

export type TileLoaderBuildingsResult = {
  boxes: BuildingBox[]
  found: number
  residentialKept: number
  otherKept: number
  message: string
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
      type: 'ways'
      result: TileLoaderWaysResult
    }
  | {
      id: number
      ok: true
      type: 'buildings'
      result: TileLoaderBuildingsResult
    }
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
