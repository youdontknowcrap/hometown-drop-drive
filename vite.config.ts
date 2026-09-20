import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Dev proxy avoids browser CORS when talking to public OSM services
 * and AWS Terrarium elevation tiles (S3 sends no Access-Control-* headers).
 * Production builds fall back to the demo Ridgecrest polyline / flat ground
 * if the APIs are unreachable (see src/lib/routing.ts, src/lib/terrarium.ts).
 */
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/nominatim': {
        target: 'https://nominatim.openstreetmap.org',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/nominatim/, ''),
        headers: {
          // Nominatim usage policy asks for a valid User-Agent / Referer.
          'User-Agent': 'HometownDropDrive/0.1 (family web toy; contact: local-dev)',
        },
      },
      '/api/osrm': {
        target: 'https://router.project-osrm.org',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/osrm/, ''),
      },
      '/api/overpass': {
        target: 'https://overpass-api.de',
        changeOrigin: true,
        rewrite: () => '/api/interpreter',
        headers: {
          'User-Agent': 'HometownDropDrive/0.1 (family web toy; contact: local-dev)',
        },
      },
      // Mapzen Terrarium on AWS Open Data — SRTM-family elev for hills.
      // Browser → /api/terrarium/12/709/1613.png
      // Proxy  → https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/709/1613.png
      '/api/terrarium': {
        target: 'https://s3.amazonaws.com/elevation-tiles-prod',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/terrarium/, '/terrarium'),
      },
    },
  },
})
