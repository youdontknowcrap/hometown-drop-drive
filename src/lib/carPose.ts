/** Live pose for the GPS dash + speedo. Written by the car each physics tick. */
export const carPose = {
  x: 0,
  z: 0,
  yaw: 0,
  /** Signed speed along forward (mph). Positive = forward. */
  speedMph: 0,
  ready: false,
}
