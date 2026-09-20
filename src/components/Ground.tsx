import { useTexture } from '@react-three/drei'
import { RigidBody } from '@react-three/rapier'
import * as THREE from 'three'

/** World-meter desert playfield. 1 UV tile = 20 m so speed is visible off-road too. */
const DESERT_REPEAT_M = 20

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

export function Ground({ size, centerX, centerZ }: GroundProps) {
  const [diff, nor] = useTexture(
    ['/textures/aerial_sand_diff_1k.jpg', '/textures/aerial_sand_nor_gl_1k.jpg'],
    prepMaps,
  )

  const tiles = Math.max(4, size / DESERT_REPEAT_M)
  diff.repeat.set(tiles, tiles)
  nor.repeat.set(tiles, tiles)

  return (
    <RigidBody
      type="fixed"
      colliders="cuboid"
      friction={1.2}
      position={[centerX, 0, centerZ]}
    >
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow position={[0, -0.05, 0]}>
        <boxGeometry args={[size, size, 0.1]} />
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
