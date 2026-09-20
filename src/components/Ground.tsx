import { RigidBody } from '@react-three/rapier'

/** Flat desert-ish playfield with a subtle grid. Large enough for demo routes. */
export function Ground() {
  return (
    <RigidBody type="fixed" colliders="cuboid" friction={1.2}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow position={[0, -0.05, 0]}>
        <boxGeometry args={[2000, 2000, 0.1]} />
        <meshStandardMaterial color="#c4a574" roughness={0.95} />
      </mesh>
      {/* Decorative grid so motion feels readable */}
      <gridHelper args={[2000, 100, '#8d6e4a', '#b08968']} position={[0, 0.01, 0]} />
    </RigidBody>
  )
}
