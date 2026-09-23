import { useEffect, useState, type FormEvent } from 'react'
import type { StreetWorld } from '../lib/osmStreets'
import { WEATHER_PRESETS, type WeatherPreset } from '../lib/weather'
import { autopilotControl } from '../lib/autopilot'
import { carPose } from '../lib/carPose'
import { PAINT_PRESETS } from './Car'

export type GpsStatus =
  | 'idle'
  | 'routing'
  | 'ready'
  | 'rerouting'
  | 'cleared'
  | 'error'

/** localStorage key for HUD open/closed — survives refresh. */
const HUD_OPEN_KEY = 'hdd-hud-open'

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
  /** Terrarium / Open-Meteo / flat status from Scene. */
  terrainMessage?: string
  /** Far LOD skyline ring status (radius / relief). */
  farTerrainMessage?: string
  /** Building load status. */
  buildingsMessage?: string
  /** Open-world streaming tile count line. */
  tilesMessage?: string
  /** Live streamer status (loading / error). */
  streamMessage?: string
  /** Teaching: priority-queue head + depth (load order ≡ paint cue). */
  queueMessage?: string
  /** Buildings stream ON/OFF (persisted by App). */
  buildingsOn: boolean
  onBuildingsOn: (on: boolean) => void
  /** GPS dial: paint loaded active ways (persisted). 3D streets untouched. */
  gpsLiveStreetsOn: boolean
  onGpsLiveStreetsOn: (on: boolean) => void
  /** 3D Troika street names (default OFF — CPU win while driving). */
  streetNamesOn: boolean
  onStreetNamesOn: (on: boolean) => void
  /** Live or preset weather summary. */
  weatherSummary?: string
  weatherPreset: WeatherPreset
  onWeatherPreset: (p: WeatherPreset) => void
  paintHex: string
  onPaintHex: (hex: string) => void
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

function readHudOpen(): boolean {
  try {
    const v = localStorage.getItem(HUD_OPEN_KEY)
    // Default open so first-time Joey still sees Drop/GPS.
    if (v == null) return true
    return v === '1' || v === 'true'
  } catch {
    return true
  }
}

function writeHudOpen(open: boolean) {
  try {
    localStorage.setItem(HUD_OPEN_KEY, open ? '1' : '0')
  } catch {
    /* private mode / blocked storage — ignore */
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
  terrainMessage,
  farTerrainMessage,
  buildingsMessage,
  tilesMessage,
  streamMessage,
  queueMessage,
  buildingsOn,
  onBuildingsOn,
  gpsLiveStreetsOn,
  onGpsLiveStreetsOn,
  streetNamesOn,
  onStreetNamesOn,
  weatherSummary,
  weatherPreset,
  onWeatherPreset,
  paintHex,
  onPaintHex,
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
  const [open, setOpen] = useState(readHudOpen)

  // Persist open/closed so a refresh keeps Joey’s preference.
  useEffect(() => {
    writeHudOpen(open)
  }, [open])

  /**
   * Keyboard shortcut: H or `[` toggles the left control frame.
   * Skip when focus is in an input/textarea so typing “H” in an address
   * doesn’t collapse the panel mid-sentence (teaching: always gate global
   * shortcuts on activeElement tag).
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 'h' || e.key === 'H' || e.key === '[') {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const submitDrop = (e: FormEvent) => {
    e.preventDefault()
    onDrop()
  }

  const submitDest = (e: FormEvent) => {
    e.preventDefault()
    onSetDestination()
  }

  // Collapsed: thin chevron tab only — max driving view.
  if (!open) {
    return (
      <div className="hud hud-collapsed">
        <button
          type="button"
          className="hud-tab"
          aria-label="Show controls"
          title="Show controls (H or [)"
          onClick={() => setOpen(true)}
        >
          <span className="hud-tab-chevron" aria-hidden>
            ›
          </span>
          <span className="hud-tab-label">Controls</span>
        </button>
      </div>
    )
  }

  return (
    <div className="hud">
      <header className="hud-header">
        <h1>Hometown Drop & Drive</h1>
        <p className="hud-tagline">Drive the real streets. GPS is the point.</p>
      </header>

      <div className="hud-stack">
        <div className="hud-collapse-row">
          <button
            type="button"
            className="hud-collapse-btn"
            aria-label="Hide controls"
            title="Hide controls (H or [)"
            onClick={() => setOpen(false)}
          >
            ‹ Hide
          </button>
          <span className="hud-collapse-hint">
            Hotkey <kbd>H</kbd> / <kbd>[</kbd>
          </span>
        </div>

        <form className="hud-panel" onSubmit={submitDrop}>
          <label>
            <span>Drop at</span>
            <input
              type="text"
              value={dropAddress}
              onChange={(e) => onDropChange(e.target.value)}
              placeholder="e.g. Main St, Springfield, IL"
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
              max={48}
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

          <label>
            <span>Weather</span>
            <select
              value={weatherPreset}
              onChange={(e) => onWeatherPreset(e.target.value as WeatherPreset)}
            >
              {WEATHER_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Paint</span>
            <select
              value={paintHex}
              onChange={(e) => onPaintHex(e.target.value)}
            >
              {PAINT_PRESETS.map((p) => (
                <option key={p.id} value={p.hex}>
                  {p.label}
                </option>
              ))}
            </select>
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
          {terrainMessage ? (
            <p className="hud-status" role="status">
              {terrainMessage}
            </p>
          ) : null}
          <p className="hud-status" role="status">
            Relief 1× (true meters — fidelity, not arcade stretch)
          </p>
          {farTerrainMessage ? (
            <p className="hud-status" role="status">
              {farTerrainMessage}
            </p>
          ) : null}
          {buildingsMessage ? (
            <p className="hud-status" role="status">
              {buildingsMessage}
            </p>
          ) : null}
          <label className="toggle">
            <input
              type="checkbox"
              checked={buildingsOn}
              onChange={(e) => onBuildingsOn(e.target.checked)}
            />
            <span>Buildings {buildingsOn ? 'ON' : 'OFF'}</span>
          </label>
          <label
            className="toggle"
            title="3D floating street names (Troika). Default OFF for CPU while driving."
          >
            <input
              type="checkbox"
              checked={streetNamesOn}
              onChange={(e) => onStreetNamesOn(e.target.checked)}
            />
            <span>Street names {streetNamesOn ? 'ON' : 'OFF'}</span>
          </label>
          {tilesMessage ? (
            <p className="hud-status" role="status">
              {tilesMessage}
            </p>
          ) : null}
          {streamMessage ? (
            <p className="hud-status" role="status">
              {streamMessage}
            </p>
          ) : null}
          {queueMessage ? (
            <p className="hud-status" role="status">
              {queueMessage}
            </p>
          ) : null}
          {weatherSummary ? (
            <p className="hud-status" role="status">
              Weather: {weatherSummary}
            </p>
          ) : null}
        </form>

        <form className="hud-panel hud-gps" onSubmit={submitDest}>
          <label>
            <span>Go to (destination)</span>
            <input
              type="text"
              value={destAddress}
              onChange={(e) => onDestChange(e.target.value)}
              placeholder="Address while driving — e.g. City Hall downtown"
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
            <AutopilotToggle hasDestination={hasDestination} />
            <label className="toggle" title="Paint loaded streets on the GPS dial only">
              <input
                type="checkbox"
                checked={gpsLiveStreetsOn}
                onChange={(e) => onGpsLiveStreetsOn(e.target.checked)}
              />
              <span>GPS streets {gpsLiveStreetsOn ? 'ON' : 'OFF'}</span>
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
            <kbd>D</kbd> drive · pad: LT gas, RT brake, LB reverse (click the
            world or press <kbd>Esc</kbd> after typing). Set a destination
            anytime. <kbd>P</kbd> / pad <strong>Y/△</strong> = autopilot (snap
            along the blue line, gas/brake set speed 0–200 mph). <kbd>C</kbd> /
            <strong>A/✕</strong> = cruise (manual cap ~110). Drive off the blue
            line and GPS will reroute. Clear = free drive. Hide this panel with{' '}
            <kbd>H</kbd> / <kbd>[</kbd>. Bottom-right GPS defaults to{' '}
            <strong>Track-up</strong> (map swings under a fixed car chevron —
            turn left, map swings right); tap the dial badge for North-up.
            GPS <strong>▢</strong> expands the dial + deeper zoom-out (tens of
            km); <strong>Streets ON/OFF</strong> toggles all live loaded ways on
            the dial at every zoom (3D streets stay; overlays still add). Destination shows remaining
            distance; expand <strong>Next turn</strong> for the cue.
          </p>
        </form>
      </div>
    </div>
  )
}

/**
 * Autopilot checkbox — talks to Car via autopilotControl bus (no remount).
 * Live ON/OFF mirrors carPose so KeyP / Y and this box stay in sync.
 */
function AutopilotToggle({ hasDestination }: { hasDestination: boolean }) {
  const [on, setOn] = useState(false)

  useEffect(() => {
    let raf = 0
    const tick = () => {
      setOn(Boolean(carPose.ready && carPose.autopilotOn))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <label className="toggle">
      <input
        type="checkbox"
        checked={on}
        disabled={!hasDestination}
        onChange={() => {
          if (!hasDestination) return
          autopilotControl.hudToggle = true
        }}
      />
      <span>Autopilot {on && hasDestination ? 'ON' : 'OFF'}</span>
    </label>
  )
}
