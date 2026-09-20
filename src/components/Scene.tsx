import { Suspense, useEffect, useMemo, useState, type MutableRefObject } from 'react'
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
import {
  fetchHeightGrid,
  flatHeightGrid,
  sampleHeight,
  waysBounds,
  type HeightGrid,
} from '../lib/terrarium'

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
  /** Optional HUD hook so Joey can see Terrarium vs flat. */
  onTerrainMessage?: (msg: string) => void
}

/**
 * Neighborhood street grid. Soft leave-the-asphalt play, then a hard
 * ~200 ft corridor wall (RoadContainment) — not curb-hugging Autopia rails.
 * Blue RouteLine is GPS only (set/clear destination in the HUD).
 *
 * Terrain: Terrarium/SRTM tiles displace the ground under the street bbox;
 * car Y and road ribbons sample the same grid (relative to spawn elev).
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
  onTerrainMessage,
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

  // Start flat so the first frame is playable; swap in Terrarium when ready.
  const [heightGrid, setHeightGrid] = useState<HeightGrid>(() =>
    flatHeightGrid(bounds.centerX, bounds.centerZ, bounds.size, 'Loading elevation…'),
  )

  useEffect(() => {
    let cancelled = false
    const bb = waysBounds(localWays)
    // Tell the HUD we're fetching — don't setHeightGrid here (avoids a sync
    // render loop warning). The previous grid stays until tiles arrive.
    onTerrainMessage?.('Loading Terrarium/SRTM…')

    void fetchHeightGrid({
      origin,
      minX: bb.minX,
      maxX: bb.maxX,
      minZ: bb.minZ,
      maxZ: bb.maxZ,
      spawnX: spawn[0],
      spawnZ: spawn[2],
    }).then((grid) => {
      if (cancelled) return
      setHeightGrid(grid)
      onTerrainMessage?.(grid.message)
    })

    return () => {
      cancelled = true
    }
  }, [origin, localWays, bounds, spawn, onTerrainMessage, routeVersion])

  // Drape the blue GPS line onto the same height samples as the asphalt.
  const drapedRoute = useMemo(
    () =>
      routePath.map(
        ([x, y, z]) =>
          [x, sampleHeight(heightGrid, x, z) + Math.max(0.2, y), z] as [
            number,
            number,
            number,
          ],
      ),
    [routePath, heightGrid],
  )

  const spawnWithHeight: [number, number, number] = [
    spawn[0],
    sampleHeight(heightGrid, spawn[0], spawn[2]) + 0.6,
    spawn[2],
  ]

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

      <PerspectiveCamera makeDefault position={[0, 12, 22]} fov={55} />
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
          <Ground heightGrid={heightGrid} />
          <Car
            keys={keys}
            path={drapedRoute}
            guidanceOn={guidanceOn}
            spawn={spawnWithHeight}
            spawnYaw={yaw}
            spawnKey={routeVersion}
            heightGrid={heightGrid}
          />
          <RoadContainment
            ways={localWays}
            version={routeVersion}
            reliefM={Math.max(0, heightGrid.maxRel - heightGrid.minRel)}
          />
        </Physics>
        <Road streets={localStreets} heightGrid={heightGrid} />
        <RouteLine points={drapedRoute} visible={showRoute} />
      </Suspense>

      <FollowCam
        targetSpawn={spawnWithHeight}
        routeVersion={routeVersion}
        distance={camDistance}
        height={camHeight}
      />
    </Canvas>
  )
}
