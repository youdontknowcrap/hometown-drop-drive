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
 * Paved = darker asphalt + lane paint + edge curbs (reads vs desert).
 * Dirt tracks = narrow brown, no paint — not China Lake Blvd.
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
        const mesh = buildRoadRibbon(path, width, 0.1)
        if (mesh) dirt.push(mesh)
        continue
      }

      const bucket = street.kind === 'service' ? service : paved
      const y = street.kind === 'service' ? 0.085 : 0.1
      const ribbon = buildRoadRibbon(path, width, y)
      if (ribbon) bucket.ribbon.push(ribbon)

      const curb = buildEdgeCurb(path, width, street.kind === 'service' ? 0.22 : 0.4, y + 0.01)
      if (curb) bucket.curb.push(curb)

      // Lane paint on longer paved roads only (not tiny service stubs).
      if (street.kind === 'paved' && localPathLengthMeters(path) >= 28) {
        const paint = buildLanePaint(path, width, y + 0.02)
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
        <mesh geometry={built.pavedRibbon} receiveShadow>
          {/* Dark cool multiply so Poly Haven asphalt reads as road, not desert. */}
          <meshStandardMaterial
            map={diff}
            normalMap={nor}
            color="#2a2c30"
            roughness={0.88}
            metalness={0}
          />
        </mesh>
      ) : null}
      {built.pavedCurb ? (
        <mesh geometry={built.pavedCurb} receiveShadow>
          <meshStandardMaterial
            color="#151618"
            roughness={0.95}
            metalness={0}
            side={THREE.DoubleSide}
          />
        </mesh>
      ) : null}
      {built.pavedPaint ? (
        <mesh geometry={built.pavedPaint}>
          <meshStandardMaterial
            color="#f7f7f0"
            emissive="#3a3a30"
            emissiveIntensity={0.15}
            roughness={0.55}
            metalness={0}
            polygonOffset
            polygonOffsetFactor={-2}
          />
        </mesh>
      ) : null}

      {built.serviceRibbon ? (
        <mesh geometry={built.serviceRibbon} receiveShadow>
          <meshStandardMaterial
            map={diff}
            normalMap={nor}
            color="#3a3836"
            roughness={0.92}
            metalness={0}
          />
        </mesh>
      ) : null}
      {built.serviceCurb ? (
        <mesh geometry={built.serviceCurb} receiveShadow>
          <meshStandardMaterial
            color="#1a1816"
            roughness={0.95}
            metalness={0}
            side={THREE.DoubleSide}
          />
        </mesh>
      ) : null}

      {built.dirtRibbon ? (
        <mesh geometry={built.dirtRibbon} receiveShadow>
          <meshStandardMaterial
            color="#7a5a3a"
            roughness={1}
            metalness={0}
          />
        </mesh>
      ) : null}
    </group>
  )
}
