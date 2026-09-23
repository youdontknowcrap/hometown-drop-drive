import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { carPose } from '../lib/carPose'
import { sampleHeight, type HeightGrid } from '../lib/terrarium'
import {
  buildGatesAlongPath,
  checkpointHud,
  GATE_OPENING_M,
  GATE_POST_H_M,
  pathCheckpointSignature,
  type CheckpointGate,
} from '../lib/checkpoints'

type GatewaysProps = {
  /** Published on-asphalt polyline (same as RouteLine). */
  path: Array<[number, number, number]>
  /** Dest / nav key — rebuild gates when this + coarse path sig changes. */
  destKey: string
  visible: boolean
  heightGrid: HeightGrid
}

type StarBurst = {
  x: number
  y: number
  z: number
  born: number
  life: number
}

const STAR_POOL = 12
const UNLOAD_BEHIND_M = 90
/** Nose probe ahead of car center (meters). */
const NOSE_M = 2.4

/**
 * Arcade archway gates + star bursts along the blue route.
 * Trigger = nose crosses gate plane in forward route dir (not a solid wall).
 * No Troika — bright mesh only.
 */
export function Gateways({ path, destKey, visible, heightGrid }: GatewaysProps) {
  const sig = useMemo(
    () => (visible ? pathCheckpointSignature(path, destKey) : 'off'),
    [path, destKey, visible],
  )
  const [gates, setGates] = useState<CheckpointGate[]>([])
  const clearedRef = useRef<Set<string>>(new Set())
  const nextIndexRef = useRef(0)
  const starsRef = useRef<StarBurst[]>([])
  const [, bumpStars] = useState(0)
  const frameSkip = useRef(0)
  const timerOriginRef = useRef<number | null>(null)
  const movedRef = useRef(false)

  useEffect(() => {
    clearedRef.current = new Set()
    nextIndexRef.current = 0
    starsRef.current = []
    timerOriginRef.current = null
    movedRef.current = false
    if (!visible || path.length < 2 || destKey === 'none') {
      setGates([])
      checkpointHud.active = false
      checkpointHud.score = 0
      checkpointHud.cleared = 0
      checkpointHud.total = 0
      checkpointHud.timerSec = 0
      return
    }
    const next = buildGatesAlongPath(path)
    setGates(next)
    checkpointHud.active = next.length > 0
    checkpointHud.score = 0
    checkpointHud.cleared = 0
    checkpointHud.total = next.length
    checkpointHud.timerSec = 0
    checkpointHud.nonce += 1
  }, [sig]) // eslint-disable-line react-hooks/exhaustive-deps -- sig encodes path+dest

  useFrame((_, dt) => {
    if (!visible || gates.length === 0) return
    if (!carPose.ready) return

    // Timer: start on dest-set once car moves, or immediately if already moving.
    if (timerOriginRef.current == null) {
      if (Math.abs(carPose.speedMph) > 2) movedRef.current = true
      if (movedRef.current) timerOriginRef.current = performance.now()
    } else {
      checkpointHud.timerSec =
        (performance.now() - timerOriginRef.current) / 1000
    }

    const noseX = carPose.x - Math.sin(carPose.yaw) * NOSE_M
    const noseZ = carPose.z - Math.cos(carPose.yaw) * NOSE_M

    // In-order scoring only.
    const i = nextIndexRef.current
    if (i < gates.length) {
      const g = gates[i]
      if (!clearedRef.current.has(g.id)) {
        // Plane through gate center, normal = route tangent.
        // Crossed when nose is on the forward side and within opening half-width.
        const dx = noseX - g.x
        const dz = noseZ - g.z
        const along = dx * g.dirX + dz * g.dirZ
        const lat = -dx * g.dirZ + dz * g.dirX
        const half = GATE_OPENING_M * 0.55
        if (along > 0 && along < 6 && Math.abs(lat) < half) {
          clearedRef.current.add(g.id)
          nextIndexRef.current = i + 1
          checkpointHud.cleared = nextIndexRef.current
          checkpointHud.score += 1
          const y = sampleHeight(heightGrid, g.x, g.z) + GATE_POST_H_M * 0.55
          // Pooled star burst 0.4–0.8 s
          const life = 0.4 + Math.random() * 0.4
          starsRef.current.push({
            x: g.x,
            y,
            z: g.z,
            born: performance.now(),
            life: life * 1000,
          })
          if (starsRef.current.length > STAR_POOL) {
            starsRef.current.splice(0, starsRef.current.length - STAR_POOL)
          }
          bumpStars((n) => n + 1)
        }
      }
    }

    // Expire stars
    const now = performance.now()
    const before = starsRef.current.length
    starsRef.current = starsRef.current.filter((s) => now - s.born < s.life)
    if (starsRef.current.length !== before) bumpStars((n) => n + 1)

    // Periodic bump so unload-behind filter re-renders without per-frame setState.
    frameSkip.current = (frameSkip.current + 1) % 12
    if (frameSkip.current === 0) bumpStars((n) => n + 1)
    void dt
  })

  if (!visible || gates.length === 0) return null

  return (
    <group>
      {gates.map((g) => {
        if (clearedRef.current.has(g.id) && carPose.ready) {
          // Unload behind: once cleared and car is > UNLOAD_BEHIND_M past gate.
          const dx = carPose.x - g.x
          const dz = carPose.z - g.z
          const along = dx * g.dirX + dz * g.dirZ
          if (along > UNLOAD_BEHIND_M) return null
        }
        const y = sampleHeight(heightGrid, g.x, g.z)
        return <Archway key={g.id} gate={g} y={y} />
      })}
      {starsRef.current.map((s, idx) => (
        <StarBurstMesh key={`star-${idx}-${s.born}`} burst={s} />
      ))}
    </group>
  )
}

function Archway({ gate, y }: { gate: CheckpointGate; y: number }) {
  const half = GATE_OPENING_M * 0.5
  const postW = 0.45
  const postD = 0.45
  const lintelH = 0.4
  const lintelY = GATE_POST_H_M - lintelH * 0.5
  // Face incoming traffic: yaw so local +Z aligns with route tangent.
  const yaw = Math.atan2(gate.dirX, gate.dirZ)

  return (
    <group position={[gate.x, y, gate.z]} rotation={[0, yaw, 0]}>
      {/* Left / right posts (local X) + yellow lintel — kid-bright arcade. */}
      <mesh position={[-half, GATE_POST_H_M * 0.5, 0]} castShadow>
        <boxGeometry args={[postW, GATE_POST_H_M, postD]} />
        <meshStandardMaterial color="#ff7043" emissive="#bf360c" emissiveIntensity={0.35} />
      </mesh>
      <mesh position={[half, GATE_POST_H_M * 0.5, 0]} castShadow>
        <boxGeometry args={[postW, GATE_POST_H_M, postD]} />
        <meshStandardMaterial color="#ff7043" emissive="#bf360c" emissiveIntensity={0.35} />
      </mesh>
      <mesh position={[0, lintelY, 0]} castShadow>
        <boxGeometry args={[GATE_OPENING_M + postW, lintelH, postD * 1.1]} />
        <meshStandardMaterial color="#ffd54f" emissive="#ff8f00" emissiveIntensity={0.45} />
      </mesh>
      {/* Soft plane cue — visual only, not a solid Rapier wall. */}
      <mesh position={[0, 1.2, 0]}>
        <planeGeometry args={[GATE_OPENING_M * 0.9, 2.2]} />
        <meshBasicMaterial
          color="#69f0ae"
          transparent
          opacity={0.18}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
    </group>
  )
}

function StarBurstMesh({ burst }: { burst: StarBurst }) {
  const t = Math.min(1, (performance.now() - burst.born) / burst.life)
  const scale = 0.6 + t * 2.4
  const opacity = 1 - t
  return (
    <group position={[burst.x, burst.y, burst.z]}>
      {[0, 1, 2, 3, 4].map((i) => {
        const a = (i / 5) * Math.PI * 2 + t * 2
        const r = scale * 1.2
        return (
          <mesh
            key={i}
            position={[Math.cos(a) * r, Math.sin(a * 1.3) * r * 0.6, Math.sin(a) * r]}
          >
            <octahedronGeometry args={[0.35, 0]} />
            <meshBasicMaterial
              color={i % 2 === 0 ? '#ffee58' : '#ff4081'}
              transparent
              opacity={opacity}
              depthWrite={false}
            />
          </mesh>
        )
      })}
    </group>
  )
}
