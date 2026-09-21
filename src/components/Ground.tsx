import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useTexture } from '@react-three/drei'
import { RigidBody, CuboidCollider } from '@react-three/rapier'
import * as THREE from 'three'
import { sampleHeight, type HeightGrid } from '../lib/terrarium'
import { trenchDepressionAt } from '../lib/roadHeights'
import type { RoadSurfaceWay } from '../lib/roadSurface'
import { ELEV_APPLY_BUDGET_MS, ELEV_APPLY_CHUNK } from '../lib/elevMorph'

/** World-meter grass playfield. 1 UV tile = 20 m so speed is visible off-road too. */
const GRASS_REPEAT_M = 20

/**
 * Flat-fallback slab half-thickness (meters). Visual plane sits on top.
 * When Terrarium data is present we still keep a deep floor under the
 * *minimum* relative height as a safety net; the car primarily pins Y from
 * sampleHeight (see Car.tsx) so hills don't need a fragile heightfield CCD.
 */
const GROUND_HALF_H = 0.5

/**
 * Debounce trench re-dig when streamed streets arrive. LEARNING: rebuilding
 * the whole PlaneGeometry on every activeWays change was a second hitch per
 * tile (after Road). Elev morph updates Y in place; trench-only updates wait
 * this quiet window so Drop’s ring can settle.
 */
const TRENCH_DEBOUNCE_MS = 280

type GroundProps = {
  heightGrid: HeightGrid
  /**
   * Widened road corridors for the grass trench pass (see buildRoadTrenchWays).
   * Empty → no trench (flat / loading).
   */
  roadTrenchWays?: RoadSurfaceWay[]
  /**
   * Bumps only when cols/rows change or Drop resets (PlaneGeometry rebuild).
   * Height-only morphs leave this stable so we mutate Y in place.
   */
  topologyGen: number
  /** True while elevMorph is lerping — keep applying live heights each frame. */
  elevBlending: boolean
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
 * Apply height samples + trench to a slice of verts. Returns next start index.
 * LEARNING — budget: 96×96 + computeVertexNormals in one React commit froze
 * the tab (“elevation adjusting”). Chunk across rAF instead.
 */
function applyHeightsSlice(
  geo: THREE.BufferGeometry,
  heightGrid: HeightGrid,
  centerX: number,
  centerZ: number,
  roadTrenchWays: RoadSurfaceWay[],
  start: number,
  maxCount: number,
): number {
  const pos = geo.attributes.position as THREE.BufferAttribute
  const end = Math.min(pos.count, start + maxCount)
  for (let i = start; i < end; i++) {
    const x = pos.getX(i) + centerX
    const z = pos.getZ(i) + centerZ
    const y = sampleHeight(heightGrid, x, z)
    const trench = trenchDepressionAt(x, z, roadTrenchWays)
    pos.setY(i, y - trench)
  }
  pos.needsUpdate = true
  return end
}

/**
 * Textured grass displaced by Terrarium/SRTM heights (or flat fallback).
 *
 * LEARNING — animated elev adjust (Joey):
 *   Do NOT recreate PlaneGeometry on every HeightGrid identity swap. Same
 *   topologyGen → keep geometry, morph vertex Y from the live morph grid in
 *   budgeted chunks. Coverage slides (origin/cellSize) rewrite XZ once, then
 *   morph Y. Avoids remount/rerender storms when sliding elev settles.
 */
export function Ground({
  heightGrid,
  roadTrenchWays = [],
  topologyGen,
  elevBlending,
}: GroundProps) {
  const [diff, nor] = useTexture(
    [
      '/textures/aerial_grass_rock_diff_1k.jpg',
      '/textures/aerial_grass_rock_nor_gl_1k.jpg',
    ],
    prepMaps,
  )

  const trenchRef = useRef(roadTrenchWays)
  trenchRef.current = roadTrenchWays
  const gridRef = useRef(heightGrid)
  gridRef.current = heightGrid

  const applyCursorRef = useRef(0)
  const needsNormalsRef = useRef(false)
  const dirtyRef = useRef(true)
  const coverageKeyRef = useRef('')

  const layout = useMemo(() => {
    const { originX, originZ, cellSize, cols, rows, minRel } = heightGrid
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
      floorY: minRel - GROUND_HALF_H * 2,
    }
  }, [heightGrid])

  // Rebuild PlaneGeometry only on topologyGen (Drop / resolution change).
  const geometry = useMemo(() => {
    const segX = Math.max(1, layout.cols - 1)
    const segZ = Math.max(1, layout.rows - 1)
    const geo = new THREE.PlaneGeometry(layout.sizeX, layout.sizeZ, segX, segZ)
    geo.rotateX(-Math.PI / 2)
    coverageKeyRef.current = `${layout.originX},${layout.originZ},${layout.cellSize}`
    applyCursorRef.current = 0
    dirtyRef.current = true
    return geo
    // layout cols/rows baked into topologyGen; size taken at rebuild time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topologyGen])

  // Coverage slide (same resolution, new origin/cellSize): rewrite XZ in place.
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
    applyCursorRef.current = 0
    dirtyRef.current = true
  }, [layout, geometry])

  useEffect(() => {
    dirtyRef.current = true
    applyCursorRef.current = 0
  }, [heightGrid, elevBlending])

  useFrame(() => {
    if (!dirtyRef.current && !elevBlending) return
    const grid = gridRef.current
    const start = performance.now()
    let cursor = applyCursorRef.current
    const pos = geometry.attributes.position as THREE.BufferAttribute
    while (
      cursor < pos.count &&
      performance.now() - start < ELEV_APPLY_BUDGET_MS
    ) {
      cursor = applyHeightsSlice(
        geometry,
        grid,
        layout.centerX,
        layout.centerZ,
        trenchRef.current,
        cursor,
        ELEV_APPLY_CHUNK,
      )
    }
    applyCursorRef.current = cursor
    if (cursor >= pos.count) {
      applyCursorRef.current = 0
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

  // Streaming streets: re-dig trench after a quiet window (in-place, budgeted).
  useEffect(() => {
    const timer = window.setTimeout(() => {
      dirtyRef.current = true
      applyCursorRef.current = 0
    }, TRENCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [roadTrenchWays])

  useEffect(
    () => () => {
      geometry.dispose()
    },
    [geometry],
  )

  const tiles = Math.max(4, layout.size / GRASS_REPEAT_M)
  diff.repeat.set(tiles, tiles)
  nor.repeat.set(tiles, tiles)

  const half = layout.size * 0.5

  return (
    <>
      {/* Visual terrain — displaced mesh, no collider (car pins Y). renderOrder 0
          so Road (2+) paints after; no polygonOffset fight with asphalt. */}
      <mesh
        geometry={geometry}
        position={[layout.centerX, 0, layout.centerZ]}
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
      <RigidBody
        type="fixed"
        colliders={false}
        position={[layout.centerX, layout.floorY, layout.centerZ]}
      >
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
