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
  stepSignedSpeedMph,
  steerScale,
} from '../lib/longitudinal'
import { sampleDriveInput, stepSteerAngle } from '../lib/driveInput'

const _euler = new THREE.Euler()
const _forward = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _yawAxis = new THREE.Vector3(0, 1, 0)
const _yawQ = new THREE.Quaternion()

type CarProps = {
  keys: MutableRefObject<DriveKeys>
  path: Array<[number, number, number]>
  guidanceOn: boolean
  spawn: [number, number, number]
  spawnYaw: number
  spawnKey: number
}

/** Base yaw rate (rad/s) at full steer before speed scaling. */
const TURN = 2.8

/** Keep the body above the ground plane if contact ever slips. */
const MIN_Y = 0.45

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
 * Horizontal linvel is authored each frame; vertical (y) is left to Rapier
 * so ground contact can push up — never clamp y≤0 (that caused fall-through).
 * Steer: stick/key target is proportional; angle lerps toward it (hold mid =
 * hold arc). Stick slop + strong spring-return centers on release; angvel
 * cleared every frame so we never keep yawing after let-go.
 */
export function Car({
  keys,
  path,
  guidanceOn,
  spawn,
  spawnYaw,
  spawnKey,
}: CarProps) {
  const body = useRef<RapierRigidBody>(null)
  /** Authoritative signed speed (mph) along forward. Positive = nose direction. */
  const signedMph = useRef(0)
  /** Smoothed steer −1..+1; springs to 0 when input released. */
  const steerAngle = useRef(0)

  // Fresh drop / respawn — zero authored speed with the new RigidBody.
  useEffect(() => {
    signedMph.current = 0
    steerAngle.current = 0
    carPose.speedMph = 0
  }, [spawnKey])

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

    // --- Longitudinal: integrate signed mph, then write horizontal velocity
    signedMph.current = stepSignedSpeedMph(
      signedMph.current,
      input.forward,
      input.back,
      dt,
    )

    const speedMs = signedMph.current * MPH_TO_MS
    const v = rb.linvel()
    // Preserve Rapier's y (gravity + ground reaction). Clamping y≤0 killed
    // contact separation and let the car tunnel through the slab at speed.
    rb.setLinvel(
      {
        x: _forward.x * speedMs,
        y: v.y,
        z: _forward.z * speedMs,
      },
      true,
    )

    // --- Steering: spring-return angle, yaw rate ∝ angle * speed scale
    let steerTarget = input.steer

    if (guidanceOn && path.length >= 2) {
      const t = rb.translation()
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

    const absMph = Math.abs(signedMph.current)
    const scale = steerScale(absMph)
    if (Math.abs(steerAngle.current) > 0.001 && scale > 0) {
      const sign = signedMph.current >= 0 ? 1 : -1
      const yaw = steerAngle.current * TURN * sign * scale * dt
      _yawQ.setFromAxisAngle(_yawAxis, yaw)
      _quat.multiply(_yawQ)
      rb.setRotation({ x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w }, true)

      // Re-align horizontal velocity to new forward so we don't skid sideways.
      _forward.set(0, 0, -1).applyQuaternion(_quat)
      _forward.y = 0
      _forward.normalize()
      const v2 = rb.linvel()
      rb.setLinvel(
        {
          x: _forward.x * speedMs,
          y: v2.y,
          z: _forward.z * speedMs,
        },
        true,
      )
    }

    // Kill residual angular velocity so Rapier doesn't keep spinning us.
    rb.setAngvel({ x: 0, y: 0, z: 0 }, true)

    // Safety net: if we ever slip under the slab, pop back onto it.
    const t = rb.translation()
    if (t.y < MIN_Y) {
      rb.setTranslation({ x: t.x, y: MIN_Y, z: t.z }, true)
      const v3 = rb.linvel()
      if (v3.y < 0) {
        rb.setLinvel({ x: v3.x, y: 0, z: v3.z }, true)
      }
    }

    _euler.setFromQuaternion(_quat, 'YXZ')
    carPose.x = t.x
    carPose.z = t.z
    carPose.yaw = _euler.y
    carPose.speedMph = signedMph.current
    carPose.ready = true
  })

  return (
    <RigidBody
      key={spawnKey}
      ref={body}
      colliders="cuboid"
      position={spawn}
      rotation={[0, spawnYaw, 0]}
      friction={1.4}
      // Drive axis is kinematic from the controller; keep damping low so
      // Rapier contacts don't sap our authored speed.
      linearDamping={0.05}
      angularDamping={2}
      canSleep={false}
      // Continuous collision — 110 mph ≈ 49 m/s tunnels a thin ground slab.
      ccd
      enabledRotations={[false, true, false]}
    >
      <group name="player-car">
        <KenneySedan />
      </group>
    </RigidBody>
  )
}
