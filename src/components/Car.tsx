import { useEffect, useMemo, useRef, type MutableRefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import { RigidBody, type RapierRigidBody } from '@react-three/rapier'
import * as THREE from 'three'
import type { DriveKeys } from '../hooks/useKeyboard'
import { softSteeringHint } from '../lib/guidance'
import { carPose } from '../lib/carPose'
import {
  MPH_TO_MS,
  OFF_ROAD_MAX_SPEED_MPH,
  MAX_SPEED_MPH,
  bicycleYawRate,
  dragTowardOffRoadCap,
  stepSignedSpeedMph,
  wheelAngleRad,
} from '../lib/longitudinal'
import { sampleDriveInput, stepSteerAngle } from '../lib/driveInput'
import {
  relativeHeightToMsl,
  sampleHeight,
  type HeightGrid,
} from '../lib/terrarium'
import {
  isOnRoadSurface,
  type RoadSurfaceWay,
} from '../lib/roadSurface'

const _euler = new THREE.Euler()
const _forward = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _yawAxis = new THREE.Vector3(0, 1, 0)
const _yawQ = new THREE.Quaternion()

/** How high the RigidBody center sits above sampled ground. */
const CAR_CLEARANCE_M = 0.55

/**
 * Arcade leave-asphalt jolt (edge-triggered on→off only — never every frame).
 * Y is normally pinned to terrain each tick, so we add a decaying half-sine
 * offset to wantY instead of a Rapier impulse (impulse would be overwritten).
 */
const LEAVE_BUMP_DURATION_S = 0.42
const LEAVE_BUMP_PEAK_M = 1.45
/** Instant mph chop when the curb hits — sells the thump with the vertical bump. */
const LEAVE_BUMP_SPEED_KEEP = 0.82

/**
 * Kenney Car Kit already ships a sportier GLB (`sedan-sports.glb`) with a
 * spoiler + lower stance. We used the drab `sedan.glb` before — switch the
 * default to sports for a teen STEM racer vibe (still CC0, no game rips).
 *
 * WHY materials on top of the GLB?
 *   Kenney packs one atlas (`colormap`). Recoloring in Blender is overkill
 *   for a teaching toy. Traverse body/spoiler meshes and swap in a punchy
 *   MeshStandardMaterial (metallic paint). Wheels keep the atlas so rubber
 *   still reads as rubber. Tiny emissive boxes fake lit headlights/taillights
 *   because the atlas has no separate light meshes.
 */
const SEDAN_SPORTS = '/models/kenney-car/sedan-sports.glb'

/** Default candy — electric blue; HUD paint picker can override. */
export const DEFAULT_PAINT = '#1e90ff'

export const PAINT_PRESETS: { id: string; label: string; hex: string }[] = [
  { id: 'blue', label: 'Electric blue', hex: '#1e90ff' },
  { id: 'red', label: 'Candy red', hex: '#e10600' },
  { id: 'lime', label: 'Acid lime', hex: '#b8f200' },
  { id: 'black', label: 'Stealth black', hex: '#1a1a1e' },
]

type CarProps = {
  keys: MutableRefObject<DriveKeys>
  path: Array<[number, number, number]>
  guidanceOn: boolean
  spawn: [number, number, number]
  spawnYaw: number
  spawnKey: number
  /** Terrarium / Open-Meteo / flat grid — car Y follows sampleHeight. */
  heightGrid: HeightGrid
  /** Body paint hex (from HUD picker or DEFAULT_PAINT). */
  paintHex?: string
  /**
   * Asphalt + track ribbons (half-width). Beyond → offRoad speed + leave bump.
   * Hard ~200 ft wall stays in RoadContainment — do not put that radius here.
   */
  roadSurfaceWays?: RoadSurfaceWay[]
}

function shadowClone(src: THREE.Object3D): THREE.Object3D {
  const obj = src.clone(true)
  obj.traverse((n) => {
    const mesh = n as THREE.Mesh
    if (mesh.isMesh) {
      mesh.castShadow = true
      mesh.receiveShadow = true
    }
  })
  return obj
}

/**
 * Punchy paint pass on body + spoiler; leave wheel meshes on the Kenney atlas.
 * Teaching: mesh.name comes from the GLB nodes (body, spoiler, wheel-*).
 */
function applySportsPaint(root: THREE.Object3D, paintHex: string) {
  const paint = new THREE.MeshStandardMaterial({
    color: new THREE.Color(paintHex),
    metalness: 0.72,
    roughness: 0.28,
    envMapIntensity: 1.1,
  })
  // Dark “glass” strip cue — slightly darker / less metal for windshield band
  // if Kenney ever splits windows; today body is one mesh so paint wins.
  const darkTrim = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#1c1c22'),
    metalness: 0.85,
    roughness: 0.35,
  })

  root.traverse((n) => {
    const mesh = n as THREE.Mesh
    if (!mesh.isMesh) return
    const name = (mesh.name || '').toLowerCase()
    // Sports GLB wheels stay on colormap (tread + rim read correctly).
    if (name.includes('wheel')) return
    if (name.includes('spoiler')) {
      // Spoiler: same paint family, a touch more metal (chrome-ish wing).
      mesh.material = paint.clone()
      ;(mesh.material as THREE.MeshStandardMaterial).metalness = 0.88
      ;(mesh.material as THREE.MeshStandardMaterial).roughness = 0.22
      return
    }
    if (name.includes('body') || name === '') {
      mesh.material = paint
      return
    }
    // Anything else (trim bits) → dark metal.
    mesh.material = darkTrim
  })
}

/** Emissive light boxes — Kenney atlas has no separate lamp meshes. */
function LightBoxes() {
  return (
    <group>
      {/* Headlights (nose is +Z in Kenney space; parent flips 180°). */}
      <mesh position={[0.45, 0.55, 1.05]} castShadow={false}>
        <boxGeometry args={[0.28, 0.12, 0.06]} />
        <meshStandardMaterial
          color="#fff5d6"
          emissive="#ffe9a8"
          emissiveIntensity={2.2}
          toneMapped={false}
        />
      </mesh>
      <mesh position={[-0.45, 0.55, 1.05]} castShadow={false}>
        <boxGeometry args={[0.28, 0.12, 0.06]} />
        <meshStandardMaterial
          color="#fff5d6"
          emissive="#ffe9a8"
          emissiveIntensity={2.2}
          toneMapped={false}
        />
      </mesh>
      {/* Taillights */}
      <mesh position={[0.42, 0.55, -1.15]} castShadow={false}>
        <boxGeometry args={[0.32, 0.1, 0.05]} />
        <meshStandardMaterial
          color="#ff2040"
          emissive="#ff1028"
          emissiveIntensity={1.6}
          toneMapped={false}
        />
      </mesh>
      <mesh position={[-0.42, 0.55, -1.15]} castShadow={false}>
        <boxGeometry args={[0.32, 0.1, 0.05]} />
        <meshStandardMaterial
          color="#ff2040"
          emissive="#ff1028"
          emissiveIntensity={1.6}
          toneMapped={false}
        />
      </mesh>
    </group>
  )
}

function KenneySportsSedan({ paintHex }: { paintHex: string }) {
  const gltf = useGLTF(SEDAN_SPORTS)
  const body = useMemo(() => {
    const clone = shadowClone(gltf.scene)
    applySportsPaint(clone, paintHex)
    return clone
  }, [gltf.scene, paintHex])

  return (
    // Kenney +Z is the nose; our arcade forward is -Z.
    <group rotation={[0, Math.PI, 0]}>
      <primitive object={body} />
      <LightBoxes />
    </group>
  )
}

useGLTF.preload(SEDAN_SPORTS)

/**
 * Kenney CC0 sports sedan with arcade WASD + gamepad driving.
 *
 * Longitudinal: signed-speed along forward (see longitudinal.ts).
 * Horizontal linvel is authored each frame; vertical (y) follows the
 * height sample so hills work without a fragile heightfield CCD.
 *
 * --- Steering = wheel angle (bicycle / single-track model) ---
 *   Stick/keys → normalized δ̂ ∈ [−1, 1]  (deadzone → 0 → goes straight)
 *   δ = wheelAngleRad(δ̂, v)               (radians, softened at speed)
 *   yaw rate ω ≈ (v / L) * tan(δ)         (rad/s)
 *
 * WHY this instead of "stick = yaw rate"? A yaw-rate joystick feels like
 * fighting the car. Wheel-angle demand means: hold mid-stick → constant
 * turn *radius* at that speed (you hold the arc). Release to deadzone →
 * δ→0 → ω→0 → straight. That is the standard arcade-sim bicycle model.
 *
 * --- Off-road (soft) vs containment (hard) ---
 * Past asphalt/track half-width → desert: edge-triggered leave bump + 55 mph
 * cap (see roadSurface.ts / longitudinal OFF_ROAD_*). ~200 ft corridor walls
 * from RoadContainment stay as the hard fence — soft feel does not replace them.
 */
export function Car({
  keys,
  path,
  guidanceOn,
  spawn,
  spawnYaw,
  spawnKey,
  heightGrid,
  paintHex = DEFAULT_PAINT,
  roadSurfaceWays = [],
}: CarProps) {
  const body = useRef<RapierRigidBody>(null)
  /** Authoritative signed speed (mph) along forward. Positive = nose direction. */
  const signedMph = useRef(0)
  /** Smoothed steer −1..+1; springs to 0 when input released. */
  const steerAngle = useRef(0)
  /** Trailing-second distance accumulator for HUD sanity (meters). */
  const odometer = useRef({ x: spawn[0], z: spawn[2], acc: 0, t: 0, last: 0 })
  /** Edge-detect leave asphalt: was on ribbon last frame? */
  const wasOnRoad = useRef(true)
  /** Seconds left in the leave-bump half-sine (0 = idle). */
  const leaveBumpT = useRef(0)

  // Fresh drop / respawn — zero authored speed with the new RigidBody.
  useEffect(() => {
    signedMph.current = 0
    steerAngle.current = 0
    wasOnRoad.current = true
    leaveBumpT.current = 0
    carPose.speedMph = 0
    carPose.metersLastSecond = 0
    carPose.elevMsl = heightGrid.spawnElevMsl
    carPose.offRoad = false
    odometer.current = { x: spawn[0], z: spawn[2], acc: 0, t: 0, last: 0 }
  }, [spawnKey, spawn, heightGrid.spawnElevMsl])

  useFrame((_state, dt) => {
    const rb = body.current
    if (!rb) return

    const input = sampleDriveInput(keys.current)
    const rot = rb.rotation()
    _quat.set(rot.x, rot.y, rot.z, rot.w)

    _forward.set(0, 0, -1).applyQuaternion(_quat)
    _forward.y = 0
    if (_forward.lengthSq() < 1e-8) return
    _forward.normalize()

    // --- Pedals: gamepad splits brake/reverse; keyboard S is context-sensitive
    let throttle = input.throttle
    let brake = input.brake
    let reverse = input.reverse
    if (input.keyboardBack) {
      // WASD: S brakes while rolling forward, reverses from rest / while backing.
      if (signedMph.current > 0.05) brake = true
      else reverse = true
    }

    const t = rb.translation()

    // --- On ribbon vs desert (soft) ---
    // Paved + track count as "road". Beyond half-width → offRoad.
    // Hard ~200 ft fence is RoadContainment — still the last-resort wall.
    const onRoad =
      roadSurfaceWays.length === 0
        ? true
        : isOnRoadSurface(t.x, t.z, roadSurfaceWays)

    // Edge-trigger: only fire the arcade jolt when we *leave* the ribbon.
    if (wasOnRoad.current && !onRoad) {
      leaveBumpT.current = LEAVE_BUMP_DURATION_S
      signedMph.current *= LEAVE_BUMP_SPEED_KEEP
    }
    wasOnRoad.current = onRoad

    // Sticky dirt: if already above 55 mph off-road, yank toward the cap first.
    const speedCap = onRoad ? MAX_SPEED_MPH : OFF_ROAD_MAX_SPEED_MPH
    if (!onRoad) {
      signedMph.current = dragTowardOffRoadCap(signedMph.current, dt)
    }

    signedMph.current = stepSignedSpeedMph(
      signedMph.current,
      throttle,
      brake,
      reverse,
      dt,
      speedCap,
    )

    const speedMs = signedMph.current * MPH_TO_MS

    // --- Terrain follow: pin Y to height sample (relative to spawn elev)
    const groundY = sampleHeight(heightGrid, t.x, t.z)
    let wantY = groundY + CAR_CLEARANCE_M

    // Leave-bump: half-sine lift so the curb thump reads even with Y pinned.
    if (leaveBumpT.current > 0) {
      const u = 1 - leaveBumpT.current / LEAVE_BUMP_DURATION_S // 0 → 1
      wantY += LEAVE_BUMP_PEAK_M * Math.sin(Math.PI * u)
      leaveBumpT.current = Math.max(0, leaveBumpT.current - dt)
    }
    // Honest MSL for the speedo: undo VERTICAL_EXAGGERATION baked into groundY.

    rb.setLinvel(
      {
        x: _forward.x * speedMs,
        y: 0, // authored horizontal drive; Y is pinned below
        z: _forward.z * speedMs,
      },
      true,
    )
    rb.setTranslation({ x: t.x, y: wantY, z: t.z }, true)

    // --- Bicycle steering ---
    let steerTarget = input.steer

    if (guidanceOn && path.length >= 2) {
      const hint = softSteeringHint(t.x, t.z, path)
      if (hint && hint.strength > 0.05) {
        const cross = _forward.x * hint.dirZ - _forward.z * hint.dirX
        steerTarget = Math.max(
          -1,
          Math.min(1, steerTarget + cross * hint.strength * 2.2),
        )
      }
    }

    steerAngle.current = stepSteerAngle(steerAngle.current, steerTarget, dt)

    // δ from stick; ω = (v/L)*tan(δ). At v=0, ω=0 (no turn-in-place spin).
    const delta = wheelAngleRad(steerAngle.current, speedMs)
    const yawRate = bicycleYawRate(speedMs, delta)
    if (Math.abs(yawRate) > 1e-5) {
      const yaw = yawRate * Math.min(dt, 0.05)
      _yawQ.setFromAxisAngle(_yawAxis, yaw)
      _quat.multiply(_yawQ)
      rb.setRotation({ x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w }, true)

      // Re-align horizontal velocity to new forward so we don't skid sideways.
      _forward.set(0, 0, -1).applyQuaternion(_quat)
      _forward.y = 0
      _forward.normalize()
      rb.setLinvel(
        {
          x: _forward.x * speedMs,
          y: 0,
          z: _forward.z * speedMs,
        },
        true,
      )
    }

    // Kill residual angular velocity so Rapier doesn't keep spinning us.
    rb.setAngvel({ x: 0, y: 0, z: 0 }, true)

    // --- Meters-last-second sanity (true scale check for the HUD) ---
    const od = odometer.current
    const dx = t.x - od.x
    const dz = t.z - od.z
    od.acc += Math.hypot(dx, dz)
    od.x = t.x
    od.z = t.z
    od.t += dt
    if (od.t >= 1) {
      od.last = od.acc / od.t // meters per trailing window ≈ m/s when ~1s
      od.acc = 0
      od.t = 0
    }

    _euler.setFromQuaternion(_quat, 'YXZ')
    carPose.x = t.x
    carPose.y = wantY
    carPose.z = t.z
    carPose.yaw = _euler.y
    carPose.speedMph = signedMph.current
    carPose.metersLastSecond = od.last
    carPose.groundY = groundY
    carPose.elevMsl = relativeHeightToMsl(heightGrid, groundY)
    carPose.offRoad = !onRoad
    carPose.ready = true
  })

  // Spawn Y also comes from the height grid so we don't drop through a hill.
  const spawnY =
    sampleHeight(heightGrid, spawn[0], spawn[2]) + CAR_CLEARANCE_M

  return (
    <RigidBody
      key={spawnKey}
      ref={body}
      colliders="cuboid"
      position={[spawn[0], spawnY, spawn[2]]}
      rotation={[0, spawnYaw, 0]}
      friction={1.4}
      // Drive axis is kinematic from the controller; keep damping low so
      // Rapier contacts don't sap our authored speed.
      linearDamping={0.05}
      angularDamping={2}
      canSleep={false}
      // Continuous collision — 110 mph ≈ 49 m/s tunnels thin colliders.
      ccd
      enabledRotations={[false, true, false]}
      gravityScale={0}
    >
      <group name="player-car">
        <KenneySportsSedan paintHex={paintHex} />
      </group>
    </RigidBody>
  )
}
