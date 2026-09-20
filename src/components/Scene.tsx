import { Suspense, useMemo, type MutableRefObject } from 'react'
import { Canvas } from '@react-three/fiber'
import { Sky, PerspectiveCamera } from '@react-three/drei'
import { Physics } from '@react-three/rapier'
import { Ground } from './Ground'
import { Car } from './Car'
import { RouteLine } from './RouteLine'
import { FollowCam } from './FollowCam'
import type { DriveKeys } from '../hooks/useKeyboard'
import { polylineToLocal, type LatLng } from '../lib/geo'

type SceneProps = {
  keys: MutableRefObject<DriveKeys>
  origin: LatLng
  polyline: LatLng[]
  guidanceOn: boolean
  /** Bumps when a new route is loaded so the car respawns at the start. */
  routeVersion: number
}

/**
 * Full 3D play space: sky, light, ground, blue route, driveable car.
 * Route lat/lng are projected into local meters around the origin.
 */
export function Scene({
  keys,
  origin,
  polyline,
  guidanceOn,
  routeVersion,
}: SceneProps) {
  const localPath = useMemo(
    () => polylineToLocal(polyline, origin),
    [polyline, origin],
  )

  const spawn: [number, number, number] = useMemo(() => {
    if (localPath.length > 0) {
      return [localPath[0][0], 0.6, localPath[0][2]]
    }
    return [0, 0.6, 0]
  }, [localPath])

  // Initial yaw: face toward the second path point when available.
  const spawnYaw = useMemo(() => {
    if (localPath.length < 2) return 0
    const a = localPath[0]
    const b = localPath[1]
    const dx = b[0] - a[0]
    const dz = b[2] - a[2]
    // Car forward is -Z.
    return Math.atan2(dx, -dz)
  }, [localPath])

  return (
    <Canvas shadows dpr={[1, 1.75]} gl={{ antialias: true }}>
      <color attach="background" args={['#87ceeb']} />
      <fog attach="fog" args={['#cfe8f5', 120, 420]} />

      <PerspectiveCamera makeDefault position={[0, 12, 18]} fov={55} />
      <ambientLight intensity={0.55} />
      <directionalLight
        castShadow
        position={[40, 60, 20]}
        intensity={1.25}
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-far={200}
        shadow-camera-left={-60}
        shadow-camera-right={60}
        shadow-camera-top={60}
        shadow-camera-bottom={-60}
      />
      <Sky sunPosition={[40, 60, 20]} turbidity={4} rayleigh={1.2} />

      <Suspense fallback={null}>
        <Physics gravity={[0, -9.81, 0]} interpolate>
          <Ground />
          <Car
            keys={keys}
            path={localPath}
            guidanceOn={guidanceOn}
            spawn={spawn}
            spawnYaw={spawnYaw}
            spawnKey={routeVersion}
          />
        </Physics>
      </Suspense>

      <RouteLine points={localPath} visible={guidanceOn} />
      <FollowCam targetSpawn={spawn} routeVersion={routeVersion} />
    </Canvas>
  )
}
