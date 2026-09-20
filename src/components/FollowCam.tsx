import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'

type FollowCamProps = {
  targetSpawn: [number, number, number]
  routeVersion: number
  distance: number
  height: number
}

/**
 * Chase camera. Distance/height come from the HUD; wheel zooms.
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
      dist.current = Math.min(48, Math.max(8, dist.current + e.deltaY * 0.02))
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

    camera.position.lerp(desired, 0.08)
    camera.lookAt(carPos.x, carPos.y + 1.2, carPos.z)
  })

  return null
}
