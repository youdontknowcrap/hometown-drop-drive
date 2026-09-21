/**
 * Pick floating street-name labels near the car.
 *
 * LEARNING — why cull so hard?
 *   A 3 km Drop can have hundreds of named OSM ways. Drawing every name as
 *   GPU text would spam the HUD and tank Troika sync cost. Real dash GPS only
 *   shows a few nearby roads. We:
 *     1. Skip unnamed ways (name/ref missing).
 *     2. Keep ONE label per unique display name (China Lake Blvd is many ways).
 *     3. Place it at the nearest centerline point to the car (follows as you drive).
 *     4. Drop anything outside ~MAX_RANGE_M, fade near the edge, hide too-close.
 *     5. Cap count so a dense downtown still stays readable.
 *
 * Perspective: world-space Text at fixed meters-tall fontSize + Billboard.
 * Camera distance does the "bigger close / smaller far" for free — no fake
 * screen-space font scaling needed.
 */

import { projectOntoPath } from './guidance'
import type { XzPoint } from './roadMesh'

/** Hide labels farther than this (meters from car → label anchor). */
export const LABEL_MAX_RANGE_M = 350
/** Start fading opacity past this distance. */
export const LABEL_FADE_START_M = 240
/** Hide when the car is almost on top of the label (under chase cam). */
export const LABEL_MIN_RANGE_M = 14
/** Hard cap — teen STEM racer tone, not HUD spam. */
export const LABEL_MAX_COUNT = 8
/** Float this many meters above terrain sample. */
export const LABEL_HEIGHT_ABOVE_M = 5.2
/** World-space Text height in meters (perspective shrinks it on screen). */
export const LABEL_FONT_SIZE_M = 4.2

export type NamedStreet = {
  /** Display string (name or ref). */
  name: string
  points: XzPoint[]
}

export type StreetLabelSlot = {
  name: string
  x: number
  z: number
  /** Distance car → anchor in XZ meters. */
  distance: number
  /** 0..1 opacity (1 near, fade toward max range). */
  opacity: number
}

/**
 * From car pose + named local streets, pick which labels to show this frame.
 * Pure function — easy to unit-test / reason about in the learning notes.
 */
export function pickStreetLabels(
  carX: number,
  carZ: number,
  streets: NamedStreet[],
): StreetLabelSlot[] {
  // Best (closest) hit per unique name.
  const bestByName = new Map<string, StreetLabelSlot>()

  for (const street of streets) {
    const hit = projectOntoPath(carX, carZ, street.points)
    if (!hit) continue
    // Distance along the ground to the label point (not lateral-only to segment).
    const dist = Math.hypot(hit.x - carX, hit.z - carZ)
    if (dist > LABEL_MAX_RANGE_M || dist < LABEL_MIN_RANGE_M) continue

    const prev = bestByName.get(street.name)
    if (prev && prev.distance <= dist) continue

    const fadeSpan = LABEL_MAX_RANGE_M - LABEL_FADE_START_M
    let opacity = 1
    if (dist > LABEL_FADE_START_M && fadeSpan > 0) {
      opacity = 1 - (dist - LABEL_FADE_START_M) / fadeSpan
    }
    // Soft fade also when very close (optional hide zone approached).
    if (dist < LABEL_MIN_RANGE_M + 10) {
      opacity = Math.min(opacity, (dist - LABEL_MIN_RANGE_M) / 10)
    }
    opacity = Math.max(0, Math.min(1, opacity))
    if (opacity < 0.05) continue

    bestByName.set(street.name, {
      name: street.name,
      x: hit.x,
      z: hit.z,
      distance: dist,
      opacity,
    })
  }

  const slots = Array.from(bestByName.values())
  // Closest first; keep only the nearest LABEL_MAX_COUNT.
  slots.sort((a, b) => a.distance - b.distance)
  return slots.slice(0, LABEL_MAX_COUNT)
}
