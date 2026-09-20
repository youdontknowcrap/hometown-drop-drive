import { Suspense, useMemo, type MutableRefObject } from 'react'
import { Canvas } from '@react-three/fiber'
import { Sky, PerspectiveCamera } from '@react-three/drei'
import { Physics } from '@react-three/rapier'
import { Ground } from './Ground'
import { Car } from './Car'
import { Road } from './Road'
import { RouteLine } from './RouteLine'
import { FollowCam } from './FollowCam'
import type { DriveKeys } from '../hooks/useKeyboard'
import { polylineToLocal, type LatLng } from '../lib/geo'
import { pathBounds } from '../lib/roadMesh'

type SceneProps = {
  keys: MutableRefObject<DriveKeys>
  origin: LatLng
  polyline: LatLng[]
  guidanceOn: boolean
  /** Bumps when a new route is loaded so the car respawns at the start. */
  routeVersion: number
}

/**
 * 3D play space. Streets are a metric asphalt ribbon from the OSM/OSRM
 * centerline. The car is free — not locked to the road.
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

  const bounds = useMemo(() => pathBounds(localPath), [localPath])

  const spawn: [number, number, number] = useMemo(() => {
    if (localPath.length > 0) {
      return [localPath[0][0], 0.6, localPath[0][2]]
    }
    return [0, 0.6, 0]
  }, [localPath])

  const spawnYaw = useMemo(() => {
    if (localPath.length < 2) return 0
    const a = localPath[0]
    const b = localPath[1]
    const dx = b[0] - a[0]
    const dz = b[2] - a[2]
    return Math.atan2(dx, -dz)
  }, [localPath])

  return (
    <Canvas shadows dpr={[1, 1.75]} gl={{ antialias: true }}>
      <color attach="background" args={['#87ceeb']} />
      <fog attach="fog" args={['#cfe8f5', 180, 520]} />

      <PerspectiveCamera makeDefault position={[0, 12, 18]} fov={55} />
      <ambientLight intensity={0.55} />
      <directionalLight
        castShadow
        position={[40, 60, 20]}
        intensity={1.25}
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-far={400}
        shadow-camera-left={-120}
        shadow-camera-right={120}
        shadow-camera-top={120}
        shadow-camera-bottom={-120}
      />
      <Sky sunPosition={[40, 60, 20]} turbidity={4} rayleigh={1.2} />

      <Suspense fallback={null}>
        <Physics gravity={[0, -9.81, 0]} interpolate>
          <Ground
            size={bounds.size}
            centerX={bounds.centerX}
            centerZ={bounds.centerZ}
          />
          <Car
            keys={keys}
            path={localPath}
            guidanceOn={guidanceOn}
            spawn={spawn}
            spawnYaw={spawnYaw}
            spawnKey={routeVersion}
          />
        </Physics>
        <Road points={localPath} />
      </Suspense>

      <RouteLine points={localPath} visible={guidanceOn} />
      <FollowCam targetSpawn={spawn} routeVersion={routeVersion} />
    </Canvas>
  )
}
