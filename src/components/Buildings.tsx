import { useMemo } from 'react'
import { RigidBody, CuboidCollider } from '@react-three/rapier'
import { sampleHeight, type HeightGrid } from '../lib/terrarium'
import {
  COLLIDER_INSET_M,
  type BuildingBox,
} from '../lib/osmBuildings'

type BuildingsProps = {
  boxes: BuildingBox[]
  heightGrid: HeightGrid
  /** Remount key when Drop reloads. */
  version: number
}

/**
 * Extruded AABB building boxes on the height grid.
 *
 * LEARNING — selective colliders + inset:
 *   Visual meshes are cheap; Rapier CuboidColliders are not when you keep
 *   hundreds of houses. osmBuildings marks solidCollider=true for the nearest
 *   N boxes and large footprints (landmarks), then Scene clears any solid that
 *   overlaps a road ribbon (clearRoadOverlappingSolidColliders).
 *
 *   WHY inset half-extents?
 *   OSM footprints → axis-aligned boxes. Houses near streets often spill onto
 *   asphalt. If the collider matches the visual 1:1, arcade setLinvel (Car.tsx)
 *   fights a fixed wall every frame → translation blocked, yaw still works
 *   ("stuck like a fly"). Pull physics in by COLLIDER_INSET_M; mesh stays full.
 *
 *   Friction is low so a glancing bump doesn't glue the car to the wall.
 *
 * Y sits on sampleHeight so boxes follow hills. No interiors, no ripped assets.
 */
export function Buildings({ boxes, heightGrid, version }: BuildingsProps) {
  const placed = useMemo(() => {
    return boxes.map((b) => {
      const groundY = sampleHeight(heightGrid, b.x, b.z)
      return { ...b, groundY }
    })
  }, [boxes, heightGrid])

  if (!placed.length) return null

  return (
    <RigidBody key={version} type="fixed" colliders={false} position={[0, 0, 0]}>
      {placed.map((b, i) => {
        const y = b.groundY + b.height * 0.5
        // Soft desert-town palette — houses slightly warmer than warehouses.
        const hue = b.residential ? 28 + (i % 5) * 3 : 22 + (i % 7) * 4
        const lightness = b.residential ? 46 + (i % 4) * 3 : 40 + (i % 5) * 4
        const color = `hsl(${hue}, 18%, ${lightness}%)`

        // Inset collider vs visual; skip if inset would go non-positive.
        const hx = Math.max(0.05, b.width * 0.5 - COLLIDER_INSET_M)
        const hz = Math.max(0.05, b.depth * 0.5 - COLLIDER_INSET_M)
        const hy = b.height * 0.5

        return (
          <group key={i} position={[b.x, y, b.z]}>
            <mesh castShadow receiveShadow>
              <boxGeometry args={[b.width, b.height, b.depth]} />
              <meshStandardMaterial
                color={color}
                roughness={0.9}
                metalness={0.05}
              />
            </mesh>
            {b.solidCollider ? (
              <CuboidCollider
                args={[hx, hy, hz]}
                friction={0.15}
                restitution={0}
              />
            ) : null}
          </group>
        )
      })}
    </RigidBody>
  )
}
