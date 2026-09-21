import { useMemo } from 'react'
import { useTexture } from '@react-three/drei'
import { RigidBody, CuboidCollider } from '@react-three/rapier'
import * as THREE from 'three'
import { sampleHeight, type HeightGrid } from '../lib/terrarium'
import {
  trenchDepressionAt,
} from '../lib/roadHeights'
import type { RoadSurfaceWay } from '../lib/roadSurface'

/** World-meter grass playfield. 1 UV tile = 20 m so speed is visible off-road too. */
const GRASS_REPEAT_M = 20

/**
 * Flat-fallback slab half-thickness (meters). Visual plane sits on top.
 * When Terrarium data is present we still keep a deep floor under the
 * *minimum* relative height as a safety net; the car primarily pins Y from
 * sampleHeight (see Car.tsx) so hills don't need a fragile heightfield CCD.
 */
const GROUND_HALF_H = 0.5

type GroundProps = {
  heightGrid: HeightGrid
  /**
   * Widened road corridors for the grass trench pass (see buildRoadTrenchWays).
   * Empty → no trench (flat / loading).
   */
  roadTrenchWays?: RoadSurfaceWay[]
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
 * Textured grass displaced by Terrarium/SRTM heights (or flat fallback).
 *
 * LEARNING — ground default is grass (not desert sand): Poly Haven
 * `aerial_grass_rock` CC0 albedo + normal. Same trench dig as before so
 * asphalt still sits in a shallow channel on hills.
 *
 * Vertex Y = sampleHeight(grid, x, z) — relative to spawn elev, so the Drop
 * point sits near y=0 and surrounding hills read as hills, not a flying carpet.
 *
 * LEARNING — road trench:
 *   Bias + densify alone still lose depth fights on 5× slopes because Ground
 *   triangles are a different triangulation than the ribbon. When a vert falls
 *   under a road corridor we lower it by ROAD_TRENCH_M so asphalt sits in a
 *   shallow dug channel. sampleHeight() is untouched — Car / Buildings still
 *   pin to the sampler; only this visual mesh is depressed.
 */
export function Ground({ heightGrid, roadTrenchWays = [] }: GroundProps) {
  const [diff, nor] = useTexture(
    [
      '/textures/aerial_grass_rock_diff_1k.jpg',
      '/textures/aerial_grass_rock_nor_gl_1k.jpg',
    ],
    prepMaps,
  )

  const { geometry, centerX, centerZ, size, floorY } = useMemo(() => {
    const { originX, originZ, cellSize, cols, rows } = heightGrid
    const sizeX = cellSize * Math.max(1, cols - 1)
    const sizeZ = cellSize * Math.max(1, rows - 1)
    const size = Math.max(sizeX, sizeZ)
    const centerX = originX + sizeX * 0.5
    const centerZ = originZ + sizeZ * 0.5

    // Match grid resolution so each vertex lands on a sample (no extra blur).
    const segX = Math.max(1, cols - 1)
    const segZ = Math.max(1, rows - 1)
    const geo = new THREE.PlaneGeometry(sizeX, sizeZ, segX, segZ)
    geo.rotateX(-Math.PI / 2)

    const pos = geo.attributes.position
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + centerX
      const z = pos.getZ(i) + centerZ
      const y = sampleHeight(heightGrid, x, z)
      const trench = trenchDepressionAt(x, z, roadTrenchWays)
      pos.setY(i, y - trench)
    }
    pos.needsUpdate = true
    geo.computeVertexNormals()

    // Safety floor under the lowest hill sample.
    const floorY = heightGrid.minRel - GROUND_HALF_H * 2

    return { geometry: geo, centerX, centerZ, size, floorY }
  }, [heightGrid, roadTrenchWays])

  const tiles = Math.max(4, size / GRASS_REPEAT_M)
  diff.repeat.set(tiles, tiles)
  nor.repeat.set(tiles, tiles)

  const half = size * 0.5

  return (
    <>
      {/* Visual terrain — displaced mesh, no collider (car pins Y). renderOrder 0
          so Road (2+) paints after; no polygonOffset fight with asphalt. */}
      <mesh
        geometry={geometry}
        position={[centerX, 0, centerZ]}
        receiveShadow
        renderOrder={0}
      >
        <meshStandardMaterial
          map={diff}
          normalMap={nor}
          // Soft green multiply — albedo is already grassy; tint sells “lawn” under sun.
          color="#c8e6a8"
          roughness={0.95}
          metalness={0}
        />
      </mesh>

      {/* Deep flat safety slab under the lowest point (catch falls if pin fails). */}
      <RigidBody type="fixed" colliders={false} position={[centerX, floorY, centerZ]}>
        <CuboidCollider
          args={[half, GROUND_HALF_H, half]}
          position={[0, -GROUND_HALF_H, 0]}
          friction={1.2}
          restitution={0}
        />
      </RigidBody>
    </>
  )
}
