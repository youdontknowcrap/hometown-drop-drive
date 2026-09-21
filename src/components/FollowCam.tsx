import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'

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
 * --- Perceived speed vs true scale ---
 * World units are real meters (OSM / latLngToLocal). 110 mph ≈ 49 m/s is
 * correct on the speedo. If that "doesn't feel fast," the lie is presentation:
 * a tight chase cam + empty desert = weak parallax. We default a bit farther
 * back and use a slightly snappier follow (higher lerp = less "heavy damp")
 * so ground texture streams past more readably — WITHOUT faking the mph number.
 */
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

  useEffect(() => {
    dist.current = distance
    h.current = height
  }, [distance, height])

  useEffect(() => {
    const el = gl.domElement
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      // Allow a longer pull-back so kids can exaggerate speed read on purpose.
      dist.current = Math.min(56, Math.max(8, dist.current + e.deltaY * 0.02))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [gl])

  useFrame(() => {
    if (initialized.current !== routeVersion) {
      camera.position.set(
        targetSpawn[0],
        targetSpawn[1] + h.current,
        targetSpawn[2] + dist.current,
      )
      camera.lookAt(targetSpawn[0], targetSpawn[1], targetSpawn[2])
      initialized.current = routeVersion
    }

    const car = scene.getObjectByName('player-car')
    if (!car) return

    const carPos = new THREE.Vector3()
    car.getWorldPosition(carPos)
    const q = new THREE.Quaternion()
    car.getWorldQuaternion(q)
    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(q)
    back.y = 0
    back.normalize()

    const desired = carPos
      .clone()
      .add(back.multiplyScalar(dist.current))
      .add(new THREE.Vector3(0, h.current, 0))

    // Was 0.08 (heavy damp). 0.14 = less damp → camera keeps up, ground rush reads.
    camera.position.lerp(desired, 0.14)
    camera.lookAt(carPos.x, carPos.y + 1.2, carPos.z)
  })

  return null
}
