import { useEffect, useRef } from 'react'
import { carPose } from '../lib/carPose'
import { MAX_SPEED_MPH, MPH_TO_MS } from '../lib/longitudinal'

/**
 * Live mph readout so Joey can verify the car actually hits ~110.
 *
 * Optional "m/s last sec" line is a SCALE SANITY CHECK, not a second speedo:
 *   expected ≈ |mph| * 0.44704
 * If mph says 110 and meters/sec says ~49, units are honest. If it still
 * "feels slow," tweak the chase cam — do not multiply mph by a fudge factor.
 */
export function Speedo() {
  const valueRef = useRef<HTMLSpanElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const sanityRef = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    let raf = 0
    const tick = () => {
      const mph = carPose.ready ? Math.abs(carPose.speedMph) : 0
      const signed = carPose.ready ? carPose.speedMph : 0
      if (valueRef.current) {
        valueRef.current.textContent = String(Math.round(mph))
      }
      if (barRef.current) {
        const pct = Math.min(100, (mph / MAX_SPEED_MPH) * 100)
        barRef.current.style.width = `${pct}%`
        barRef.current.dataset.dir = signed < -0.5 ? 'rev' : 'fwd'
      }
      if (sanityRef.current) {
        const mps = carPose.ready ? carPose.metersLastSecond : 0
        const expect = mph * MPH_TO_MS
        sanityRef.current.textContent =
          mps > 0.5
            ? `${mps.toFixed(0)} m/s last sec · expect ~${expect.toFixed(0)}`
            : `expect ~${expect.toFixed(0)} m/s at this mph`
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="speedo" aria-live="polite" title="Speed (mph) — true scale">
      <div className="speedo-readout">
        <span ref={valueRef} className="speedo-value">
          0
        </span>
        <span className="speedo-unit">mph</span>
      </div>
      <div className="speedo-track">
        <div ref={barRef} className="speedo-bar" style={{ width: '0%' }} />
      </div>
      <p className="speedo-cap">cap {MAX_SPEED_MPH}</p>
      <p className="speedo-sanity" ref={sanityRef}>
        —
      </p>
    </div>
  )
}
