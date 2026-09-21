/**
 * React bridge for StreetTileStreamer.
 *
 * LEARNING:
 *   The streamer is a plain class (queue + cache + active set). This hook
 *   owns its lifetime, pushes carPose into it, and mirrors activeWays into
 *   React state so Scene + GpsDash re-render together — hard GPS rule:
 *   the dial only shows streets that are mounted in the 3D world.
 */

import { useEffect, useRef, useState } from 'react'
import { carPose } from '../lib/carPose'
import {
  startStreetStream,
  tileMathBlurb,
  type LoadedAabb,
  type StreetTileStreamer,
} from '../lib/streetTiles'
import type { StreetWay, StreetWorld } from '../lib/osmStreets'

export type StreetStreamingState = {
  world: StreetWorld
  /** HARD GPS RULE: same ways Scene renders — never prefetch-only. */
  activeWays: StreetWay[]
  activeTileCount: number
  loadingCount: number
  streamMessage: string
  loadedAabb: LoadedAabb | null
  /**
   * Bumps when the *active tile set* changes (ways added/removed).
   * LEARNING — NOT a remount key for Car / FollowCam / Scene. App passes
   * dropNonce as routeVersion for spawn/camera; streamVersion only feeds
   * additive Road / GPS way lists.
   */
  streamVersion: number
  streaming: boolean
  tileMath: string
  busy: boolean
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
    activeTileCount: s.activeTileCount,
    loadingCount: s.loadingCount,
    streamMessage: s.message,
    loadedAabb: s.loadedAabb,
    streamVersion: s.version,
    streaming: true,
    tileMath: tileMathBlurb(s.origin.lat),
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
  activeTileCount: 0,
  loadingCount: 0,
  streamMessage: 'Streaming…',
  loadedAabb: null,
  streamVersion: 0,
  streaming: false,
  tileMath: '',
  busy: false,
}

/**
 * Drop → start stream; while driving, updateCar from carPose.
 * Consumers MUST feed `activeWays` to both Scene and GpsDash.
 */
export function useStreetStreaming(dropAddress: string, dropNonce: number): StreetStreamingState {
  const [state, setState] = useState<StreetStreamingState>({ ...IDLE, busy: true })
  const streamerRef = useRef<StreetTileStreamer | null>(null)

  useEffect(() => {
    let cancelled = false
    let unsub: (() => void) | null = null
    let poll = 0

    setState((prev) => ({ ...prev, busy: true, streamMessage: 'Loading Drop tiles…' }))

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
        const next = stateFromStreamer(streamer)
        // Keep geocode label / initial message from startStreetStream.
        next.world = {
          ...next.world,
          dropLabel: world.dropLabel || next.world.dropLabel,
          message: world.message || next.world.message,
        }
        setState({ ...next, busy: false })

        unsub = streamer.subscribe(() => {
          if (cancelled) return
          setState({ ...stateFromStreamer(streamer), busy: false })
        })

        // 4 Hz is enough for 1 km tiles; look-ahead uses yaw + speed so the
        // next ring activates before soft-clamp meets a continuing road.
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
      if (unsub) unsub()
      if (poll) window.clearInterval(poll)
      streamerRef.current?.dispose()
      streamerRef.current = null
    }
  }, [dropAddress, dropNonce])

  return state
}
