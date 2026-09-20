# Hometown Drop & Drive

Kid-friendly **browser driving toy**: type a start and stop address, get an OpenStreetMap route, toggle blue-line guidance, and drive with WASD / arrow keys.

Web-first prototype (no Unity). Location-agnostic — works with any geocodable addresses, and always falls back to a Ridgecrest, CA demo loop if routing APIs fail (CORS / offline).

## Quick start

```bash
cd hometown-drop-drive
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

Production build:

```bash
npm install
npm run build
npm run preview
```

## Stack

| Piece | Choice |
|--------|--------|
| Bundler | [Vite](https://vitejs.dev/) |
| UI | React 19 + TypeScript |
| 3D | [three.js](https://threejs.org/) via [react-three-fiber](https://docs.pmnd.rs/react-three-fiber) |
| Helpers | [@react-three/drei](https://github.com/pmndrs/drei) (Sky, Line, camera) |
| Physics | [@react-three/rapier](https://github.com/pmndrs/react-three-rapier) |
| Geocode | [Nominatim](https://nominatim.org/) (OpenStreetMap) |
| Routing | [OSRM](https://project-osrm.org/) public demo server |

Dev-time CORS is handled by a small Vite proxy (`/api/nominatim`, `/api/osrm`) in `vite.config.ts`.

## Controls

- **W / ↑** — accelerate  
- **S / ↓** — reverse / brake  
- **A / ←** · **D / →** — steer  
- **Guidance ON** — show blue path + soft steering hint toward the line  
- **Guidance OFF** — free drive, hide the line  
- **Go** — geocode addresses and load a new route (respawns the car)

Unlimited gas. No damage model yet (planned later).

## What works vs stubbed (milestone 1)

**Works**

- Driveable 3D scene (sky, sun, desert ground, geometric car)
- WASD / arrow arcade controls with chase camera
- Address UI + Guidance toggle
- Nominatim + OSRM via Vite proxy
- Ridgecrest demo polyline fallback (always available)
- Soft guidance hint (not hard rails)

**Stubbed / next**

- Real road mesh / terrain from map tiles
- Physically richer vehicle (suspension, tire grip)
- Light damage / bumps
- Mobile touch controls
- Multi-stop “drop & drive” errands

## Licenses & attribution

- This project code: use freely for the Hometown Drop & Drive experiment.
- **OpenStreetMap** data © OpenStreetMap contributors ([ODbL](https://www.openstreetmap.org/copyright)).
- **Nominatim** — please respect the [usage policy](https://operations.osmfoundation.org/policies/nominatim/) (identify your app; cache results; don’t hammer the service).
- **OSRM** public demo — for light prototyping only; self-host or use a commercial provider for production traffic.
- **three.js / R3F / drei / rapier** — see their respective MIT (or similar) licenses in `node_modules`.

## Project layout

```
src/
  App.tsx                 # UI state + routing trigger
  components/
    Scene.tsx             # Canvas, lights, physics world
    Car.tsx               # Driveable geometric car
    Ground.tsx            # Playfield
    RouteLine.tsx         # Blue guidance line
    FollowCam.tsx         # Chase camera
    Hud.tsx               # Address overlay
  hooks/useKeyboard.ts
  lib/
    geo.ts                # Lat/lng ↔ local meters
    routing.ts            # Nominatim + OSRM + fallback
    demoRoute.ts          # Ridgecrest CA demo polyline
    guidance.ts           # Soft steering hint math
```

## Next recommended step

Add **map-aligned scenery**: project a short OSM road centerline into a textured ribbon / simple buildings near the route so the blue line feels like a hometown street, still using free public map data only.
