import { useMemo } from 'react'
import { RigidBody, CuboidCollider } from '@react-three/rapier'
import {
  buildContainmentWalls,
  CONTAINMENT_M,
  type ContainmentWall,
} from '../lib/roadCorridor'
import type { XzPoint } from '../lib/roadMesh'

type RoadContainmentProps = {
  ways: XzPoint[][]
  /** Bumps when Drop reloads the street grid so colliders remount cleanly. */
  version: number
  /** Invisible by default — set true only for debug. */
  debugVisible?: boolean
  /**
   * Terrain relief (maxRel − minRel). Walls grow so a hill can't let you
   * hop the ~200 ft corridor fence.
   */
  reliefM?: number
}

function WallColliders({ walls }: { walls: ContainmentWall[] }) {
  return (
    <>
      {walls.map((w, i) => (
        <CuboidCollider
          key={i}
          args={[w.length * 0.5, w.height * 0.5, w.thickness * 0.5]}
          position={[w.x, w.height * 0.5, w.z]}
          rotation={[0, w.yaw, 0]}
          friction={0.4}
          restitution={0}
        />
      ))}
    </>
  )
}

/**
 * Hard outer fence ~CONTAINMENT_M off the loaded OSM street network.
 * Rebuilds whenever `ways` / `version` change (Drop / route load).
 */
export function RoadContainment({
  ways,
  version,
  debugVisible = false,
  reliefM = 0,
}: RoadContainmentProps) {
  const walls = useMemo(() => {
    const base = buildContainmentWalls(ways, CONTAINMENT_M)
    // Default wall is 5 m; grow with terrain relief so hills don't clear it.
    const h = Math.max(5, 5 + reliefM + 4)
    return base.map((w) => ({ ...w, height: h }))
  }, [ways, reliefM])

  if (!walls.length) return null

  return (
    <RigidBody
      key={version}
      type="fixed"
      colliders={false}
      position={[0, 0, 0]}
    >
      <WallColliders walls={walls} />
      {debugVisible
        ? walls.map((w, i) => (
            <mesh
              key={`viz-${i}`}
              position={[w.x, w.height * 0.5, w.z]}
              rotation={[0, w.yaw, 0]}
            >
              <boxGeometry args={[w.length, w.height, w.thickness]} />
              <meshStandardMaterial
                color="#7ec8e3"
                transparent
                opacity={0.18}
                depthWrite={false}
              />
            </mesh>
          ))
        : null}
    </RigidBody>
  )
}
