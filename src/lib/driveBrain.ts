/**
 * Thin drive-brain API — policy owns intent; Car owns Rapier/physics.
 *
 * LEARNING (Forge architecture): Car used to pile manual + cruise + autopilot
 * flags in one giant useFrame. That made three “competing flag piles.” Here
 * we extract a small policy interface:
 *
 *   tickDriveBrain(pose, input, route, state, dt) → { command, state }
 *
 * Policies (exactly one active mode per tick):
 *   • manual    — stick/keys → bicycle steer; pedals → signed speed
 *   • cruise    — hold set mph (A/✕/C); steer still manual; brake/reverse cancel
 *   • autopilot — snap/slide along the **driven** route path; gas/brake modulate
 *                 target 0..200 mph; reverse / arrive / clear cancel
 *
 * Car applies: longitudinal step, bicycle yaw (manual/cruise), AP snap pose,
 * terrain pin, wedge escape. Brain never remounts Car / FollowCam / Scene.
 *
 * Soft guidance (blue-line hint while manual) stays in Car — it is a steering
 * assist, not a separate policy mode.
 */

import type { DriveSample } from './driveInput'
import {
  AUTOPILOT_ARRIVE_M,
  AUTOPILOT_MAX_SPEED_MPH,
  AP_TARGET_LOWER_MPH_S,
  AP_TARGET_RAISE_MPH_S,
  autopilotControl,
  followPathSnapSlide,
  type AutopilotFollow,
} from './autopilot'
import { isLikelyCrowFlight } from './streetGraph'
import {
  MAX_SPEED_MPH,
  OFF_ROAD_MAX_SPEED_MPH,
} from './longitudinal'

/** World pose the brain may read (no Rapier handles). */
export type DriveBrainPose = {
  x: number
  z: number
  /** Signed mph along nose (authoritative arcade speed). */
  signedMph: number
  /** True when on asphalt/track ribbon (soft off-road uses the inverse). */
  onRoad: boolean
}

/** Mutable policy memory — Car keeps this in a ref across frames. */
export type DriveBrainState = {
  cruiseOn: boolean
  /** Signed hold target (mph) while cruiseOn. */
  cruiseMph: number
  apOn: boolean
  /** Commanded AP speed target (mph, 0..200). */
  apTargetMph: number
}

/** One-path-truth route the AP policy follows (aligned loaded centerlines). */
export type DriveBrainRoute = {
  /** Driven path in world XZ — same polyline GPS paints blue. */
  path: Array<[number, number, number]>
}

export type DriveBrainMode = 'manual' | 'cruise' | 'autopilot'

/**
 * Command bus → Car control loop.
 *
 * Teaching: everything the physics step needs to integrate *this frame*.
 * Snap/slide lives here as `apFollow` so Car does not re-derive AP geometry.
 */
export type DriveBrainCommand = {
  mode: DriveBrainMode
  /**
   * Normalized steer demand −1..+1 for bicycle model.
   * Ignored while mode === 'autopilot' (AP owns yaw via apFollow).
   */
  steer: number
  /** Pedal bits after keyboard S context mapping (Car passes them in). */
  throttle: boolean
  brake: boolean
  reverse: boolean
  /**
   * When true, longitudinal holds cruiseTargetMph (no coast burndown).
   * Only meaningful in cruise mode with no pedals.
   */
  cruiseHold: boolean
  cruiseTargetMph: number
  /** Soft speed ceiling for this frame (AP 200 / manual 110 / off-road 55). */
  speedCapMph: number
  /**
   * Autopilot snap/slide sample. Non-null → Car places XZ + yaw from this
   * and skips bicycle δ. Null in manual/cruise.
   */
  apFollow: AutopilotFollow | null
  /** Skip desert leave-bump + 50% penalty (AP may leave the ribbon briefly). */
  skipOffRoadPenalty: boolean
}

export function defaultDriveBrainState(): DriveBrainState {
  return {
    cruiseOn: false,
    cruiseMph: 0,
    apOn: false,
    apTargetMph: 0,
  }
}

/**
 * Resolve pedals: gamepad already splits brake/reverse; keyboard S is
 * context-sensitive (brake while rolling forward, reverse from rest).
 */
export function resolvePedals(
  input: DriveSample,
  signedMph: number,
): { throttle: boolean; brake: boolean; reverse: boolean } {
  let throttle = input.throttle
  let brake = input.brake
  let reverse = input.reverse
  if (input.keyboardBack) {
    if (signedMph > 0.05) brake = true
    else reverse = true
  }
  return { throttle, brake, reverse }
}

/**
 * One brain tick. Order matters (teaching):
 *   1) HUD / KeyP / Y△ autopilot edge (needs path)
 *   2) Reverse / empty path / arrive cancel AP
 *   3) Cruise edge (ignored while AP owns longitudinal)
 *   4) Brake/reverse cancel cruise
 *   5) Emit command for the active mode
 */
export function tickDriveBrain(
  pose: DriveBrainPose,
  input: DriveSample,
  route: DriveBrainRoute,
  state: DriveBrainState,
  dt: number,
  pedals: { throttle: boolean; brake: boolean; reverse: boolean },
): { command: DriveBrainCommand; state: DriveBrainState } {
  const path = route.path
  const next: DriveBrainState = {
    cruiseOn: state.cruiseOn,
    cruiseMph: state.cruiseMph,
    apOn: state.apOn,
    apTargetMph: state.apTargetMph,
  }

  const { throttle, brake, reverse } = pedals

  // --- Autopilot engage / cancel (before cruise so AP clears cruise) ---
  const hudApToggle = autopilotControl.hudToggle
  if (hudApToggle) autopilotControl.hudToggle = false
  if (autopilotControl.forceOff) {
    next.apOn = false
    autopilotControl.forceOff = false
  }
  const apToggle = input.autopilotToggle || hudApToggle
  if (apToggle) {
    if (next.apOn) {
      next.apOn = false
    } else if (path.length >= 2 && !isLikelyCrowFlight(path)) {
      // LEARNING — never engage AP on geodesic straight-fallback. OSRM spines
      // and near-car splices have enough vertices / arc to pass this gate.
      next.apOn = true
      next.apTargetMph = Math.max(
        15,
        Math.min(AUTOPILOT_MAX_SPEED_MPH, Math.abs(pose.signedMph)),
      )
      next.cruiseOn = false
    }
  }
  if (reverse || path.length < 2 || isLikelyCrowFlight(path)) {
    next.apOn = false
  }

  // --- Cruise (A / ✕ / C): edge toggle; brake or reverse always cancel ---
  if (input.cruiseToggle && !next.apOn) {
    if (next.cruiseOn) {
      next.cruiseOn = false
    } else {
      next.cruiseOn = true
      next.cruiseMph = pose.signedMph
    }
  }
  if (brake || reverse) {
    next.cruiseOn = false
  }

  // --- Speed cap + off-road policy ---
  const skipOffRoad = next.apOn
  const offRoadPenalty = !pose.onRoad && !skipOffRoad
  const speedCapMph = next.apOn
    ? AUTOPILOT_MAX_SPEED_MPH
    : offRoadPenalty
      ? OFF_ROAD_MAX_SPEED_MPH
      : MAX_SPEED_MPH

  // --- Mode-specific longitudinal / steer intent ---
  if (next.apOn) {
    return {
      state: next,
      command: autopilotPolicy(
        pose,
        path,
        next,
        dt,
        throttle,
        brake,
        reverse,
        speedCapMph,
        input.steer,
      ),
    }
  }

  if (next.cruiseOn) {
    // Clamp hold target to soft cap (off-road may yank it down).
    const absSet = Math.abs(next.cruiseMph)
    if (absSet > speedCapMph) {
      next.cruiseMph = Math.sign(next.cruiseMph || 1) * speedCapMph
    }
    const cruiseHold = !throttle && !brake && !reverse
    return {
      state: next,
      command: {
        mode: 'cruise',
        steer: input.steer,
        throttle,
        brake,
        reverse,
        cruiseHold,
        cruiseTargetMph: next.cruiseMph,
        speedCapMph,
        apFollow: null,
        skipOffRoadPenalty: false,
      },
    }
  }

  // Manual
  return {
    state: next,
    command: {
      mode: 'manual',
      steer: input.steer,
      throttle,
      brake,
      reverse,
      cruiseHold: false,
      cruiseTargetMph: 0,
      speedCapMph,
      apFollow: null,
      skipOffRoadPenalty: false,
    },
  }
}

/**
 * Autopilot policy: modulate target mph with gas/brake; emit snap/slide follow.
 * Arrive (~AUTOPILOT_ARRIVE_M) clears apOn via state mutation on the command path —
 * we return apFollow null and flip state when close.
 */
function autopilotPolicy(
  pose: DriveBrainPose,
  path: Array<[number, number, number]>,
  state: DriveBrainState,
  dt: number,
  throttle: boolean,
  brake: boolean,
  reverse: boolean,
  speedCapMph: number,
  steer: number,
): DriveBrainCommand {
  // Target raise/lower (Joey: AP speed is a commanded hold, not raw pedal).
  if (throttle) {
    state.apTargetMph = Math.min(
      speedCapMph,
      state.apTargetMph + AP_TARGET_RAISE_MPH_S * dt,
    )
  }
  if (brake) {
    state.apTargetMph = Math.max(
      0,
      state.apTargetMph - AP_TARGET_LOWER_MPH_S * dt,
    )
  }
  state.apTargetMph = Math.min(speedCapMph, Math.max(0, state.apTargetMph))

  const speedMs = pose.signedMph * 0.44704
  let apFollow: AutopilotFollow | null = null
  if (path.length >= 2 && !reverse) {
    const follow = followPathSnapSlide(pose.x, pose.z, path, speedMs, dt)
    if (follow.ok && follow.distToEnd <= AUTOPILOT_ARRIVE_M) {
      state.apOn = false
      apFollow = null
    } else if (follow.ok) {
      apFollow = follow
    }
  }

  // Chase target like cruise: throttle below, brake above / pedal brake.
  const tgt = state.apTargetMph
  const below = pose.signedMph < tgt - 0.4
  const above = pose.signedMph > tgt + 0.4
  const apThrottle = !brake && below
  const apBrake = brake || above
  // Hold when on target — stepSignedSpeedMph uses cruiseHold semantics.
  const onTarget = !apThrottle && !apBrake

  return {
    mode: state.apOn ? 'autopilot' : 'manual',
    steer, // unused while apFollow set
    throttle: apThrottle,
    brake: apBrake,
    reverse: false,
    cruiseHold: onTarget && state.apOn,
    cruiseTargetMph: tgt,
    speedCapMph,
    apFollow: state.apOn ? apFollow : null,
    skipOffRoadPenalty: state.apOn,
  }
}
