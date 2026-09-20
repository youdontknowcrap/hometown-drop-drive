import { useEffect, useRef, type MutableRefObject } from 'react'

/** Tracks WASD + arrow keys for driving. */
export type DriveKeys = {
  forward: boolean
  back: boolean
  left: boolean
  right: boolean
}

const EMPTY: DriveKeys = {
  forward: false,
  back: false,
  left: false,
  right: false,
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
      // Don't steal typing from address inputs.
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
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
