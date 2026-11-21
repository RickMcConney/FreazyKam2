import { memo, useMemo } from 'react'
import { Group } from 'react-konva'
import type { ImportedPath } from '../../importers/svgImporter'
import { shapeDragReadout } from '../../shapes/dragReadout'
import { scaleShapeParams } from '../../shapes/shapeGenerators'
import { useCanvasStore } from '../../store/canvasStore'
import { useWorkpieceStore } from '../../store/workpieceStore'
import { placedAngleDeg, transformPoint, type BBox } from '../selectionUtils'
import type { LiveTransform } from '../types'
import type { Viewport } from '../viewport'
import { BoxDims, Plate, readoutText } from './ShapeDimLayer'

// The live figures of a TRANSFORM-HANDLE gesture, the handle counterpart of
// ShapeDimLayer. A resize dimensions the box as it will land, with the scale and —
// for a lone shape — the parameters the scale carries it to (the same
// scaleShapeParams the Properties panel shows live); a rotate states the angle the
// selection will stand at and how far this drag has turned it; a skew its shear
// angles. A plain move draws nothing: its figures are a position, and the snap
// guides already answer where it is going.

interface Props {
  viewport: Viewport
  bbox: BBox
  liveTransform: LiveTransform | null
  selectedPaths: ImportedPath[]
}

const pct = (k: number) => `${(k * 100).toFixed(1)}%`
const deg = (a: number) => `${a.toFixed(1)}°`
const signedDeg = (a: number) => `${a > 0 ? '+' : a < 0 ? '−' : ''}${Math.abs(a).toFixed(1)}°`
/** Into (−180, 180], the range the Angle field shows. */
const wrapDeg = (a: number) => { const r = ((a % 360) + 540) % 360 - 180; return r === -180 ? 180 : r }

export const TransformDimLayer = memo(function TransformDimLayer({ viewport, bbox, liveTransform: lt, selectedPaths }: Props) {
  const units = useWorkpieceStore((s) => s.units)
  const cursor = useCanvasStore((s) => s.cursorMM)

  // The shape whose parameters a resize carries: a lone parametric path, or a
  // selection that is exactly one multi-part shape (a gear's parts) — the rule the
  // Properties panel uses.
  const shapeParams = useMemo(() => {
    if (selectedPaths.length === 1) return selectedPaths[0].shapeParams ?? null
    const g = selectedPaths[0]?.groupId
    return g && selectedPaths.every((p) => p.groupId === g && p.shapePart !== undefined && p.shapeParams)
      ? selectedPaths[0].shapeParams ?? null : null
  }, [selectedPaths])
  // How far the selection already stands turned — one answer only when every path agrees.
  const placedAngle = useMemo(() => {
    const a = selectedPaths.map((p) => placedAngleDeg(p.placement))
    return a.length && a.every((d) => Math.abs(d - a[0]) < 1e-6) ? a[0] : null
  }, [selectedPaths])

  if (!lt || lt.kind === 'translate') return null

  const atCursor = (text: string) => cursor && (
    <Plate x={viewport.x + cursor.x * viewport.scale + 16} y={viewport.y - cursor.y * viewport.scale + 16} text={text} />
  )

  if (lt.kind === 'scale') {
    const a = transformPoint(bbox.minX, bbox.minY, lt), b = transformPoint(bbox.maxX, bbox.maxY, lt)
    const box = { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) }
    const lines: string[] = [Math.abs(lt.sx - lt.sy) < 1e-9
      ? `Scale ${pct(Math.abs(lt.sx))}`
      : `Scale X ${pct(Math.abs(lt.sx))}  Y ${pct(Math.abs(lt.sy))}`]
    // A scale the shape cannot express spills into the placement and leaves the
    // parameters as they were, so there is nothing new to show for them.
    const scaled = shapeParams ? scaleShapeParams(shapeParams, lt.ax, lt.ay, lt.sx, lt.sy) : null
    const extra = scaled ? readoutText(shapeDragReadout(scaled), units) : ''
    if (extra) lines.push(extra)
    return <Group listening={false}><BoxDims viewport={viewport} box={box} readout={lines.join('\n')} /></Group>
  }

  if (lt.kind === 'rotate') {
    const lines = placedAngle !== null
      ? [`Angle ${deg(wrapDeg(placedAngle + lt.angle))}`, `Turned ${signedDeg(lt.angle)}`]
      : [`Turned ${signedDeg(lt.angle)}`]
    return <Group listening={false}>{atCursor(lines.join('\n'))}</Group>
  }

  // Skew: a shear k leans an edge by atan(k).
  const lines: string[] = []
  if (Math.abs(lt.kx) > 1e-9) lines.push(`Skew X ${signedDeg(Math.atan(lt.kx) * 180 / Math.PI)}`)
  if (Math.abs(lt.ky) > 1e-9) lines.push(`Skew Y ${signedDeg(Math.atan(lt.ky) * 180 / Math.PI)}`)
  if (!lines.length) return null
  return <Group listening={false}>{atCursor(lines.join('\n'))}</Group>
})
