import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Scene } from './components/Scene'
import { Hud, type GpsStatus } from './components/Hud'
import { GpsDash } from './components/GpsDash'
import { Speedo } from './components/Speedo'
import { releaseDriveFocus, useKeyboard } from './hooks/useKeyboard'
import { localToLatLng, polylineToLocal, type LatLng } from './lib/geo'
import { carPose } from './lib/carPose'
import { distanceToPath } from './lib/guidance'
import { fetchStreetWorld, getDemoWorld, type StreetWorld } from './lib/osmStreets'
import { routeBetween, routeToAddress, type NavRoute } from './lib/routing'

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
  const [busy, setBusy] = useState(false)
  const [world, setWorld] = useState<StreetWorld>(() => getDemoWorld())
  const [worldVersion, setWorldVersion] = useState(0)
  const [camDistance, setCamDistance] = useState(14)
  const [camHeight, setCamHeight] = useState(7)

  const [nav, setNav] = useState<NavRoute | null>(null)
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>('idle')
  const [gpsMessage, setGpsMessage] = useState('')
  const [gpsBusy, setGpsBusy] = useState(false)

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

  const onDrop = useCallback(async () => {
    setBusy(true)
    try {
      const next = await fetchStreetWorld(dropAddress)
      setWorld(next)
      setWorldVersion((v) => v + 1)
      // Fresh neighborhood — clear any leftover GPS so we don't draw a
      // stale blue line against a new origin.
      setNav(null)
      destRef.current = null
      destLabelRef.current = ''
      navLocalRef.current = []
      setGpsStatus('idle')
      setGpsMessage('')
    } finally {
      setBusy(false)
      // Playtest #17: leave the address field so WASD drives immediately.
      releaseDriveFocus()
    }
  }, [dropAddress])

  useEffect(() => {
    if (booted.current) return
    booted.current = true
    void onDrop()
  }, [onDrop])

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
    () => world.ways.map((w) => polylineToLocal(w.points, world.origin)),
    [world],
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
          ways={world.ways}
          routePath={routeLocal}
          guidanceOn={guidanceOn && hasDestination}
          showRoute={hasDestination}
          routeVersion={worldVersion}
          camDistance={camDistance}
          camHeight={camHeight}
        />
      </div>
      <Hud
        dropAddress={dropAddress}
        destAddress={destAddress}
        guidanceOn={guidanceOn && hasDestination}
        busy={busy}
        gpsBusy={gpsBusy}
        gpsStatus={gpsStatus}
        gpsMessage={gpsMessage}
        hasDestination={hasDestination}
        world={world}
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
