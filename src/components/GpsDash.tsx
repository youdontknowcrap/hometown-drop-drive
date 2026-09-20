import { useEffect, useRef } from 'react'
import { carPose } from '../lib/carPose'
import { localToLatLng, type LatLng } from '../lib/geo'
import type { XzPoint } from '../lib/roadMesh'

type GpsDashProps = {
  origin: LatLng
  ways: XzPoint[][]
  /** Optional blue GPS route overlay on the mini-map. */
  route?: XzPoint[]
}

const SIZE = 168

/** Mini map of the loaded street grid + car blip + GPS route. */
export function GpsDash({ origin, ways, route = [] }: GpsDashProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const coordRef = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    for (const way of ways) {
      for (const p of way) {
        minX = Math.min(minX, p[0])
        maxX = Math.max(maxX, p[0])
        minZ = Math.min(minZ, p[2])
        maxZ = Math.max(maxZ, p[2])
      }
    }
    for (const p of route) {
      minX = Math.min(minX, p[0])
      maxX = Math.max(maxX, p[0])
      minZ = Math.min(minZ, p[2])
      maxZ = Math.max(maxZ, p[2])
    }
    if (!Number.isFinite(minX)) {
      minX = -100
      maxX = 100
      minZ = -100
      maxZ = 100
    }
    const pad = 40
    minX -= pad
    maxX += pad
    minZ -= pad
    maxZ += pad
    const span = Math.max(maxX - minX, maxZ - minZ, 1)

    const toPx = (x: number, z: number) => {
      const u = (x - minX) / span
      const v = (z - minZ) / span
      return { x: u * SIZE, y: v * SIZE }
    }

    let raf = 0
    const draw = () => {
      ctx.fillStyle = '#0b1c28'
      ctx.fillRect(0, 0, SIZE, SIZE)
      ctx.strokeStyle = '#5c7a8a'
      ctx.lineWidth = 1.2
      for (const way of ways) {
        if (way.length < 2) continue
        ctx.beginPath()
        const a = toPx(way[0][0], way[0][2])
        ctx.moveTo(a.x, a.y)
        for (let i = 1; i < way.length; i++) {
          const p = toPx(way[i][0], way[i][2])
          ctx.lineTo(p.x, p.y)
        }
        ctx.stroke()
      }

      if (route.length >= 2) {
        ctx.strokeStyle = '#42a5f5'
        ctx.lineWidth = 2.4
        ctx.beginPath()
        const a = toPx(route[0][0], route[0][2])
        ctx.moveTo(a.x, a.y)
        for (let i = 1; i < route.length; i++) {
          const p = toPx(route[i][0], route[i][2])
          ctx.lineTo(p.x, p.y)
        }
        ctx.stroke()
        const end = toPx(route[route.length - 1][0], route[route.length - 1][2])
        ctx.fillStyle = '#ef5350'
        ctx.beginPath()
        ctx.arc(end.x, end.y, 4, 0, Math.PI * 2)
        ctx.fill()
      }

      if (carPose.ready) {
        const p = toPx(carPose.x, carPose.z)
        ctx.save()
        ctx.translate(p.x, p.y)
        ctx.rotate(carPose.yaw)
        ctx.fillStyle = '#ffca28'
        ctx.beginPath()
        ctx.moveTo(0, -7)
        ctx.lineTo(5, 6)
        ctx.lineTo(0, 3)
        ctx.lineTo(-5, 6)
        ctx.closePath()
        ctx.fill()
        ctx.restore()

        if (coordRef.current) {
          const ll = localToLatLng(carPose.x, carPose.z, origin)
          coordRef.current.textContent = `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`
        }
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [origin, ways, route])

  return (
    <div className="gps">
      <canvas ref={canvasRef} width={SIZE} height={SIZE} aria-label="GPS" />
      <p className="gps-coord" ref={coordRef}>
        GPS
      </p>
    </div>
  )
}
