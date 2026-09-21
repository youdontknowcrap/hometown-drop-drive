# Hometown Drop & Drive

Kid-friendly **browser driving toy**: type a start and stop address, get an OpenStreetMap driving path, and drive with WASD or a USB game controller.

Drop at an address. Drop loads the tile under you + neighbors, then **streams ~1 km street tiles** as you drive (including backroads / tracks). Drive them. Leave the asphalt a bit, then hit a **hard stop ~200 ft** off the road network (not curb-hugging Autopia rails). GPS dash + camera sliders. Hills from **Terrarium/SRTM** with **Open-Meteo elevation** fallback; OSM building boxes; local weather + sun.

Web-first prototype (no Unity). Live routing + elevation need `npm run dev` (Vite proxy). Offline / CORS failure falls back to a Ridgecrest demo loop and flat ground.

## Developer inbox

Bugs, extra requirements, and “we discussed this” notes go in **GitHub Issues** on this repo — not a side README.

https://github.com/youdontknowcrap/hometown-drop-drive/issues

Commit messages close or reference those issues (`Fixes #1`). That is the paper trail.

Buildings (#5) are simple extruded OSM boxes along the Drop. HUD collapses (`H` / `[`) so the drive view stays big.

## Quick start

```bash
cd hometown-drop-drive
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`). First load tries Crossroads / China Lake Blvd → Eastern Sierra Railroad (real Ridgecrest streets).

## Controls

### Keyboard

- **W / ↑** — accelerate
- **S / ↓** — brake while moving forward; reverse from rest
- **A / ←** · **D / →** — steer (wheel angle; spring-return to center on release)
- **Esc** / click the 3D view — leave HUD text fields so driving works again

### USB game controller (Gamepad API)

Plug in any standard browser gamepad. Keyboard and pad work **at the same time** (inputs merge each frame).

| Input | Action |
| --- | --- |
| Left stick X / D-pad | Steer = wheel angle δ (deadzone ~0.22 → straight) |
| **LT** (button 6) | Gas / throttle |
| **RT** (button 7) | Brake (toward 0 — does not tip into reverse) |
| **LB** (button 4) | Reverse |

Stick axes use a **0.22 deadzone** so resting sticks don’t drift. Steering is analog from the stick and springs back to center when released (same as releasing A/D). Hold mid-stick → hold a mid arc (bicycle model).

### HUD

- **Drop** — geocode + load the OSM street grid (respawns the car)
- **Set destination** — GPS path from the car to an address (while driving)
- **Clear** — free drive, hide the blue line
- **Guidance ON** — soft follow the blue GPS line (nearest-segment hint)
- **Guidance OFF** / no destination — free drive

Drive off the planned path and GPS **reroutes** (debounced). Leave asphalt/track ribbons and you get an arcade **leave bump** plus a **~50% speed cap (~55 mph)** in the desert; after ~200 ft a hard corridor wall stops the car. Ground and road textures repeat in **meters**. On-road cap **110 mph** (~18 mph/s throttle, ~28 brake, ~4 coast).

Speedo shows **true mph** plus an optional **meters-last-second** sanity line (`≈ mph × 0.447`). We do not fake units — if 110 “doesn’t feel fast,” pull the chase cam back.

## Streaming + worker load

Street tiles (~1 km) activate around the car; **buildings** and a **sliding near height grid** follow the same active AABB (far skyline recenters as you drive). Overpass / Terrarium / Open-Meteo **parse runs in a Web Worker** (`tileLoader.worker.ts`) so the render/input thread only merges results — tile loads must not remount Car / FollowCam / Scene.

## Learning notes

This repo is a teaching project. New/changed files carry short **why** comments. The models in one place:

### Bicycle / single-track steering

Stick or keys set a **wheel angle** δ, not a yaw-rate joystick.

```
δ̂ ∈ [−1, 1]     // deadzone → 0 → goes straight
δ  = f(δ̂, v)     // radians; max lock softens at high speed
ω  ≈ (v / L) · tan(δ)   // yaw rate (rad/s), L = wheelbase ≈ 2.6 m
```

Hold mid-stick at constant speed → constant turn **radius** (you hold the arc). Pure full-lock at 110 mph would spin like a top, so max δ shrinks with speed while the `(v/L)·tan(δ)` relationship stays.

See `src/lib/longitudinal.ts` (`wheelAngleRad`, `bicycleYawRate`) and `src/components/Car.tsx`.

### Building colliders vs asphalt ("stuck like a fly")

Arcade drive authors `setLinvel` every frame. OSM building footprints become **axis-aligned** boxes; houses near streets often overlap the roadway. Rapier then blocks translation while yaw still works — spin in place on invisible flypaper.

Mitigations: inset CuboidColliders vs the visual mesh (`COLLIDER_INSET_M`), skip solids that kiss a road ribbon (`clearRoadOverlappingSolidColliders`), and a Car escape hatch if authored speed produces almost no XZ displacement for several frames. Visual houses stay full size; warehouses set back from the curb still bump. The ~200 ft `RoadContainment` corridor is unchanged.

### Longitudinal rates

Signed speed along the nose (mph), written into Rapier each frame:

| | mph/s | note |
| --- | --- | --- |
| Throttle | ~18 | 0–60 in ≈ 3.3 s |
| Brake | ~28 | RT / S while rolling forward |
| Coast | ~4 | no pedal |
| Cap | 110 | product lock |

Gamepad splits **brake** (RT → toward 0) from **reverse** (LB). Keyboard S stays “brake or reverse by context.” See `src/lib/driveInput.ts` for button indices.

### Off-road soft feel vs hard containment

Two layers:

1. **Road surface** (`roadSurface.ts`) — distance to nearest OSM way centerline vs that way’s half-width (paved **or** track). Past the ribbon → desert: edge-triggered leave bump (half-sine Y offset + speed chop) and `OFF_ROAD_MAX_SPEED_MPH` (55). Speedo shows **OFF ROAD −50%**.
2. **Hard corridor** (`roadCorridor.ts` / `RoadContainment`) — ~200 ft / 61 m buffer walls. Last-resort fence so you cannot wander forever. Soft feel does **not** replace this.

### Perceived speed vs true scale

World units are real meters (`latLngToLocal`). **110 mph ≈ 49 m/s** is honest. Weak “feels slow” is usually a tight chase cam + empty desert (weak parallax). Defaults: longer chase distance, slightly snappier camera lerp. HUD sanity: meters covered in the last second should track `mph × 0.447`. **Do not multiply mph by a fudge factor.**

### Terrarium / SRTM terrain (web stand-in for DTED)

Military DTED files are awkward in a browser. Same elevation family for the US: **SRTM via free Terrarium PNG tiles** on AWS Open Data.

```
URL:  /api/terrarium/{z}/{x}/{y}.png   (Vite → s3 elevation-tiles-prod)
Decode: elev_m = (R × 256 + G + B / 256) − 32768
```

We displace the ground under the loaded street bbox, drape asphalt + GPS line, and pin the car’s Y to a bilinear sample. Heights are **relative to spawn elevation** so Drop doesn’t launch into the sky, at **1× fidelity** (real meters of relief — no arcade stretch). HUD + speedo MSL match the mesh. A separate **far LOD ring** (~12 km, visual only, Terrarium z8–z9 or Open-Meteo) draws distant mountains beyond the near bbox. Tile fetch failure → flat ground (still playable).

Playtest fix (hills eat roads): densify OSM centerlines to **0.5×`cellSize`**, raise ribbons ~**1.25 m** above `sampleHeight` (arcade curb), dig a matching **desert trench** under road corridors on Ground / FarGround blend, and strengthen `polygonOffset` / `renderOrder`. `sampleHeight` itself is unchanged — the car still pins Y to the same sampler with clearance a hair above the bias so it sits on asphalt.

This works **US-wide** for a later cross-country pass. **Road streaming (#11) is live** — ~1 km tiles load/unload with the car; elevation still follows lat/lng via Terrarium.

See `src/lib/terrarium.ts`, `src/components/Ground.tsx`, Vite `/api/terrarium` proxy.

### Open-Meteo elevation fallback

If Terrarium tiles fail (no proxy / CORS / decode), we sample a ≤100-point lat/lng grid from Open-Meteo elevation, bilinear-upsample to the same height grid, still **relative-to-spawn** with `VERTICAL_EXAGGERATION = 1` (fidelity). Both fail → quiet “Flat ground” (no scary sample errors). HUD labels the path: Terrarium / Open-Meteo elev / Flat, plus a **Far terrain:** line for the skyline ring.

See `src/lib/elevation.ts`, `src/lib/openMeteoElev.ts`, Vite `/api/open-meteo`.

### Far LOD skyline

Near ground only covers street bbox + ~40 m pad — empty horizon in a chase cam. `FarGround` samples a coarse height grid out ~12 km (soft blend at the seam, **no physics colliders**). Clear/Cloudy fog + camera `far` are pushed so silhouettes survive; Fog/Storm presets stay tight on purpose. Speedo shows live **m MSL** under mph.

See `src/lib/terrarium.ts` (`fetchFarHeightGrid`), `src/components/FarGround.tsx`, `src/components/Speedo.tsx`.

### Sports car skin (Kenney CC0)

Default model is `sedan-sports.glb` (spoiler). Body/spoiler get a metallic `MeshStandardMaterial` paint pass; wheels keep the Kenney atlas; emissive boxes fake lamps. HUD paint picker swaps the hex.

See `src/components/Car.tsx`.

### Collapsible HUD

Left control frame hides to a thin tab (`H` or `[`, persisted in `localStorage`) so teens get a full-width drive view. Drop/GPS/weather stay usable when expanded.


## Floating street names

OSM ways often carry a `name` (or `ref` for numbered routes). We store those on `StreetWay`, place a GPU `Text` + `Billboard` a few meters above the nearest centerline point to the car, and cull hard (named only, one label per unique name, ~350 m range, fade at the edge, max 6). World-space font size is **~2.1 m** tall (playtest cut ~50% from 4.2 m so names stop cluttering the chase cam); perspective still gives **bigger close, smaller far**. Demo fallback invents a couple of names (China Lake Blvd / Ridgecrest Blvd) so offline still teaches the feature.

Verify: Drop Ridgecrest, drive China Lake Blvd — the name floats ahead and shrinks as you leave it behind.

## Why streets were missing (and what changed)

OSM/OSRM already returned a centerline in lat/lng. Milestone 1 only drew a `Line` on a tan box. The datum was there; the street was not.

Now the centerline is a **dark asphalt ribbon** (not desert-with-rails): ~7.2 m wide paved, length = great-circle meters along the path, UV.v = distance / 6 m. Lane dashes are 3 m on / 9 m off. Edge curbs are accents only.

## Stack

- Vite + React 19 + TypeScript
- three.js / react-three-fiber / drei / rapier
- Nominatim + OSRM public demo via `/api/nominatim` and `/api/osrm` (dev only)
- Terrarium/SRTM via `/api/terrarium` (dev proxy → AWS elevation-tiles-prod)
- Browser **Gamepad API** for USB controllers (no extra deps)
- CC0 textures: Poly Haven asphalt + aerial sand; Kenney road tilesheet vendored for later (see `ATTRIBUTION.md`)
- CC0 car: Kenney Car Kit sedan + wheels (`public/models/kenney-car/`)

## What works vs later

**Works**

- Kenney CC0 sedan (sports GLB sitting there as a second skin, no picker yet)
- Dark paved asphalt ribbon + lane paint + curb accents (dirt tracks stay brown)
- Terrarium/SRTM hills under the street box (flat fallback offline)
- Arcade signed-speed drive + bicycle-model steering; WASD **and** USB gamepad (LT/RT/LB)
- Live OSM street when the proxy works
- Demo fallback with length shown in the HUD
- Soft guidance (nearest segment + look-ahead meters), not rails
- Hard ~200 ft off-road containment from the loaded street grid (Rapier)
- Floating street-name labels in the 3D view (OSM `name`/`ref`, distance cull + perspective)
- Set / clear destination + off-course OSRM reroute (Phase 1 GPS)

**Later (issues)**

- OSM buildings (#5) — parked
- Production geocode proxy (#6)
- Drop / arrive / multi-stop (#8)
- Street tile streaming (#11) — **shipped**: ~1 km tiles, soft void edge, GPS zoom
- Water + biome polish on top of elevation (#14 remainder)
- Blue marble entry (#15)


## Street tile streaming (open world)

Drop no longer freezes one 3 km Overpass box forever. Streets stream as **~1 km tiles**:

```
TILE_M = 1000
tx = floor(localX / TILE_M)
tz = floor(localZ / TILE_M)
```

At Drop latitude φ: `Δlat ≈ TILE_M / 111320`, `Δlng ≈ TILE_M / (111320·cos φ)`.

- **Active ring = 1** → 3×3 tiles live in Scene **and** GpsDash (~3 km across)
- **Prefetch ring = 2** → outer ring may download into cache only
- Leaving a tile farther than the prefetch ring **unloads** it from both world and dial

### Hard GPS rule (Joey lock)

GpsDash strokes **only** streets from tiles with `status === 'active'` (mounted in
Scene/Road). Prefetch may hit the network, but never paints on the dial until
that tile activates. When a tile loads into the 3D world, it appears on GPS at
the same time — that **is** the visual load indicator.

### Soft edge

The hard ~200 ft road-corridor walls are off while streaming. Off-road bump +
50% speed still apply on loaded asphalt. Driving into unloaded void soft-clamps
you back into the loaded AABB (no invisible brick wall).

### GPS zoom

`+` / `−` on the dial change meters-across-the-map (persisted in `localStorage`).
Zoomed out shows more of the **loaded** map; driving toward the edge of loaded
data still triggers the next tile (world + then GPS).

### HUD

`Tiles: N loaded · streaming` — live active tile count.

See `src/lib/streetTiles.ts` (math + queue) and `src/hooks/useStreetStreaming.ts`.

## Licenses

See `ATTRIBUTION.md`. OSM data © OpenStreetMap contributors (ODbL). Public Nominatim/OSRM are for light prototyping only. Elevation: AWS Terrain Tiles / Mapzen Terrarium (SRTM and related public DEMs).
