import { useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text } from '@react-three/drei'
import * as THREE from 'three'
import { carPose } from '../lib/carPose'
import { sampleHeight, type HeightGrid } from '../lib/terrarium'
import { displayNameForWay } from '../lib/osmStreets'
import {
  LABEL_FONT_SIZE_M,
  LABEL_HEIGHT_ABOVE_M,
  pickStreetLabels,
  type NamedStreet,
  type StreetLabelSlot,
} from '../lib/streetLabels'
import type { LocalStreet } from './Road'

type StreetLabelsProps = {
  streets: LocalStreet[]
  heightGrid: HeightGrid
}

/**
 * Floating street-name labels in the 3D view (not the GPS dial).
 *
 * LEARNING — world-space Text + Billboard:
 *   Troika `Text` lives in meters in the scene. A fixed fontSize (≈4 m tall)
 *   looks big when you're next to China Lake Blvd and shrinks with true
 *   perspective as you drive away — depth cue without fake CSS font math.
 *   `Billboard` rotates the group to face the camera every frame so names
 *   stay readable while turning (like arcade race HUD markers).
 *
 *   Which labels show is recomputed every few frames from `carPose` (written
 *   by Car). Aggressive cull lives in `pickStreetLabels` — named ways only,
 *   one per unique name, within ~350 m, opacity fade at range.
 */
export function StreetLabels({ streets, heightGrid }: StreetLabelsProps) {
  const named = useMemo((): NamedStreet[] => {
    const out: NamedStreet[] = []
    for (const s of streets) {
      const name = displayNameForWay(s)
      if (!name || s.points.length < 2) continue
      out.push({ name, points: s.points })
    }
    return out
  }, [streets])

  const [slots, setSlots] = useState<StreetLabelSlot[]>([])
  const frameSkip = useRef(0)

  useFrame(() => {
    // Every 3rd frame is enough while driving; Troika sync is the costly bit.
    frameSkip.current = (frameSkip.current + 1) % 3
    if (frameSkip.current !== 0) return

    if (!carPose.ready || !named.length) {
      setSlots((prev) => (prev.length ? [] : prev))
      return
    }

    const next = pickStreetLabels(carPose.x, carPose.z, named)
    setSlots((prev) => (labelsEqual(prev, next) ? prev : next))
  })

  if (!named.length) return null

  return (
    <group>
      {slots.map((slot) => {
        const y = sampleHeight(heightGrid, slot.x, slot.z) + LABEL_HEIGHT_ABOVE_M
        return (
          <StreetLabelMark
            key={slot.name}
            name={slot.name}
            position={[slot.x, y, slot.z]}
            opacity={slot.opacity}
          />
        )
      })}
    </group>
  )
}

function labelsEqual(a: StreetLabelSlot[], b: StreetLabelSlot[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x.name !== y.name) return false
    // Ignore tiny position / opacity jitter to cut React churn.
    if (Math.abs(x.x - y.x) > 2 || Math.abs(x.z - y.z) > 2) return false
    if (Math.abs(x.opacity - y.opacity) > 0.08) return false
  }
  return true
}

type MarkProps = {
  name: string
  position: [number, number, number]
  opacity: number
}

function StreetLabelMark({ name, position, opacity }: MarkProps) {
  // Rough pill width from character count (world meters).
  const pillW = Math.max(
    LABEL_FONT_SIZE_M * 2.4,
    Math.min(LABEL_FONT_SIZE_M * 0.55 * name.length + LABEL_FONT_SIZE_M, 28),
  )
  const pillH = LABEL_FONT_SIZE_M * 1.35

  return (
    <group position={position}>
      <Billboard follow>
        {/* Soft dark pill — readable on bright desert sky or asphalt. */}
        <mesh position={[0, 0, -0.1]} renderOrder={8}>
          <planeGeometry args={[pillW, pillH]} />
          <meshBasicMaterial
            color="#0c1018"
            transparent
            opacity={0.55 * opacity}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
        <Text
          fontSize={LABEL_FONT_SIZE_M}
          color="#f2f5fa"
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.14}
          outlineColor="#05070c"
          outlineOpacity={0.85 * opacity}
          fillOpacity={opacity}
          maxWidth={32}
          textAlign="center"
          renderOrder={9}
          depthOffset={-2}
        >
          {name}
        </Text>
      </Billboard>
    </group>
  )
}
