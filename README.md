# Hometown Drop & Drive

Kid-friendly **browser driving toy**: type a start and stop address, get an OpenStreetMap driving path, and drive with WASD.

Drop at an address. Load **every OSM street in a 3 km radius** (including backroads / tracks). Drive them. Leave the asphalt if the car can. No Autopia walls. GPS dash + camera sliders.

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

- **W / ↑** — accelerate
- **S / ↓** — reverse / brake
- **A / ←** · **D / →** — steer
- **Drop** — geocode + load the OSM street grid (respawns the car)
- **Set destination** — GPS path from the car to an address (while driving)
- **Clear** — free drive, hide the blue line
- **Guidance ON** — soft follow the blue GPS line (nearest-segment hint)
- **Guidance OFF** / no destination — free drive

Drive off the planned path and GPS **reroutes** (debounced). You can drive onto the desert. Ground and road textures repeat in **meters**.

## Why streets were missing (and what changed)

OSM/OSRM already returned a centerline in lat/lng. Milestone 1 only drew a `Line` on a tan box. The datum was there; the street was not.

Now the centerline is a ribbon: 7.2 m wide, length = great-circle meters along the path, UV.v = distance / 6 m. Lane dashes are 3 m on / 9 m off.

## Stack

- Vite + React 19 + TypeScript
- three.js / react-three-fiber / drei / rapier
- Nominatim + OSRM public demo via `/api/nominatim` and `/api/osrm` (dev only)
- CC0 textures: Poly Haven asphalt + aerial sand; Kenney road tilesheet vendored for later (see `ATTRIBUTION.md`)
- CC0 car: Kenney Car Kit sedan + wheels (`public/models/kenney-car/`)

## What works vs later

**Works**

- Kenney CC0 sedan (sports GLB sitting there as a second skin, no picker yet)
- Metric asphalt ribbon + lane paint
- Textured desert you can drive on
- Live OSM street when the proxy works
- Demo fallback with length shown in the HUD
- Soft guidance (nearest segment + look-ahead meters), not rails
- Set / clear destination + off-course OSRM reroute (Phase 1 GPS)

**Later (issues)**

- OSM buildings (#5) — parked
- Production geocode proxy (#6)
- Drop / arrive / multi-stop (#8)
- Streaming the whole map (#4 remainder)

## Licenses

See `ATTRIBUTION.md`. OSM data © OpenStreetMap contributors (ODbL). Public Nominatim/OSRM are for light prototyping only.
