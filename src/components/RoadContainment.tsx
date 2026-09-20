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
}: RoadContainmentProps) {
  const walls = useMemo(() => buildContainmentWalls(ways, CONTAINMENT_M), [ways])

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
