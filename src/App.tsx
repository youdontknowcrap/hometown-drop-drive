import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Scene } from './components/Scene'
import { Hud, type GpsStatus } from './components/Hud'
import { GpsDash } from './components/GpsDash'
import { Speedo } from './components/Speedo'
import { releaseDriveFocus, useKeyboard } from './hooks/useKeyboard'
import { localToLatLng, polylineToLocal, type LatLng } from './lib/geo'
import { carPose } from './lib/carPose'
import { distanceToPath } from './lib/guidance'
import { type StreetWorld } from './lib/osmStreets'
import { useStreetStreaming } from './hooks/useStreetStreaming'
import { routeBetween, routeToAddress, type NavRoute } from './lib/routing'
import { VERTICAL_EXAGGERATION } from './lib/terrarium'
import { tileLoaderUsesWorker } from './lib/tileLoaderClient'
import {
  fetchLocalWeather,
  resolveWeatherLook,
  type WeatherLook,
  type WeatherPreset,
} from './lib/weather'
import { DEFAULT_PAINT } from './components/Car'
import { autopilotControl } from './lib/autopilot'
import { loadedWaysFingerprint } from './lib/streetGraph'
import { createRouteAlignScheduler } from './lib/routeAlignScheduler'
import { IntroScreen } from './components/intro/IntroScreen'

/**
 * LEARNING (Joey intro): no hardcoded Ridgecrest Drop on boot.
 * Dest field starts empty too — GPS is opt-in after you land.
 * Demo world (`getDemoWorld`) remains a streamer *fallback* only when
 * Nominatim/Overpass fail mid-Drop — never the cold-load spawn.
 */
const IDLE_WORLD: StreetWorld = {
  origin: { lat: 0, lng: 0 },
  ways: [],
  source: 'demo',
  message: 'Enter an address to Drop.',
  dropLabel: '',
  streetMeters: 0,
  wayCount: 0,
}

/** How far off the blue line before we start the reroute timer (meters). */
const OFF_COURSE_M = 42
/** Must stay off-course this long before calling OSRM (kids swerve a lot). */
const OFF_COURSE_HOLD_MS = 1600
/** Minimum gap between successful reroutes so we don't spam the public API. */
const REROUTE_COOLDOWN_MS = 4500
/** Poll car vs path this often while a destination is active. */
const OFF_COURSE_POLL_MS = 250

export default function App() {
  const keys = useKeyboard()
  /**
   * First-run phase: 'intro' = blue marble + address; 'driving' = Scene + HUD.
   * Cold load must stay on intro until Joey submits a place (no surprise Drop).
   */
  const [phase, setPhase] = useState<'intro' | 'driving'>('intro')
  const [dropAddress, setDropAddress] = useState('')
  const [destAddress, setDestAddress] = useState('')
  const [guidanceOn, setGuidanceOn] = useState(true)
  const [world, setWorld] = useState<StreetWorld>(() => IDLE_WORLD)
  /** Bumped on every Drop so the streamer restarts cleanly. */
  const [dropNonce, setDropNonce] = useState(0)
  // Slightly longer chase default — more ground rush without faking mph.
  const [camDistance, setCamDistance] = useState(20)
  const [camHeight, setCamHeight] = useState(8)

  const [nav, setNav] = useState<NavRoute | null>(null)
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>('idle')
  const [gpsMessage, setGpsMessage] = useState('')
  const [gpsBusy, setGpsBusy] = useState(false)
  const [terrainMessage, setTerrainMessage] = useState('Elevation: …')
  const [farTerrainMessage, setFarTerrainMessage] = useState('Far terrain: …')
  // Buildings stream with street tiles (see useStreetStreaming) — no one-shot Drop fetch.
  const [weatherPreset, setWeatherPreset] = useState<WeatherPreset>('auto')
  const [liveWeather, setLiveWeather] = useState<WeatherLook | null>(null)
  const [paintHex, setPaintHex] = useState(DEFAULT_PAINT)
  /**
   * Buildings ON/OFF (Joey A/B). Default ON; persist so refresh keeps the choice.
   * OFF → streamer skips building Overpass + Scene gets empty boxes.
   */
  const [buildingsOn, setBuildingsOn] = useState(() => {
    try {
      const v = localStorage.getItem('hdd-buildings-on')
      if (v == null) return true
      return v === '1' || v === 'true'
    } catch {
      return true
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('hdd-buildings-on', buildingsOn ? '1' : '0')
    } catch {
      /* private mode */
    }
  }, [buildingsOn])

  /**
   * GPS dial live-street paint (Joey). Default ON = stream load cue on the
   * dial. OFF hides activeWays strokes so majors/route/overlays stay readable.
   * 3D world streets are untouched — dial-only.
   */
  const [gpsLiveStreetsOn, setGpsLiveStreetsOn] = useState(() => {
    try {
      const v = localStorage.getItem('hdd-gps-live-streets')
      if (v == null) return true
      return v === '1' || v === 'true'
    } catch {
      return true
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('hdd-gps-live-streets', gpsLiveStreetsOn ? '1' : '0')
    } catch {
      /* private mode */
    }
  }, [gpsLiveStreetsOn])

  const booted = useRef(false)
  /** Destination lat/lng kept for reroutes even while polyline updates. */
  const destRef = useRef<LatLng | null>(null)
  const destLabelRef = useRef('')
  const navLocalRef = useRef<Array<[number, number, number]>>([])
  const originRef = useRef(world.origin)
  const reroutingRef = useRef(false)
  const offCourseSinceRef = useRef<number | null>(null)
  const lastRerouteAtRef = useRef(0)

  useEffect(() => {
    originRef.current = world.origin
  }, [world.origin])

  const weather = useMemo(
    () => resolveWeatherLook(weatherPreset, liveWeather),
    [weatherPreset, liveWeather],
  )


  // Open-world street streaming (#11). activeWays is the ONLY list Scene +
  // GpsDash may draw (hard GPS rule — no prefetch ghosts on the dial).
  // Stream only after intro → driving (enabled gate). HUD Drop still bumps nonce.
  const stream = useStreetStreaming(
    dropAddress,
    dropNonce,
    buildingsOn,
    phase === 'driving',
  )

  // Mirror streamer world into the existing `world` state so Hud / Scene keep
  // working; ways always come from active tiles only.
  // JOEY LOCK: streamVersion must NOT remount Car / FollowCam / Scene — only
  // dropNonce does (via routeVersion below). Streaming = additive mesh/data.
  // Origin object identity churned every emit — only commit when lat/lng/label
  // actually change so Scene elev reset + GpsDash overlay deps stay quiet.
  useEffect(() => {
    if (!stream.streaming && stream.busy) return
    setWorld((prev) => {
      const next = stream.world
      if (
        prev.origin.lat === next.origin.lat &&
        prev.origin.lng === next.origin.lng &&
        prev.dropLabel === next.dropLabel &&
        prev.message === next.message &&
        prev.source === next.source &&
        prev.wayCount === next.wayCount
      ) {
        return prev
      }
      return next
    })
  }, [stream.world, stream.streamVersion, stream.streaming, stream.busy])

  const onDrop = useCallback(async () => {
    // Clear GPS against the old origin; streamer restarts via dropNonce.
    setNav(null)
    destRef.current = null
    destLabelRef.current = ''
    navLocalRef.current = []
    setGpsStatus('idle')
    setGpsMessage('')
    setLiveWeather(null)
    autopilotControl.forceOff = true
    setDropNonce((n) => n + 1)
    // Playtest #17: leave the address field so WASD drives immediately.
    releaseDriveFocus()
  }, [])

  /**
   * Intro → driving: address already geocoded on the marble; reuse Drop path
   * by setting dropAddress + enabling the streamer (phase flip).
   * Streamer will geocode again inside startStreetStream — same Nominatim
   * source of truth as HUD Drop (cheap; keeps one code path).
   */
  const onIntroEnter = useCallback((address: string) => {
    setDropAddress(address)
    setNav(null)
    destRef.current = null
    destLabelRef.current = ''
    navLocalRef.current = []
    setGpsStatus('idle')
    setGpsMessage('')
    setLiveWeather(null)
    autopilotControl.forceOff = true
    setDropNonce((n) => n + 1)
    setPhase('driving')
    releaseDriveFocus()
  }, [])

  useEffect(() => {
    if (phase !== 'driving') return
    if (booted.current) return
    booted.current = true
    releaseDriveFocus()
  }, [phase])

  // Refresh live weather every ~10 min while on Auto (cheap Open-Meteo call).
  useEffect(() => {
    if (weatherPreset !== 'auto') return
    const id = window.setInterval(() => {
      void fetchLocalWeather(originRef.current).then(setLiveWeather)
    }, 10 * 60_000)
    return () => window.clearInterval(id)
  }, [weatherPreset, world.origin])

  // Weather follows Drop origin; buildings stream with tiles (worker Overpass).
  useEffect(() => {
    if (!stream.streaming) return
    const origin = stream.world.origin
    if (!origin.lat && !origin.lng) return
    void fetchLocalWeather(origin).then(setLiveWeather)
    console.info('[stream]', stream.tileMath, {
      elevWorker: tileLoaderUsesWorker(), // Terrarium decode only; Overpass = main
      relief: `${VERTICAL_EXAGGERATION}× fidelity`,
      drop: 'center-tile first → neighbors serial',
    })
  }, [stream.world.origin.lat, stream.world.origin.lng, stream.streaming])


  const applyNav = useCallback((next: NavRoute, status: GpsStatus) => {
    setNav(next)
    destRef.current = next.destination
    destLabelRef.current = next.destLabel
    setGpsStatus(status)
    setGpsMessage(next.message)
  }, [])

  const carLatLng = useCallback((): LatLng => {
    const origin = originRef.current
    if (carPose.ready) {
      return localToLatLng(carPose.x, carPose.z, origin)
    }
    return origin
  }, [])

  const onSetDestination = useCallback(async () => {
    const q = destAddress.trim()
    if (!q) {
      setGpsStatus('error')
      setGpsMessage('Type a destination address first.')
      return
    }
    setGpsBusy(true)
    setGpsStatus('routing')
    setGpsMessage('Finding a path…')
    try {
      const next = await routeToAddress(carLatLng(), q)
      applyNav(next, 'ready')
      setGuidanceOn(true)
      lastRerouteAtRef.current = performance.now()
      offCourseSinceRef.current = null
    } catch (err) {
      const why = err instanceof Error ? err.message : 'unknown error'
      setGpsStatus('error')
      setGpsMessage(why)
    } finally {
      setGpsBusy(false)
    }
  }, [destAddress, carLatLng, applyNav])

  const onClearDestination = useCallback(() => {
    setNav(null)
    destRef.current = null
    destLabelRef.current = ''
    navLocalRef.current = []
    setGpsStatus('cleared')
    setGpsMessage('Destination cleared — free drive.')
    setGuidanceOn(false)
    // Drop AP with the blue line — Car reads forceOff next frame.
    autopilotControl.forceOff = true
    offCourseSinceRef.current = null
    reroutingRef.current = false
  }, [])

  /**
   * Scene / GPS dial ways — HARD GPS RULE: active (mounted) only.
   * Keep highway/name so the dial can filter by zoom + label turns.
   */
  const localWays = useMemo(
    () =>
      stream.activeWays.map((w) => ({
        points: polylineToLocal(w.points, world.origin),
        highway: w.highway,
        name: w.name ?? w.ref,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- origin lat/lng
    [stream.activeWays, world.origin.lat, world.origin.lng],
  )

  /**
   * Align graph ways — active + cached (fetched) tiles.
   * LEARNING: thin active ring alone made near-car snap jump gaps with
   * crow-flight chords. Cached corridor ways feed Dijkstra without painting
   * prefetch ghosts on the GPS dial (still activeWays only there).
   */
  const alignLocalWays = useMemo(
    () =>
      stream.alignWays.map((w) => ({
        points: polylineToLocal(w.points, world.origin),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- origin lat/lng
    [stream.alignWays, world.origin.lat, world.origin.lng],
  )

  /** Raw OSRM / straight polyline in world XZ (destination spine before near snap). */
  const routeLocalRaw = useMemo(() => {
    if (!nav) return [] as Array<[number, number, number]>
    return polylineToLocal(nav.polyline, world.origin)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- origin lat/lng
  }, [nav, world.origin.lat, world.origin.lng])

  /**
   * Driven path = **full OSRM spine** + near-car street splice.
   *
   * LEARNING (Joey long-haul): Ridgecrest → Missouri must keep the OSRM
   * highway course on the blue GPS line. Replacing the entire polyline with
   * a local-tile graph path destroyed cross-country routing. Hang-budget
   * early-bail then published crow-flight tails → AP aimed diagonal.
   *
   * Correct publish rules:
   *   1) New dest → paint full OSRM immediately (long-haul GPS).
   *   2) Idle near-car splice onto active+cached ways (asphalt under tires).
   *   3) Far ahead stays untouched OSRM — never align-only graph path.
   *   4) Never publish straight-fallback geodesic to AP when ways exist.
   *   5) Budget timeout keeps last good OSRM/spliced spine (no mid-drive wipe).
   * Does NOT remount Car (path prop only; remount guards from hang fix stay).
   */
  const waysFingerprint = useMemo(
    () => loadedWaysFingerprint(alignLocalWays),
    [alignLocalWays],
  )

  const [routeLocal, setRouteLocal] = useState<
    Array<[number, number, number]>
  >([])
  const alignSchedulerRef = useRef<ReturnType<
    typeof createRouteAlignScheduler
  > | null>(null)
  const alignWaysRef = useRef(alignLocalWays)
  alignWaysRef.current = alignLocalWays

  useEffect(() => {
    const sched = createRouteAlignScheduler({
      coalesceMs: 140,
      timeBudgetMs: 6,
    })
    alignSchedulerRef.current = sched
    return () => {
      sched.dispose()
      alignSchedulerRef.current = null
    }
  }, [])

  const navKey = useMemo(() => {
    if (!nav) return 'none'
    return `${nav.destination.lat.toFixed(5)},${nav.destination.lng.toFixed(5)},${nav.polyline.length},${nav.source}`
  }, [nav])
  const prevNavKeyRef = useRef(navKey)

  useEffect(() => {
    if (routeLocalRaw.length < 2) {
      setRouteLocal([])
      navLocalRef.current = []
      prevNavKeyRef.current = navKey
      return
    }
    const fp = `${navKey}|${waysFingerprint}`
    const navChanged = prevNavKeyRef.current !== navKey
    prevNavKeyRef.current = navKey
    const osrm = nav?.source === 'osrm'
    const waysNear = alignWaysRef.current.length > 0
    alignSchedulerRef.current?.schedule({
      rawPath: routeLocalRaw,
      ways: alignWaysRef.current,
      fingerprint: fp,
      carX: carPose.ready ? carPose.x : routeLocalRaw[0][0],
      carZ: carPose.ready ? carPose.z : routeLocalRaw[0][2],
      rawIsStreetFollowing: osrm,
      // New destination: paint full OSRM spine immediately (long-haul GPS).
      // Straight fallback: do NOT paint geodesic when ways exist — wait for
      // centerline chase / keep prior path (never crow-flight to AP).
      onRaw:
        navChanged && (osrm || !waysNear)
          ? (raw) => {
              setRouteLocal(raw)
              navLocalRef.current = raw
            }
          : undefined,
      onAligned: (aligned, meta) => {
        // LEARNING — never publish a non-publishable splice (off-road chord /
        // soft-fail thin cache). Scheduler already prefers lastGood; this gate
        // is belt-and-suspenders so blue/AP never jump to dirt mid-drive.
        if (!meta.publishable || aligned.length < 2) return
        // ONE published polyline: Scene blue RouteLine + GpsDash + AP/guidance
        // all read routeLocal. Near-car splice redraws the blue line too —
        // never AP-on-snapped / blue-on-raw split.
        setRouteLocal(aligned)
        navLocalRef.current = aligned
      },
    })
  }, [routeLocalRaw, waysFingerprint, navKey, nav?.source])

  // Debounced off-course → OSRM reroute from the car to the same destination.
  useEffect(() => {
    if (!nav) return

    const tick = () => {
      if (!destRef.current || reroutingRef.current) return
      if (!carPose.ready) return

      const path = navLocalRef.current
      if (path.length < 2) return

      const dist = distanceToPath(carPose.x, carPose.z, path)
      const now = performance.now()

      if (dist > OFF_COURSE_M) {
        if (offCourseSinceRef.current == null) {
          offCourseSinceRef.current = now
        }
        const held = now - offCourseSinceRef.current
        const cooled = now - lastRerouteAtRef.current >= REROUTE_COOLDOWN_MS
        if (held >= OFF_COURSE_HOLD_MS && cooled) {
          reroutingRef.current = true
          setGpsStatus('rerouting')
          setGpsMessage('Rerouting…')
          const from = localToLatLng(carPose.x, carPose.z, originRef.current)
          const dest = destRef.current
          const label = destLabelRef.current || 'destination'
          void routeBetween(from, dest, label)
            .then((next) => {
              applyNav(next, 'ready')
              lastRerouteAtRef.current = performance.now()
              offCourseSinceRef.current = null
            })
            .catch(() => {
              setGpsStatus('ready')
              setGpsMessage('Reroute failed — keeping the old path.')
            })
            .finally(() => {
              reroutingRef.current = false
            })
        }
      } else {
        offCourseSinceRef.current = null
      }
    }

    const id = window.setInterval(tick, OFF_COURSE_POLL_MS)
    return () => window.clearInterval(id)
  }, [nav, applyNav])

  const hasDestination = nav != null

  // Cold load: marble + address only. Scene/HUD mount after first Drop.
  if (phase === 'intro') {
    return (
      <div className="app">
        <IntroScreen onEnter={onIntroEnter} />
      </div>
    )
  }

  return (
    <div className="app">
      <div className="canvas-wrap">
        <Scene
          keys={keys}
          origin={world.origin}
          ways={stream.activeWays}
          activeTiles={stream.activeTiles}
          routePath={routeLocal}
          guidanceOn={guidanceOn && hasDestination}
          showRoute={hasDestination}
          routeVersion={dropNonce}
          hardContainment={false}
          loadedAabb={stream.loadedAabb}
          camDistance={camDistance}
          camHeight={camHeight}
          onTerrainMessage={setTerrainMessage}
          onFarTerrainMessage={setFarTerrainMessage}
          buildings={stream.activeBuildings}
          weather={weather}
          paintHex={paintHex}
        />
      </div>
      <Hud
        dropAddress={dropAddress}
        destAddress={destAddress}
        guidanceOn={guidanceOn && hasDestination}
        busy={stream.busy}
        gpsBusy={gpsBusy}
        gpsStatus={gpsStatus}
        gpsMessage={gpsMessage}
        hasDestination={hasDestination}
        world={world}
        terrainMessage={terrainMessage}
        farTerrainMessage={farTerrainMessage}
        buildingsMessage={stream.buildingsMessage}
        buildingsOn={buildingsOn}
        onBuildingsOn={setBuildingsOn}
        gpsLiveStreetsOn={gpsLiveStreetsOn}
        onGpsLiveStreetsOn={setGpsLiveStreetsOn}
        tilesMessage={`Tiles: ${stream.activeTileCount} loaded · streaming`}
        streamMessage={stream.streamMessage}
        queueMessage={
          stream.streaming
            ? `Fetch: ${
                stream.corridorBlend < 0.33
                  ? 'circle (crawl)'
                  : stream.corridorBlend > 0.66
                    ? 'corridor (highway)'
                    : `blend ${stream.corridorBlend.toFixed(2)}`
              } · next ${stream.nextQueueKey ?? '—'} · queue ${stream.queueDepth}`
            : undefined
        }
        weatherSummary={weather.summary}
        weatherPreset={weatherPreset}
        onWeatherPreset={setWeatherPreset}
        paintHex={paintHex}
        onPaintHex={setPaintHex}
        camDistance={camDistance}
        camHeight={camHeight}
        onDropChange={setDropAddress}
        onDestChange={setDestAddress}
        onGuidanceChange={setGuidanceOn}
        onCamDistance={setCamDistance}
        onCamHeight={setCamHeight}
        onDrop={onDrop}
        onSetDestination={onSetDestination}
        onClearDestination={onClearDestination}
      />
      <Speedo />
      <GpsDash
        origin={world.origin}
        ways={localWays}
        route={routeLocal}
        guidanceActive={hasDestination}
        liveStreetsOn={gpsLiveStreetsOn}
        onLiveStreetsOn={setGpsLiveStreetsOn}
        streamBusy={stream.busy}
      />
    </div>
  )
}
