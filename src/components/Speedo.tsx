import { useEffect, useRef } from 'react'
import { carPose } from '../lib/carPose'
import { MAX_SPEED_MPH } from '../lib/longitudinal'

/**
 * Live mph readout so Joey can verify the car actually hits ~110.
 * Reads carPose from the physics loop — no React state thrash.
 */
export function Speedo() {
  const valueRef = useRef<HTMLSpanElement>(null)
  const barRef = useRef<HTMLDivElement>(null)

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
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="speedo" aria-live="polite" title="Speed (mph)">
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
    </div>
  )
}
