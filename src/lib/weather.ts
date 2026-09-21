/**
 * Local weather via Open-Meteo forecast (free, no API key).
 *
 * Default path: fetch current conditions for the Drop lat/lng, then drive
 * sky / fog / sun intensity / light rain from that. HUD can override with
 * a small preset list so teens can force “Storm” for STEM drama.
 *
 * API:
 *   /v1/forecast?latitude=&longitude=&current=cloud_cover,precipitation,
 *     weather_code,wind_speed_10m&daily=sunrise,sunset&timezone=auto
 *
 * WMO weather_code (simplified for toys):
 *   0 clear · 1–3 cloudy ladder · 45/48 fog · 51–67 rain · 80–82 showers
 *   95–99 thunderstorm
 */

import type { LatLng } from './geo'

/** Manual override presets — Auto uses live Open-Meteo. */
export type WeatherPreset =
  | 'auto'
  | 'clear'
  | 'cloudy'
  | 'overcast'
  | 'rain'
  | 'storm'
  | 'fog'

export const WEATHER_PRESETS: { id: WeatherPreset; label: string }[] = [
  { id: 'auto', label: 'Auto (local)' },
  { id: 'clear', label: 'Clear' },
  { id: 'cloudy', label: 'Cloudy' },
  { id: 'overcast', label: 'Overcast' },
  { id: 'rain', label: 'Rain' },
  { id: 'storm', label: 'Storm' },
  { id: 'fog', label: 'Fog' },
]

/** Visual knobs Scene / Sky / fog consume. */
export type WeatherLook = {
  preset: WeatherPreset
  /** Live or overridden summary for the HUD. */
  summary: string
  cloudCover: number // 0–100
  precipMm: number
  weatherCode: number
  windKmh: number
  /** Fog near / far (meters). */
  fogNear: number
  fogFar: number
  fogColor: string
  skyBackground: string
  /** Multipliers on lights. */
  ambientScale: number
  sunScale: number
  /** drei Sky turbidity / rayleigh hints. */
  turbidity: number
  rayleigh: number
  /** Show light rain particle system. */
  rain: boolean
  rainDensity: number
  sunriseIso?: string
  sunsetIso?: string
  source: 'open-meteo' | 'preset' | 'fallback'
}

type ForecastJson = {
  current?: {
    weather_code?: number
    cloud_cover?: number
    precipitation?: number
    wind_speed_10m?: number
    temperature_2m?: number
  }
  daily?: {
    sunrise?: string[]
    sunset?: string[]
  }
}

function forecastUrls(origin: LatLng): string[] {
  const qs =
    `latitude=${origin.lat.toFixed(5)}&longitude=${origin.lng.toFixed(5)}` +
    `&current=temperature_2m,weather_code,cloud_cover,precipitation,wind_speed_10m` +
    `&daily=sunrise,sunset&timezone=auto&forecast_days=1`
  return [
    `/api/open-meteo/v1/forecast?${qs}`,
    `https://api.open-meteo.com/v1/forecast?${qs}`,
  ]
}

function codeLabel(code: number): string {
  if (code === 0) return 'Clear'
  if (code <= 3) return code === 3 ? 'Overcast' : 'Cloudy'
  if (code === 45 || code === 48) return 'Fog'
  if (code >= 51 && code <= 67) return 'Rain'
  if (code >= 80 && code <= 82) return 'Showers'
  if (code >= 95) return 'Storm'
  if (code >= 71 && code <= 77) return 'Snow'
  return `Code ${code}`
}

/** Map numeric conditions → visual look (shared by live + presets). */
export function lookFromConditions(opts: {
  preset: WeatherPreset
  cloudCover: number
  precipMm: number
  weatherCode: number
  windKmh: number
  tempC?: number
  sunriseIso?: string
  sunsetIso?: string
  source: WeatherLook['source']
  summaryExtra?: string
}): WeatherLook {
  const cloud = Math.max(0, Math.min(100, opts.cloudCover))
  const precip = Math.max(0, opts.precipMm)
  const code = opts.weatherCode

  const isFog = opts.preset === 'fog' || code === 45 || code === 48
  const isStorm = opts.preset === 'storm' || code >= 95
  const isRain =
    opts.preset === 'rain' ||
    isStorm ||
    precip > 0.1 ||
    (code >= 51 && code <= 67) ||
    (code >= 80 && code <= 82)

  // Fog distances: clear sees far; fog hugs the car.
  let fogNear = 220
  let fogFar = 640
  let fogColor = '#cfe8f5'
  let skyBackground = '#87ceeb'
  let ambientScale = 0.55
  let sunScale = 1.25
  let turbidity = 4
  let rayleigh = 1.2

  if (cloud > 40) {
    turbidity = 6 + cloud / 25
    rayleigh = 0.9
    fogColor = '#c5d4e0'
    skyBackground = '#9bb4c8'
    sunScale = 1.05
  }
  if (cloud > 75) {
    turbidity = 10
    rayleigh = 0.6
    fogNear = 160
    fogFar = 480
    fogColor = '#a8b8c8'
    skyBackground = '#7a8fa3'
    ambientScale = 0.45
    sunScale = 0.75
  }
  if (isRain) {
    fogNear = 120
    fogFar = 400
    fogColor = '#8a9aaa'
    skyBackground = '#6a7a8a'
    ambientScale = 0.4
    sunScale = 0.55
    turbidity = 12
    rayleigh = 0.4
  }
  if (isStorm) {
    fogNear = 80
    fogFar = 320
    fogColor = '#5a6a7a'
    skyBackground = '#3d4a58'
    ambientScale = 0.32
    sunScale = 0.35
    turbidity = 14
    rayleigh = 0.25
  }
  if (isFog) {
    fogNear = 18
    fogFar = 90
    fogColor = '#c8d0d4'
    skyBackground = '#b0b8bc'
    ambientScale = 0.5
    sunScale = 0.4
    turbidity = 8
    rayleigh = 0.5
  }

  const tempBit =
    opts.tempC != null && Number.isFinite(opts.tempC)
      ? ` · ${opts.tempC.toFixed(0)}°C`
      : ''
  const windBit =
    opts.windKmh > 0 ? ` · wind ${opts.windKmh.toFixed(0)} km/h` : ''
  const summary =
    (opts.preset === 'auto'
      ? `${codeLabel(code)}${tempBit} · cloud ${cloud.toFixed(0)}%`
      : WEATHER_PRESETS.find((p) => p.id === opts.preset)?.label ?? opts.preset) +
    windBit +
    (opts.summaryExtra ? ` · ${opts.summaryExtra}` : '')

  return {
    preset: opts.preset,
    summary,
    cloudCover: cloud,
    precipMm: precip,
    weatherCode: code,
    windKmh: opts.windKmh,
    fogNear,
    fogFar,
    fogColor,
    skyBackground,
    ambientScale,
    sunScale,
    turbidity,
    rayleigh,
    rain: isRain,
    rainDensity: isStorm ? 1 : isRain ? 0.55 : 0,
    sunriseIso: opts.sunriseIso,
    sunsetIso: opts.sunsetIso,
    source: opts.source,
  }
}

/** Hard-coded looks for manual HUD presets. */
export function lookForPreset(preset: WeatherPreset): WeatherLook {
  switch (preset) {
    case 'clear':
      return lookFromConditions({
        preset,
        cloudCover: 5,
        precipMm: 0,
        weatherCode: 0,
        windKmh: 8,
        source: 'preset',
      })
    case 'cloudy':
      return lookFromConditions({
        preset,
        cloudCover: 55,
        precipMm: 0,
        weatherCode: 2,
        windKmh: 12,
        source: 'preset',
      })
    case 'overcast':
      return lookFromConditions({
        preset,
        cloudCover: 95,
        precipMm: 0,
        weatherCode: 3,
        windKmh: 14,
        source: 'preset',
      })
    case 'rain':
      return lookFromConditions({
        preset,
        cloudCover: 90,
        precipMm: 2.5,
        weatherCode: 61,
        windKmh: 18,
        source: 'preset',
      })
    case 'storm':
      return lookFromConditions({
        preset,
        cloudCover: 100,
        precipMm: 8,
        weatherCode: 95,
        windKmh: 35,
        source: 'preset',
      })
    case 'fog':
      return lookFromConditions({
        preset,
        cloudCover: 80,
        precipMm: 0,
        weatherCode: 45,
        windKmh: 4,
        source: 'preset',
      })
    case 'auto':
    default:
      return lookFromConditions({
        preset: 'auto',
        cloudCover: 30,
        precipMm: 0,
        weatherCode: 1,
        windKmh: 10,
        source: 'fallback',
        summaryExtra: 'loading…',
      })
  }
}

/** Fetch live Open-Meteo current weather for a Drop. */
export async function fetchLocalWeather(origin: LatLng): Promise<WeatherLook> {
  let lastErr: Error | null = null
  for (const url of forecastUrls(origin)) {
    try {
      const res = await fetch(url)
      if (!res.ok) {
        lastErr = new Error(`weather HTTP ${res.status}`)
        continue
      }
      const data = (await res.json()) as ForecastJson
      const cur = data.current
      if (!cur) {
        lastErr = new Error('weather missing current')
        continue
      }
      return lookFromConditions({
        preset: 'auto',
        cloudCover: Number(cur.cloud_cover ?? 30),
        precipMm: Number(cur.precipitation ?? 0),
        weatherCode: Number(cur.weather_code ?? 1),
        windKmh: Number(cur.wind_speed_10m ?? 0),
        tempC: cur.temperature_2m != null ? Number(cur.temperature_2m) : undefined,
        sunriseIso: data.daily?.sunrise?.[0],
        sunsetIso: data.daily?.sunset?.[0],
        source: 'open-meteo',
        summaryExtra: 'Open-Meteo',
      })
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
    }
  }
  console.warn('[weather] fetch failed', lastErr)
  const fb = lookForPreset('clear')
  return {
    ...fb,
    preset: 'auto',
    source: 'fallback',
    summary: 'Weather unavailable — clear fallback',
  }
}

/**
 * Resolve what Scene should draw: manual preset wins, else live Auto look.
 */
export function resolveWeatherLook(
  preset: WeatherPreset,
  live: WeatherLook | null,
): WeatherLook {
  if (preset !== 'auto') return lookForPreset(preset)
  return live ?? lookForPreset('auto')
}
