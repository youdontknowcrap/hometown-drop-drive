import { useEffect, useMemo } from 'react'
import { useTexture } from '@react-three/drei'
import * as THREE from 'three'
import {
  buildEdgeCurb,
  buildLanePaint,
  buildRoadRibbon,
  densifyPath,
  localPathLengthMeters,
  mergeMeshArrays,
  type MeshArrays,
  type XzPoint,
} from '../lib/roadMesh'
import { widthForHighway, type StreetKind } from '../lib/osmStreets'
import {
  ROAD_DENSIFY_CELL_FRAC,
  ROAD_Y_BIAS_M,
} from '../lib/roadHeights'
import { sampleHeight, type HeightGrid } from '../lib/terrarium'

export type LocalStreet = {
  points: XzPoint[]
  kind: StreetKind
  highway: string
  /** OSM name (optional) — floating 3D labels. */
  name?: string
  /** OSM ref fallback for numbered roads. */
  ref?: string
}

type RoadProps = {
  streets: LocalStreet[]
  /** Terrarium (or flat) — ribbons are draped so asphalt follows hills. */
  heightGrid: HeightGrid
}

function arraysToGeometry(built: MeshArrays | null): THREE.BufferGeometry | null {
  if (!built || built.positions.length < 9) return null
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(built.positions, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(built.uvs, 2))
  g.setAttribute('normal', new THREE.BufferAttribute(built.normals, 3))
  g.setIndex(new THREE.BufferAttribute(built.indices, 1))
  g.computeBoundingSphere()
  g.computeBoundingBox()
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

type Bucket = {
  ribbon: MeshArrays[]
  paint: MeshArrays[]
  curb: MeshArrays[]
}

function emptyBucket(): Bucket {
  return { ribbon: [], paint: [], curb: [] }
}

/** Lift every vertex by terrain height so roads follow hills (not float at y=0). */
function drapeGeometry(
  geo: THREE.BufferGeometry | null,
  grid: HeightGrid,
): THREE.BufferGeometry | null {
  if (!geo) return null
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const z = pos.getZ(i)
    // Keep the ribbon bias already baked into Y, add terrain sample.
    pos.setY(i, pos.getY(i) + sampleHeight(grid, x, z))
  }
  pos.needsUpdate = true
  // Recompute after drape — slopes change normals; DoubleSide materials keep both faces.
  geo.computeVertexNormals()
  return geo
}

/**
 * Densify OSM centerline tighter than cellSize so draped chords track 5× hills.
 * LEARNING: 1× cellSize still left mid-segment desert poking through on steep
 * Ridgecrest slopes; 0.5× puts ribbon verts on a finer hill frequency.
 */
function pathForDrape(path: XzPoint[], grid: HeightGrid): XzPoint[] {
  const maxSeg = Math.max(4, grid.cellSize * ROAD_DENSIFY_CELL_FRAC)
  return densifyPath(path, maxSeg)
}

/**
 * OSM streets as asphalt / service / dirt ribbons.
 * Paved = dark asphalt band + lane paint + edge curbs (must read vs desert).
 * Dirt tracks = narrow brown, no paint.
 * Ribbons are draped onto the Terrarium height grid so hills lift the asphalt.
 *
 * Playtest: only black curb lines showed — fill was camouflaged / hard to
 * read. Ribbons are raised, DoubleSide, and multiply a near-black tint so the
 * paved band is obvious even when the albedo map is mid-gray.
 *
 * Playtest (hills): 0.4 m bias + 1× densify still let Ground / FarGround eat
 * streets on 5× slopes. Harder fix: ~1.25 m ROAD_Y_BIAS_M, 0.5× densify,
 * stronger polygonOffset / renderOrder, plus Ground trench (see roadHeights).
 */
export function Road({ streets, heightGrid }: RoadProps) {
  const [diff, nor] = useTexture(
    ['/textures/asphalt_01_diff_1k.jpg', '/textures/asphalt_01_nor_gl_1k.jpg'],
    prepMaps,
  )

  const built = useMemo(() => {
    const paved = emptyBucket()
    const service = emptyBucket()
    const dirt: MeshArrays[] = []

    for (const street of streets) {
      const width = widthForHighway(street.highway)
      const path = pathForDrape(street.points, heightGrid)
      if (street.kind === 'dirt') {
        const mesh = buildRoadRibbon(path, width, ROAD_Y_BIAS_M)
        if (mesh) dirt.push(mesh)
        continue
      }

      const bucket = street.kind === 'service' ? service : paved
      // Service a hair lower than paved so main roads read first on z-fight.
      const y =
        street.kind === 'service' ? ROAD_Y_BIAS_M : ROAD_Y_BIAS_M + 0.05
      const ribbon = buildRoadRibbon(path, width, y)
      if (ribbon) bucket.ribbon.push(ribbon)

      const curb = buildEdgeCurb(
        path,
        width,
        street.kind === 'service' ? 0.22 : 0.4,
        y + 0.015,
      )
      if (curb) bucket.curb.push(curb)

      // Lane paint on longer paved roads only (not tiny service stubs).
      // Length from original points is fine — densify doesn't change total length.
      if (street.kind === 'paved' && localPathLengthMeters(street.points) >= 28) {
        const paint = buildLanePaint(path, width, y + 0.025)
        if (paint) bucket.paint.push(paint)
      }
    }

    // Drape after merge — asphalt follows Terrarium hills (flat grid → no-op).
    return {
      pavedRibbon: drapeGeometry(arraysToGeometry(mergeMeshArrays(paved.ribbon)), heightGrid),
      pavedPaint: drapeGeometry(arraysToGeometry(mergeMeshArrays(paved.paint)), heightGrid),
      pavedCurb: drapeGeometry(arraysToGeometry(mergeMeshArrays(paved.curb)), heightGrid),
      serviceRibbon: drapeGeometry(arraysToGeometry(mergeMeshArrays(service.ribbon)), heightGrid),
      serviceCurb: drapeGeometry(arraysToGeometry(mergeMeshArrays(service.curb)), heightGrid),
      dirtRibbon: drapeGeometry(arraysToGeometry(mergeMeshArrays(dirt)), heightGrid),
    }
  }, [streets, heightGrid])

  useEffect(
    () => () => {
      for (const g of Object.values(built)) g?.dispose()
    },
    [built],
  )

  const any =
    built.pavedRibbon ||
    built.serviceRibbon ||
    built.dirtRibbon
  if (!any) return null

  return (
    <group>
      {built.pavedRibbon ? (
        <mesh geometry={built.pavedRibbon} receiveShadow renderOrder={2}>
          <meshStandardMaterial
            map={diff}
            normalMap={nor}
            // Near-black multiply — mid-gray asphalt albedo was washing into desert.
            color="#101215"
            roughness={0.92}
            metalness={0}
            emissive="#0a0b0d"
            emissiveIntensity={0.2}
            side={THREE.DoubleSide}
            polygonOffset
            polygonOffsetFactor={-6}
            polygonOffsetUnits={-6}
            depthWrite
          />
        </mesh>
      ) : null}
      {built.pavedCurb ? (
        <mesh geometry={built.pavedCurb} receiveShadow renderOrder={3}>
          <meshStandardMaterial
            color="#0a0a0c"
            roughness={0.95}
            metalness={0}
            side={THREE.DoubleSide}
            polygonOffset
            polygonOffsetFactor={-6}
            polygonOffsetUnits={-6}
          />
        </mesh>
      ) : null}
      {built.pavedPaint ? (
        <mesh geometry={built.pavedPaint} renderOrder={4}>
          <meshStandardMaterial
            color="#f7f7f0"
            emissive="#3a3a30"
            emissiveIntensity={0.15}
            roughness={0.55}
            metalness={0}
            polygonOffset
            polygonOffsetFactor={-8}
            polygonOffsetUnits={-8}
            side={THREE.DoubleSide}
          />
        </mesh>
      ) : null}

      {built.serviceRibbon ? (
        <mesh geometry={built.serviceRibbon} receiveShadow renderOrder={2}>
          <meshStandardMaterial
            map={diff}
            normalMap={nor}
            color="#1c1a18"
            roughness={0.94}
            metalness={0}
            emissive="#0c0b0a"
            emissiveIntensity={0.15}
            side={THREE.DoubleSide}
            polygonOffset
            polygonOffsetFactor={-6}
            polygonOffsetUnits={-6}
          />
        </mesh>
      ) : null}
      {built.serviceCurb ? (
        <mesh geometry={built.serviceCurb} receiveShadow renderOrder={3}>
          <meshStandardMaterial
            color="#12100e"
            roughness={0.95}
            metalness={0}
            side={THREE.DoubleSide}
            polygonOffset
            polygonOffsetFactor={-6}
            polygonOffsetUnits={-6}
          />
        </mesh>
      ) : null}

      {built.dirtRibbon ? (
        <mesh geometry={built.dirtRibbon} receiveShadow renderOrder={2}>
          <meshStandardMaterial
            color="#6b4a2e"
            roughness={1}
            metalness={0}
            side={THREE.DoubleSide}
            polygonOffset
            polygonOffsetFactor={-6}
            polygonOffsetUnits={-6}
          />
        </mesh>
      ) : null}
    </group>
  )
}
