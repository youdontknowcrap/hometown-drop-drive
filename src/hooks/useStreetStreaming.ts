/**
 * React bridge for StreetTileStreamer.
 *
 * LEARNING:
 *   The streamer is a plain class (queue + cache + active set). This hook
 *   owns its lifetime, pushes carPose into it, and mirrors activeWays into
 *   React state so Scene + GpsDash re-render together — hard GPS rule:
 *   the dial only shows streets that are mounted in the 3D world.
 *
 * LEARNING — Fast Drop + smooth apply:
 *   startStreetStream resolves when the **center tile** ways exist (not after
 *   ~5 neighbors). busy clears then → streets visible + car driveable.
 *   Neighbor tiles + buildings emit later; createApplyCoordinator coalesces
 *   into ≤1 React commit per animation frame so we never apply 9 Road meshes
 *   in one frame after Drop.
 */

import { useEffect, useRef, useState } from 'react'
import { carPose } from '../lib/carPose'
import { createApplyCoordinator } from '../lib/applyCoordinator'
import {
  startStreetStream,
  tileMathBlurb,
  type ActiveTileWays,
  type LoadedAabb,
  type StreetTileStreamer,
} from '../lib/streetTiles'
import type { StreetWay, StreetWorld } from '../lib/osmStreets'
import type { BuildingBox } from '../lib/osmBuildings'

export type StreetStreamingState = {
  world: StreetWorld
  /** HARD GPS RULE: same ways Scene renders — never prefetch-only. */
  activeWays: StreetWay[]
  /**
   * active+cached ways for AP/route near-car splice only (not dial/Scene).
   * Wider than activeWays so align can use fetched corridor coverage.
   */
  alignWays: StreetWay[]
  /** Per-tile ways for incremental Road groups (Scene remeshes dirty tiles only). */
  activeTiles: ActiveTileWays[]
  /** Buildings for active tiles only (unload with tiles). Not on GPS. */
  activeBuildings: BuildingBox[]
  buildingsMessage: string
  activeTileCount: number
  loadingCount: number
  streamMessage: string
  loadedAabb: LoadedAabb | null
  /**
   * Bumps when the *active tile set* changes (ways added/removed).
   * LEARNING — NOT a remount key for Car / FollowCam / Scene. App passes
   * dropNonce as routeVersion for spawn/camera; streamVersion only feeds
   * additive Road / GPS / building lists.
   */
  streamVersion: number
  streaming: boolean
  tileMath: string
  busy: boolean
  /** Teaching: next Overpass tile in priority queue. */
  nextQueueKey: string | null
  queueDepth: number
  /** 0 = crawl circle, 1 = highway corridor. */
  corridorBlend: number
}

function worldFromStreamer(streamer: StreetTileStreamer): StreetWorld {
  const s = streamer.snapshot()
  return {
    origin: s.origin,
    ways: s.activeWays,
    source: s.source,
    message: s.message,
    dropLabel: s.dropLabel,
    streetMeters: 0,
    wayCount: s.activeWays.length,
  }
}

function stateFromStreamer(streamer: StreetTileStreamer): Omit<StreetStreamingState, 'busy'> {
  const s = streamer.snapshot()
  return {
    world: worldFromStreamer(streamer),
    activeWays: s.activeWays,
    alignWays: s.alignWays,
    activeTiles: s.activeTiles,
    activeBuildings: s.activeBuildings,
    buildingsMessage: s.buildingsMessage,
    activeTileCount: s.activeTileCount,
    loadingCount: s.loadingCount,
    streamMessage: s.message,
    loadedAabb: s.loadedAabb,
    streamVersion: s.version,
    streaming: true,
    tileMath: tileMathBlurb(s.origin.lat),
    nextQueueKey: s.nextQueueKey,
    queueDepth: s.queueDepth,
    corridorBlend: s.corridorBlend,
  }
}

const IDLE: StreetStreamingState = {
  world: {
    origin: { lat: 0, lng: 0 },
    ways: [],
    source: 'demo',
    message: 'Streaming…',
    dropLabel: '',
    streetMeters: 0,
    wayCount: 0,
  },
  activeWays: [],
  alignWays: [],
  activeTiles: [],
  activeBuildings: [],
  buildingsMessage: 'Buildings: …',
  activeTileCount: 0,
  loadingCount: 0,
  streamMessage: 'Streaming…',
  loadedAabb: null,
  streamVersion: 0,
  streaming: false,
  tileMath: '',
  busy: false,
  nextQueueKey: null,
  queueDepth: 0,
  corridorBlend: 0,
}

/**
 * Drop → start stream; while driving, updateCar from carPose.
 * Consumers MUST feed `activeWays` to both Scene and GpsDash.
 */
export function useStreetStreaming(
  dropAddress: string,
  dropNonce: number,
  buildingsEnabled = true,
): StreetStreamingState {
  const [state, setState] = useState<StreetStreamingState>({ ...IDLE, busy: true })
  const streamerRef = useRef<StreetTileStreamer | null>(null)
  const buildingsEnabledRef = useRef(buildingsEnabled)
  buildingsEnabledRef.current = buildingsEnabled

  // Push HUD Buildings toggle into the live streamer (skip/resume Overpass).
  useEffect(() => {
    streamerRef.current?.setBuildingsEnabled(buildingsEnabled)
  }, [buildingsEnabled])

  useEffect(() => {
    let cancelled = false
    let unsub: (() => void) | null = null
    let poll = 0
    // ≤1 mesh/data commit per frame; short coalesce merges back-to-back emits.
    const apply = createApplyCoordinator({ coalesceMs: 40 })

    setState((prev) => ({ ...prev, busy: true, streamMessage: 'Loading Drop center…' }))

    // Tear down previous Drop's streamer before starting a new one.
    streamerRef.current?.dispose()
    streamerRef.current = null

    void startStreetStream(dropAddress)
      .then(({ streamer, world }) => {
        if (cancelled) {
          streamer.dispose()
          return
        }
        streamerRef.current = streamer
        streamer.setBuildingsEnabled(buildingsEnabledRef.current)
        const next = stateFromStreamer(streamer)
        // Keep geocode label / initial message from startStreetStream.
        next.world = {
          ...next.world,
          dropLabel: world.dropLabel || next.world.dropLabel,
          message: world.message || next.world.message,
        }
        // Center ways ready → clear busy. Neighbors fill under apply budget.
        setState({ ...next, busy: false })

        unsub = streamer.subscribe(() => {
          if (cancelled) return
          // Budgeted: coalesce tile packages into one React commit / frame.
          apply.schedule(() => {
            if (cancelled || !streamerRef.current) return
            setState({ ...stateFromStreamer(streamerRef.current), busy: false })
          })
        })

        // 4 Hz is enough for 1 km tiles; yaw + speedMph blend circle↔corridor
        // so the next tiles activate before soft-clamp meets a continuing road.
        poll = window.setInterval(() => {
          if (cancelled || !streamerRef.current) return
          if (!carPose.ready) return
          streamerRef.current.updateCar(
            carPose.x,
            carPose.z,
            carPose.yaw,
            carPose.speedMph,
          )
        }, 250)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const why = err instanceof Error ? err.message : 'stream failed'
        setState({
          ...IDLE,
          busy: false,
          streamMessage: `Stream error: ${why}`,
          world: {
            ...IDLE.world,
            message: `Stream error: ${why}`,
          },
        })
      })

    return () => {
      cancelled = true
      apply.dispose()
      if (unsub) unsub()
      if (poll) window.clearInterval(poll)
      streamerRef.current?.dispose()
      streamerRef.current = null
    }
  }, [dropAddress, dropNonce])

  return state
}
