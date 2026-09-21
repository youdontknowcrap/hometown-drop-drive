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

/**
 * Off-road (desert, past asphalt/track half-width) — Joey playtest feel.
 * Cap effective top speed at half of MAX so dirt feels sticky/slow.
 * Hard ~200 ft corridor wall is separate (roadCorridor / RoadContainment).
 */
export const OFF_ROAD_SPEED_FACTOR = 0.5
export const OFF_ROAD_MAX_SPEED_MPH = MAX_SPEED_MPH * OFF_ROAD_SPEED_FACTOR // 55

/**
 * When you leave the ribbon already above the off-road cap, yank toward it
 * (mph/s). Arcade "mud" — not a gentle coast down from 110.
 */
export const OFF_ROAD_DRAG_MPH_S = 55

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
  /** Soft cap (on-road 110, off-road ~55). Defaults to product max. */
  maxSpeedMph: number = MAX_SPEED_MPH,
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

  const cap = Math.max(1, Math.min(MAX_SPEED_MPH, maxSpeedMph))
  return Math.max(-cap, Math.min(cap, next))
}

/**
 * Sticky-dirt helper: if already faster than the off-road cap, drag toward it.
 * Call BEFORE stepSignedSpeedMph when offRoad, so the next integrate can't
 * keep you at highway speed in the desert.
 */
export function dragTowardOffRoadCap(signedMph: number, dt: number): number {
  const cap = OFF_ROAD_MAX_SPEED_MPH
  const abs = Math.abs(signedMph)
  if (abs <= cap) return signedMph
  const t = Math.max(0, Math.min(dt, 0.05))
  const next = abs - OFF_ROAD_DRAG_MPH_S * t
  const clamped = Math.max(cap, next)
  return Math.sign(signedMph) * clamped
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
 *
 * LEARNING NOTE — high-speed desensitization (Joey 2026-09-20):
 * Real cars and racing games reduce steering gain with speed so the same stick
 * throw does NOT mean the same yaw rate on the highway. Pure bicycle at 110 mph
 * (~49 m/s) with parking-lot lock would spin like a top.
 *
 * We do two things:
 *  1) Shrink max lock δ as |v| rises (less wheel angle available).
 *  2) Soften the stick curve a bit more at speed so mid-deflection is gentler.
 * Mid-stick still holds a mid arc at whatever lock remains
 * (radius R = L / tan(δ) for fixed δ).
 */
export function wheelAngleRad(steerNorm: number, speedMs: number): number {
  const absV = Math.abs(speedMs)
  const s = Math.max(-1, Math.min(1, steerNorm))

  // Stronger than the first pass: /18 falls off faster than /28.
  // At ~0 mph → ~full MAX_STEER_RAD; at ~110 mph → only a small fraction left.
  const speedEase = 1 / (1 + absV / 18)
  // Floor 0.12 (was 0.35): highway full-stick is a lane change, not a U-turn.
  const maxDelta = MAX_STEER_RAD * (0.12 + 0.88 * speedEase)

  // Extra sensitivity taper on the stick itself at speed (keep parking agile).
  // Near rest: linear. At highway: compress mid-range so small jostles don't yank.
  const stickEase = 0.55 + 0.45 * speedEase
  const shaped = Math.sign(s) * Math.pow(Math.abs(s), 1 / stickEase)

  return shaped * maxDelta
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
