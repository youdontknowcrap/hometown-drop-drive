import { useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'

type FollowCamProps = {
  targetSpawn: [number, number, number]
  routeVersion: number
}

/**
 * Simple chase camera that looks toward world origin of the car each frame
 * by finding the first RigidBody-backed mesh near spawn… Actually we chase
 * by scanning the scene for our car group via a shared name.
 *
 * Simpler approach: lerp camera toward a point behind/above the car by
 * reading the object named "player-car" if present; otherwise hold near spawn.
 */
export function FollowCam({ targetSpawn, routeVersion }: FollowCamProps) {
  const { camera, scene } = useThree()
  const initialized = useRef(0)

  useFrame(() => {
    // Reset when a new route loads
    if (initialized.current !== routeVersion) {
      camera.position.set(
        targetSpawn[0] + 0,
        targetSpawn[1] + 10,
        targetSpawn[2] + 14,
      )
      camera.lookAt(targetSpawn[0], targetSpawn[1], targetSpawn[2])
      initialized.current = routeVersion
    }

    const car = scene.getObjectByName('player-car')
    if (!car) return

    const carPos = new THREE.Vector3()
    car.getWorldPosition(carPos)

    // Derive facing from world quaternion
    const q = new THREE.Quaternion()
    car.getWorldQuaternion(q)
    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(q) // behind car (+Z local)
    back.y = 0
    back.normalize()

    const desired = carPos
      .clone()
      .add(back.multiplyScalar(12))
      .add(new THREE.Vector3(0, 7, 0))

    camera.position.lerp(desired, 0.08)
    const look = carPos.clone().add(new THREE.Vector3(0, 1.2, 0))
    camera.lookAt(look)
  })

  return null
}
