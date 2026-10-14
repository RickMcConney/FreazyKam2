import { memo } from 'react'
import { Label, Tag, Text } from 'react-konva'
import type { Viewport } from '../CanvasStage'
import { useWorkpieceStore } from '../../store/workpieceStore'
import { useUIStore } from '../../store/uiStore'
import { sheetOffset } from '../../cam/sheets'
import { useSheetCount } from '../useSheetCount'

const FONT_PX = 12
const LIFT_PX = 4

/**
 * "Sheet 1", "Sheet 2"… above each sheet's top-left corner, when a nest spread the parts
 * over several (cam/sheets). In the SCREEN-space layer, over the drawing: inside the sheet
 * they were drawn under the parts nested into that corner, and at a fixed pixel size they
 * stay readable however far out the view is zoomed. Zoomed right out, the gap between rows
 * is narrower than a line of text, so a label can sit on the bottom edge of the sheet
 * above it — the tag behind the text keeps it legible there.
 */
export const SheetLabelLayer = memo(function SheetLabelLayer({ viewport }: { viewport: Viewport }) {
  const sheets = useSheetCount()
  const widthMM = useWorkpieceStore((s) => s.widthMM)
  const heightMM = useWorkpieceStore((s) => s.heightMM)
  const active = Math.min(useUIStore((s) => s.activeSheet), sheets - 1)
  const dark = useUIStore((s) => s.darkMode)
  if (sheets < 2) return null
  return (
    <>
      {Array.from({ length: sheets }, (_, k) => {
        const o = sheetOffset(k, { widthMM, heightMM })
        // CNC → screen: the sheet's top-left corner, then up by the label's height.
        const sx = viewport.x + o.x * viewport.scale
        const sy = viewport.y - (o.y + heightMM) * viewport.scale
        return (
          <Label key={k} x={sx} y={sy - LIFT_PX - FONT_PX - 4}>
            <Tag fill={dark ? '#262626' : '#f3f4f6'} opacity={0.9} cornerRadius={3} />
            <Text text={`Sheet ${k + 1}`} fontSize={FONT_PX} padding={2}
              fontStyle={k === active ? 'bold' : 'normal'}
              fill={k === active ? (dark ? '#ffffff' : '#111827') : (dark ? '#a3a3a3' : '#4b5563')} />
          </Label>
        )
      })}
    </>
  )
})
