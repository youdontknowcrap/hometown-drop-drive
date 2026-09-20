import { useCallback, useEffect, useRef, useState } from 'react'
import { Scene } from './components/Scene'
import { Hud } from './components/Hud'
import { useKeyboard } from './hooks/useKeyboard'
import { fetchRoute, getDemoRoute, type RouteResult } from './lib/routing'

/** First live street: church → railroad club, both real Ridgecrest addresses. */
const DEFAULT_START = '235 N China Lake Blvd, Ridgecrest, CA'
const DEFAULT_STOP = '520 S Richmond Rd, Ridgecrest, CA'

/**
 * Hometown Drop & Drive — streets in meters, free drive, OSM when the proxy works.
 */
export default function App() {
  const keys = useKeyboard()
  const [startAddress, setStartAddress] = useState(DEFAULT_START)
  const [stopAddress, setStopAddress] = useState(DEFAULT_STOP)
  const [guidanceOn, setGuidanceOn] = useState(true)
  const [busy, setBusy] = useState(false)
  const [route, setRoute] = useState<RouteResult>(() => getDemoRoute())
  const [routeVersion, setRouteVersion] = useState(0)
  const booted = useRef(false)

  const onGo = useCallback(async () => {
    setBusy(true)
    try {
      const next = await fetchRoute(startAddress, stopAddress)
      setRoute(next)
      setRouteVersion((v) => v + 1)
    } finally {
      setBusy(false)
    }
  }, [startAddress, stopAddress])

  useEffect(() => {
    if (booted.current) return
    booted.current = true
    void onGo()
  }, [onGo])

  return (
    <div className="app">
      <div className="canvas-wrap">
        <Scene
          keys={keys}
          origin={route.origin}
          polyline={route.polyline}
          guidanceOn={guidanceOn}
          routeVersion={routeVersion}
        />
      </div>
      <Hud
        startAddress={startAddress}
        stopAddress={stopAddress}
        guidanceOn={guidanceOn}
        busy={busy}
        route={route}
        onStartChange={setStartAddress}
        onStopChange={setStopAddress}
        onGuidanceChange={setGuidanceOn}
        onGo={onGo}
      />
    </div>
  )
}
