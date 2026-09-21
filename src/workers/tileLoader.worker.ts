/**
 * Tile-loader Web Worker — Overpass + elevation off the render thread.
 *
 * LEARNING — why a worker?
 *   Main thread runs React Three Fiber, Rapier, and WASD every frame. JSON
 *   parse for a full Overpass tile (or Terrarium PNG → Float32 elev) can stall
 *   that loop for tens of ms. This worker does fetch + parse; main only merges
 *   StreetWay[] / BuildingBox[] / HeightGrid into meshes. See tileLoaderClient.
 *
 * Etiquette: StreetTileStreamer still owns MAX_IN_FLIGHT + OVERPASS_GAP_MS —
 * the worker is a compute lane, not a parallel stampede into public APIs.
 */

import { fetchWaysInBbox } from '../lib/osmStreets'
import {
  fetchBuildingsInBbox,
  MAX_BUILDINGS_PER_TILE,
} from '../lib/osmBuildings'
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
    case 'ways': {
      const ways = await fetchWaysInBbox(
        req.south,
        req.west,
        req.north,
        req.east,
      )
      return { id: req.id, ok: true, type: 'ways', result: { ways } }
    }
    case 'buildings': {
      const bw = await fetchBuildingsInBbox(
        req.south,
        req.west,
        req.north,
        req.east,
        req.origin,
        req.maxBoxes ?? MAX_BUILDINGS_PER_TILE,
      )
      return {
        id: req.id,
        ok: true,
        type: 'buildings',
        result: {
          boxes: bw.boxes,
          found: bw.found,
          residentialKept: bw.residentialKept,
          otherKept: bw.otherKept,
          message: bw.message,
        },
      }
    }
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

