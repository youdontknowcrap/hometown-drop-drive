import { useMemo } from 'react'
import { RigidBody, CuboidCollider } from '@react-three/rapier'
import { sampleHeight, type HeightGrid } from '../lib/terrarium'
import type { BuildingBox } from '../lib/osmBuildings'

type BuildingsProps = {
  boxes: BuildingBox[]
  heightGrid: HeightGrid
  /** Remount key when Drop reloads. */
  version: number
}

/**
 * Extruded AABB building boxes on the height grid.
 *
 * LEARNING — selective colliders:
 *   Visual meshes are cheap; Rapier CuboidColliders are not when you keep
 *   hundreds of houses. osmBuildings marks solidCollider=true for the nearest
 *   N boxes and large footprints (landmarks). Far small houses are mesh-only
 *   so the neighborhood looks full without melting the physics step.
 *   Joey still bumps into what he drives past near Drop / big boxes.
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
            {/* Solid collider only when flagged — half-extents match the visual. */}
            {b.solidCollider ? (
              <CuboidCollider
                args={[b.width * 0.5, b.height * 0.5, b.depth * 0.5]}
                friction={0.6}
                restitution={0}
              />
            ) : null}
          </group>
        )
      })}
    </RigidBody>
  )
}
