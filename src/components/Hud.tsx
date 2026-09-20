import type { FormEvent } from 'react'
import type { RouteResult } from '../lib/routing'

type HudProps = {
  startAddress: string
  stopAddress: string
  guidanceOn: boolean
  busy: boolean
  route: RouteResult
  onStartChange: (v: string) => void
  onStopChange: (v: string) => void
  onGuidanceChange: (on: boolean) => void
  onGo: () => void
}

/**
 * Family-friendly overlay: start/stop addresses, Go, and guidance toggle.
 * Pointer-events only on the panel so the canvas still receives clicks.
 */
export function Hud({
  startAddress,
  stopAddress,
  guidanceOn,
  busy,
  route,
  onStartChange,
  onStopChange,
  onGuidanceChange,
  onGo,
}: HudProps) {
  const submit = (e: FormEvent) => {
    e.preventDefault()
    onGo()
  }

  return (
    <div className="hud">
      <header className="hud-header">
        <h1>Hometown Drop &amp; Drive</h1>
        <p className="hud-tagline">Kid-friendly browser driving toy</p>
      </header>

      <form className="hud-panel" onSubmit={submit}>
        <label>
          <span>Start address</span>
          <input
            type="text"
            value={startAddress}
            onChange={(e) => onStartChange(e.target.value)}
            placeholder="e.g. City Hall, Ridgecrest CA"
            autoComplete="off"
          />
        </label>
        <label>
          <span>Stop address</span>
          <input
            type="text"
            value={stopAddress}
            onChange={(e) => onStopChange(e.target.value)}
            placeholder="e.g. Library, Ridgecrest CA"
            autoComplete="off"
          />
        </label>

        <div className="hud-row">
          <button type="submit" className="btn-go" disabled={busy}>
            {busy ? 'Routing…' : 'Go'}
          </button>
          <label className="toggle">
            <input
              type="checkbox"
              checked={guidanceOn}
              onChange={(e) => onGuidanceChange(e.target.checked)}
            />
            <span>Guidance {guidanceOn ? 'ON' : 'OFF'}</span>
          </label>
        </div>

        <p className="hud-status" role="status">
          {route.message}
          {route.source === 'demo' ? ' · demo data' : ' · live OSM'}
        </p>
        <p className="hud-help">
          Drive with <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> or arrows.
          Guidance ON draws a blue line and gives a soft steering hint.
        </p>
      </form>
    </div>
  )
}
