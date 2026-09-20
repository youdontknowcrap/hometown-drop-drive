/**
 * Arcade longitudinal control — signed target-speed along the car forward axis.
 *
 * Common in MIT arcade / simple racers: integrate mph along forward, then write
 * world linear velocity from that signed speed each frame (Rapier still handles
 * collisions / contacts; we own the drive axis).
 *
 * Rates (Joey / playtest):
 *   W  while going forward or from rest → +5 mph/s
 *   W  while in reverse → brake toward 0 at 8 mph/s, then +5
 *   S  while going forward → brake at 8 mph/s
 *   S  while stopped / reverse → accelerate reverse at 8 mph/s
 *   coast (no W/S) → decay toward 0 at 3 mph/s
 *   |speed| capped at MAX_SPEED_MPH
 */

export const MPH_TO_MS = 0.44704
export const MAX_SPEED_MPH = 110
export const THROTTLE_MPH_S = 5
export const BRAKE_MPH_S = 8
export const COAST_MPH_S = 3

/** Near-zero band so we don't chatter around stop. */
const REST_EPS = 0.05

function clampDt(dt: number): number {
  return Math.max(0, Math.min(dt, 0.05))
}

/**
 * One integration step of signed speed (mph). Positive = forward along nose.
 */
export function stepSignedSpeedMph(
  signedMph: number,
  throttle: boolean,
  brake: boolean,
  dt: number,
): number {
  const t = clampDt(dt)
  let next = signedMph

  if (throttle && !brake) {
    if (signedMph < -REST_EPS) {
      // Leave reverse hard (8), then throttle forward (5) with leftover time.
      const timeToStop = -signedMph / BRAKE_MPH_S
      if (t <= timeToStop) {
        next = signedMph + BRAKE_MPH_S * t
      } else {
        next = THROTTLE_MPH_S * (t - timeToStop)
      }
    } else {
      next = signedMph + THROTTLE_MPH_S * t
    }
  } else if (brake && !throttle) {
    if (signedMph > REST_EPS) {
      // Brake hard, then reverse with leftover time.
      const timeToStop = signedMph / BRAKE_MPH_S
      if (t <= timeToStop) {
        next = signedMph - BRAKE_MPH_S * t
      } else {
        next = -BRAKE_MPH_S * (t - timeToStop)
      }
    } else {
      next = signedMph - BRAKE_MPH_S * t
    }
  } else {
    // Coast — always decay toward 0; never overshoot stop.
    if (Math.abs(signedMph) <= REST_EPS) return 0
    if (signedMph > 0) {
      next = signedMph - COAST_MPH_S * t
      if (next < 0) next = 0
    } else {
      next = signedMph + COAST_MPH_S * t
      if (next > 0) next = 0
    }
  }

  if (Math.abs(next) < REST_EPS && !throttle && !brake) next = 0

  return Math.max(-MAX_SPEED_MPH, Math.min(MAX_SPEED_MPH, next))
}

/** Steering gain vs |mph| — engage with speed, dialed down near 110. */
export function steerScale(absMph: number): number {
  if (absMph < 0.4) return 0
  const engage = Math.min(1, absMph / 12)
  const highSpeedDamp = 1 / (1 + absMph / 45)
  return engage * highSpeedDamp
}
