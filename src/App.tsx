import { useCallback, useState } from 'react'
import { Scene } from './components/Scene'
import { Hud } from './components/Hud'
import { useKeyboard } from './hooks/useKeyboard'
import { fetchRoute, getDemoRoute, type RouteResult } from './lib/routing'

/**
 * Hometown Drop & Drive — milestone 1 prototype.
 * Address → route → blue guidance → drive with WASD.
 */
export default function App() {
  const keys = useKeyboard()
  const [startAddress, setStartAddress] = useState('')
  const [stopAddress, setStopAddress] = useState('')
  const [guidanceOn, setGuidanceOn] = useState(true)
  const [busy, setBusy] = useState(false)
  const [route, setRoute] = useState<RouteResult>(() => getDemoRoute())
  const [routeVersion, setRouteVersion] = useState(0)

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
