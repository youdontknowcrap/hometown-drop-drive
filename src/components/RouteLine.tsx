import { useMemo } from 'react'
import * as THREE from 'three'
import { Line } from '@react-three/drei'

type RouteLineProps = {
  points: Array<[number, number, number]>
  visible: boolean
}

/** Blue guidance ribbon along the planned path. Hidden when guidance is OFF. */
export function RouteLine({ points, visible }: RouteLineProps) {
  const linePoints = useMemo(
    () => points.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
    [points],
  )

  if (!visible || linePoints.length < 2) return null

  return (
    <group>
      {/* Soft glow under the bright center line */}
      <Line
        points={linePoints}
        color="#1565c0"
        lineWidth={8}
        transparent
        opacity={0.35}
      />
      <Line
        points={linePoints}
        color="#42a5f5"
        lineWidth={3}
        transparent
        opacity={0.95}
      />
    </group>
  )
}
