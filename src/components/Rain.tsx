import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { carPose } from '../lib/carPose'

type RainProps = {
  /** 0 = off, 1 = storm density. */
  density: number
}

/**
 * Lightweight rain streaks that follow the car (STEM weather FX).
 * Points in a box above/around the vehicle — not a full fluid sim.
 */
export function Rain({ density }: RainProps) {
  const ref = useRef<THREE.Points>(null)
  const count = density > 0.8 ? 900 : density > 0.3 ? 500 : 0

  const { positions, speeds } = useMemo(() => {
    const positions = new Float32Array(Math.max(1, count) * 3)
    const speeds = new Float32Array(Math.max(1, count))
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 40
      positions[i * 3 + 1] = Math.random() * 28
      positions[i * 3 + 2] = (Math.random() - 0.5) * 40
      speeds[i] = 18 + Math.random() * 22
    }
    return { positions, speeds }
  }, [count])

  useFrame((_, dt) => {
    const pts = ref.current
    if (!pts || count === 0) return
    const attr = pts.geometry.getAttribute('position') as THREE.BufferAttribute
    const arr = attr.array as Float32Array
    const cx = carPose.ready ? carPose.x : 0
    const cz = carPose.ready ? carPose.z : 0
    pts.position.set(cx, 0, cz)

    for (let i = 0; i < count; i++) {
      arr[i * 3 + 1] -= speeds[i] * dt
      if (arr[i * 3 + 1] < 0) {
        arr[i * 3] = (Math.random() - 0.5) * 40
        arr[i * 3 + 1] = 18 + Math.random() * 12
        arr[i * 3 + 2] = (Math.random() - 0.5) * 40
      }
    }
    attr.needsUpdate = true
  })

  if (count === 0) return null

  return (
    <points ref={ref} frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[positions, 3]}
          count={count}
        />
      </bufferGeometry>
      <pointsMaterial
        color="#b0c4d8"
        size={0.12}
        sizeAttenuation
        transparent
        opacity={0.55}
        depthWrite={false}
      />
    </points>
  )
}
