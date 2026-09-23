/**
 * Merge keyboard + USB gamepad into one drive sample each frame.
 *
 * --- Gamepad standard mapping (W3C Gamepad API button indices) ---
 *   buttons[6]  LT  Left trigger   → GAS (throttle)
 *   buttons[7]  RT  Right trigger  → BRAKE (toward 0, no reverse)
 *   buttons[4]  LB  Left bumper    → REVERSE
 *   buttons[0]  A / ✕ Cross (south face) → CRUISE toggle (edge)
 *   axes[0]     Left stick X       → steer (−1 left … +1 right on hardware)
 *   buttons[14]/[15] D-pad L/R     → steer
 *
 * WHY LT=gas / RT=brake? Joey's muscle memory from other driving games, and
 * it frees LB for an explicit reverse so brake no longer "tips into reverse"
 * the way the old combined LT mapping did.
 *
 * Cruise (buttons[0] / KeyC): edge-triggered set/clear of a hold-speed. While
 * ON, longitudinal skips COAST_MPH_S burndown so speed holds without LT/W.
 * Brake (RT), reverse (LB), or A/✕ again cancel. See Car.tsx + longitudinal.
 *
 * Autopilot (buttons[3] Y/△ / KeyP): edge toggle. Needs a GPS destination.
 * AP owns heading (snap/slide on the blue route); gas/brake modulate the
 * commanded speed up to 200 mph. Reverse / toggle / arrive cancel. Cruise
 * stays separate — engaging AP clears cruise. See lib/autopilot.ts + Car.
 *
 * Keyboard WASD still works in parallel (inputs OR together each frame):
 *   W / ↑  throttle
 *   S / ↓  brake-or-reverse (Car picks from current signed speed)
 *   A/D    steer
 *   C      cruise toggle (testing without a pad)
 *   P      autopilot toggle
 *
 * Stick deadzone → δ=0 → bicycle yaw rate 0 → goes straight.
 * Holding mid-stick holds a mid turn: steer target tracks stick proportionally
 * and the angle lerps toward that target (not binary snap / overshoot).
 */

import type { DriveKeys } from '../hooks/useKeyboard'

/** Slop around stick center — within this, input → 0 and angle springs home. */
export const GAMEPAD_DEADZONE = 0.22

/** Lerp rate toward stick/key target while input is active (1/s scale). */
export const STEER_RESPOND = 8

/** Faster return-to-center when input ≈ 0 (kills lingering yaw). */
export const STEER_RELEASE = 26

/** |target| below this uses release rate and can hard-snap to 0. */
const TARGET_ZERO_EPS = 0.03

export type DriveSample = {
  /** LT / W — accelerate forward. */
  throttle: boolean
  /** RT — decelerate toward 0 (never crosses into reverse by itself). */
  brake: boolean
  /** LB — accelerate reverse. */
  reverse: boolean
  /**
   * Keyboard S/↓. Car maps this to brake while moving forward, reverse from
   * rest — keeps WASD familiar without a separate reverse key.
   */
  keyboardBack: boolean
  /**
   * Rising edge this frame: Xbox A / PS5 ✕ (buttons[0]) or KeyC.
   * Car toggles cruise ON (set = current signed mph) / OFF. Not a held level.
   */
  cruiseToggle: boolean
  /**
   * Rising edge: Xbox Y / PS5 △ (buttons[3]) or KeyP.
   * Car toggles street autopilot when a destination path exists.
   */
  autopilotToggle: boolean
  /**
   * −1 = right, +1 = left. This is the *normalized wheel angle demand* δ̂
   * (not a yaw-rate joystick). Car turns it into δ rad via wheelAngleRad().
   */
  steer: number
  /** True when a connected pad contributed this frame. */
  usingGamepad: boolean
}

function deadzone(v: number, dz = GAMEPAD_DEADZONE): number {
  if (!Number.isFinite(v)) return 0
  const a = Math.abs(v)
  if (a < dz) return 0
  // Re-scale so dz..1 maps to 0..1 (proportional after slop)
  return Math.sign(v) * ((a - dz) / (1 - dz))
}

/**
 * Mild ease on remapped stick: mostly linear mid (hold mid → mid turn),
 * slight soft knee near full lock so tiny overshoots don't feel binary.
 */
function easeSteer(v: number): number {
  const a = Math.abs(v)
  if (a < 1e-8) return 0
  const smooth = a * a * (3 - 2 * a)
  return Math.sign(v) * (a * 0.75 + smooth * 0.25)
}

function clampSteer(v: number): number {
  return Math.max(-1, Math.min(1, v))
}

/**
 * Previous-frame press for rising-edge cruise toggle.
 * Module state is fine here: one drive sample path, one player.
 */
let prevCruiseBtn = false
let prevCruiseKey = false
let prevApBtn = false
let prevApKey = false
let prevResetBtn = false
let prevResetKey = false

/**
 * Read navigator.getGamepads() and fold into keyboard state.
 * Safe to call every frame from useFrame; no allocations of note.
 */
export function sampleDriveInput(keys: DriveKeys): DriveSample {
  let steer = 0
  // Keyboard: target ±1 while held (angle approaches via stepSteerAngle, not snap)
  if (keys.left) steer += 1
  if (keys.right) steer -= 1

  let throttle = keys.forward
  let brake = false
  let reverse = false
  const keyboardBack = keys.back
  let cruiseBtn = false
  let apBtn = false
  let resetBtn = false
  let usingGamepad = false

  const pads =
    typeof navigator !== 'undefined' && navigator.getGamepads
      ? navigator.getGamepads()
      : []

  for (let i = 0; i < pads.length; i++) {
    const p = pads[i]
    if (!p || !p.connected) continue
    usingGamepad = true

    // Left stick X: −1 left … +1 right on hardware → our steer is opposite sign
    // (positive steer = turn left = positive yaw in our Y-up frame).
    // Deadzone + ease → proportional mid-hold; center slop → 0 (spring home).
    const stickX = easeSteer(deadzone(p.axes[0] ?? 0))
    steer += -stickX

    // D-pad (standard: 14 left, 15 right). Some pads also mirror on axes 6/7.
    if (p.buttons[14]?.pressed) steer += 1
    if (p.buttons[15]?.pressed) steer -= 1
    if ((p.axes.length > 6 ? deadzone(p.axes[6] ?? 0, 0.5) : 0) < 0) steer += 1
    if ((p.axes.length > 6 ? deadzone(p.axes[6] ?? 0, 0.5) : 0) > 0) steer -= 1

    // --- Trigger / bumper map (Joey feel-pack) ---
    // buttons[6] LT = gas, buttons[7] RT = brake, buttons[4] LB = reverse.
    // buttons[0] A / ✕ = cruise toggle (south face on standard mapping).
    // buttons[3] Y / △ = autopilot toggle (north face).
    const lt = p.buttons[6]?.value ?? (p.buttons[6]?.pressed ? 1 : 0)
    const rt = p.buttons[7]?.value ?? (p.buttons[7]?.pressed ? 1 : 0)
    const lb = p.buttons[4]?.pressed ?? false
    if (p.buttons[0]?.pressed) cruiseBtn = true
    if (p.buttons[3]?.pressed) apBtn = true
    // buttons[1] B / ○ = reset-to-road (east face — free vs A/Y used above).
    if (p.buttons[1]?.pressed) resetBtn = true

    if (lt > 0.15) throttle = true
    if (rt > 0.15) brake = true
    if (lb) reverse = true
  }

  // Rising edge only — hold does not spam toggle every frame.
  const cruiseKey = keys.cruise
  const cruiseToggle =
    (cruiseBtn && !prevCruiseBtn) || (cruiseKey && !prevCruiseKey)
  prevCruiseBtn = cruiseBtn
  prevCruiseKey = cruiseKey

  const apKey = keys.autopilot
  const autopilotToggle =
    (apBtn && !prevApBtn) || (apKey && !prevApKey)
  prevApBtn = apBtn
  prevApKey = apKey

  const resetKey = keys.resetToRoad
  const resetToRoad =
    (resetBtn && !prevResetBtn) || (resetKey && !prevResetKey)
  prevResetBtn = resetBtn
  prevResetKey = resetKey

  return {
    throttle,
    brake,
    reverse,
    keyboardBack,
    cruiseToggle,
    autopilotToggle,
    resetToRoad,
    steer: clampSteer(steer),
    usingGamepad,
  }
}

/**
 * Spring steer angle toward target.
 * Faster return-to-center when released / in stick slop so residual yaw dies.
 * While held, lerps toward proportional target — mid stick holds a mid arc.
 */
export function stepSteerAngle(
  current: number,
  target: number,
  dt: number,
  respond = STEER_RESPOND,
  release = STEER_RELEASE,
): number {
  const t = Math.max(0, Math.min(dt, 0.05))
  const releasing = Math.abs(target) < TARGET_ZERO_EPS
  const rate = releasing ? release : respond
  let next = current + (target - current) * Math.min(1, rate * t)
  // Hard snap once close on release — don't keep micro-yawing after let-go
  if (releasing && Math.abs(next) < 0.004) next = 0
  return clampSteer(next)
}
