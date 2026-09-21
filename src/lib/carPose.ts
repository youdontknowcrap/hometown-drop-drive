/**
 * Live pose for the GPS dash + speedo. Written by the car each physics tick.
 *
 * speedMph is TRUE arcade mph (signed). metersLastSecond is a sanity check:
 * at a steady 110 mph you should see ~49 m/s (110 * 0.44704). We do NOT fake
 * units — if it "doesn't feel fast," that is camera / parallax, not a lie in
 * the speedometer (see FollowCam + Speedo comments).
 */
export const carPose = {
  x: 0,
  /** World Y (terrain-relative meters). */
  y: 0,
  z: 0,
  yaw: 0,
  /** Signed speed along forward (mph). Positive = forward. */
  speedMph: 0,
  /**
   * How many meters of ground the car covered in the trailing 1 second.
   * Compare to |speedMph| * 0.447 — they should match when speed is steady.
   */
  metersLastSecond: 0,
  /** Relative terrain height under the car (m, spawn = 0, already × exaggerated). */
  groundY: 0,
  /**
   * Absolute altitude above sea level (meters).
   * Computed as spawnElevMsl + groundY / VERTICAL_EXAGGERATION so the speedo
   * shows honest MSL even though the mesh is arcade-exaggerated.
   */
  elevMsl: 0,
  ready: false,
}
