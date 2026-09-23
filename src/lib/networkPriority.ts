/**
 * Elev / ground ahead of Overpass when the network is contended.
 *
 * LEARNING (Joey): TLS/mirror thrash on Overpass was crowding Terrarium /
 * Open-Meteo elev fetches. Hills and ground must win; streets can wait a beat.
 * Do not starve Overpass forever — after OVERPASS_YIELD_MAX_MS we let one
 * tile through so the corridor still fills.
 *
 * applyCoordinator stays independent (mesh apply ≠ HTTP). This gate only
 * delays *starting* new Overpass tile fetches while elev is in flight.
 */

let elevInFlight = 0
let elevHoldSince = 0
const listeners = new Set<() => void>()

/** Max time Overpass yields to elev before we allow a fetch (ms). */
export const OVERPASS_YIELD_MAX_MS = 3_500

export function beginElevNetwork(): void {
  if (elevInFlight === 0) elevHoldSince = performance.now()
  elevInFlight += 1
}

export function endElevNetwork(): void {
  elevInFlight = Math.max(0, elevInFlight - 1)
  if (elevInFlight === 0) {
    for (const cb of listeners) {
      try {
        cb()
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * True while Overpass should wait (elev holds the lane).
 * Returns false after yield max so streets are never starved forever.
 */
export function elevHoldsOverpassLane(): boolean {
  if (elevInFlight <= 0) return false
  return performance.now() - elevHoldSince < OVERPASS_YIELD_MAX_MS
}

/** Wake streamer pumps when elev releases the lane. */
export function onElevNetworkReleased(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
