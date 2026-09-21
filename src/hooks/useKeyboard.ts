import { useEffect, useRef, type MutableRefObject } from 'react'

/** Tracks WASD + arrow keys for driving. */
export type DriveKeys = {
  forward: boolean
  back: boolean
  left: boolean
  right: boolean
  /** Held KeyC — cruise toggle is edge-detected in sampleDriveInput. */
  cruise: boolean
  /** Held KeyP — autopilot toggle is edge-detected in sampleDriveInput. */
  autopilot: boolean
}

const EMPTY: DriveKeys = {
  forward: false,
  back: false,
  left: false,
  right: false,
  cruise: false,
  autopilot: false,
}

/** True only when the user is typing in a text field (not range/checkbox). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type
    return (
      type === 'text' ||
      type === 'search' ||
      type === 'email' ||
      type === 'url' ||
      type === 'tel' ||
      type === 'password' ||
      type === 'number' ||
      type === ''
    )
  }
  return false
}

/** Blur HUD fields and focus the WebGL canvas so WASD drives again. */
export function releaseDriveFocus(): void {
  const active = document.activeElement
  if (active instanceof HTMLElement) active.blur()
  const canvas = document.querySelector(
    '.canvas-wrap canvas',
  ) as HTMLCanvasElement | null
  canvas?.focus({ preventScroll: true })
}

function mapKey(code: string, pressed: boolean, state: DriveKeys): void {
  switch (code) {
    case 'KeyW':
    case 'ArrowUp':
      state.forward = pressed
      break
    case 'KeyS':
    case 'ArrowDown':
      state.back = pressed
      break
    case 'KeyA':
    case 'ArrowLeft':
      state.left = pressed
      break
    case 'KeyD':
    case 'ArrowRight':
      state.right = pressed
      break
    case 'KeyC':
      // Cruise toggle (same as Xbox A / PS5 ✕). Edge in sampleDriveInput.
      state.cruise = pressed
      break
    case 'KeyP':
      // Autopilot toggle (same as Xbox Y / PS5 △). Edge in sampleDriveInput.
      state.autopilot = pressed
      break
    default:
      break
  }
}

/**
 * Mutable ref of current key state — read inside the render/physics loop
 * without causing React re-renders on every keydown.
 */
export function useKeyboard(): MutableRefObject<DriveKeys> {
  const keys = useRef<DriveKeys>({ ...EMPTY })

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.code === 'Escape') {
        releaseDriveFocus()
        keys.current = { ...EMPTY }
        return
      }
      // Don't steal typing from address inputs — but range/checkbox/button
      // focus must still allow driving (playtest #17).
      if (isTypingTarget(e.target)) return
      mapKey(e.code, true, keys.current)
    }
    const onUp = (e: KeyboardEvent) => mapKey(e.code, false, keys.current)
    const clear = () => {
      keys.current = { ...EMPTY }
    }

    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', clear)
    }
  }, [])

  return keys
}
