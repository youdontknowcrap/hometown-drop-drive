import type { FormEvent } from 'react'
import type { StreetWorld } from '../lib/osmStreets'

export type GpsStatus =
  | 'idle'
  | 'routing'
  | 'ready'
  | 'rerouting'
  | 'cleared'
  | 'error'

type HudProps = {
  dropAddress: string
  destAddress: string
  guidanceOn: boolean
  busy: boolean
  gpsBusy: boolean
  gpsStatus: GpsStatus
  gpsMessage: string
  hasDestination: boolean
  world: StreetWorld
  camDistance: number
  camHeight: number
  onDropChange: (v: string) => void
  onDestChange: (v: string) => void
  onGuidanceChange: (on: boolean) => void
  onCamDistance: (n: number) => void
  onCamHeight: (n: number) => void
  onDrop: () => void
  onSetDestination: () => void
  onClearDestination: () => void
}

function gpsStatusLine(
  status: GpsStatus,
  message: string,
  hasDestination: boolean,
): string {
  switch (status) {
    case 'routing':
      return 'Finding a path…'
    case 'rerouting':
      return 'Rerouting…'
    case 'cleared':
      return 'Destination cleared — free drive.'
    case 'error':
      return message || 'Could not set destination.'
    case 'ready':
      return message || 'Destination set.'
    case 'idle':
    default:
      return hasDestination
        ? message
        : 'No destination — free drive. Type where to go.'
  }
}

export function Hud({
  dropAddress,
  destAddress,
  guidanceOn,
  busy,
  gpsBusy,
  gpsStatus,
  gpsMessage,
  hasDestination,
  world,
  camDistance,
  camHeight,
  onDropChange,
  onDestChange,
  onGuidanceChange,
  onCamDistance,
  onCamHeight,
  onDrop,
  onSetDestination,
  onClearDestination,
}: HudProps) {
  const submitDrop = (e: FormEvent) => {
    e.preventDefault()
    onDrop()
  }

  const submitDest = (e: FormEvent) => {
    e.preventDefault()
    onSetDestination()
  }

  return (
    <div className="hud">
      <header className="hud-header">
        <h1>Hometown Drop & Drive</h1>
        <p className="hud-tagline">Drive the real streets. GPS is the point.</p>
      </header>

      <div className="hud-stack">
        <form className="hud-panel" onSubmit={submitDrop}>
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

          <p
            className={
              world.source === 'osm' && world.wayCount > 0
                ? 'hud-status'
                : 'hud-status hud-status-warn'
            }
            role="status"
          >
            {world.message}
            {world.source === 'demo'
              ? ' · DEMO (not live OSM)'
              : world.wayCount > 0
                ? ` · live OSM (${world.wayCount} ways)`
                : ' · OSM returned zero ways'}
          </p>
        </form>

        <form className="hud-panel hud-gps" onSubmit={submitDest}>
          <label>
            <span>Go to (destination)</span>
            <input
              type="text"
              value={destAddress}
              onChange={(e) => onDestChange(e.target.value)}
              placeholder="Address while driving — e.g. Walmart Ridgecrest"
              autoComplete="off"
            />
          </label>

          <div className="hud-row">
            <button type="submit" className="btn-go" disabled={gpsBusy || busy}>
              {gpsStatus === 'routing'
                ? 'Setting…'
                : gpsStatus === 'rerouting'
                  ? 'Rerouting…'
                  : 'Set destination'}
            </button>
            <button
              type="button"
              className="btn-clear"
              disabled={!hasDestination && gpsStatus !== 'error'}
              onClick={onClearDestination}
            >
              Clear
            </button>
            <label className="toggle">
              <input
                type="checkbox"
                checked={guidanceOn}
                onChange={(e) => onGuidanceChange(e.target.checked)}
                disabled={!hasDestination}
              />
              <span>Guidance {guidanceOn && hasDestination ? 'ON' : 'OFF'}</span>
            </label>
          </div>

          <p
            className={
              gpsStatus === 'rerouting' || gpsStatus === 'routing'
                ? 'hud-status hud-gps-live'
                : 'hud-status'
            }
            role="status"
          >
            {gpsStatusLine(gpsStatus, gpsMessage, hasDestination)}
          </p>
          <p className="hud-help">
            <kbd>W</kbd>
            <kbd>A</kbd>
            <kbd>S</kbd>
            <kbd>D</kbd> drive (click the world or press{' '}
            <kbd>Esc</kbd> after typing). Set a destination anytime. Drive off
            the blue line and GPS will reroute. Clear = free drive.
          </p>
        </form>
      </div>
    </div>
  )
}
