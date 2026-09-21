import { Suspense, useEffect, useMemo, useRef, type MutableRefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import { RigidBody, type RapierRigidBody } from '@react-three/rapier'
import * as THREE from 'three'
import type { DriveKeys } from '../hooks/useKeyboard'
import { softSteeringHint } from '../lib/guidance'
import { carPose } from '../lib/carPose'
import {
  MPH_TO_MS,
  bicycleYawRate,
  dragTowardOffRoadCap,
  stepSignedSpeedMph,
  wheelAngleRad,
} from '../lib/longitudinal'
import { sampleDriveInput, stepSteerAngle } from '../lib/driveInput'
import { yawFromForwardXZ } from '../lib/autopilot'
import {
  defaultDriveBrainState,
  resolvePedals,
  tickDriveBrain,
  type DriveBrainState,
} from '../lib/driveBrain'
import {
  relativeHeightToMsl,
  sampleHeight,
  type HeightGrid,
} from '../lib/terrarium'
import { CAR_CLEARANCE_M } from '../lib/roadHeights'
import {
  isOnRoadSurface,
  type RoadSurfaceWay,
} from '../lib/roadSurface'
import {
  softClampToLoadedAabb,
  type LoadedAabb,
} from '../lib/streetTiles'

const _euler = new THREE.Euler()
const _forward = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _yawAxis = new THREE.Vector3(0, 1, 0)
const _yawQ = new THREE.Quaternion()


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
 * Escape hatch — "stuck like a fly".
 *
 * Arcade drive sets linvel every frame. When a fixed CuboidCollider (building
 * AABB that spilled onto asphalt, or a corner wedge) blocks XZ, Rapier refuses
 * translation but our authored yaw still runs → spin in place.
 *
 * Detect: |authored mph| > ε AND world XZ displacement ≪ expected for N frames.
 * Then: back out along −forward, slide on the free lateral axis, soften speed.
 * Primary fix is inset + road-overlap skip in Buildings / osmBuildings; this is
 * the last-resort unstick so a rare jam does not soft-lock Joey.
 */
const WEDGE_SPEED_EPS_MPH = 2
const WEDGE_DISP_RATIO = 0.08 // displacement / expected move
const WEDGE_DISP_FLOOR_M = 0.015
const WEDGE_FRAMES = 12
const WEDGE_BACK_M = 0.45
const WEDGE_LATERAL_MS = 2.8
const WEDGE_SPEED_KEEP = 0.55

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
  /** Soft void edge while streaming (null = no clamp). */
  loadedAabb?: LoadedAabb | null
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
 * --- Drive brain (lib/driveBrain.ts) ---
 * Policies: manual | cruise | autopilot. Brain emits steer / pedals /
 * speedCap / optional apFollow; this file applies Rapier + terrain only.
 * Cruise (A/✕/C) and AP (Y/△/P/HUD) toggles live in the brain — not here.
 *
 * --- Autopilot path ---
 * `path` is the **driven** route (OSRM snapped onto loaded OSM centerlines).
 * Same polyline GPS paints blue. Snap/slide; no bicycle δ. Cap 200 mph.
 *
 * --- Off-road (soft) vs containment (hard) ---
 * Past asphalt/track half-width → desert: edge-triggered leave bump + 55 mph
 * cap (see roadSurface.ts / longitudinal OFF_ROAD_*). ~200 ft corridor walls
 * from RoadContainment stay as the hard fence — soft feel does not replace them.
 *
 * --- Building flypaper ---
 * Solid building AABBs that overlap asphalt used to pin XZ while yaw spun.
 * Primary fix: inset + skip road-kissing solids (Buildings / osmBuildings).
 * WEDGE_* below is the escape hatch if still jammed against a real mass.
 */
/**
 * LEARNING — remount guard (module scope, survives React remount):
 *   R3F Canvas wraps children in Suspense. If anything above Car suspends
 *   (or a long main-thread freeze recovers), Car remounts and useRef(0) would
 *   zero speed + useEffect([spawnKey]) would re-fire even when spawnKey is
 *   unchanged → speed→0 + FollowCam intro. Track last Drop key here so a
 *   same-Drop remount RESTORES from carPose instead of wiping authored state.
 */
let lastSpeedResetSpawnKey: number | null = null

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
  loadedAabb = null,
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
  /** Consecutive frames: authored speed but almost no world XZ move. */
  const wedgeFrames = useRef(0)
  /** Prior-frame XZ for wedge displacement check. */
  const prevXZ = useRef({ x: spawn[0], z: spawn[2] })
  /**
   * Drive-brain memory (cruise + AP). Refs only — never remount RigidBody.
   * See lib/driveBrain.ts — Car applies physics; brain picks the policy.
   */
  const brainState = useRef<DriveBrainState>(defaultDriveBrainState())

  /**
   * Drop-sticky RigidBody mount Y. LEARNING — @react-three/rapier syncs the
   * `position` prop into rigidBody.setTranslation whenever mutable props change.
   * Scene used to pass spawnWithHeight with Y = sampleHeight(elev) every elev
   * swap → object3D jumped back to spawn XZ + new Y → teleport + “bump”.
   * Freeze Y after Drop / first network-spawn adopt; useFrame pins wantY from
   * the live heightGrid continuously (no elev teleport).
   */
  const mountYRef = useRef<{
    key: number
    x: number
    y: number
    z: number
  } | null>(null)
  if (mountYRef.current?.key !== spawnKey) {
    mountYRef.current = {
      key: spawnKey,
      x: spawn[0],
      y: spawn[1],
      z: spawn[2],
    }
  } else if (
    mountYRef.current.x !== spawn[0] ||
    mountYRef.current.z !== spawn[2]
  ) {
    // Ways resolved for this Drop — adopt XZ + Y once. Never chase elev-only Y.
    mountYRef.current = {
      key: spawnKey,
      x: spawn[0],
      y: spawn[1],
      z: spawn[2],
    }
  }

  /**
   * Fresh drop / respawn — zero authored speed with the new RigidBody.
   *
   * LEARNING — why spawnElevMsl must NOT be in these deps:
   *   Elev grids land async (flat → Terrarium/Open-Meteo) and may widen as
   *   tiles stream. spawnElevMsl is the relative-height zero; when it first
   *   locks (or the HeightGrid identity swaps) a dep on it re-fires this
   *   effect and zeros signedMph mid-drive → speed drops to 0. Same trap if
   *   `spawn` (array identity / Y from spawnWithHeight) is listed: Scene
   *   rebuilds that tuple on every elev apply. Reset on spawnKey only (Drop
   *   nonce). Elev swaps update carPose.elevMsl below / in useFrame — never
   *   touch speed, steer, or odometer.
   */
  useEffect(() => {
    if (lastSpeedResetSpawnKey === spawnKey) {
      // Same Drop, Car remounted (Suspense / freeze recovery) — restore speed
      // + brain flags from carPose; do NOT replay Drop zeroing.
      signedMph.current = carPose.speedMph
      carPose.elevMsl = heightGrid.spawnElevMsl
      prevXZ.current = { x: carPose.x, z: carPose.z }
      odometer.current = {
        x: carPose.x,
        z: carPose.z,
        acc: 0,
        t: 0,
        last: carPose.metersLastSecond,
      }
      return
    }
    lastSpeedResetSpawnKey = spawnKey
    signedMph.current = 0
    steerAngle.current = 0
    wasOnRoad.current = true
    leaveBumpT.current = 0
    wedgeFrames.current = 0
    prevXZ.current = { x: spawn[0], z: spawn[2] }
    brainState.current = defaultDriveBrainState()
    carPose.speedMph = 0
    carPose.metersLastSecond = 0
    carPose.elevMsl = heightGrid.spawnElevMsl
    carPose.offRoad = false
    carPose.cruiseOn = false
    carPose.cruiseMph = 0
    carPose.autopilotOn = false
    carPose.autopilotTargetMph = 0
    odometer.current = { x: spawn[0], z: spawn[2], acc: 0, t: 0, last: 0 }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Drop nonce only
  }, [spawnKey])

  // Elev grid swap: HUD MSL zero only — keep authored speed / steer / odo.
  useEffect(() => {
    carPose.elevMsl = heightGrid.spawnElevMsl
  }, [heightGrid.spawnElevMsl])

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

    // --- Drive brain: pedals + policy (manual | cruise | autopilot) ---
    // LEARNING: brain owns toggles / caps / AP snap sample; Car applies Rapier.
    const pedals = resolvePedals(input, signedMph.current)

    const t = rb.translation()

    // Soft void edge (streaming): clamp ONLY outside union AABB of active
    // tiles (+ small outward margin). Hard ~200 ft corridor stays OFF while
    // streaming (Scene hardContainment=false). Never remount on tile load.
    let tx = t.x
    let tz = t.z
    if (loadedAabb) {
      const clamped = softClampToLoadedAabb(tx, tz, loadedAabb, 12)
      if (clamped.outside) {
        rb.setTranslation({ x: clamped.x, y: t.y, z: clamped.z }, true)
        const v = rb.linvel()
        rb.setLinvel({ x: v.x * 0.35, y: v.y, z: v.z * 0.35 }, true)
        tx = clamped.x
        tz = clamped.z
      }
    }
    // --- On ribbon vs desert (soft) ---
    // Paved + track count as "road". Beyond half-width → offRoad.
    // Hard ~200 ft fence is RoadContainment — still the last-resort wall.
    const onRoad =
      roadSurfaceWays.length === 0
        ? true
        : isOnRoadSurface(tx, tz, roadSurfaceWays)

    const brain = tickDriveBrain(
      {
        x: tx,
        z: tz,
        signedMph: signedMph.current,
        onRoad,
      },
      input,
      { path },
      brainState.current,
      dt,
      pedals,
    )
    brainState.current = brain.state
    const cmd = brain.command

    // AP may briefly leave the ribbon — clear any in-progress leave bump.
    if (cmd.skipOffRoadPenalty) {
      leaveBumpT.current = 0
    }

    // Edge-trigger: only fire the arcade jolt when we *leave* the ribbon.
    // Autopilot owns the route and must not inherit the manual off-road bump.
    if (wasOnRoad.current && !onRoad && !cmd.skipOffRoadPenalty) {
      leaveBumpT.current = LEAVE_BUMP_DURATION_S
      signedMph.current *= LEAVE_BUMP_SPEED_KEEP
    }
    wasOnRoad.current = onRoad

    // Sticky dirt: yank toward 55 mph when the soft penalty applies.
    if (!onRoad && !cmd.skipOffRoadPenalty) {
      signedMph.current = dragTowardOffRoadCap(signedMph.current, dt)
    }

    // --- Longitudinal from brain pedals / cruise hold / AP chase ---
    signedMph.current = stepSignedSpeedMph(
      signedMph.current,
      cmd.throttle,
      cmd.brake,
      cmd.reverse,
      dt,
      cmd.speedCapMph,
      cmd.cruiseHold,
      cmd.cruiseTargetMph,
    )

    const speedMs = signedMph.current * MPH_TO_MS

    // --- Terrain follow: pin Y to height sample (relative to spawn elev).
    // Clearance tracks ROAD_Y_BIAS_M (roadHeights) so the body sits on asphalt.
    let groundY = sampleHeight(heightGrid, tx, tz)
    let wantY = groundY + CAR_CLEARANCE_M

    // Leave-bump: half-sine lift so the curb thump reads even with Y pinned.
    if (leaveBumpT.current > 0 && !cmd.skipOffRoadPenalty) {
      const u = 1 - leaveBumpT.current / LEAVE_BUMP_DURATION_S // 0 → 1
      wantY += LEAVE_BUMP_PEAK_M * Math.sin(Math.PI * u)
      leaveBumpT.current = Math.max(0, leaveBumpT.current - dt)
    }
    // Honest MSL for the speedo: groundY / VERTICAL_EXAGGERATION (1× fidelity).

    // --- Wedge detect (before we author another push into the wall) ---
    const disp = Math.hypot(tx - prevXZ.current.x, tz - prevXZ.current.z)
    const dtClamped = Math.min(dt, 0.05)
    const expectedMove = Math.abs(signedMph.current) * MPH_TO_MS * dtClamped
    const wantingMove = Math.abs(signedMph.current) >= WEDGE_SPEED_EPS_MPH
    if (
      wantingMove &&
      expectedMove > 0.04 &&
      disp < Math.max(WEDGE_DISP_FLOOR_M, expectedMove * WEDGE_DISP_RATIO)
    ) {
      wedgeFrames.current += 1
    } else {
      wedgeFrames.current = 0
    }
    prevXZ.current = { x: tx, z: tz }

    const wedged = wedgeFrames.current >= WEDGE_FRAMES

    // Brain already sampled AP snap/slide; drop it if wedged this frame.
    let apFollow = wedged ? null : cmd.apFollow

    if (wedged) {
      // Last-resort unstick: back out + lateral slide on the free XZ axis.
      // Steer picks the side when possible; otherwise default +1.
      const side =
        Math.abs(steerAngle.current) > 0.05
          ? Math.sign(steerAngle.current)
          : 1
      const latX = -_forward.z * side
      const latZ = _forward.x * side
      const back = Math.sign(signedMph.current || 1) // back opposite of travel
      rb.setTranslation(
        {
          x: tx - _forward.x * WEDGE_BACK_M * back + latX * 0.2,
          y: wantY,
          z: tz - _forward.z * WEDGE_BACK_M * back + latZ * 0.2,
        },
        true,
      )
      const escapeMs = Math.min(Math.abs(speedMs), WEDGE_LATERAL_MS)
      rb.setLinvel(
        {
          x: latX * escapeMs - _forward.x * escapeMs * 0.35 * back,
          y: 0,
          z: latZ * escapeMs - _forward.z * escapeMs * 0.35 * back,
        },
        true,
      )
      signedMph.current *= WEDGE_SPEED_KEEP
      wedgeFrames.current = 0
    } else if (apFollow) {
      // AP: place on soft-snapped XZ, drive along look-ahead heading.
      // LEARNING: we intentionally skip bicycle δ — Joey wants slide-on-line,
      // not a realistic turning radius at 200 mph.
      // Re-sample height at the slid pose so hills stay under the tires.
      groundY = sampleHeight(heightGrid, apFollow.x, apFollow.z)
      const apY = groundY + CAR_CLEARANCE_M
      _forward.set(apFollow.dirX, 0, apFollow.dirZ).normalize()
      const yaw = yawFromForwardXZ(apFollow.dirX, apFollow.dirZ)
      _euler.set(0, yaw, 0)
      _quat.setFromEuler(_euler)
      rb.setRotation({ x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w }, true)
      rb.setLinvel(
        {
          x: _forward.x * speedMs,
          y: 0,
          z: _forward.z * speedMs,
        },
        true,
      )
      rb.setTranslation({ x: apFollow.x, y: apY, z: apFollow.z }, true)
      wantY = apY
      steerAngle.current = 0 // stick spring unused while AP owns heading
    } else {
      rb.setLinvel(
        {
          x: _forward.x * speedMs,
          y: 0, // authored horizontal drive; Y is pinned below
          z: _forward.z * speedMs,
        },
        true,
      )
      rb.setTranslation({ x: tx, y: wantY, z: tz }, true)
    }

    // --- Bicycle steering (manual / soft guidance / cruise — skipped while AP) ---
    if (!apFollow) {
      let steerTarget = cmd.steer

      if (guidanceOn && path.length >= 2) {
        const hint = softSteeringHint(tx, tz, path)
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
      // While wedged this frame we already wrote escape linvel — still allow yaw
      // so Joey can turn away, but do not re-slam forward into the wall.
      const delta = wheelAngleRad(steerAngle.current, speedMs)
      const yawRate = bicycleYawRate(speedMs, delta)
      if (Math.abs(yawRate) > 1e-5) {
        const yaw = yawRate * dtClamped
        _yawQ.setFromAxisAngle(_yawAxis, yaw)
        _quat.multiply(_yawQ)
        rb.setRotation({ x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w }, true)

        if (!wedged) {
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
      }
    }

    // Kill residual angular velocity so Rapier doesn't keep spinning us.
    rb.setAngvel({ x: 0, y: 0, z: 0 }, true)

    // --- Meters-last-second sanity (true scale check for the HUD) ---
    const od = odometer.current
    const dx = tx - od.x
    const dz = tz - od.z
    od.acc += Math.hypot(dx, dz)
    od.x = tx
    od.z = tz
    od.t += dt
    if (od.t >= 1) {
      od.last = od.acc / od.t // meters per trailing window ≈ m/s when ~1s
      od.acc = 0
      od.t = 0
    }

    _euler.setFromQuaternion(_quat, 'YXZ')
    carPose.x = apFollow ? apFollow.x : tx
    carPose.y = wantY
    carPose.z = apFollow ? apFollow.z : tz
    carPose.yaw = _euler.y
    carPose.speedMph = signedMph.current
    carPose.metersLastSecond = od.last
    carPose.groundY = groundY
    carPose.elevMsl = relativeHeightToMsl(heightGrid, groundY)
    // The HUD's OFF ROAD −50% indicator describes the active manual penalty;
    // AP can be physically over dirt without that soft restriction.
    const bs = brainState.current
    carPose.offRoad = !onRoad && !bs.apOn
    carPose.cruiseOn = bs.cruiseOn
    carPose.cruiseMph = bs.cruiseOn ? bs.cruiseMph : 0
    carPose.autopilotOn = bs.apOn
    carPose.autopilotTargetMph = bs.apOn ? bs.apTargetMph : 0
    carPose.ready = true
  })

  // Mount Y is Drop-sticky (mountYRef); live terrain follow is useFrame wantY.
  const mountY = mountYRef.current?.y ?? spawn[1]

  return (
    <RigidBody
      key={spawnKey}
      ref={body}
      colliders="cuboid"
      position={[spawn[0], mountY, spawn[2]]}
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
        {/* Nested Suspense: GLTF must never bubble to Canvas Suspense (Joey remount lock). */}
        <Suspense fallback={null}>
          <KenneySportsSedan paintHex={paintHex} />
        </Suspense>
      </group>
    </RigidBody>
  )
}
