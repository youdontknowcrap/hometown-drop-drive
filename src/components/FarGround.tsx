import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useTexture } from '@react-three/drei'
import * as THREE from 'three'
import {
  FAR_BLEND_M,
  sampleHeight,
  type HeightGrid,
} from '../lib/terrarium'
import { trenchDepressionAt } from '../lib/roadHeights'
import type { RoadSurfaceWay } from '../lib/roadSurface'
import { ELEV_APPLY_BUDGET_MS, ELEV_APPLY_CHUNK } from '../lib/elevMorph'

/**
 * Visual-only far LOD terrain ring (skyline / distant mountains).
 *
 * LEARNING NOTE:
 *   The near Ground mesh only covers the street bbox + pad — fine for
 *   driving, empty for a chase-cam horizon. This second mesh samples a coarse
 *   height grid out ~8–15 km (see FAR_TERRAIN_RADIUS_M) so Ridgecrest can show
 *   El Paso Mtns / Sierra silhouette. NO Rapier colliders — the car never
 *   drives out here; pinning Y on the near grid is enough.
 *
 * LEARNING — animated far recenter (Joey):
 *   Hard-swapping farGrid (or rebuilding whenever nearGrid identity changed)
 *   was a second hitch on every sliding near elev apply. Keep geometry stable
 *   across near morph ticks; only rebuild on farTopologyGen. Blend seam reads
 *   nearGrid from a ref each budgeted vert pass. Far morph lerps heights so
 *   recenter fades instead of hard-cutting the skyline.
 */

const GRASS_REPEAT_M = 80

type FarGroundProps = {
  nearGrid: HeightGrid
  farGrid: HeightGrid
  roadTrenchWays?: RoadSurfaceWay[]
  /** Bumps when far PlaneGeometry must rebuild (Drop / far resolution). */
  farTopologyGen: number
  elevBlending: boolean
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
  const dx = Math.max(near.minX - x, 0, x - near.maxX)
  const dz = Math.max(near.minZ - z, 0, z - near.maxZ)
  const outside = Math.hypot(dx, dz)
  if (outside <= 0) return 0
  if (outside >= blendM) return 1
  const t = outside / blendM
  return t * t * (3 - 2 * t)
}

function applyFarSlice(
  geo: THREE.BufferGeometry,
  nearGrid: HeightGrid,
  farGrid: HeightGrid,
  centerX: number,
  centerZ: number,
  roadTrenchWays: RoadSurfaceWay[],
  start: number,
  maxCount: number,
  keep: boolean[],
): number {
  const pos = geo.attributes.position as THREE.BufferAttribute
  const near = nearExtent(nearGrid)
  const end = Math.min(pos.count, start + maxCount)
  for (let i = start; i < end; i++) {
    const x = pos.getX(i) + centerX
    const z = pos.getZ(i) + centerZ
    const w = farBlendWeight(x, z, near, FAR_BLEND_M)
    keep[i] = w > 0.02
    const farY = sampleHeight(farGrid, x, z)
    const trench = trenchDepressionAt(x, z, roadTrenchWays) * (1 - w)
    if (w <= 0) {
      pos.setY(i, sampleHeight(nearGrid, x, z) - 0.15 - trench)
    } else if (w >= 1) {
      pos.setY(i, farY)
    } else {
      const nearY = sampleHeight(nearGrid, x, z)
      pos.setY(i, nearY * (1 - w) + farY * w - trench)
    }
  }
  pos.needsUpdate = true
  return end
}

export function FarGround({
  nearGrid,
  farGrid,
  roadTrenchWays = [],
  farTopologyGen,
  elevBlending,
}: FarGroundProps) {
  const [diff, nor] = useTexture(
    [
      '/textures/aerial_grass_rock_diff_1k.jpg',
      '/textures/aerial_grass_rock_nor_gl_1k.jpg',
    ],
    prepMaps,
  )

  const nearRef = useRef(nearGrid)
  nearRef.current = nearGrid
  const farRef = useRef(farGrid)
  farRef.current = farGrid
  const trenchRef = useRef(roadTrenchWays)
  trenchRef.current = roadTrenchWays

  const applyCursorRef = useRef(0)
  const needsNormalsRef = useRef(false)
  const dirtyRef = useRef(true)
  const keepRef = useRef<boolean[]>([])
  const denseIndexRef = useRef<Uint32Array | null>(null)
  const coverageKeyRef = useRef('')

  const layout = useMemo(() => {
    const { originX, originZ, cellSize, cols, rows } = farGrid
    const sizeX = cellSize * Math.max(1, cols - 1)
    const sizeZ = cellSize * Math.max(1, rows - 1)
    return {
      originX,
      originZ,
      cellSize,
      cols,
      rows,
      sizeX,
      sizeZ,
      size: Math.max(sizeX, sizeZ),
      centerX: originX + sizeX * 0.5,
      centerZ: originZ + sizeZ * 0.5,
    }
  }, [farGrid])

  const geometry = useMemo(() => {
    const segX = Math.max(1, layout.cols - 1)
    const segZ = Math.max(1, layout.rows - 1)
    const geo = new THREE.PlaneGeometry(layout.sizeX, layout.sizeZ, segX, segZ)
    geo.rotateX(-Math.PI / 2)
    keepRef.current = new Array(geo.attributes.position.count)
    denseIndexRef.current = null
    coverageKeyRef.current = `${layout.originX},${layout.originZ},${layout.cellSize}`
    applyCursorRef.current = 0
    dirtyRef.current = true
    return geo
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [farTopologyGen])

  // Far recenter moves origin — rewrite XZ in place (same FAR_GRID_RES).
  useEffect(() => {
    const key = `${layout.originX},${layout.originZ},${layout.cellSize}`
    if (coverageKeyRef.current === key) return
    coverageKeyRef.current = key
    const segX = Math.max(1, layout.cols - 1)
    const segZ = Math.max(1, layout.rows - 1)
    const fresh = new THREE.PlaneGeometry(layout.sizeX, layout.sizeZ, segX, segZ)
    fresh.rotateX(-Math.PI / 2)
    const dst = geometry.attributes.position as THREE.BufferAttribute
    const src = fresh.attributes.position as THREE.BufferAttribute
    if (dst.count === src.count) {
      for (let i = 0; i < dst.count; i++) {
        dst.setXYZ(i, src.getX(i), src.getY(i), src.getZ(i))
      }
      dst.needsUpdate = true
    }
    fresh.dispose()
    keepRef.current = new Array(dst.count)
    denseIndexRef.current = null
    applyCursorRef.current = 0
    dirtyRef.current = true
  }, [layout, geometry])

  useEffect(() => {
    dirtyRef.current = true
    applyCursorRef.current = 0
  }, [farGrid, nearGrid, elevBlending, roadTrenchWays])

  useFrame(() => {
    if (!dirtyRef.current && !elevBlending) return
    const start = performance.now()
    let cursor = applyCursorRef.current
    const pos = geometry.attributes.position as THREE.BufferAttribute
    const keep = keepRef.current
    while (
      cursor < pos.count &&
      performance.now() - start < ELEV_APPLY_BUDGET_MS
    ) {
      cursor = applyFarSlice(
        geometry,
        nearRef.current,
        farRef.current,
        layout.centerX,
        layout.centerZ,
        trenchRef.current,
        cursor,
        ELEV_APPLY_CHUNK,
        keep,
      )
    }
    applyCursorRef.current = cursor
    if (cursor >= pos.count) {
      applyCursorRef.current = 0
      // Hole inside near AABB — filter from cached dense PlaneGeometry index.
      let dense = denseIndexRef.current
      if (!dense || dense.length === 0) {
        const segX = Math.max(1, layout.cols - 1)
        const segZ = Math.max(1, layout.rows - 1)
        const tmp = new THREE.PlaneGeometry(layout.sizeX, layout.sizeZ, segX, segZ)
        tmp.rotateX(-Math.PI / 2)
        dense = tmp.index ? Uint32Array.from(tmp.index.array) : new Uint32Array()
        tmp.dispose()
        denseIndexRef.current = dense
      }
      const out: number[] = []
      for (let t = 0; t < dense.length; t += 3) {
        const a = dense[t]
        const b = dense[t + 1]
        const c = dense[t + 2]
        if (keep[a] || keep[b] || keep[c]) out.push(a, b, c)
      }
      geometry.setIndex(out)
      needsNormalsRef.current = true
      if (!elevBlending) dirtyRef.current = false
    }
    if (
      needsNormalsRef.current &&
      performance.now() - start < ELEV_APPLY_BUDGET_MS
    ) {
      geometry.computeVertexNormals()
      needsNormalsRef.current = false
    }
  })

  useEffect(
    () => () => {
      geometry.dispose()
    },
    [geometry],
  )

  const tiles = Math.max(8, layout.size / GRASS_REPEAT_M)
  diff.repeat.set(tiles, tiles)
  nor.repeat.set(tiles, tiles)

  return (
    <mesh
      geometry={geometry}
      position={[layout.centerX, 0, layout.centerZ]}
      receiveShadow
      renderOrder={-1}
    >
      <meshStandardMaterial
        map={diff}
        normalMap={nor}
        roughness={0.98}
        metalness={0}
        color="#b7c99a"
        polygonOffset
        polygonOffsetFactor={2}
        polygonOffsetUnits={2}
      />
    </mesh>
  )
}
