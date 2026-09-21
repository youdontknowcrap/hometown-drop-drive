# Attribution

CC0 / public-domain assets only. No game rips (GTA, Fortnite, BeamNG, etc.).

## Poly Haven (CC0)

- `asphalt_01` — Dario Barresi (processing), Charlotte Baglioni (photography)
  https://polyhaven.com/a/asphalt_01
- `aerial_sand` — Rob Tuytel
  https://polyhaven.com/a/aerial_sand

Files in `public/textures/` are 1K JPG (web toy size).

## Kenney Car Kit (CC0)

- https://kenney.nl/assets/car-kit
- Default driveable car: `sedan-sports.glb` (spoiler + stance) with a runtime metallic paint pass + emissive lamps.
- `sedan.glb` + `wheel-default.glb` kept in-tree as CC0 spares.
- License: `public/models/kenney-car/LICENSE.txt`

## Kenney Road Textures (CC0)

- https://kenney.nl/assets/road-textures
- License: `public/textures/kenney/LICENSE.txt`
- Tilesheet kept for later 2D-style markings. The live street ribbon uses Poly Haven asphalt + generated lane paint so length stays in real meters.

## Map data

- OpenStreetMap contributors (ODbL) via Nominatim + OSRM public demo (dev proxy only).


## Elevation (Terrarium / SRTM)

Mapzen Terrarium PNG tiles hosted as AWS Open Data (`elevation-tiles-prod`).
Built primarily from SRTM and related public DEMs. Used here as the browser-friendly
stand-in for DTED-class height data.

- Registry: https://registry.opendata.aws/terrain-tiles/
- Format: https://github.com/tilezen/joerd/blob/master/docs/formats.md
- Decode: `(R * 256 + G + B / 256) - 32768` → meters MSL


## Open-Meteo (elevation + weather)

Free, no-key APIs used for:
- Elevation grid fallback when Terrarium tiles fail: `/v1/elevation`
- Local current weather + sunrise/sunset: `/v1/forecast`

https://open-meteo.com/
