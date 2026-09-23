import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { carPose } from '../lib/carPose'

type FollowCamProps = {
  targetSpawn: [number, number, number]
  /**
   * Drop-only. Streaming tile loads must NOT change this — otherwise the chase
   * cam snaps back to spawn (Joey lock).
   */
  routeVersion: number
  distance: number
  height: number
}

/**
 * Chase camera. Distance/height come from the HUD; wheel zooms.
 *
 * LEARNING — tight follow at every speed (Joey):
 *   We used to default farther back + snappy lerp so high mph "read" via
 *   ground rush. That felt like the cam pulling out on accelerate. Keep the
 *   HUD distance fixed — NO speed-linked FOV / dolly / distance. Smooth with
 *   dt-based exp lerp + smoothed look target so elev morph / leave-bump Y
 *   spikes do not jerk the view.
 *
 * LEARNING — remount guard (module scope):
 *   If FollowCam remounts mid-Drop (Canvas Suspense recovery / elev hitch
 *   recovery), useRef(0) resets and `initialized !== routeVersion` would replay
 *   the intro snap (camera wiggle). Remember which dropNonce already intro'd
 *   so same-Drop remounts resume chase from carPose — NEVER re-run intro.
 *   Hitch ≠ remount, but both used to look the same; intro is Drop-only.
 */
let introDoneForRouteVersion = -1

/** Position follow rate (1/s). Higher = snappier; still dt-based (not per-frame α). */
const POS_FOLLOW_RATE = 10
/** Look-at follow rate — slower on Y so terrain spikes do not whip the view. */
const LOOK_FOLLOW_RATE = 12
const LOOK_Y_FOLLOW_RATE = 6

export function FollowCam({
  targetSpawn,
  routeVersion,
  distance,
  height,
}: FollowCamProps) {
  const { camera, scene, gl } = useThree()
  const initialized = useRef(0)
  const dist = useRef(distance)
  const h = useRef(height)
  const look = useRef(new THREE.Vector3())
  const lookReady = useRef(false)
  // Scratch — avoid alloc every rAF (GC hitch looked like a cam jerk).
  const carPos = useRef(new THREE.Vector3())
  const back = useRef(new THREE.Vector3())
  const desired = useRef(new THREE.Vector3())
  const q = useRef(new THREE.Quaternion())

  useEffect(() => {
    dist.current = distance
    h.current = height
  }, [distance, height])

  useEffect(() => {
    const el = gl.domElement
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      // Manual zoom only — never auto-dolly with speed.
      dist.current = Math.min(40, Math.max(8, dist.current + e.deltaY * 0.02))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [gl])

  useFrame((_, dt) => {
    const dtClamped = Math.min(Math.max(dt, 0), 0.05)

    if (initialized.current !== routeVersion) {
      // Drop-only intro: if this dropNonce already intro'd (same-Drop remount
      // after Suspense/hitch), skip spawn snap entirely — even if carPose is
      // briefly not ready. Mid-drive stream / elev / route splice must never
      // replay the intro.
      if (introDoneForRouteVersion === routeVersion) {
        initialized.current = routeVersion
      } else {
        camera.position.set(
          targetSpawn[0],
          targetSpawn[1] + h.current,
          targetSpawn[2] + dist.current,
        )
        camera.lookAt(targetSpawn[0], targetSpawn[1], targetSpawn[2])
        look.current.set(targetSpawn[0], targetSpawn[1] + 1.2, targetSpawn[2])
        lookReady.current = true
        initialized.current = routeVersion
        introDoneForRouteVersion = routeVersion
      }
    }

    const car = scene.getObjectByName('player-car')
    const pos = carPos.current
    const b = back.current
    if (car) {
      car.getWorldPosition(pos)
      car.getWorldQuaternion(q.current)
      b.set(0, 0, 1).applyQuaternion(q.current)
    } else if (carPose.ready) {
      // Belt: if player-car blips for a frame (mesh suspend / sibling churn),
      // keep chase continuous from authored pose — never re-run intro snap.
      pos.set(carPose.x, carPose.y, carPose.z)
      b.set(Math.sin(carPose.yaw), 0, Math.cos(carPose.yaw))
    } else {
      return
    }
    b.y = 0
    if (b.lengthSq() < 1e-8) b.set(0, 0, 1)
    b.normalize()

    // Fixed HUD distance — no speed factor (Joey: stay tight on accelerate).
    desired.current.copy(pos).addScaledVector(b, dist.current)
    desired.current.y += h.current

    const posAlpha = 1 - Math.exp(-POS_FOLLOW_RATE * dtClamped)
    camera.position.lerp(desired.current, posAlpha)

    const lookTargetX = pos.x
    const lookTargetY = pos.y + 1.2
    const lookTargetZ = pos.z
    if (!lookReady.current) {
      look.current.set(lookTargetX, lookTargetY, lookTargetZ)
      lookReady.current = true
    } else {
      const lookA = 1 - Math.exp(-LOOK_FOLLOW_RATE * dtClamped)
      const lookYA = 1 - Math.exp(-LOOK_Y_FOLLOW_RATE * dtClamped)
      look.current.x += (lookTargetX - look.current.x) * lookA
      look.current.z += (lookTargetZ - look.current.z) * lookA
      look.current.y += (lookTargetY - look.current.y) * lookYA
    }
    camera.lookAt(look.current)
  })

  return null
}
