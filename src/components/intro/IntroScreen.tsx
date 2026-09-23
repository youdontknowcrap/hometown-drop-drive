/**
 * IntroScreen — first-run entry: blue marble + address → Drop.
 *
 * LEARNING (Joey north star):
 *   1. Cold load shows Earth, NOT an automatic Ridgecrest Drop.
 *   2. Kid/parent types an address in the prominent search box.
 *   3. We geocode with the same Nominatim helper the Drop pipeline uses
 *      (`geocodeDrop`), optionally zoom the marble toward that lon/lat,
 *      then hand the address to App so `useStreetStreaming` / streetTiles
 *      start the existing center-tile → neighbors Drop path.
 *
 * HUD Drop still works later for re-Drop; this screen is only first entry.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Canvas } from '@react-three/fiber'
import { PerspectiveCamera } from '@react-three/drei'
import { BlueMarble, type MarbleTarget } from './BlueMarble'
import { geocodeDrop } from '../../lib/osmStreets'

type IntroScreenProps = {
  /** Called with the typed address after a successful geocode (+ zoom). */
  onEnter: (address: string) => void
}

const ZOOM_MS = 1100

export function IntroScreen({ onEnter }: IntroScreenProps) {
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [target, setTarget] = useState<MarbleTarget | null>(null)
  const [zoomProgress, setZoomProgress] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const zoomRaf = useRef(0)

  // Focus the search box on mount so cold-load is “type to play”.
  useEffect(() => {
    const id = window.setTimeout(() => inputRef.current?.focus(), 80)
    return () => window.clearTimeout(id)
  }, [])

  useEffect(() => {
    return () => {
      if (zoomRaf.current) cancelAnimationFrame(zoomRaf.current)
    }
  }, [])

  const runZoomThenEnter = useCallback(
    (q: string, hit: MarbleTarget) => {
      setTarget(hit)
      const t0 = performance.now()
      const tick = (now: number) => {
        const t = Math.min(1, (now - t0) / ZOOM_MS)
        // Ease-in-out so the approach feels gentle.
        const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
        setZoomProgress(eased)
        if (t < 1) {
          zoomRaf.current = requestAnimationFrame(tick)
        } else {
          onEnter(q)
        }
      }
      zoomRaf.current = requestAnimationFrame(tick)
    },
    [onEnter],
  )

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const q = address.trim()
    if (!q) {
      setError('Type an address or place name to Drop.')
      return
    }
    if (busy) return
    setBusy(true)
    setError('')
    try {
      // Same Nominatim path Drop uses — validate before leaving the marble.
      const hit = await geocodeDrop(q)
      runZoomThenEnter(q, { lat: hit.lat, lng: hit.lng })
      // Keep busy true through the zoom; parent unmounts us on enter.
    } catch (err) {
      const why = err instanceof Error ? err.message : 'Geocode failed'
      setError(why)
      setBusy(false)
      setTarget(null)
      setZoomProgress(0)
    }
  }

  return (
    <div className="intro" role="dialog" aria-label="Choose a starting place">
      <div className="intro-canvas" aria-hidden>
        <Canvas dpr={[1, 1.75]} gl={{ antialias: true, alpha: false }}>
          <color attach="background" args={['#02040a']} />
          <PerspectiveCamera makeDefault position={[0, 0.35, 3.2]} fov={42} />
          <BlueMarble target={target} zoomProgress={zoomProgress} />
        </Canvas>
      </div>

      <div className="intro-ui">
        <header className="intro-header">
          <p className="intro-kicker">Hometown Drop &amp; Drive</p>
          <h1 className="intro-title">Where do you want to start?</h1>
          <p className="intro-tagline">
            Pick any address on Earth. We Drop you there — then you drive.
          </p>
        </header>

        <form className="intro-form" onSubmit={(e) => void onSubmit(e)}>
          <label className="intro-label" htmlFor="intro-address">
            Address or place
          </label>
          <div className="intro-row">
            <input
              ref={inputRef}
              id="intro-address"
              className="intro-input"
              type="text"
              name="address"
              autoComplete="street-address"
              placeholder="e.g. 1 Infinite Loop, Cupertino, CA"
              value={address}
              disabled={busy}
              onChange={(e) => {
                setAddress(e.target.value)
                if (error) setError('')
              }}
            />
            <button
              type="submit"
              className="intro-go"
              disabled={busy || !address.trim()}
            >
              {busy ? (zoomProgress > 0 ? 'Dropping…' : 'Finding…') : 'Drop here'}
            </button>
          </div>
          {error ? (
            <p className="intro-error" role="alert">
              {error}
            </p>
          ) : (
            <p className="intro-hint">
              No default town — you choose. Uses OpenStreetMap Nominatim, then
              the same street-streaming Drop as the HUD.
            </p>
          )}
        </form>
      </div>
    </div>
  )
}
