import { memo } from 'react'
import { Group, Line } from 'react-konva'
import type { Viewport } from '../viewport'
import { TabMarker, TAB_COLOR } from './TabLayer'
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
export const HoldPreviewLayer = memo(function HoldPreviewLayer({ viewport }: { viewport: Viewport }) {
  const p = useUIStore((s) => s.holdPreview)
  if (!p) return null
  if (p.kind === 'strip') {
    const len = Math.hypot(p.x2 - p.x1, p.y2 - p.y1)
    if (len < 1e-9) return null
    // Round-capped, as BridgeLayer draws the real ones: the ends pulled in by half the width.
    const h = p.widthMM / 2
    const pull = Math.min(h, len / 2) / len
    const dx = (p.x2 - p.x1) * pull, dy = (p.y2 - p.y1) * pull
    return (
      <Line listening={false} stroke={OP_TYPE_COLORS.tabs} strokeWidth={2 * h} lineCap="round" opacity={0.3} perfectDrawEnabled={false}
        points={[p.x1 + dx, p.y1 + dy, p.x2 - dx, p.y2 - dy]} />
    )
  }
  // The same marker a placed tab gets — bar, dot and handle, at the same size on screen.
  return (
    <Group listening={false} x={p.x} y={p.y} rotation={Math.atan2(p.ty, p.tx) * 180 / Math.PI} opacity={0.55}>
      <TabMarker lengthMM={p.lengthMM} outSide={p.outSide} scale={viewport.scale} fill={TAB_COLOR} />
    </Group>
  )
})
