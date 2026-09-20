# Hometown Drop & Drive

Kid-friendly **browser driving toy**: type a start and stop address, get an OpenStreetMap driving path, and drive with WASD.

The path is extruded into a **real-meter street** (two 12-ft lanes, world-locked asphalt UVs so speed is visible). The car is **not** locked to the road. Guidance is a soft hint plus an optional blue overlay.

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
- **Guidance ON** — blue overlay + soft steering hint (not rails)
- **Guidance OFF** — free drive, hide the overlay
- **Go** — geocode + load a new street (respawns the car)

You can drive onto the desert. Ground and road textures repeat in **meters**.

## Why streets were missing (and what changed)

OSM/OSRM already returned a centerline in lat/lng. Milestone 1 only drew a `Line` on a tan box. The datum was there; the street was not.

Now the centerline is a ribbon: 7.2 m wide, length = great-circle meters along the path, UV.v = distance / 6 m. Lane dashes are 3 m on / 9 m off.

## Stack

- Vite + React 19 + TypeScript
- three.js / react-three-fiber / drei / rapier
- Nominatim + OSRM public demo via `/api/nominatim` and `/api/osrm` (dev only)
- CC0 textures: Poly Haven asphalt + aerial sand; Kenney road tilesheet vendored for later (see `ATTRIBUTION.md`)

## What works vs later

**Works**

- Metric asphalt ribbon + lane paint
- Textured desert you can drive on
- Live OSM street when the proxy works
- Demo fallback with length shown in the HUD
- Soft guidance, not rails

**Later (issues)**

- OSM buildings (#5) — parked
- Production geocode proxy (#6)
- Guidance nearest-segment (#7)
- Drop / arrive / multi-stop (#8)
- Streaming the whole map (#4 remainder)

## Licenses

See `ATTRIBUTION.md`. OSM data © OpenStreetMap contributors (ODbL). Public Nominatim/OSRM are for light prototyping only.
