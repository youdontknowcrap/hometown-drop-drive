import { Suspense, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { Canvas } from '@react-three/fiber'
import { Sky, PerspectiveCamera, useTexture } from '@react-three/drei'
import { Physics } from '@react-three/rapier'
import { Ground } from './Ground'
import { FarGround } from './FarGround'
import { Car } from './Car'
import { RoadTiles } from './RoadTiles'
import { StreetLabels } from './StreetLabels'
import { RoadContainment } from './RoadContainment'
import { RouteLine } from './RouteLine'
import { FollowCam } from './FollowCam'
import { Buildings } from './Buildings'
import { Rain } from './Rain'
import { releaseDriveFocus, type DriveKeys } from '../hooks/useKeyboard'
import { polylineToLocal, type LatLng } from '../lib/geo'
import { nearestOnNetwork } from '../lib/roadMesh'
import type { StreetWay } from '../lib/osmStreets'
import { buildRoadSurfaceWays } from '../lib/roadSurface'
import {
  buildRoadTrenchWays,
  CAR_CLEARANCE_M,
} from '../lib/roadHeights'
import {
  clearRoadOverlappingSolidColliders,
  type BuildingBox,
} from '../lib/osmBuildings'
import {
  flatHeightGrid,
  sampleHeight,
  VERTICAL_EXAGGERATION,
  type HeightGrid,
} from '../lib/terrarium'
import { sunAt, sunLightPosition } from '../lib/sun'
import type { WeatherLook } from '../lib/weather'
import {
  PREFETCH_RING,
  TILE_M,
  type ActiveTileWays,
  type LoadedAabb,
} from '../lib/streetTiles'
import {
  tileLoaderUsesWorker,
  workerFetchElevFar,
  workerFetchElevNear,
} from '../lib/tileLoaderClient'
import { carPose } from '../lib/carPose'

// Preload textures outside Suspense that wraps Physics — first streamed Road /
// FarGround must NOT suspend Car RigidBody (Joey lock: remount ⇒ signedMph→0 +
// FollowCam intro snap when player-car blips).
useTexture.preload([
  '/textures/asphalt_01_diff_1k.jpg',
  '/textures/asphalt_01_nor_gl_1k.jpg',
  '/textures/aerial_grass_rock_diff_1k.jpg',
  '/textures/aerial_grass_rock_nor_gl_1k.jpg',
])


type SceneProps = {
  keys: MutableRefObject<DriveKeys>
  origin: LatLng
  ways: StreetWay[]
  /**
   * Per-tile ways for incremental Road meshes. When omitted, Scene falls
   * back to a single Road from `ways` (tests / demo). Prefer activeTiles
   * from the streamer so one tile arrival remeshes that tile only.
   */
  activeTiles?: ActiveTileWays[]
  /** Local XZ guidance polyline (empty = no destination). */
  routePath: Array<[number, number, number]>
  /** Soft follow — only when guidance ON and a destination exists. */
  guidanceOn: boolean
  /** Draw the blue GPS line whenever a destination is set. */
  showRoute: boolean
  /**
   * Drop-only remount key (App passes dropNonce). MUST NOT be streamVersion —
   * tile activate/unload is additive; Car RigidBody + FollowCam stay continuous.
   */
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
  /** When false (streaming), skip hard ~200 ft corridor walls. */
  hardContainment?: boolean
  /** Soft void edge — union of active tile AABBs (local meters). */
  loadedAabb?: LoadedAabb | null
}

/**
 * Neighborhood street grid. Soft leave-the-asphalt (bump + 50% speed via
 * roadSurface), then a hard ~200 ft corridor wall (RoadContainment) — not
 * curb-hugging Autopia rails.
 * Blue RouteLine is GPS only (set/clear destination in the HUD).
 *
 * Terrain: Terrarium first, Open-Meteo elev fallback, quiet flat last.
 * Far LOD ring (~12 km, visual only) for distant mountain silhouette.
 * Sky/sun track Drop lat/lng + local clock; weather drives fog/rain/light.
 * Floating street-name labels (StreetLabels) billboard near the car.
 */
export function Scene({
  keys,
  origin,
  ways,
  activeTiles,
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
  hardContainment = true,
  loadedAabb = null,
}: SceneProps) {
  const localStreets = useMemo(
    () =>
      ways.map((w) => ({
        points: polylineToLocal(w.points, origin),
        kind: w.kind,
        highway: w.highway,
        name: w.name,
        ref: w.ref,
      })),
    [ways, origin],
  )

  const localWays = useMemo(
    () => localStreets.map((s) => s.points),
    [localStreets],
  )

  /** Half-width ribbons for soft off-road (bump + 50% speed) — not the 200 ft wall. */
  const roadSurfaceWays = useMemo(
    () => buildRoadSurfaceWays(localStreets),
    [localStreets],
  )

  /**
   * Drop solid colliders that overlap asphalt. Buildings fetch is async and
   * does not see ways; once both exist, clear road-kissing AABBs so arcade
   * drive does not hit invisible flypaper on residential streets.
   */
  const driveableBuildings = useMemo(
    () => clearRoadOverlappingSolidColliders(buildings, roadSurfaceWays),
    [buildings, roadSurfaceWays],
  )

  /**
   * JOEY LOCK — spawn pose is Drop-sticky. Recomputing nearestOnNetwork whenever
   * streamed tiles change would move spawn props and (with a bad spawnKey) yank
   * the car / camera. We only resolve once per routeVersion when ways exist.
   */
  const spawnRef = useRef<{
    version: number
    spawn: [number, number, number]
    yaw: number
  } | null>(null)
  if (spawnRef.current?.version !== routeVersion) {
    spawnRef.current = null
  }
  if (spawnRef.current == null && localWays.length > 0) {
    const n = nearestOnNetwork(0, 0, localWays)
    spawnRef.current = {
      version: routeVersion,
      spawn: n.spawn,
      yaw: n.yaw,
    }
  }
  const spawn: [number, number, number] = spawnRef.current?.spawn ?? [
    0, 0, 0,
  ]
  const yaw = spawnRef.current?.yaw ?? 0

  // Start flat so the first frame is playable; swap in hills when ready.
  // Span matches the Drop elev box (prefetch footprint) — not streamed ways.
  const [heightGrid, setHeightGrid] = useState<HeightGrid>(() => {
    const span = TILE_M * (PREFETCH_RING + 1)
    return flatHeightGrid(0, 0, span * 2, 'Loading elevation…')
  })
  /** Coarse skyline mesh (~12 km); null until far fetch lands (or permanently if both paths fail). */
  const [farHeightGrid, setFarHeightGrid] = useState<HeightGrid | null>(null)

  /**
   * Widened corridors for Ground / FarGround trench dig — cellSize-aware so
   * coarse grass verts still fall under ribbons (see roadHeights).
   */
  const roadTrenchWays = useMemo(
    () => buildRoadTrenchWays(localStreets, heightGrid.cellSize),
    [localStreets, heightGrid.cellSize],
  )

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

  /**
   * Sliding near height grid + far skyline (worker elev decode).
   *
   * LEARNING — worker vs main:
   *   Terrarium PNG decode / Open-Meteo upsample run in the tile-loader worker
   *   (CPU-bound — worth offloading). Overpass ways stay on main. Main only
   *   setState’s the HeightGrid. Ground rebuilds verts via useMemo;
   *   Car / FollowCam keep spawnKey=routeVersion (Drop only) — elev swaps must
   *   NOT remount the RigidBody or camera (Joey lock).
   *
   * LEARNING — hitch fix (elev) + Fast Drop:
   *   Drop paints center-tile ways first; elev follows the center AABB, then
   *   expands as neighbors activate. Do NOT rebuild Ground on every tiny AABB
   *   edge twitch. Debounce + only refresh when the soft-edge AABB grows by
   *   ≥ ~½ tile vs the last fetched box (or first load). Far elev runs after
   *   near succeeds — deferred, not competing with first paint.
   *   lockedSpawnElevMsl keeps relative heights stable so the car Y pin does
   *   not “pop”. VERTICAL_EXAGGERATION = 1 (fidelity lock).
   */
  const spawnElevLockRef = useRef<number | null>(null)
  const elevGenRef = useRef(0)
  const lastFarAtRef = useRef<{ x: number; z: number } | null>(null)
  /** Last AABB we actually fetched elev for — significance gate. */
  const lastElevAabbRef = useRef<LoadedAabb | null>(null)

  // Drop reset — clear elev lock so the new origin re-zeros honestly.
  useEffect(() => {
    spawnElevLockRef.current = null
    lastFarAtRef.current = null
    lastElevAabbRef.current = null
    elevGenRef.current += 1
    const span = TILE_M * (PREFETCH_RING + 1)
    setHeightGrid(flatHeightGrid(0, 0, span * 2, 'Loading elevation…'))
    setFarHeightGrid(null)
    onTerrainMessage?.('Loading elevation (worker · Terrarium → Open-Meteo)…')
    onFarTerrainMessage?.('Far terrain: loading…')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Drop-only reset
  }, [routeVersion, origin.lat, origin.lng])

  // Near elev: debounce + significance gate so neighbor expands don’t swap
  // Ground every tile. First fetch is center AABB after Drop. Far elev after.
  useEffect(() => {
    let cancelled = false
    const span = TILE_M * (PREFETCH_RING + 1)
    const aabb: LoadedAabb = loadedAabb ?? {
      minX: -span,
      maxX: span,
      minZ: -span,
      maxZ: span,
    }

    const significant = (next: LoadedAabb, prev: LoadedAabb | null): boolean => {
      if (!prev) return true
      // Refresh when soft edge grows by ≥ half a tile on any side.
      const grow = TILE_M * 0.5
      return (
        next.minX <= prev.minX - grow ||
        next.maxX >= prev.maxX + grow ||
        next.minZ <= prev.minZ - grow ||
        next.maxZ >= prev.maxZ + grow
      )
    }

    if (!significant(aabb, lastElevAabbRef.current)) {
      return () => {
        cancelled = true
      }
    }

    const gen = ++elevGenRef.current
    // Quiet window — center Drop AABB first; neighbor expands coalesce later.
    const timer = window.setTimeout(() => {
      if (cancelled) return
      // Re-check after debounce: another expand may have landed.
      const latest: LoadedAabb = loadedAabb ?? aabb
      if (!significant(latest, lastElevAabbRef.current) && lastElevAabbRef.current) {
        return
      }
      lastElevAabbRef.current = { ...latest }
      onTerrainMessage?.(
        `Loading elevation (sliding · relief ${VERTICAL_EXAGGERATION}×)…`,
      )
      void workerFetchElevNear({
        origin,
        minX: latest.minX,
        maxX: latest.maxX,
        minZ: latest.minZ,
        maxZ: latest.maxZ,
        spawnX: spawn[0],
        spawnZ: spawn[2],
        lockedSpawnElevMsl: spawnElevLockRef.current ?? undefined,
      }).then(async (grid) => {
        if (cancelled || gen !== elevGenRef.current) return
        if (grid.source !== 'flat' && spawnElevLockRef.current == null) {
          spawnElevLockRef.current = grid.spawnElevMsl
        }
        // Additive data swap — no remount keys touched.
        setHeightGrid(grid)
        const lane = tileLoaderUsesWorker() ? 'worker' : 'main'
        onTerrainMessage?.(
          `${grid.message} · ${lane} · near grid follows tiles`,
        )

        if (grid.source === 'flat') {
          onFarTerrainMessage?.('Far terrain: skipped (near elev flat)')
          return
        }

        const cx = carPose.ready ? carPose.x : spawn[0]
        const cz = carPose.ready ? carPose.z : spawn[2]
        lastFarAtRef.current = { x: cx, z: cz }
        const far = await workerFetchElevFar({
          origin,
          spawnX: cx,
          spawnZ: cz,
          spawnElevMsl: spawnElevLockRef.current ?? grid.spawnElevMsl,
        })
        if (cancelled || gen !== elevGenRef.current) return
        if (far) {
          setFarHeightGrid(far)
          onFarTerrainMessage?.(far.message)
        } else {
          onFarTerrainMessage?.('Far terrain: unavailable')
        }
      })
    }, 450)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
    // spawn Drop-sticky; AABB edges drive the sliding window — not streamVersion.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    origin.lat,
    origin.lng,
    routeVersion,
    loadedAabb?.minX,
    loadedAabb?.maxX,
    loadedAabb?.minZ,
    loadedAabb?.maxZ,
    onTerrainMessage,
    onFarTerrainMessage,
  ])

  // Far elev recenters as the car drives so distant relief becomes near.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!carPose.ready) return
      const lock = spawnElevLockRef.current
      if (lock == null) return
      const last = lastFarAtRef.current
      const dx = last ? carPose.x - last.x : Infinity
      const dz = last ? carPose.z - last.z : Infinity
      // ~1.5 km travel before re-centering the ~12 km skyline ring.
      if (Math.hypot(dx, dz) < 1500) return
      const cx = carPose.x
      const cz = carPose.z
      lastFarAtRef.current = { x: cx, z: cz }
      const gen = elevGenRef.current
      void workerFetchElevFar({
        origin,
        spawnX: cx,
        spawnZ: cz,
        spawnElevMsl: lock,
      }).then((far) => {
        if (gen !== elevGenRef.current) return
        if (far) {
          setFarHeightGrid(far)
          onFarTerrainMessage?.(far.message + ' · follows car')
        }
      })
    }, 2500)
    return () => window.clearInterval(id)
  }, [origin.lat, origin.lng, routeVersion, onFarTerrainMessage])

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

  /**
   * Drop-sticky spawn pose for Car mount + FollowCam intro snap.
   * LEARNING — do NOT recompute Y from heightGrid on every elev apply.
   * Car RigidBody position prop is synced by rapier into setTranslation; a
   * live elev Y here teleports the body back to spawn XZ (feels like a bump
   * + FollowCam “intro wiggle” when player-car blips). Car pins Y each frame
   * from the live grid; routeVersion/spawnKey stay dropNonce only.
   */
  const spawnPoseRef = useRef<{
    version: number
    pose: [number, number, number]
  } | null>(null)
  if (spawnPoseRef.current?.version !== routeVersion) {
    spawnPoseRef.current = {
      version: routeVersion,
      pose: [
        spawn[0],
        sampleHeight(heightGrid, spawn[0], spawn[2]) + CAR_CLEARANCE_M,
        spawn[2],
      ],
    }
  } else {
    // Adopt network XZ/yaw once when ways resolve (still same Drop); never
    // chase elev Y after the pose was captured for this routeVersion.
    const prev = spawnPoseRef.current.pose
    if (
      (prev[0] !== spawn[0] || prev[2] !== spawn[2]) &&
      spawnRef.current != null
    ) {
      spawnPoseRef.current = {
        version: routeVersion,
        pose: [
          spawn[0],
          sampleHeight(heightGrid, spawn[0], spawn[2]) + CAR_CLEARANCE_M,
          spawn[2],
        ],
      }
    }
  }
  const spawnWithHeight = spawnPoseRef.current.pose

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

      {/*
        LEARNING — Suspense isolation (Joey remount lock):
          One outer Suspense around Physics + RoadTiles + StreetLabels meant the
          first asphalt useTexture OR Troika Text font load suspended the WHOLE
          boundary → Physics/Car unmounted → RigidBody remount at spawn,
          signedMph ref re-inits to 0, FollowCam loses player-car (intro wiggle).
          Nested boundaries: texture/font suspends never remount Car.
      */}
      <Physics gravity={[0, -9.81, 0]} interpolate>
        <Suspense fallback={null}>
          <Ground heightGrid={heightGrid} roadTrenchWays={roadTrenchWays} />
        </Suspense>
        {/* spawnKey = dropNonce only — tile stream must not remount RigidBody */}
        <Car
          keys={keys}
          path={drapedRoute}
          guidanceOn={guidanceOn}
          spawn={spawnWithHeight}
          spawnYaw={yaw}
          spawnKey={routeVersion}
          heightGrid={heightGrid}
          paintHex={paintHex}
          roadSurfaceWays={roadSurfaceWays}
          loadedAabb={hardContainment ? null : loadedAabb}
        />
        {hardContainment ? (
          <RoadContainment
            ways={localWays}
            version={routeVersion}
            reliefM={Math.max(0, heightGrid.maxRel - heightGrid.minRel)}
          />
        ) : null}
        <Buildings
          boxes={driveableBuildings}
          heightGrid={heightGrid}
          version={routeVersion}
        />
      </Physics>
      {/* Far skyline: visual only — outside Physics, own Suspense (grass tex). */}
      <Suspense fallback={null}>
        {farHeightGrid ? (
          <FarGround nearGrid={heightGrid} farGrid={farHeightGrid} roadTrenchWays={roadTrenchWays} />
        ) : null}
      </Suspense>
      {/* Per-tile asphalt — suspend here only, never Physics/Car. */}
      <Suspense fallback={null}>
        <RoadTiles
          origin={origin}
          tiles={
            activeTiles ?? [
              { key: 'all', tx: 0, tz: 0, ways },
            ]
          }
          heightGrid={heightGrid}
        />
      </Suspense>
      {/* Troika Text font loads — own boundary so new labels never remount Car. */}
      <Suspense fallback={null}>
        <StreetLabels streets={localStreets} heightGrid={heightGrid} />
      </Suspense>
      <RouteLine points={drapedRoute} visible={showRoute} />
      <Rain density={weather.rain ? weather.rainDensity : 0} />

      <FollowCam
        targetSpawn={spawnWithHeight}
        routeVersion={routeVersion}
        distance={camDistance}
        height={camHeight}
      />
    </Canvas>
  )
}
