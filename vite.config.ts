import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Dev proxy avoids browser CORS when talking to public OSM services.
 * Production builds fall back to the demo Ridgecrest polyline if the
 * APIs are unreachable (see src/lib/routing.ts).
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
    },
  },
})
