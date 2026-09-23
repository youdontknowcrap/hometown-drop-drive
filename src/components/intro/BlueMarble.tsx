/**
 * BlueMarble — intro Earth for first-run entry (Joey north star).
 *
 * LEARNING:
 *   Cold boot must NOT Drop into Ridgecrest. This R3F globe is the quiet
 *   “where do you want to start?” stage. We stay in the existing three.js /
 *   @react-three/fiber stack (same as Scene) so we don’t bolt on a second
 *   renderer. Continents are a cheap CanvasTexture (no NASA fetch / CORS),
 *   with a Fresnel-ish atmosphere shell + drei Stars for depth.
 *
 * Optional zoom: when `target` (geocoded lat/lng) arrives, the camera eases
 * toward that surface point before the parent swaps to the driving Scene.
 */

import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Stars } from '@react-three/drei'
import * as THREE from 'three'

export type MarbleTarget = { lat: number; lng: number }

type BlueMarbleProps = {
  /** Geocode hit — camera slowly approaches this lon/lat on the sphere. */
  target?: MarbleTarget | null
  /** 0..1 progress driven by IntroScreen after a successful geocode. */
  zoomProgress?: number
}

/** WGS84-ish lon/lat → unit sphere (Y up, matching three.js). */
function latLngToUnit(lat: number, lng: number): THREE.Vector3 {
  const phi = ((90 - lat) * Math.PI) / 180
  const theta = ((lng + 180) * Math.PI) / 180
  return new THREE.Vector3(
    -Math.sin(phi) * Math.cos(theta),
    Math.cos(phi),
    Math.sin(phi) * Math.sin(theta),
  )
}

/**
 * Paint a soft “blue marble” onto a canvas — oceans + fuzzy land blobs.
 * Teaching: procedural texture keeps the intro offline-friendly and free of
 * third-party tile URLs; detail is intentionally low (mood, not cartography).
 */
function makeEarthCanvasTexture(): THREE.CanvasTexture {
  const size = 512
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  // Deep ocean base.
  ctx.fillStyle = '#0b3d91'
  ctx.fillRect(0, 0, size, size)

  // Soft continent-ish blobs (not geographically accurate — vibe only).
  const blobs: Array<[number, number, number, string]> = [
    [0.22, 0.38, 0.14, '#2e7d32'], // Americas-ish
    [0.28, 0.55, 0.08, '#558b2f'],
    [0.52, 0.32, 0.16, '#33691e'], // Eurasia-ish
    [0.58, 0.48, 0.1, '#6d4c41'], // Africa-ish
    [0.72, 0.62, 0.09, '#558b2f'], // Aus-ish
    [0.48, 0.72, 0.07, '#8d6e63'], // Antarctica-ish
    [0.15, 0.22, 0.06, '#eceff1'], // ice
    [0.55, 0.18, 0.05, '#eceff1'],
  ]
  for (const [ux, uy, r, color] of blobs) {
    const g = ctx.createRadialGradient(
      ux * size,
      uy * size,
      0,
      ux * size,
      uy * size,
      r * size,
    )
    g.addColorStop(0, color)
    g.addColorStop(0.65, color)
    g.addColorStop(1, 'rgba(11,61,145,0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(ux * size, uy * size, r * size, 0, Math.PI * 2)
    ctx.fill()
  }

  // Cloud wisps — lighten a few bands.
  ctx.globalAlpha = 0.18
  ctx.fillStyle = '#e3f2fd'
  for (let i = 0; i < 18; i++) {
    const y = (i / 18) * size + Math.sin(i * 2.1) * 12
    ctx.fillRect(0, y, size, 6 + (i % 3) * 3)
  }
  ctx.globalAlpha = 1

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

export function BlueMarble({ target = null, zoomProgress = 0 }: BlueMarbleProps) {
  const earthRef = useRef<THREE.Mesh>(null)
  const atmoRef = useRef<THREE.Mesh>(null)
  const groupRef = useRef<THREE.Group>(null)
  const pinRef = useRef<THREE.Mesh>(null)

  const earthMap = useMemo(() => makeEarthCanvasTexture(), [])

  useEffect(() => {
    return () => {
      earthMap.dispose()
    }
  }, [earthMap])

  useFrame((_, dt) => {
    // Idle spin until zoom starts; then ease camera via parent zoomProgress.
    if (groupRef.current && zoomProgress < 0.05) {
      groupRef.current.rotation.y += dt * 0.08
    }
    if (atmoRef.current) {
      atmoRef.current.rotation.y -= dt * 0.02
    }
  })

  // Place a small marker on the geocoded point (teaching: lat/lng on a sphere).
  useEffect(() => {
    if (!pinRef.current || !target) return
    const p = latLngToUnit(target.lat, target.lng).multiplyScalar(1.02)
    pinRef.current.position.copy(p)
    pinRef.current.visible = true
  }, [target])

  // Camera approaches the target surface as zoomProgress → 1.
  useFrame(({ camera }) => {
    const idle = new THREE.Vector3(0, 0.35, 3.2)
    if (!target || zoomProgress <= 0) {
      camera.position.lerp(idle, 0.08)
      camera.lookAt(0, 0, 0)
      return
    }
    const surface = latLngToUnit(target.lat, target.lng)
    // From far (3.2) toward near-surface (~1.35) along the ray from origin.
    const dist = THREE.MathUtils.lerp(3.2, 1.35, zoomProgress)
    const goal = surface.clone().multiplyScalar(dist)
    // Keep a slight “above” bias so we don’t stare edge-on.
    goal.y += THREE.MathUtils.lerp(0.35, 0.12, zoomProgress)
    camera.position.lerp(goal, 0.12)
    camera.lookAt(surface.clone().multiplyScalar(0.9))
  })

  return (
    <group ref={groupRef}>
      <Stars radius={80} depth={40} count={2500} factor={3} saturation={0} fade speed={0.4} />

      {/* Soft fill so the night side isn’t pure black. */}
      <ambientLight intensity={0.35} />
      <directionalLight position={[5, 2, 3]} intensity={1.35} color="#fff6e8" />
      <directionalLight position={[-3, -1, -2]} intensity={0.25} color="#82b1ff" />

      {/* Earth */}
      <mesh ref={earthRef}>
        <sphereGeometry args={[1, 64, 64]} />
        <meshStandardMaterial
          map={earthMap}
          roughness={0.72}
          metalness={0.08}
          emissive="#021631"
          emissiveIntensity={0.15}
        />
      </mesh>

      {/* Atmosphere shell — additive blue rim. */}
      <mesh ref={atmoRef} scale={1.045}>
        <sphereGeometry args={[1, 48, 48]} />
        <meshBasicMaterial
          color="#4fc3f7"
          transparent
          opacity={0.14}
          side={THREE.BackSide}
          depthWrite={false}
        />
      </mesh>
      <mesh scale={1.08}>
        <sphereGeometry args={[1, 32, 32]} />
        <meshBasicMaterial
          color="#81d4fa"
          transparent
          opacity={0.06}
          side={THREE.BackSide}
          depthWrite={false}
        />
      </mesh>

      {/* Drop pin (hidden until geocode). */}
      <mesh ref={pinRef} visible={false}>
        <sphereGeometry args={[0.025, 16, 16]} />
        <meshBasicMaterial color="#ff5252" />
      </mesh>
    </group>
  )
}
