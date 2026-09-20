import { useEffect, useMemo } from 'react'
import { useTexture } from '@react-three/drei'
import * as THREE from 'three'
import { buildLanePaint, buildRoadRibbon } from '../lib/roadMesh'

type RoadProps = {
  points: Array<[number, number, number]>
}

function arraysToGeometry(
  built: {
    positions: Float32Array
    uvs: Float32Array
    normals: Float32Array
    indices: Uint32Array
  } | null,
): THREE.BufferGeometry | null {
  if (!built || built.positions.length < 9) return null
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(built.positions, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(built.uvs, 2))
  g.setAttribute('normal', new THREE.BufferAttribute(built.normals, 3))
  g.setIndex(new THREE.BufferAttribute(built.indices, 1))
  return g
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

/** Textured street ribbon in real meters. Not a collider — drive on or off it. */
export function Road({ points }: RoadProps) {
  const [diff, nor] = useTexture(
    ['/textures/asphalt_01_diff_1k.jpg', '/textures/asphalt_01_nor_gl_1k.jpg'],
    prepMaps,
  )

  const ribbon = useMemo(() => arraysToGeometry(buildRoadRibbon(points)), [points])
  const paint = useMemo(() => arraysToGeometry(buildLanePaint(points)), [points])

  useEffect(
    () => () => {
      ribbon?.dispose()
      paint?.dispose()
    },
    [ribbon, paint],
  )

  if (!ribbon) return null

  return (
    <group>
      <mesh geometry={ribbon} receiveShadow>
        <meshStandardMaterial map={diff} normalMap={nor} roughness={0.92} metalness={0} />
      </mesh>
      {paint ? (
        <mesh geometry={paint}>
          <meshStandardMaterial
            color="#f5f5f0"
            roughness={0.6}
            metalness={0}
            polygonOffset
            polygonOffsetFactor={-1}
          />
        </mesh>
      ) : null}
    </group>
  )
}
