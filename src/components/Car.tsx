import { useEffect, useMemo, useRef, type MutableRefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import { RigidBody, type RapierRigidBody } from '@react-three/rapier'
import * as THREE from 'three'
import type { DriveKeys } from '../hooks/useKeyboard'
import { softSteeringHint } from '../lib/guidance'
import { carPose } from '../lib/carPose'
import {
  MPH_TO_MS,
  bicycleYawRate,
  stepSignedSpeedMph,
  wheelAngleRad,
} from '../lib/longitudinal'
import { sampleDriveInput, stepSteerAngle } from '../lib/driveInput'
import { sampleHeight, type HeightGrid } from '../lib/terrarium'

const _euler = new THREE.Euler()
const _forward = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _yawAxis = new THREE.Vector3(0, 1, 0)
const _yawQ = new THREE.Quaternion()

/** How high the RigidBody center sits above sampled ground. */
const CAR_CLEARANCE_M = 0.55

type CarProps = {
  keys: MutableRefObject<DriveKeys>
  path: Array<[number, number, number]>
  guidanceOn: boolean
  spawn: [number, number, number]
  spawnYaw: number
  spawnKey: number
  /** Terrarium (or flat) grid — car Y follows sampleHeight each frame. */
  heightGrid: HeightGrid
}

const SEDAN = '/models/kenney-car/sedan.glb'
const WHEEL = '/models/kenney-car/wheel-default.glb'

/** Kenney sedan, Y-up, +Z nose. Wheels are a separate GLB. Units ≈ meters. */
const WHEEL_POS: Array<[number, number, number]> = [
  [0.62, 0.3, 0.88],
  [-0.62, 0.3, 0.88],
  [0.62, 0.3, -0.95],
  [-0.62, 0.3, -0.95],
]

function shadowClone(src: THREE.Object3D): THREE.Object3D {
  const obj = src.clone(true)
  obj.traverse((n) => {
    const mesh = n as THREE.Mesh
    if (mesh.isMesh) {
      mesh.castShadow = true
      mesh.receiveShadow = true
    }
  })
  return obj
}

function KenneySedan() {
  const sedan = useGLTF(SEDAN)
  const wheel = useGLTF(WHEEL)
  const body = useMemo(() => shadowClone(sedan.scene), [sedan.scene])
  const wheels = useMemo(
    () => WHEEL_POS.map(() => shadowClone(wheel.scene)),
    [wheel.scene],
  )

  return (
    // Kenney +Z is the nose; our arcade forward is -Z.
    <group rotation={[0, Math.PI, 0]}>
      <primitive object={body} />
      {wheels.map((w, i) => (
        <primitive key={i} object={w} position={WHEEL_POS[i]} />
      ))}
    </group>
  )
}

useGLTF.preload(SEDAN)
useGLTF.preload(WHEEL)

/**
 * Kenney CC0 sedan with arcade WASD + gamepad driving.
 *
 * Longitudinal: signed-speed along forward (see longitudinal.ts).
 * Horizontal linvel is authored each frame; vertical (y) follows the
 * Terrarium height sample so hills work without a fragile heightfield CCD.
 *
 * --- Steering = wheel angle (bicycle / single-track model) ---
 *   Stick/keys → normalized δ̂ ∈ [−1, 1]  (deadzone → 0 → goes straight)
 *   δ = wheelAngleRad(δ̂, v)               (radians, softened at speed)
 *   yaw rate ω ≈ (v / L) * tan(δ)         (rad/s)
 *
 * WHY this instead of "stick = yaw rate"? A yaw-rate joystick feels like
 * fighting the car. Wheel-angle demand means: hold mid-stick → constant
 * turn *radius* at that speed (you hold the arc). Release to deadzone →
 * δ→0 → ω→0 → straight. That is the standard arcade-sim bicycle model.
 */
export function Car({
  keys,
  path,
  guidanceOn,
  spawn,
  spawnYaw,
  spawnKey,
  heightGrid,
}: CarProps) {
  const body = useRef<RapierRigidBody>(null)
  /** Authoritative signed speed (mph) along forward. Positive = nose direction. */
  const signedMph = useRef(0)
  /** Smoothed steer −1..+1; springs to 0 when input released. */
  const steerAngle = useRef(0)
  /** Trailing-second distance accumulator for HUD sanity (meters). */
  const odometer = useRef({ x: spawn[0], z: spawn[2], acc: 0, t: 0, last: 0 })

  // Fresh drop / respawn — zero authored speed with the new RigidBody.
  useEffect(() => {
    signedMph.current = 0
    steerAngle.current = 0
    carPose.speedMph = 0
    carPose.metersLastSecond = 0
    odometer.current = { x: spawn[0], z: spawn[2], acc: 0, t: 0, last: 0 }
  }, [spawnKey, spawn])

  useFrame((_state, dt) => {
    const rb = body.current
    if (!rb) return

    const input = sampleDriveInput(keys.current)
    const rot = rb.rotation()
    _quat.set(rot.x, rot.y, rot.z, rot.w)

    _forward.set(0, 0, -1).applyQuaternion(_quat)
    _forward.y = 0
    if (_forward.lengthSq() < 1e-8) return
    _forward.normalize()

    // --- Pedals: gamepad splits brake/reverse; keyboard S is context-sensitive
    let throttle = input.throttle
    let brake = input.brake
    let reverse = input.reverse
    if (input.keyboardBack) {
      // WASD: S brakes while rolling forward, reverses from rest / while backing.
      if (signedMph.current > 0.05) brake = true
      else reverse = true
    }

    signedMph.current = stepSignedSpeedMph(
      signedMph.current,
      throttle,
      brake,
      reverse,
      dt,
    )

    const speedMs = signedMph.current * MPH_TO_MS
    const t = rb.translation()

    // --- Terrain follow: pin Y to Terrarium sample (relative to spawn elev)
    const groundY = sampleHeight(heightGrid, t.x, t.z)
    const wantY = groundY + CAR_CLEARANCE_M

    rb.setLinvel(
      {
        x: _forward.x * speedMs,
        y: 0, // authored horizontal drive; Y is pinned below
        z: _forward.z * speedMs,
      },
      true,
    )
    rb.setTranslation({ x: t.x, y: wantY, z: t.z }, true)

    // --- Bicycle steering ---
    let steerTarget = input.steer

    if (guidanceOn && path.length >= 2) {
      const hint = softSteeringHint(t.x, t.z, path)
      if (hint && hint.strength > 0.05) {
        const cross = _forward.x * hint.dirZ - _forward.z * hint.dirX
        steerTarget = Math.max(
          -1,
          Math.min(1, steerTarget + cross * hint.strength * 2.2),
        )
      }
    }

    steerAngle.current = stepSteerAngle(steerAngle.current, steerTarget, dt)

    // δ from stick; ω = (v/L)*tan(δ). At v=0, ω=0 (no turn-in-place spin).
    const delta = wheelAngleRad(steerAngle.current, speedMs)
    const yawRate = bicycleYawRate(speedMs, delta)
    if (Math.abs(yawRate) > 1e-5) {
      const yaw = yawRate * Math.min(dt, 0.05)
      _yawQ.setFromAxisAngle(_yawAxis, yaw)
      _quat.multiply(_yawQ)
      rb.setRotation({ x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w }, true)

      // Re-align horizontal velocity to new forward so we don't skid sideways.
      _forward.set(0, 0, -1).applyQuaternion(_quat)
      _forward.y = 0
      _forward.normalize()
      rb.setLinvel(
        {
          x: _forward.x * speedMs,
          y: 0,
          z: _forward.z * speedMs,
        },
        true,
      )
    }

    // Kill residual angular velocity so Rapier doesn't keep spinning us.
    rb.setAngvel({ x: 0, y: 0, z: 0 }, true)

    // --- Meters-last-second sanity (true scale check for the HUD) ---
    const od = odometer.current
    const dx = t.x - od.x
    const dz = t.z - od.z
    od.acc += Math.hypot(dx, dz)
    od.x = t.x
    od.z = t.z
    od.t += dt
    if (od.t >= 1) {
      od.last = od.acc / od.t // meters per trailing window ≈ m/s when ~1s
      od.acc = 0
      od.t = 0
    }

    _euler.setFromQuaternion(_quat, 'YXZ')
    carPose.x = t.x
    carPose.y = wantY
    carPose.z = t.z
    carPose.yaw = _euler.y
    carPose.speedMph = signedMph.current
    carPose.metersLastSecond = od.last
    carPose.groundY = groundY
    carPose.ready = true
  })

  // Spawn Y also comes from the height grid so we don't drop through a hill.
  const spawnY =
    sampleHeight(heightGrid, spawn[0], spawn[2]) + CAR_CLEARANCE_M

  return (
    <RigidBody
      key={spawnKey}
      ref={body}
      colliders="cuboid"
      position={[spawn[0], spawnY, spawn[2]]}
      rotation={[0, spawnYaw, 0]}
      friction={1.4}
      // Drive axis is kinematic from the controller; keep damping low so
      // Rapier contacts don't sap our authored speed.
      linearDamping={0.05}
      angularDamping={2}
      canSleep={false}
      // Continuous collision — 110 mph ≈ 49 m/s tunnels thin colliders.
      ccd
      enabledRotations={[false, true, false]}
      gravityScale={0}
    >
      <group name="player-car">
        <KenneySedan />
      </group>
    </RigidBody>
  )
}
