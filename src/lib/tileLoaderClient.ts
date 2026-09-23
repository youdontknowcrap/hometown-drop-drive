/**
 * Main-thread bridge: Overpass on main, elev decode in the Web Worker.
 *
 * LEARNING — Option A (preferred, Joey Drop TTI):
 *   Overpass is network-bound. A Web Worker does not speed the HTTP; it adds
 *   postMessage + structured clone, then applyCoordinator still merges on
 *   main. So `mainFetchWays` / `mainFetchBuildings` are plain async on the
 *   render thread (await yield between microtasks — UI stays responsive).
 *
 *   Terrarium PNG → Float32 *is* CPU-bound → `workerFetchElevNear/Far` keep
 *   that off React Three Fiber / Rapier / WASD.
 *
 *   Critical Drop path: StreetTileStreamer.loadCenterTileFast() calls
 *   mainFetchWays for tile (0,0) and paints ASAP — never waits on a 3×3 burst
 *   or worker round-trip. Neighbors fill in serially afterward.
 *
 * Fallback: if Worker construction fails, elev runs on main too so Drop still
 * works. Car / FollowCam / Scene keys must NOT remount when results land
 * (Joey lock — additive mesh/data only).
 */

import TileLoaderWorker from '../workers/tileLoader.worker.ts?worker'
import type {
  TileLoaderRequest,
  TileLoaderResponse,
} from './tileLoaderProtocol'
import type { LatLng } from './geo'
import type { StreetWay } from './osmStreets'
import { fetchWaysInBbox } from './osmStreets'
import {
  fetchBuildingsInBbox,
  MAX_BUILDINGS_PER_TILE,
  type BuildingBox,
} from './osmBuildings'
import type { FarTerrainFetchOpts, HeightGrid, TerrainFetchOpts } from './terrarium'
import { fetchElevationGrid, fetchFarElevationGrid } from './elevation'
import { beginElevNetwork, endElevNetwork } from './networkPriority'

export type MainBuildingsResult = {
  boxes: BuildingBox[]
  found: number
  residentialKept: number
  otherKept: number
  message: string
}

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
      console.warn('[tileLoader] worker error — elev falls back to main', err)
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
      '[tileLoader] Web Worker ready — Terrarium/elev decode only (Overpass stays main)',
    )
    return worker
  } catch (err) {
    console.warn('[tileLoader] Worker unavailable, elev on main', err)
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
    return runElevOnMain(full)
  }
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, type: full.type })
    w.postMessage(full)
  })
}

async function runElevOnMain(req: TileLoaderRequest): Promise<TileLoaderResponse> {
  try {
    switch (req.type) {
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

/**
 * Overpass highways — always main-thread async (network-bound; no worker).
 * Used by Drop center fast path and neighbor tile fills.
 */
export async function mainFetchWays(
  south: number,
  west: number,
  north: number,
  east: number,
  signal?: AbortSignal,
): Promise<StreetWay[]> {
  return fetchWaysInBbox(south, west, north, east, signal)
}

/**
 * Overpass buildings — main thread, deferred until after ways paint.
 * Never block Drop TTI on this.
 */
export async function mainFetchBuildings(
  south: number,
  west: number,
  north: number,
  east: number,
  origin: LatLng,
  maxBoxes = MAX_BUILDINGS_PER_TILE,
): Promise<MainBuildingsResult> {
  const bw = await fetchBuildingsInBbox(
    south,
    west,
    north,
    east,
    origin,
    maxBoxes,
  )
  return {
    boxes: bw.boxes,
    found: bw.found,
    residentialKept: bw.residentialKept,
    otherKept: bw.otherKept,
    message: bw.message,
  }
}

/** @deprecated alias — keep call sites readable during the worker→main cutover. */
export const workerFetchWays = mainFetchWays
/** @deprecated alias — buildings are main-thread now. */
export async function workerFetchBuildings(
  south: number,
  west: number,
  north: number,
  east: number,
  origin: LatLng,
  maxBoxes = MAX_BUILDINGS_PER_TILE,
): Promise<MainBuildingsResult> {
  return mainFetchBuildings(south, west, north, east, origin, maxBoxes)
}

export async function workerFetchElevNear(
  opts: TerrainFetchOpts,
): Promise<HeightGrid> {
  // Elev holds the network lane — Overpass tile pumps yield (Joey priority).
  beginElevNetwork()
  try {
    const res = await post({ type: 'elevNear', opts })
    if (!res.ok || res.type !== 'elevNear') {
      throw new Error(!res.ok ? res.error : 'unexpected response')
    }
    const grid = reviveGrid(res.result.grid)
    if (!grid) throw new Error('elevNear returned null grid')
    return grid
  } finally {
    endElevNetwork()
  }
}

export async function workerFetchElevFar(
  opts: FarTerrainFetchOpts,
): Promise<HeightGrid | null> {
  beginElevNetwork()
  try {
    const res = await post({ type: 'elevFar', opts })
    if (!res.ok || res.type !== 'elevFar') {
      throw new Error(!res.ok ? res.error : 'unexpected response')
    }
    return reviveGrid(res.result.grid)
  } finally {
    endElevNetwork()
  }
}

/** True once the elev worker constructed (for HUD / console teaching). */
export function tileLoaderUsesWorker(): boolean {
  ensureWorker()
  return !workerFailed && worker != null
}
