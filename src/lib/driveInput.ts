/**
 * Merge keyboard + USB gamepad into one drive sample each frame.
 *
 * Gamepad (standard mapping, Browser Gamepad API):
 *   Left stick X / D-pad  → steer (−1 right … +1 left, matches WASD)
 *   RT / A                → accelerate
 *   LT / B                → brake / reverse
 *
 * Stick deadzone ~0.22 (slop around center → treat as zero, spring to straight).
 * Holding mid-stick holds a mid turn: steer target tracks stick proportionally
 * and the angle lerps toward that target (not binary snap / overshoot).
 * Keyboard A/D uses the same spring-return on release.
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
  forward: boolean
  back: boolean
  /** −1 = right, +1 = left (same sign as legacy A/D → yaw). */
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
  // Mix linear with smoothstep — mid stays ~proportional, edges soften a bit
  const smooth = a * a * (3 - 2 * a)
  return Math.sign(v) * (a * 0.75 + smooth * 0.25)
}

function clampSteer(v: number): number {
  return Math.max(-1, Math.min(1, v))
}

/**
 * Read navigator.getGamepads() and fold into keyboard state.
 * Safe to call every frame from useFrame; no allocations of note.
 */
export function sampleDriveInput(keys: DriveKeys): DriveSample {
  let steer = 0
  // Keyboard: target ±1 while held (angle approaches via stepSteerAngle, not snap)
  if (keys.left) steer += 1
  if (keys.right) steer -= 1

  let forward = keys.forward
  let back = keys.back
  let usingGamepad = false

  const pads =
    typeof navigator !== 'undefined' && navigator.getGamepads
      ? navigator.getGamepads()
      : []

  for (let i = 0; i < pads.length; i++) {
    const p = pads[i]
    if (!p || !p.connected) continue
    usingGamepad = true

    // Left stick X: −1 left … +1 right → our steer is opposite sign.
    // Deadzone + ease → proportional mid-hold; center slop → 0 (spring home).
    const stickX = easeSteer(deadzone(p.axes[0] ?? 0))
    steer += -stickX

    // D-pad (standard: 14 left, 15 right). Some pads also mirror on axes 6/7.
    if (p.buttons[14]?.pressed) steer += 1
    if (p.buttons[15]?.pressed) steer -= 1
    if ((p.axes.length > 6 ? deadzone(p.axes[6] ?? 0, 0.5) : 0) < 0) steer += 1
    if ((p.axes.length > 6 ? deadzone(p.axes[6] ?? 0, 0.5) : 0) > 0) steer -= 1

    const rt = p.buttons[7]?.value ?? (p.buttons[7]?.pressed ? 1 : 0)
    const lt = p.buttons[6]?.value ?? (p.buttons[6]?.pressed ? 1 : 0)
    const aBtn = p.buttons[0]?.pressed ?? false
    const bBtn = p.buttons[1]?.pressed ?? false

    if (rt > 0.15 || aBtn) forward = true
    if (lt > 0.15 || bBtn) back = true
  }

  return {
    forward,
    back,
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
