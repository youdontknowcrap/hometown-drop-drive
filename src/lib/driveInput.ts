/**
 * Merge keyboard + USB gamepad into one drive sample each frame.
 *
 * Gamepad (standard mapping, Browser Gamepad API):
 *   Left stick X / D-pad  → steer (−1 right … +1 left, matches WASD)
 *   RT / A                → accelerate
 *   LT / B                → brake / reverse
 *
 * Stick deadzone ~0.15. Keyboard and pad combine (either can drive).
 */

import type { DriveKeys } from '../hooks/useKeyboard'

export const GAMEPAD_DEADZONE = 0.15

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
  // Re-scale so dz..1 maps to 0..1
  return Math.sign(v) * ((a - dz) / (1 - dz))
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
    const stickX = deadzone(p.axes[0] ?? 0)
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

/** Spring steer angle toward target; faster return-to-center when released. */
export function stepSteerAngle(
  current: number,
  target: number,
  dt: number,
  respond = 10,
  release = 16,
): number {
  const t = Math.max(0, Math.min(dt, 0.05))
  const rate = Math.abs(target) < 0.02 ? release : respond
  let next = current + (target - current) * Math.min(1, rate * t)
  if (Math.abs(target) < 0.02 && Math.abs(next) < 0.002) next = 0
  return clampSteer(next)
}
