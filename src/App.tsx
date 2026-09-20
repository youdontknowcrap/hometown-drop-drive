import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Scene } from './components/Scene'
import { Hud } from './components/Hud'
import { GpsDash } from './components/GpsDash'
import { useKeyboard } from './hooks/useKeyboard'
import { polylineToLocal } from './lib/geo'
import { fetchStreetWorld, getDemoWorld, type StreetWorld } from './lib/osmStreets'

const DEFAULT_DROP = '235 N China Lake Blvd, Ridgecrest, CA'

export default function App() {
  const keys = useKeyboard()
  const [dropAddress, setDropAddress] = useState(DEFAULT_DROP)
  const [guidanceOn, setGuidanceOn] = useState(false)
  const [busy, setBusy] = useState(false)
  const [world, setWorld] = useState<StreetWorld>(() => getDemoWorld())
  const [worldVersion, setWorldVersion] = useState(0)
  const [camDistance, setCamDistance] = useState(14)
  const [camHeight, setCamHeight] = useState(7)
  const booted = useRef(false)

  const onDrop = useCallback(async () => {
    setBusy(true)
    try {
      const next = await fetchStreetWorld(dropAddress)
      setWorld(next)
      setWorldVersion((v) => v + 1)
    } finally {
      setBusy(false)
    }
  }, [dropAddress])

  useEffect(() => {
    if (booted.current) return
    booted.current = true
    void onDrop()
  }, [onDrop])

  const localWays = useMemo(
    () => world.ways.map((w) => polylineToLocal(w, world.origin)),
    [world],
  )

  return (
    <div className="app">
      <div className="canvas-wrap">
        <Scene
          keys={keys}
          origin={world.origin}
          ways={world.ways}
          guidanceOn={guidanceOn}
          routeVersion={worldVersion}
          camDistance={camDistance}
          camHeight={camHeight}
        />
      </div>
      <Hud
        dropAddress={dropAddress}
        guidanceOn={guidanceOn}
        busy={busy}
        world={world}
        camDistance={camDistance}
        camHeight={camHeight}
        onDropChange={setDropAddress}
        onGuidanceChange={setGuidanceOn}
        onCamDistance={setCamDistance}
        onCamHeight={setCamHeight}
        onGo={onDrop}
      />
      <GpsDash origin={world.origin} ways={localWays} />
    </div>
  )
}

