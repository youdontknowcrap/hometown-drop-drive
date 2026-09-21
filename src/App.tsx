import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Scene } from './components/Scene'
import { Hud, type GpsStatus } from './components/Hud'
import { GpsDash } from './components/GpsDash'
import { Speedo } from './components/Speedo'
import { releaseDriveFocus, useKeyboard } from './hooks/useKeyboard'
import { localToLatLng, polylineToLocal, type LatLng } from './lib/geo'
import { carPose } from './lib/carPose'
import { distanceToPath } from './lib/guidance'
import { getDemoWorld, type StreetWorld } from './lib/osmStreets'
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

const DEFAULT_DROP = '235 N China Lake Blvd, Ridgecrest, CA'
const DEFAULT_DEST = 'Eastern Sierra Blvd, Ridgecrest, CA'

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
  const [dropAddress, setDropAddress] = useState(DEFAULT_DROP)
  const [destAddress, setDestAddress] = useState(DEFAULT_DEST)
  const [guidanceOn, setGuidanceOn] = useState(true)
  const [world, setWorld] = useState<StreetWorld>(() => getDemoWorld())
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
  const stream = useStreetStreaming(dropAddress, dropNonce)

  // Mirror streamer world into the existing `world` state so Hud / Scene keep
  // working; ways always come from active tiles only.
  // JOEY LOCK: streamVersion must NOT remount Car / FollowCam / Scene — only
  // dropNonce does (via routeVersion below). Streaming = additive mesh/data.
  useEffect(() => {
    if (!stream.streaming && stream.busy) return
    setWorld(stream.world)
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
    setDropNonce((n) => n + 1)
    // Playtest #17: leave the address field so WASD drives immediately.
    releaseDriveFocus()
  }, [])

  useEffect(() => {
    if (booted.current) return
    booted.current = true
    // Nonce 0 already started the stream via the hook; just clear focus.
    releaseDriveFocus()
  }, [])

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
      worker: tileLoaderUsesWorker(),
      relief: `${VERTICAL_EXAGGERATION}× fidelity`,
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
    offCourseSinceRef.current = null
    reroutingRef.current = false
  }, [])

  const localWays = useMemo(
    // HARD GPS RULE: only active (Scene-mounted) ways — never prefetch cache.
    () => stream.activeWays.map((w) => polylineToLocal(w.points, world.origin)),
    [stream.activeWays, world.origin],
  )

  const routeLocal = useMemo(() => {
    if (!nav) return [] as Array<[number, number, number]>
    return polylineToLocal(nav.polyline, world.origin)
  }, [nav, world.origin])

  useEffect(() => {
    navLocalRef.current = routeLocal
  }, [routeLocal])

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
        tilesMessage={`Tiles: ${stream.activeTileCount} loaded · streaming`}
        streamMessage={stream.streamMessage}
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
      <GpsDash origin={world.origin} ways={localWays} route={routeLocal} />
    </div>
  )
}
