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

/** Base yaw rate (rad/s) before speed scaling — still snappy at mid speed. */
const TURN = 2.8

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
 * Kenney CC0 sedan with arcade WASD driving.
 *
 * Longitudinal: signed-speed / target-speed along forward (see longitudinal.ts).
 * We set horizontal linvel from that each frame — no impulse+drag fight.
 * Soft follow only when guidance ON and a GPS destination path is set.
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

  // Fresh drop / respawn — zero authored speed with the new RigidBody.
  useEffect(() => {
    signedMph.current = 0
    carPose.speedMph = 0
  }, [spawnKey])

  useFrame((_state, dt) => {
    const rb = body.current
    if (!rb) return

    const k = keys.current
    const rot = rb.rotation()
    _quat.set(rot.x, rot.y, rot.z, rot.w)

    _forward.set(0, 0, -1).applyQuaternion(_quat)
    _forward.y = 0
    if (_forward.lengthSq() < 1e-8) return
    _forward.normalize()

    // --- Longitudinal: integrate signed mph, then write velocity along forward
    signedMph.current = stepSignedSpeedMph(
      signedMph.current,
      k.forward,
      k.back,
      dt,
    )

    const speedMs = signedMph.current * MPH_TO_MS
    const v = rb.linvel()
    rb.setLinvel(
      {
        x: _forward.x * speedMs,
        y: Math.min(v.y, 0),
        z: _forward.z * speedMs,
      },
      true,
    )

    // --- Steering (arcade yaw vs speed; dialed down at 110 mph)
    let steer = 0
    if (k.left) steer += 1
    if (k.right) steer -= 1

    if (guidanceOn && path.length >= 2) {
      const t = rb.translation()
      const hint = softSteeringHint(t.x, t.z, path)
      if (hint && hint.strength > 0.05) {
        const cross = _forward.x * hint.dirZ - _forward.z * hint.dirX
        steer += cross * hint.strength * 2.2
      }
    }

    const absMph = Math.abs(signedMph.current)
    const scale = steerScale(absMph)
    if (Math.abs(steer) > 0.01 && scale > 0) {
      const sign = signedMph.current >= 0 ? 1 : -1
      const yaw = steer * TURN * sign * scale * dt
      _yawQ.setFromAxisAngle(_yawAxis, yaw)
      _quat.multiply(_yawQ)
      rb.setRotation({ x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w }, true)

      // Re-align velocity to new forward so we don't skid sideways.
      _forward.set(0, 0, -1).applyQuaternion(_quat)
      _forward.y = 0
      _forward.normalize()
      const v2 = rb.linvel()
      rb.setLinvel(
        {
          x: _forward.x * speedMs,
          y: Math.min(v2.y, 0),
          z: _forward.z * speedMs,
        },
        true,
      )
    }

    rb.setAngvel({ x: 0, y: 0, z: 0 }, true)

    const t = rb.translation()
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
      enabledRotations={[false, true, false]}
    >
      <group name="player-car">
        <KenneySedan />
      </group>
    </RigidBody>
  )
}
