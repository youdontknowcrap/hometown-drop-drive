import { Suspense, useEffect, useMemo, useState, type MutableRefObject } from 'react'
import { Canvas } from '@react-three/fiber'
import { Sky, PerspectiveCamera } from '@react-three/drei'
import { Physics } from '@react-three/rapier'
import { Ground } from './Ground'
import { FarGround } from './FarGround'
import { Car } from './Car'
import { Road } from './Road'
import { RoadContainment } from './RoadContainment'
import { RouteLine } from './RouteLine'
import { FollowCam } from './FollowCam'
import { Buildings } from './Buildings'
import { Rain } from './Rain'
import { releaseDriveFocus, type DriveKeys } from '../hooks/useKeyboard'
import { polylineToLocal, type LatLng } from '../lib/geo'
import { nearestOnNetwork, networkBounds } from '../lib/roadMesh'
import type { StreetWay } from '../lib/osmStreets'
import type { BuildingBox } from '../lib/osmBuildings'
import {
  flatHeightGrid,
  sampleHeight,
  waysBounds,
  type HeightGrid,
} from '../lib/terrarium'
import { fetchElevationGrid, fetchFarElevationGrid } from '../lib/elevation'
import { sunAt, sunLightPosition } from '../lib/sun'
import type { WeatherLook } from '../lib/weather'

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
  /** Optional HUD hook so Joey can see Terrarium / Open-Meteo / flat. */
  onTerrainMessage?: (msg: string) => void
  /** Far LOD skyline status line for the HUD. */
  onFarTerrainMessage?: (msg: string) => void
  /** OSM building AABB boxes (may be empty). */
  buildings?: BuildingBox[]
  /** Resolved weather look (Auto or manual preset). */
  weather: WeatherLook
  /** Body paint hex for Kenney sports sedan. */
  paintHex?: string
}

/**
 * Neighborhood street grid. Soft leave-the-asphalt play, then a hard
 * ~200 ft corridor wall (RoadContainment) — not curb-hugging Autopia rails.
 * Blue RouteLine is GPS only (set/clear destination in the HUD).
 *
 * Terrain: Terrarium first, Open-Meteo elev fallback, quiet flat last.
 * Far LOD ring (~12 km, visual only) for distant mountain silhouette.
 * Sky/sun track Drop lat/lng + local clock; weather drives fog/rain/light.
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
  onFarTerrainMessage,
  buildings = [],
  weather,
  paintHex,
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

  // Start flat so the first frame is playable; swap in hills when ready.
  const [heightGrid, setHeightGrid] = useState<HeightGrid>(() =>
    flatHeightGrid(bounds.centerX, bounds.centerZ, bounds.size, 'Loading elevation…'),
  )
  /** Coarse skyline mesh (~12 km); null until far fetch lands (or permanently if both paths fail). */
  const [farHeightGrid, setFarHeightGrid] = useState<HeightGrid | null>(null)

  // Recompute sun every minute (and when Drop origin changes).
  const [nowTick, setNowTick] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  const sun = useMemo(() => sunAt(origin, new Date(nowTick)), [origin, nowTick])
  const sunPos = useMemo(
    () => sunLightPosition(sun.direction, 200),
    [sun.direction],
  )

  // Daylight × weather sun scale — dusk dims even on a Clear preset.
  const sunIntensity = weather.sunScale * (0.25 + 0.75 * sun.daylight)
  const ambientIntensity = weather.ambientScale * (0.35 + 0.65 * sun.daylight)

  useEffect(() => {
    let cancelled = false
    const bb = waysBounds(localWays)
    onTerrainMessage?.('Loading elevation (Terrarium → Open-Meteo)…')
    onFarTerrainMessage?.('Far terrain: loading…')
    setFarHeightGrid(null)

    void fetchElevationGrid({
      origin,
      minX: bb.minX,
      maxX: bb.maxX,
      minZ: bb.minZ,
      maxZ: bb.maxZ,
      spawnX: spawn[0],
      spawnZ: spawn[2],
    }).then(async (grid) => {
      if (cancelled) return
      setHeightGrid(grid)
      onTerrainMessage?.(grid.message)

      // Far skyline only when near elev actually worked (flat = nowhere to hang mountains).
      if (grid.source === 'flat') {
        onFarTerrainMessage?.('Far terrain: skipped (near elev flat)')
        return
      }

      const far = await fetchFarElevationGrid({
        origin,
        spawnX: spawn[0],
        spawnZ: spawn[2],
        spawnElevMsl: grid.spawnElevMsl,
      })
      if (cancelled) return
      if (far) {
        setFarHeightGrid(far)
        onFarTerrainMessage?.(far.message)
      } else {
        onFarTerrainMessage?.('Far terrain: unavailable')
      }
    })

    return () => {
      cancelled = true
    }
  }, [origin, localWays, bounds, spawn, onTerrainMessage, onFarTerrainMessage, routeVersion])

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
      <color attach="background" args={[weather.skyBackground]} />
      <fog
        attach="fog"
        args={[weather.fogColor, weather.fogNear, weather.fogFar]}
      />

      {/*
        far must clear the ~12 km skyline ring. Default three.js far=2000 would
        clip El Paso / Sierra silhouette even when fog lets them through.
      */}
      <PerspectiveCamera makeDefault position={[0, 12, 22]} fov={55} near={0.4} far={28000} />
      <ambientLight intensity={ambientIntensity} />
      <directionalLight
        castShadow
        position={sunPos}
        intensity={sunIntensity}
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-far={500}
        shadow-camera-left={-160}
        shadow-camera-right={160}
        shadow-camera-top={160}
        shadow-camera-bottom={-160}
      />
      {/*
        Sky sunPosition follows the same vector as the directional light.
        turbidity / rayleigh come from weather (clear → storm).
      */}
      <Sky
        sunPosition={sunPos}
        turbidity={weather.turbidity}
        rayleigh={weather.rayleigh}
      />

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
            paintHex={paintHex}
          />
          <RoadContainment
            ways={localWays}
            version={routeVersion}
            reliefM={Math.max(0, heightGrid.maxRel - heightGrid.minRel)}
          />
          <Buildings
            boxes={buildings}
            heightGrid={heightGrid}
            version={routeVersion}
          />
        </Physics>
        {/* Far skyline: visual only — outside Physics, no car colliders. */}
        {farHeightGrid ? (
          <FarGround nearGrid={heightGrid} farGrid={farHeightGrid} />
        ) : null}
        <Road streets={localStreets} heightGrid={heightGrid} />
        <RouteLine points={drapedRoute} visible={showRoute} />
        <Rain density={weather.rain ? weather.rainDensity : 0} />
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
