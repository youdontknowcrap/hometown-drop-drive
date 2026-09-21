/**
 * Main-thread bridge to the tile-loader Web Worker.
 *
 * LEARNING — worker vs main:
 *   Call these from StreetTileStreamer / Scene. The worker thread hits the
 *   network and parses; we await a Promise and then setState / swap HeightGrid.
 *   Car / FollowCam / Scene keys must NOT remount when results land — additive
 *   mesh/data only (Joey lock).
 *
 * Fallback: if Worker construction fails (odd embed), run the same functions
 * on main so Drop still works.
 */

import TileLoaderWorker from '../workers/tileLoader.worker.ts?worker'
import type {
  TileLoaderBuildingsResult,
  TileLoaderRequest,
  TileLoaderResponse,
  TileLoaderWaysResult,
} from './tileLoaderProtocol'
import type { LatLng } from './geo'
import type { FarTerrainFetchOpts, HeightGrid, TerrainFetchOpts } from './terrarium'
import { fetchWaysInBbox } from './osmStreets'
import {
  fetchBuildingsInBbox,
  MAX_BUILDINGS_PER_TILE,
} from './osmBuildings'
import { fetchElevationGrid, fetchFarElevationGrid } from './elevation'

type Pending = {
  resolve: (v: TileLoaderResponse) => void
  reject: (e: Error) => void
  type: TileLoaderRequest['type']
}

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, Pending>()
let workerFailed = false

function ensureWorker(): Worker | null {
  if (workerFailed) return null
  if (worker) return worker
  try {
    worker = new TileLoaderWorker()
    worker.onmessage = (ev: MessageEvent<TileLoaderResponse>) => {
      const res = ev.data
      const p = pending.get(res.id)
      if (!p) return
      pending.delete(res.id)
      p.resolve(res)
    }
    worker.onerror = (err) => {
      console.warn('[tileLoader] worker error — falling back to main', err)
      workerFailed = true
      for (const [id, p] of pending) {
        pending.delete(id)
        p.reject(new Error('tile loader worker failed'))
      }
      try {
        worker?.terminate()
      } catch {
        /* ignore */
      }
      worker = null
    }
    console.info(
      '[tileLoader] Web Worker ready — Overpass/elev parse off render thread',
    )
    return worker
  } catch (err) {
    console.warn('[tileLoader] Worker unavailable, main-thread fallback', err)
    workerFailed = true
    return null
  }
}

/** Omit on a union must distribute — else only shared keys survive. */
type RequestBody = TileLoaderRequest extends infer R
  ? R extends TileLoaderRequest
    ? Omit<R, 'id'>
    : never
  : never

function post(req: RequestBody): Promise<TileLoaderResponse> {
  const w = ensureWorker()
  const id = nextId++
  const full = { ...req, id } as TileLoaderRequest
  if (!w) {
    return runOnMain(full)
  }
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, type: full.type })
    w.postMessage(full)
  })
}

async function runOnMain(req: TileLoaderRequest): Promise<TileLoaderResponse> {
  try {
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
          req.maxBoxes,
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
        return { id: req.id, ok: true, type: 'elevNear', result: { grid } }
      }
      case 'elevFar': {
        const grid = await fetchFarElevationGrid(req.opts)
        return { id: req.id, ok: true, type: 'elevFar', result: { grid } }
      }
    }
  } catch (err) {
    return {
      id: req.id,
      ok: false,
      type: req.type,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}


/** Normalize heights after structured clone (may arrive as Array). */
function reviveGrid(grid: HeightGrid | null): HeightGrid | null {
  if (!grid) return null
  if (grid.heights instanceof Float32Array) return grid
  return {
    ...grid,
    heights: new Float32Array(grid.heights as unknown as ArrayLike<number>),
  }
}

export async function workerFetchWays(
  south: number,
  west: number,
  north: number,
  east: number,
): Promise<TileLoaderWaysResult['ways']> {
  const res = await post({ type: 'ways', south, west, north, east })
  if (!res.ok || res.type !== 'ways') {
    throw new Error(!res.ok ? res.error : 'unexpected response')
  }
  return res.result.ways
}

export async function workerFetchBuildings(
  south: number,
  west: number,
  north: number,
  east: number,
  origin: LatLng,
  maxBoxes = MAX_BUILDINGS_PER_TILE,
): Promise<TileLoaderBuildingsResult> {
  const res = await post({
    type: 'buildings',
    south,
    west,
    north,
    east,
    origin,
    maxBoxes,
  })
  if (!res.ok || res.type !== 'buildings') {
    throw new Error(!res.ok ? res.error : 'unexpected response')
  }
  return res.result
}

export async function workerFetchElevNear(
  opts: TerrainFetchOpts,
): Promise<HeightGrid> {
  const res = await post({ type: 'elevNear', opts })
  if (!res.ok || res.type !== 'elevNear') {
    throw new Error(!res.ok ? res.error : 'unexpected response')
  }
  const grid = reviveGrid(res.result.grid)
  if (!grid) throw new Error('elevNear returned null grid')
  return grid
}

export async function workerFetchElevFar(
  opts: FarTerrainFetchOpts,
): Promise<HeightGrid | null> {
  const res = await post({ type: 'elevFar', opts })
  if (!res.ok || res.type !== 'elevFar') {
    throw new Error(!res.ok ? res.error : 'unexpected response')
  }
  return reviveGrid(res.result.grid)
}

/** True once the worker constructed (for HUD / console teaching). */
export function tileLoaderUsesWorker(): boolean {
  ensureWorker()
  return !workerFailed && worker != null
}
