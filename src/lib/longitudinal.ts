/**
 * Arcade longitudinal control — signed target-speed along the car forward axis.
 *
 * Common in MIT arcade / simple racers: integrate mph along forward, then write
 * world linear velocity from that signed speed each frame (Rapier still handles
 * collisions / contacts; we own the drive axis).
 *
 * --- Rates (Joey feel-pack, 2026-09-20) ---
 *   Throttle  ≈ 18 mph/s  →  0–60 mph in 60/18 ≈ 3.3 s (was ~12 s at +5)
 *   Brake     ≈ 28 mph/s  →  hard stop from 60 in ~2.1 s
 *   Coast     ≈  4 mph/s  →  gentle decay when you let go
 *   Cap           110 mph (unchanged product lock)
 *
 * WHY punchier? The old +5/−8 felt like a grocery cart. Real-ish 0–60 for a
 * family arcade toy sits around 3–4 s — still readable for kids, not a rocket.
 *
 * Gamepad (see driveInput.ts): LT = throttle, RT = brake, LB = reverse.
 * Keyboard: W = throttle; S = brake while moving forward, reverse from rest.
 */

export const MPH_TO_MS = 0.44704
export const MAX_SPEED_MPH = 110

/** ~18 mph/s → 0–60 in ≈ 3.3 seconds. */
export const THROTTLE_MPH_S = 18

/** ~28 mph/s — punchy stops without being instant. */
export const BRAKE_MPH_S = 28

/** ~4 mph/s coast decay toward 0 when no pedal is held. */
export const COAST_MPH_S = 4

/** Near-zero band so we don't chatter around stop. */
const REST_EPS = 0.05

function clampDt(dt: number): number {
  return Math.max(0, Math.min(dt, 0.05))
}

/**
 * One integration step of signed speed (mph). Positive = forward along nose.
 *
 * Inputs are independent so the gamepad can split brake vs reverse:
 *   throttle → accelerate +mph
 *   brake    → always toward 0 (never crosses into the other direction)
 *   reverse  → accelerate −mph
 * If throttle + reverse both held, throttle wins (safer default).
 */
export function stepSignedSpeedMph(
  signedMph: number,
  throttle: boolean,
  brake: boolean,
  reverse: boolean,
  dt: number,
): number {
  const t = clampDt(dt)
  let next = signedMph

  // Throttle beats reverse if the kid mashes both.
  const wantForward = throttle
  const wantReverse = reverse && !throttle

  if (wantForward) {
    if (signedMph < -REST_EPS) {
      // Leave reverse hard (brake rate), then throttle with leftover time.
      const timeToStop = -signedMph / BRAKE_MPH_S
      if (t <= timeToStop) {
        next = signedMph + BRAKE_MPH_S * t
      } else {
        next = THROTTLE_MPH_S * (t - timeToStop)
      }
    } else {
      next = signedMph + THROTTLE_MPH_S * t
    }
  } else if (brake && !wantReverse) {
    // Pure brake — decay toward 0, do NOT tip into reverse.
    if (Math.abs(signedMph) <= REST_EPS) {
      next = 0
    } else if (signedMph > 0) {
      next = signedMph - BRAKE_MPH_S * t
      if (next < 0) next = 0
    } else {
      next = signedMph + BRAKE_MPH_S * t
      if (next > 0) next = 0
    }
  } else if (wantReverse) {
    if (signedMph > REST_EPS) {
      // Still going forward — brake to 0 first, then reverse.
      const timeToStop = signedMph / BRAKE_MPH_S
      if (t <= timeToStop) {
        next = signedMph - BRAKE_MPH_S * t
      } else {
        next = -THROTTLE_MPH_S * (t - timeToStop)
      }
    } else {
      next = signedMph - THROTTLE_MPH_S * t
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

  if (Math.abs(next) < REST_EPS && !wantForward && !wantReverse) next = 0

  return Math.max(-MAX_SPEED_MPH, Math.min(MAX_SPEED_MPH, next))
}

/**
 * Bicycle-model helpers live next to speed because yaw rate needs v.
 *
 *   yaw_rate ≈ (v / L) * tan(δ)
 *
 * where v = signed speed (m/s), L = wheelbase (m), δ = steer angle (rad).
 * See Car.tsx for the full teaching comment and why we soften max δ at speed.
 */
export const WHEELBASE_M = 2.6

/** Full-lock steer at parking speeds (~18°). Softened further at highway speed. */
export const MAX_STEER_RAD = 0.32

/**
 * Map stick/key −1..+1 → wheel angle δ (radians).
 * At high speed we shrink max lock so (v/L)*tan(δ) stays playable at 110 mph —
 * pure full-lock bicycle at 49 m/s would spin like a top.
 */
export function wheelAngleRad(steerNorm: number, speedMs: number): number {
  const absV = Math.abs(speedMs)
  // ~full lock near rest; ~1/4 lock by ~80 mph. Mid-stick still holds a mid arc
  // at whatever lock remains — radius R = L/tan(δ) is constant for fixed δ.
  const speedEase = 1 / (1 + absV / 28)
  const maxDelta = MAX_STEER_RAD * (0.35 + 0.65 * speedEase)
  return Math.max(-1, Math.min(1, steerNorm)) * maxDelta
}

/**
 * Bicycle yaw rate (rad/s): ω = (v / L) * tan(δ).
 * Deadzone → δ=0 → ω=0 → goes straight. Hold mid δ at constant v → constant
 * radius arc (the whole point of "stick = wheel angle").
 */
export function bicycleYawRate(speedMs: number, deltaRad: number): number {
  // Tiny δ → tan(δ)≈δ; guard absurd lock just in case.
  const d = Math.max(-1.2, Math.min(1.2, deltaRad))
  return (speedMs / WHEELBASE_M) * Math.tan(d)
}
