import { memo } from 'react'
import { Group, Shape } from 'react-konva'
import type { Viewport } from '../CanvasStage'
import { useWorkpieceStore } from '../../store/workpieceStore'
import { useUIStore } from '../../store/uiStore'
import { originWorldXY } from './WorkpieceLayer'
import { majorStepMM, minorStepMM, formatRulerLabel } from '../gridUtils'
import { canvasTheme } from '../../theme'

interface Props {
  viewport: Viewport
  stageWidth: number
  stageHeight: number
}

const FONT = 'ui-monospace, "SF Mono", Menlo, monospace'
const FONT_PX = 12

export const GridLayer = memo(function GridLayer({ viewport, stageWidth, stageHeight }: Props) {
  const { units, origin, widthMM, heightMM } = useWorkpieceStore()
  const darkMode = useUIStore((s) => s.darkMode)
  const C = canvasTheme(darkMode)
  const { x: vx, y: vy, scale } = viewport

  return (
    <Group listening={false}>
      <Shape
        sceneFunc={(ctx) => {
          const step = majorStepMM(scale, units)
          if (step * scale < 3) return

          const minor = minorStepMM(step, units)
          const drawMinor = minor * scale >= 3

          const { x: ox, y: oy } = originWorldXY(origin, widthMM, heightMM)

          // Visible CNC bounds with one-step margin so lines don't pop in
          const cncXMin = -vx / scale - step
          const cncXMax = (stageWidth - vx) / scale + step
          const cncYMin = (vy - stageHeight) / scale - step
          const cncYMax = vy / scale + step

          const c = ctx._context as CanvasRenderingContext2D
          c.save()

          // ── Minor lines ──────────────────────────────────────────────
          if (drawMinor) {
            c.strokeStyle = C.grid.axisMn
            c.lineWidth = 0.5 / scale
            c.beginPath()

            const xMin0 = ox + Math.floor((cncXMin - ox) / minor) * minor
            for (let wx = xMin0; wx <= cncXMax; wx += minor) {
              // skip positions that coincide with a major line
              if (Math.abs(Math.round((wx - ox) / step) * step - (wx - ox)) < step * 0.01) continue
              c.moveTo(wx, cncYMin)
              c.lineTo(wx, cncYMax)
            }

            const yMin0 = oy + Math.floor((cncYMin - oy) / minor) * minor
            for (let wy = yMin0; wy <= cncYMax; wy += minor) {
              if (Math.abs(Math.round((wy - oy) / step) * step - (wy - oy)) < step * 0.01) continue
              c.moveTo(cncXMin, wy)
              c.lineTo(cncXMax, wy)
            }

            c.stroke()
          }

          // ── Major lines ──────────────────────────────────────────────
          c.strokeStyle = C.grid.axisMj
          c.lineWidth = 0.5 / scale
          c.beginPath()

          const xMaj0 = ox + Math.floor((cncXMin - ox) / step) * step
          for (let wx = xMaj0; wx <= cncXMax; wx += step) {
            c.moveTo(wx, cncYMin)
            c.lineTo(wx, cncYMax)
          }

          const yMaj0 = oy + Math.floor((cncYMin - oy) / step) * step
          for (let wy = yMaj0; wy <= cncYMax; wy += step) {
            c.moveTo(cncXMin, wy)
            c.lineTo(cncXMax, wy)
          }

          c.stroke()

          // ── Origin axis lines (full-canvas, semi-transparent) ────────
          c.strokeStyle = C.grid.originLine
          c.lineWidth = 1 / scale
          c.globalAlpha = 0.35
          c.beginPath()
          c.moveTo(ox, cncYMin)
          c.lineTo(ox, cncYMax)
          c.moveTo(cncXMin, oy)
          c.lineTo(cncXMax, oy)
          c.stroke()
          c.globalAlpha = 1

          // ── Labels along axes ─────────────────────────────────────────
          // Clamp the label row/column to the visible area so labels remain
          // readable even when the origin is scrolled off-screen.
          const margin = 24 / scale
          const labelRowY = Math.max(cncYMin + margin, Math.min(cncYMax - margin, oy))
          const labelColX = Math.max(cncXMin + margin, Math.min(cncXMax - margin, ox))

          c.fillStyle = C.grid.mmLabel
          c.font = `${FONT_PX}px ${FONT}`

          // X labels: one per major vertical line, positioned on the horizontal axis
          c.textAlign = 'center'
          c.textBaseline = 'top'
          for (let wx = xMaj0; wx <= cncXMax; wx += step) {
            if (Math.abs(wx - ox) < step * 0.01) continue // skip origin
            const label = formatRulerLabel(wx - ox, units)
            c.save()
            // translate to CNC position, then undo layer scale so text is in screen px
            c.translate(wx, labelRowY)
            c.scale(1 / scale, -1 / scale)
            c.fillText(label, 0, 3)
            c.restore()
          }

          // Y labels: one per major horizontal line, positioned on the vertical axis
          c.textAlign = 'left'
          c.textBaseline = 'middle'
          for (let wy = yMaj0; wy <= cncYMax; wy += step) {
            if (Math.abs(wy - oy) < step * 0.01) continue // skip origin
            const label = formatRulerLabel(wy - oy, units)
            c.save()
            c.translate(labelColX, wy)
            c.scale(1 / scale, -1 / scale)
            c.fillText(label, 4, 0)
            c.restore()
          }

          c.restore()
        }}
        listening={false}
      />
    </Group>
  )
})
