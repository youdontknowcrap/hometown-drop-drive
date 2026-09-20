# Hometown Drop & Drive

Kid-friendly **browser driving toy**: type a start and stop address, get an OpenStreetMap driving path, and drive with WASD or a USB game controller.

Drop at an address. Load **every OSM street in a 3 km radius** (including backroads / tracks). Drive them. Leave the asphalt a bit, then hit a **hard stop ~200 ft** off the road network (not curb-hugging Autopia rails). GPS dash + camera sliders.

Web-first prototype (no Unity). Live routing needs `npm run dev` (Vite proxy). Offline / CORS failure falls back to a Ridgecrest demo loop.

## Developer inbox

Bugs, extra requirements, and “we discussed this” notes go in **GitHub Issues** on this repo — not a side README.

https://github.com/youdontknowcrap/hometown-drop-drive/issues

Commit messages close or reference those issues (`Fixes #1`). That is the paper trail.

Buildings are parked on purpose (issue #5) until streets read as streets.

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
- **S / ↓** — reverse / brake
- **A / ←** · **D / →** — steer (spring-return to center on release)
- **Esc** / click the 3D view — leave HUD text fields so driving works again

### USB game controller (Gamepad API)

Plug in any standard browser gamepad. Keyboard and pad work **at the same time** (inputs merge each frame).

| Input | Action |
| --- | --- |
| Left stick X / D-pad | Steer (deadzone ~0.15) |
| Right trigger (RT) / **A** | Accelerate |
| Left trigger (LT) / **B** | Brake / reverse |

Stick axes use a **0.15 deadzone** so resting sticks don’t drift. Steering is analog from the stick and springs back to center when released (same as releasing A/D).

### HUD

- **Drop** — geocode + load the OSM street grid (respawns the car)
- **Set destination** — GPS path from the car to an address (while driving)
- **Clear** — free drive, hide the blue line
- **Guidance ON** — soft follow the blue GPS line (nearest-segment hint)
- **Guidance OFF** / no destination — free drive

Drive off the planned path and GPS **reroutes** (debounced). You can drive onto the desert for ~200 ft, then a hard corridor wall stops the car. Ground and road textures repeat in **meters**. Cap speed **110 mph** (+5 / −3 coast / −8 brake).

## Why streets were missing (and what changed)

OSM/OSRM already returned a centerline in lat/lng. Milestone 1 only drew a `Line` on a tan box. The datum was there; the street was not.

Now the centerline is a **dark asphalt ribbon** (not desert-with-rails): ~7.2 m wide paved, length = great-circle meters along the path, UV.v = distance / 6 m. Lane dashes are 3 m on / 9 m off. Edge curbs are accents only.

## Stack

- Vite + React 19 + TypeScript
- three.js / react-three-fiber / drei / rapier
- Nominatim + OSRM public demo via `/api/nominatim` and `/api/osrm` (dev only)
- Browser **Gamepad API** for USB controllers (no extra deps)
- CC0 textures: Poly Haven asphalt + aerial sand; Kenney road tilesheet vendored for later (see `ATTRIBUTION.md`)
- CC0 car: Kenney Car Kit sedan + wheels (`public/models/kenney-car/`)

## What works vs later

**Works**

- Kenney CC0 sedan (sports GLB sitting there as a second skin, no picker yet)
- Dark paved asphalt ribbon + lane paint + curb accents (dirt tracks stay brown)
- Textured desert you can drive on (thick ground collider + CCD — no fall-through)
- Arcade signed-speed drive + spring-return steering; WASD **and** USB gamepad
- Live OSM street when the proxy works
- Demo fallback with length shown in the HUD
- Soft guidance (nearest segment + look-ahead meters), not rails
- Hard ~200 ft off-road containment from the loaded street grid (Rapier)
- Set / clear destination + off-course OSRM reroute (Phase 1 GPS)

**Later (issues)**

- OSM buildings (#5) — parked
- Production geocode proxy (#6)
- Drop / arrive / multi-stop (#8)
- Streaming the whole map (#4 remainder)

## Licenses

See `ATTRIBUTION.md`. OSM data © OpenStreetMap contributors (ODbL). Public Nominatim/OSRM are for light prototyping only.
