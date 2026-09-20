import { useRef, type MutableRefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import { RigidBody, type RapierRigidBody } from '@react-three/rapier'
import * as THREE from 'three'
import type { DriveKeys } from '../hooks/useKeyboard'
import { softSteeringHint } from '../lib/guidance'

type CarProps = {
  keys: MutableRefObject<DriveKeys>
  path: Array<[number, number, number]>
  guidanceOn: boolean
  /** Spawn at the first path point (or origin). */
  spawn: [number, number, number]
  /** Yaw in radians so the nose faces down the route. */
  spawnYaw: number
  spawnKey: number
}

const ACCEL = 28
const TURN = 3.2
const MAX_SPEED = 42
const DRAG = 0.98

/**
 * Simple geometric car with arcade WASD driving.
 * When guidance is ON, gently blends heading toward the blue path
 * (soft hint — not locked rails).
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

    // Forward is local -Z in our car mesh.
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q)
    forward.y = 0
    forward.normalize()

    let speed = Math.hypot(linvel.x, linvel.z)
    const movingForward =
      forward.x * linvel.x + forward.z * linvel.z >= -0.5

    // Throttle / brake
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

    // Player steer
    let steer = 0
    if (k.left) steer += 1
    if (k.right) steer -= 1

    // Soft guidance hint toward the path
    if (guidanceOn && path.length >= 2) {
      const t = rb.translation()
      const hint = softSteeringHint(t.x, t.z, path)
      if (hint && hint.strength > 0.05) {
        const cross = forward.x * hint.dirZ - forward.z * hint.dirX
        steer += cross * hint.strength * 2.2
      }
    }

    // Only yaw when moving a bit (arcade feel)
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

    // Light drag + keep upright
    const v = rb.linvel()
    rb.setLinvel({ x: v.x * DRAG, y: Math.min(v.y, 0), z: v.z * DRAG }, true)
    rb.setAngvel({ x: 0, y: rb.angvel().y * 0.85, z: 0 }, true)
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
      {/* Named group so FollowCam can chase us */}
      <group name="player-car">
        <mesh castShadow position={[0, 0.35, 0]}>
          <boxGeometry args={[1.6, 0.45, 3.2]} />
          <meshStandardMaterial color="#29b6f6" metalness={0.35} roughness={0.4} />
        </mesh>
        <mesh castShadow position={[0, 0.75, -0.15]}>
          <boxGeometry args={[1.3, 0.45, 1.6]} />
          <meshStandardMaterial color="#e1f5fe" metalness={0.1} roughness={0.3} />
        </mesh>
        <mesh position={[0, 0.38, -1.55]}>
          <boxGeometry args={[1.55, 0.12, 0.15]} />
          <meshStandardMaterial color="#fff59d" />
        </mesh>
        <Wheel position={[-0.85, 0.28, 1.0]} />
        <Wheel position={[0.85, 0.28, 1.0]} />
        <Wheel position={[-0.85, 0.28, -1.0]} />
        <Wheel position={[0.85, 0.28, -1.0]} />
      </group>
    </RigidBody>
  )
}

function Wheel({ position }: { position: [number, number, number] }) {
  return (
    <mesh castShadow position={position} rotation={[0, 0, Math.PI / 2]}>
      <cylinderGeometry args={[0.28, 0.28, 0.28, 16]} />
      <meshStandardMaterial color="#263238" roughness={0.9} />
    </mesh>
  )
}
