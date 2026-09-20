import { useEffect, useMemo } from 'react'
import { useTexture } from '@react-three/drei'
import * as THREE from 'three'
import {
  buildEdgeCurb,
  buildLanePaint,
  buildRoadRibbon,
  localPathLengthMeters,
  mergeMeshArrays,
  type MeshArrays,
  type XzPoint,
} from '../lib/roadMesh'
import { widthForHighway, type StreetKind } from '../lib/osmStreets'

export type LocalStreet = {
  points: XzPoint[]
  kind: StreetKind
  highway: string
}

type RoadProps = {
  streets: LocalStreet[]
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

/**
 * OSM streets as asphalt / service / dirt ribbons.
 * Paved = dark asphalt band + lane paint + edge curbs (must read vs desert).
 * Dirt tracks = narrow brown, no paint.
 *
 * Playtest: only black curb lines showed — fill was camouflaged / hard to
 * read. Ribbons are raised, DoubleSide, and multiply a near-black tint so the
 * paved band is obvious even when the albedo map is mid-gray.
 */
export function Road({ streets }: RoadProps) {
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
      const path = street.points
      if (street.kind === 'dirt') {
        const mesh = buildRoadRibbon(path, width, 0.12)
        if (mesh) dirt.push(mesh)
        continue
      }

      const bucket = street.kind === 'service' ? service : paved
      // Keep paved clearly above the desert plane (y=0) to avoid z-fight.
      const y = street.kind === 'service' ? 0.12 : 0.14
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
      if (street.kind === 'paved' && localPathLengthMeters(path) >= 28) {
        const paint = buildLanePaint(path, width, y + 0.025)
        if (paint) bucket.paint.push(paint)
      }
    }

    return {
      pavedRibbon: arraysToGeometry(mergeMeshArrays(paved.ribbon)),
      pavedPaint: arraysToGeometry(mergeMeshArrays(paved.paint)),
      pavedCurb: arraysToGeometry(mergeMeshArrays(paved.curb)),
      serviceRibbon: arraysToGeometry(mergeMeshArrays(service.ribbon)),
      serviceCurb: arraysToGeometry(mergeMeshArrays(service.curb)),
      dirtRibbon: arraysToGeometry(mergeMeshArrays(dirt)),
    }
  }, [streets])

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
        <mesh geometry={built.pavedRibbon} receiveShadow renderOrder={1}>
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
            polygonOffsetFactor={-1}
            polygonOffsetUnits={-1}
          />
        </mesh>
      ) : null}
      {built.pavedCurb ? (
        <mesh geometry={built.pavedCurb} receiveShadow renderOrder={2}>
          <meshStandardMaterial
            color="#0a0a0c"
            roughness={0.95}
            metalness={0}
            side={THREE.DoubleSide}
          />
        </mesh>
      ) : null}
      {built.pavedPaint ? (
        <mesh geometry={built.pavedPaint} renderOrder={3}>
          <meshStandardMaterial
            color="#f7f7f0"
            emissive="#3a3a30"
            emissiveIntensity={0.15}
            roughness={0.55}
            metalness={0}
            polygonOffset
            polygonOffsetFactor={-2}
            side={THREE.DoubleSide}
          />
        </mesh>
      ) : null}

      {built.serviceRibbon ? (
        <mesh geometry={built.serviceRibbon} receiveShadow renderOrder={1}>
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
            polygonOffsetFactor={-1}
          />
        </mesh>
      ) : null}
      {built.serviceCurb ? (
        <mesh geometry={built.serviceCurb} receiveShadow renderOrder={2}>
          <meshStandardMaterial
            color="#12100e"
            roughness={0.95}
            metalness={0}
            side={THREE.DoubleSide}
          />
        </mesh>
      ) : null}

      {built.dirtRibbon ? (
        <mesh geometry={built.dirtRibbon} receiveShadow renderOrder={1}>
          <meshStandardMaterial
            color="#6b4a2e"
            roughness={1}
            metalness={0}
            side={THREE.DoubleSide}
          />
        </mesh>
      ) : null}
    </group>
  )
}
