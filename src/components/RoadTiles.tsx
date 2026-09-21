/**
 * Incremental asphalt: one <Road> group per active street tile.
 *
 * LEARNING — why not one mega mesh?
 *   Flattening every active way into a single Road useMemo meant each new
 *   ~1 km tile remeshed the *entire* world asphalt (densify + ribbon + drape).
 *   On Drop, 3×3 completions felt like hitting a bump every time something
 *   new loaded. Per-tile groups: activate tile (3,1) → rebuild only that
 *   tile’s ribbons; neighbors keep their BufferGeometry.
 *
 *   heightGrid swaps still re-drape each mounted tile (elev is debounced /
 *   significance-gated in Scene so that hitch is rare). Car / FollowCam /
 *   Scene never remount on streamVersion (Joey lock).
 */

import { useMemo } from 'react'
import { polylineToLocal, type LatLng } from '../lib/geo'
import type { ActiveTileWays } from '../lib/streetTiles'
import type { HeightGrid } from '../lib/terrarium'
import { Road, type LocalStreet } from './Road'

type RoadTilesProps = {
  origin: LatLng
  tiles: ActiveTileWays[]
  heightGrid: HeightGrid
}

function tileToLocalStreets(tile: ActiveTileWays, origin: LatLng): LocalStreet[] {
  return tile.ways.map((w) => ({
    points: polylineToLocal(w.points, origin),
    kind: w.kind,
    highway: w.highway,
    name: w.name,
    ref: w.ref,
  }))
}

export function RoadTiles({ origin, tiles, heightGrid }: RoadTilesProps) {
  // Stable list identity when only elev changes — each Road still sees heightGrid.
  const mounted = useMemo(
    () =>
      tiles.map((t) => ({
        key: t.key,
        streets: tileToLocalStreets(t, origin),
      })),
    [tiles, origin],
  )

  if (!mounted.length) return null

  return (
    <group>
      {mounted.map((t) => (
        <Road key={t.key} streets={t.streets} heightGrid={heightGrid} />
      ))}
    </group>
  )
}
