import { useMemo, useRef, type MutableRefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import { RigidBody, type RapierRigidBody } from '@react-three/rapier'
import * as THREE from 'three'
import type { DriveKeys } from '../hooks/useKeyboard'
import { softSteeringHint } from '../lib/guidance'
import { carPose } from '../lib/carPose'

const _euler = new THREE.Euler()

type CarProps = {
  keys: MutableRefObject<DriveKeys>
  path: Array<[number, number, number]>
  guidanceOn: boolean
  spawn: [number, number, number]
  spawnYaw: number
  spawnKey: number
}

const ACCEL = 28
const TURN = 3.2
const MAX_SPEED = 42
const DRAG = 0.98

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
 * Soft follow only when guidance ON and a GPS destination path is set.
 * Hint uses nearest-segment projection (see guidance.ts) — not rails.
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

  useFrame((_state, dt) => {
    const rb = body.current
    if (!rb) return

    const k = keys.current
    const linvel = rb.linvel()
    const rot = rb.rotation()
    const q = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w)

    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q)
    forward.y = 0
    forward.normalize()

    let speed = Math.hypot(linvel.x, linvel.z)
    const movingForward =
      forward.x * linvel.x + forward.z * linvel.z >= -0.5

    if (k.forward) {
      const boost = Math.max(0, 1 - speed / MAX_SPEED)
      rb.applyImpulse(
        {
          x: forward.x * ACCEL * boost * dt,
          y: 0,
          z: forward.z * ACCEL * boost * dt,
        },
        true,
      )
    }
    if (k.back) {
      rb.applyImpulse(
        {
          x: -forward.x * ACCEL * 0.6 * dt,
          y: 0,
          z: -forward.z * ACCEL * 0.6 * dt,
        },
        true,
      )
    }

    let steer = 0
    if (k.left) steer += 1
    if (k.right) steer -= 1

    if (guidanceOn && path.length >= 2) {
      const t = rb.translation()
      const hint = softSteeringHint(t.x, t.z, path)
      if (hint && hint.strength > 0.05) {
        const cross = forward.x * hint.dirZ - forward.z * hint.dirX
        steer += cross * hint.strength * 2.2
      }
    }

    speed = Math.hypot(rb.linvel().x, rb.linvel().z)
    if (Math.abs(steer) > 0.01 && speed > 0.4) {
      const sign = movingForward ? 1 : -1
      const yaw = steer * TURN * sign * Math.min(1, speed / 8) * dt
      const yawQ = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        yaw,
      )
      q.multiply(yawQ)
      rb.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true)

      const v = rb.linvel()
      const along = forward.x * v.x + forward.z * v.z
      rb.setLinvel(
        {
          x: forward.x * along * 0.85 + v.x * 0.15,
          y: v.y,
          z: forward.z * along * 0.85 + v.z * 0.15,
        },
        true,
      )
    }

    const v = rb.linvel()
    rb.setLinvel({ x: v.x * DRAG, y: Math.min(v.y, 0), z: v.z * DRAG }, true)
    rb.setAngvel({ x: 0, y: rb.angvel().y * 0.85, z: 0 }, true)

    const t = rb.translation()
    _euler.setFromQuaternion(q, 'YXZ')
    carPose.x = t.x
    carPose.z = t.z
    carPose.yaw = _euler.y
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
      linearDamping={0.2}
      angularDamping={1.5}
      canSleep={false}
      enabledRotations={[false, true, false]}
    >
      <group name="player-car">
        <KenneySedan />
      </group>
    </RigidBody>
  )
}
