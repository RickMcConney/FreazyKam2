import { memo } from 'react'
import { Group, Line, Circle } from 'react-konva'
import { useUIStore } from '../../store/uiStore'
import { OP_TYPE_COLORS } from '../../colors'

/**
 * The ghost of what a click would place, while the Tabs form's click-to-place is on
 * (`uiStore.holdPreview`, set by useTabPlaceTool): a strip across the gap, or a tab on the
 * outline — drawn as the real ones are, fainter, so the click is never a guess.
 *
 * In the simulation's layer like the hover highlight: it moves with the pointer, and on the
 * drawing's layer every move would repaint the whole drawing.
 */
export const HoldPreviewLayer = memo(function HoldPreviewLayer() {
  const p = useUIStore((s) => s.holdPreview)
  if (!p) return null
  if (p.kind === 'strip') {
    const len = Math.hypot(p.x2 - p.x1, p.y2 - p.y1)
    if (len < 1e-9) return null
    const h = p.widthMM / 2
    const nx = -(p.y2 - p.y1) / len * h, ny = (p.x2 - p.x1) / len * h
    return (
      <Line listening={false} closed fill={OP_TYPE_COLORS.tabs} opacity={0.3} perfectDrawEnabled={false}
        points={[p.x1 + nx, p.y1 + ny, p.x2 + nx, p.y2 + ny, p.x2 - nx, p.y2 - ny, p.x1 - nx, p.y1 - ny]} />
    )
  }
  const ux = p.tx, uy = p.ty, nx = -uy, ny = ux
  const hl = p.lengthMM / 2, hw = p.heightMM / 2
  return (
    <Group listening={false}>
      <Line closed fill="#f59e0b" opacity={0.35} perfectDrawEnabled={false}
        points={[
          p.x - ux * hl - nx * hw, p.y - uy * hl - ny * hw, p.x + ux * hl - nx * hw, p.y + uy * hl - ny * hw,
          p.x + ux * hl + nx * hw, p.y + uy * hl + ny * hw, p.x - ux * hl + nx * hw, p.y - uy * hl + ny * hw,
        ]} />
      <Circle x={p.x} y={p.y} radius={hw * 0.6} fill="#f59e0b" opacity={0.6} perfectDrawEnabled={false} />
    </Group>
  )
})
