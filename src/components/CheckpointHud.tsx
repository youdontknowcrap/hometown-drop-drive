import { useEffect, useRef } from 'react'
import { checkpointHud } from '../lib/checkpoints'

/**
 * SCORE + GATE n/N + timer — reads checkpointHud each rAF (no React churn).
 */
export function CheckpointHud() {
  const rootRef = useRef<HTMLDivElement>(null)
  const scoreRef = useRef<HTMLSpanElement>(null)
  const gateRef = useRef<HTMLSpanElement>(null)
  const timerRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    let raf = 0
    const tick = () => {
      const active = checkpointHud.active && checkpointHud.total > 0
      if (rootRef.current) rootRef.current.hidden = !active
      if (active) {
        if (scoreRef.current) {
          scoreRef.current.textContent = String(checkpointHud.score)
        }
        if (gateRef.current) {
          gateRef.current.textContent = `${checkpointHud.cleared}/${checkpointHud.total}`
        }
        if (timerRef.current) {
          const s = Math.max(0, checkpointHud.timerSec)
          const m = Math.floor(s / 60)
          const r = Math.floor(s % 60)
          timerRef.current.textContent = `${m}:${r.toString().padStart(2, '0')}`
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="checkpoint-hud" ref={rootRef} hidden>
      <div className="checkpoint-score">
        SCORE <span ref={scoreRef}>0</span>
      </div>
      <div className="checkpoint-gate">
        GATE <span ref={gateRef}>0/0</span>
      </div>
      <div className="checkpoint-timer">
        <span ref={timerRef}>0:00</span>
      </div>
    </div>
  )
}
