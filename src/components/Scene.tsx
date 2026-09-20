import { Suspense, useMemo, type MutableRefObject } from 'react'
import { Canvas } from '@react-three/fiber'
import { Sky, PerspectiveCamera } from '@react-three/drei'
import { Physics } from '@react-three/rapier'
import { Ground } from './Ground'
import { Car } from './Car'
import { Road } from './Road'
import { RoadContainment } from './RoadContainment'
import { RouteLine } from './RouteLine'
import { FollowCam } from './FollowCam'
import { releaseDriveFocus, type DriveKeys } from '../hooks/useKeyboard'
import { polylineToLocal, type LatLng } from '../lib/geo'
import { nearestOnNetwork, networkBounds } from '../lib/roadMesh'
import type { StreetWay } from '../lib/osmStreets'

type SceneProps = {
  keys: MutableRefObject<DriveKeys>
  origin: LatLng
  ways: StreetWay[]
  /** Local XZ guidance polyline (empty = no destination). */
  routePath: Array<[number, number, number]>
  /** Soft follow — only when guidance ON and a destination exists. */
  guidanceOn: boolean
  /** Draw the blue GPS line whenever a destination is set. */
  showRoute: boolean
  routeVersion: number
  camDistance: number
  camHeight: number
}

/**
 * Neighborhood street grid. Soft leave-the-asphalt play, then a hard
 * ~200 ft corridor wall (RoadContainment) — not curb-hugging Autopia rails.
 * Blue RouteLine is GPS only (set/clear destination in the HUD).
 */
export function Scene({
  keys,
  origin,
  ways,
  routePath,
  guidanceOn,
  showRoute,
  routeVersion,
  camDistance,
  camHeight,
}: SceneProps) {
  const localStreets = useMemo(
    () =>
      ways.map((w) => ({
        points: polylineToLocal(w.points, origin),
        kind: w.kind,
        highway: w.highway,
      })),
    [ways, origin],
  )

  const localWays = useMemo(
    () => localStreets.map((s) => s.points),
    [localStreets],
  )

  const bounds = useMemo(() => networkBounds(localWays), [localWays])

  const { spawn, yaw } = useMemo(
    () => nearestOnNetwork(0, 0, localWays),
    [localWays],
  )

  return (
    <Canvas
      shadows
      dpr={[1, 1.75]}
      gl={{ antialias: true }}
      tabIndex={0}
      onPointerDown={() => {
        // Click world → leave HUD text fields so WASD drives (playtest #17).
        releaseDriveFocus()
      }}
      onCreated={({ gl }) => {
        gl.domElement.tabIndex = 0
        gl.domElement.style.outline = 'none'
      }}
    >
      <color attach="background" args={['#87ceeb']} />
      <fog attach="fog" args={['#cfe8f5', 220, 640]} />

      <PerspectiveCamera makeDefault position={[0, 12, 18]} fov={55} />
      <ambientLight intensity={0.55} />
      <directionalLight
        castShadow
        position={[40, 60, 20]}
        intensity={1.25}
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-far={500}
        shadow-camera-left={-160}
        shadow-camera-right={160}
        shadow-camera-top={160}
        shadow-camera-bottom={-160}
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
            path={routePath}
            guidanceOn={guidanceOn}
            spawn={spawn}
            spawnYaw={yaw}
            spawnKey={routeVersion}
          />
          <RoadContainment ways={localWays} version={routeVersion} />
        </Physics>
        <Road streets={localStreets} />
        <RouteLine points={routePath} visible={showRoute} />
      </Suspense>

      <FollowCam
        targetSpawn={spawn}
        routeVersion={routeVersion}
        distance={camDistance}
        height={camHeight}
      />
    </Canvas>
  )
}
