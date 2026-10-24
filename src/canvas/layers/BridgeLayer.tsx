// The sheet's holding strips (cam/bridges, where they are called bridges): each a
// translucent band across the gap it joins, drawn in CNC space under the tab markers, so
// where the cuts will lift can be checked against the parts before anything is cut. Drawing
// only — they are placed from the Tabs form, and nothing here listens.

import { memo } from 'react'
import { Group, Line } from 'react-konva'
import { useWorkpieceStore } from '../../store/workpieceStore'
import { OP_TYPE_COLORS } from '../../colors'

export const BridgeLayer = memo(function BridgeLayer() {
  const bridges = useWorkpieceStore((s) => s.bridges)
  if (!bridges) return null
  const h = bridges.widthMM / 2
  return (
    <Group listening={false}>
      {bridges.lines.map((l, i) => {
        const len = Math.hypot(l.x2 - l.x1, l.y2 - l.y1)
        if (len < 1e-9) return null
        // The band's corners: the centreline pushed half a width to either side.
        const nx = -(l.y2 - l.y1) / len * h, ny = (l.x2 - l.x1) / len * h
        return (
          <Line key={i} closed fill={OP_TYPE_COLORS.tabs} opacity={0.45} perfectDrawEnabled={false}
            points={[l.x1 + nx, l.y1 + ny, l.x2 + nx, l.y2 + ny, l.x2 - nx, l.y2 - ny, l.x1 - nx, l.y1 - ny]} />
        )
      })}
    </Group>
  )
})
