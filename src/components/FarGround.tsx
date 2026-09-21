import { useMemo } from 'react'
import { useTexture } from '@react-three/drei'
import * as THREE from 'three'
import {
  FAR_BLEND_M,
  sampleHeight,
  type HeightGrid,
} from '../lib/terrarium'
import { trenchDepressionAt } from '../lib/roadHeights'
import type { RoadSurfaceWay } from '../lib/roadSurface'

/**
 * Visual-only far LOD terrain ring (skyline / distant mountains).
 *
 * LEARNING NOTE:
 *   The near Ground mesh only covers the street bbox + ~40 m pad — fine for
 *   driving, empty for a chase-cam horizon. This second mesh samples a coarse
 *   height grid out ~8–15 km (see FAR_TERRAIN_RADIUS_M) so Ridgecrest can show
 *   El Paso Mtns / Sierra silhouette. NO Rapier colliders — the car never
 *   drives out here; pinning Y on the near grid is enough.
 *
 * Soft blend: inside the near AABB we skip (hole). In a FAR_BLEND_M band we
 * lerp toward near sampleHeight so the seam is not a cliff.
 *
 * Road trench: in the blend ring, nearY can still cover edge ribbons. Apply
 * the same corridor dig so FarGround doesn’t flash bare dirt over asphalt there.
 */

const GRASS_REPEAT_M = 80

type FarGroundProps = {
  nearGrid: HeightGrid
  farGrid: HeightGrid
  roadTrenchWays?: RoadSurfaceWay[]
}

function prepMaps(textures: THREE.Texture | THREE.Texture[]) {
  const list = Array.isArray(textures) ? textures : [textures]
  for (const t of list) {
    t.wrapS = THREE.RepeatWrapping
    t.wrapT = THREE.RepeatWrapping
    t.anisotropy = 4
  }
  list[0].colorSpace = THREE.SRGBColorSpace
}

function nearExtent(grid: HeightGrid): {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
} {
  const sizeX = grid.cellSize * Math.max(1, grid.cols - 1)
  const sizeZ = grid.cellSize * Math.max(1, grid.rows - 1)
  return {
    minX: grid.originX,
    maxX: grid.originX + sizeX,
    minZ: grid.originZ,
    maxZ: grid.originZ + sizeZ,
  }
}

/** 0 = fully near / hole, 1 = fully far. */
function farBlendWeight(
  x: number,
  z: number,
  near: { minX: number; maxX: number; minZ: number; maxZ: number },
  blendM: number,
): number {
  // Signed distance outside the near AABB (positive = outside).
  const dx = Math.max(near.minX - x, 0, x - near.maxX)
  const dz = Math.max(near.minZ - z, 0, z - near.maxZ)
  const outside = Math.hypot(dx, dz)
  if (outside <= 0) return 0 // inside near box → hole / use near only
  if (outside >= blendM) return 1
  // Smoothstep for a soft seam.
  const t = outside / blendM
  return t * t * (3 - 2 * t)
}

export function FarGround({
  nearGrid,
  farGrid,
  roadTrenchWays = [],
}: FarGroundProps) {
  // Same grass family as near Ground — far ring was reading as desert sand.
  const [diff, nor] = useTexture(
    [
      '/textures/aerial_grass_rock_diff_1k.jpg',
      '/textures/aerial_grass_rock_nor_gl_1k.jpg',
    ],
    prepMaps,
  )

  const { geometry, centerX, centerZ, size } = useMemo(() => {
    const { originX, originZ, cellSize, cols, rows } = farGrid
    const sizeX = cellSize * Math.max(1, cols - 1)
    const sizeZ = cellSize * Math.max(1, rows - 1)
    const size = Math.max(sizeX, sizeZ)
    const centerX = originX + sizeX * 0.5
    const centerZ = originZ + sizeZ * 0.5
    const near = nearExtent(nearGrid)

    const segX = Math.max(1, cols - 1)
    const segZ = Math.max(1, rows - 1)
    const geo = new THREE.PlaneGeometry(sizeX, sizeZ, segX, segZ)
    geo.rotateX(-Math.PI / 2)

    const pos = geo.attributes.position
    const keep: boolean[] = new Array(pos.count)
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + centerX
      const z = pos.getZ(i) + centerZ
      const w = farBlendWeight(x, z, near, FAR_BLEND_M)
      keep[i] = w > 0.02
      const farY = sampleHeight(farGrid, x, z)
      // Dig only the near-influenced contribution so blend-ring ribbons stay clear.
      const trench = trenchDepressionAt(x, z, roadTrenchWays) * (1 - w)
      if (w <= 0) {
        // Inside near: match near height (hidden under near Ground).
        pos.setY(i, sampleHeight(nearGrid, x, z) - 0.15 - trench)
      } else if (w >= 1) {
        pos.setY(i, farY)
      } else {
        const nearY = sampleHeight(nearGrid, x, z)
        pos.setY(i, nearY * (1 - w) + farY * w - trench)
      }
    }
    pos.needsUpdate = true

    // Rebuild index: drop triangles whose three verts are deep inside near.
    const idx = geo.index
    if (idx) {
      const src = idx.array
      const out: number[] = []
      for (let t = 0; t < src.length; t += 3) {
        const a = src[t]
        const b = src[t + 1]
        const c = src[t + 2]
        // Keep triangle if any vertex is in the far/blend zone.
        if (keep[a] || keep[b] || keep[c]) {
          out.push(a, b, c)
        }
      }
      geo.setIndex(out)
    }

    geo.computeVertexNormals()
    return { geometry: geo, centerX, centerZ, size }
  }, [nearGrid, farGrid, roadTrenchWays])

  const tiles = Math.max(8, size / GRASS_REPEAT_M)
  diff.repeat.set(tiles, tiles)
  nor.repeat.set(tiles, tiles)

  return (
    <mesh
      geometry={geometry}
      position={[centerX, 0, centerZ]}
      receiveShadow
      // Behind near Ground (0) and Road (2+); positive offset pushes into depth.
      renderOrder={-1}
    >
      <meshStandardMaterial
        map={diff}
        normalMap={nor}
        roughness={0.98}
        metalness={0}
        // Slightly cooler / muted so distant ring reads as haze skyline.
        color="#b7c99a"
        polygonOffset
        polygonOffsetFactor={2}
        polygonOffsetUnits={2}
      />
    </mesh>
  )
}
