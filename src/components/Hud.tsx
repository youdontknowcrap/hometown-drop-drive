import type { FormEvent } from 'react'
import type { StreetWorld } from '../lib/osmStreets'

type HudProps = {
  dropAddress: string
  guidanceOn: boolean
  busy: boolean
  world: StreetWorld
  camDistance: number
  camHeight: number
  onDropChange: (v: string) => void
  onGuidanceChange: (on: boolean) => void
  onCamDistance: (n: number) => void
  onCamHeight: (n: number) => void
  onGo: () => void
}

export function Hud({
  dropAddress,
  guidanceOn,
  busy,
  world,
  camDistance,
  camHeight,
  onDropChange,
  onGuidanceChange,
  onCamDistance,
  onCamHeight,
  onGo,
}: HudProps) {
  const submit = (e: FormEvent) => {
    e.preventDefault()
    onGo()
  }

  return (
    <div className="hud">
      <header className="hud-header">
        <h1>Hometown Drop & Drive</h1>
        <p className="hud-tagline">Drive the real streets. No walls.</p>
      </header>

      <form className="hud-panel" onSubmit={submit}>
        <label>
          <span>Drop at</span>
          <input
            type="text"
            value={dropAddress}
            onChange={(e) => onDropChange(e.target.value)}
            placeholder="e.g. 235 N China Lake Blvd, Ridgecrest CA"
            autoComplete="off"
          />
        </label>

        <div className="hud-row">
          <button type="submit" className="btn-go" disabled={busy}>
            {busy ? 'Loading streets…' : 'Drop'}
          </button>
          <label className="toggle">
            <input
              type="checkbox"
              checked={guidanceOn}
              onChange={(e) => onGuidanceChange(e.target.checked)}
            />
            <span>Hint {guidanceOn ? 'ON' : 'OFF'}</span>
          </label>
        </div>

        <label className="slider">
          <span>Camera distance {camDistance.toFixed(0)} m</span>
          <input
            type="range"
            min={8}
            max={40}
            step={1}
            value={camDistance}
            onChange={(e) => onCamDistance(Number(e.target.value))}
          />
        </label>
        <label className="slider">
          <span>Camera height {camHeight.toFixed(0)} m</span>
          <input
            type="range"
            min={3}
            max={22}
            step={1}
            value={camHeight}
            onChange={(e) => onCamHeight(Number(e.target.value))}
          />
        </label>

        <p className="hud-status" role="status">
          {world.message}
          {world.source === 'demo' ? ' · demo data' : ' · live OSM'}
        </p>
        <p className="hud-help">
          <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> drive.
          Scroll to zoom. Off-road is allowed. GPS is the map, not a route.
        </p>
      </form>
    </div>
  )
}
