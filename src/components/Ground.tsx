import { useTexture } from '@react-three/drei'
import { RigidBody, CuboidCollider } from '@react-three/rapier'
import * as THREE from 'three'

/** World-meter desert playfield. 1 UV tile = 20 m so speed is visible off-road too. */
const DESERT_REPEAT_M = 20

/** Half-thickness of the physics slab (meters). Visual plane sits on top at y=0. */
const GROUND_HALF_H = 0.5

type GroundProps = {
  size: number
  centerX: number
  centerZ: number
}

function prepMaps(textures: THREE.Texture | THREE.Texture[]) {
  const list = Array.isArray(textures) ? textures : [textures]
  for (const t of list) {
    t.wrapS = THREE.RepeatWrapping
    t.wrapT = THREE.RepeatWrapping
    t.anisotropy = 8
  }
  list[0].colorSpace = THREE.SRGBColorSpace
}

/**
 * Textured desert + thick fixed collider.
 * Visual is a flat plane at y=0; physics is a 1 m slab whose top is y=0 so
 * high-speed CCD contacts don't tunnel (old 0.1 m box was too thin).
 */
export function Ground({ size, centerX, centerZ }: GroundProps) {
  const [diff, nor] = useTexture(
    ['/textures/aerial_sand_diff_1k.jpg', '/textures/aerial_sand_nor_gl_1k.jpg'],
    prepMaps,
  )

  const tiles = Math.max(4, size / DESERT_REPEAT_M)
  diff.repeat.set(tiles, tiles)
  nor.repeat.set(tiles, tiles)

  const half = size * 0.5

  return (
    <RigidBody type="fixed" colliders={false} position={[centerX, 0, centerZ]}>
      <CuboidCollider
        args={[half, GROUND_HALF_H, half]}
        position={[0, -GROUND_HALF_H, 0]}
        friction={1.2}
        restitution={0}
      />
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[size, size]} />
        <meshStandardMaterial
          map={diff}
          normalMap={nor}
          roughness={0.95}
          metalness={0}
        />
      </mesh>
    </RigidBody>
  )
}
