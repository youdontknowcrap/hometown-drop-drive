/**
 * Tile-loader Web Worker — Terrarium / elev decode ONLY.
 *
 * LEARNING — why not Overpass here?
 *   Drop’s first paint is gated on highway ways. Overpass is network-bound:
 *   a worker cannot finish the HTTP sooner, and postMessage + clone of a big
 *   StreetWay[] adds latency before main can mesh asphalt. So ways/buildings
 *   fetch on main (async). This worker keeps CPU-heavy PNG → Float32 elev off
 *   the render/input thread so WASD + Rapier stay smooth when hills land.
 *
 * Etiquette: StreetTileStreamer owns MAX_IN_FLIGHT + OVERPASS_GAP_MS for OSM.
 * Elev fetches are Scene-side (debounced / significance-gated).
 */

import { fetchElevationGrid, fetchFarElevationGrid } from '../lib/elevation'
import type {
  TileLoaderRequest,
  TileLoaderResponse,
} from '../lib/tileLoaderProtocol'
import type { HeightGrid } from '../lib/terrarium'

function cloneGrid(grid: HeightGrid): HeightGrid {
  // Structured clone needs a fresh Float32Array buffer we can transfer.
  return {
    ...grid,
    heights: new Float32Array(grid.heights),
  }
}

async function handle(req: TileLoaderRequest): Promise<TileLoaderResponse> {
  switch (req.type) {
    case 'elevNear': {
      const grid = await fetchElevationGrid(req.opts)
      return {
        id: req.id,
        ok: true,
        type: 'elevNear',
        result: { grid: cloneGrid(grid) },
      }
    }
    case 'elevFar': {
      const far = await fetchFarElevationGrid(req.opts)
      return {
        id: req.id,
        ok: true,
        type: 'elevFar',
        result: { grid: far ? cloneGrid(far) : null },
      }
    }
  }
}

self.onmessage = (ev: MessageEvent<TileLoaderRequest>) => {
  const req = ev.data
  void handle(req)
    .then((res) => {
      if (res.ok && (res.type === 'elevNear' || res.type === 'elevFar')) {
        const grid = res.result.grid
        if (grid) {
          // Transfer the elev buffer so main doesn't copy megabytes.
          ;(self as DedicatedWorkerGlobalScope).postMessage(res, [
            grid.heights.buffer,
          ])
          return
        }
      }
      ;(self as DedicatedWorkerGlobalScope).postMessage(res)
    })
    .catch((err: unknown) => {
      const error = err instanceof Error ? err.message : String(err)
      const fail: TileLoaderResponse = {
        id: req.id,
        ok: false,
        type: req.type,
        error,
      }
      ;(self as DedicatedWorkerGlobalScope).postMessage(fail)
    })
}
