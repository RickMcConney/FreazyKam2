import { useMemo, useState } from 'react'
import { Group, Circle } from 'react-konva'
import type { Viewport } from '../CanvasStage'
import { usePathsStore } from '../../store/pathsStore'
import { useUIStore } from '../../store/uiStore'
import { getTreatableCorners } from '../../tools/cornerTreatment'

const MARKER_R = 7
const STROKE_COLOR = '#38bdf8'
const SELECTED_COLOR = '#f59e0b'
const TREATED_COLOR = '#22c55e'
const HOVER_COLOR = '#ffffff'

// Clickable markers on the treatable corners of the corner-pick path.
// Rendered while the Corner Treatment form is open; clicking toggles which
// corners the treatment applies to (none selected = all). Corners come from
// the session's baseD snapshot, so already-treated corners (green) stay
// pickable — re-applying replaces their treatment.
export function CornerPickLayer({ viewport }: { viewport: Viewport }) {
  const cornerPickPathId = useUIStore((s) => s.cornerPickPathId)
  const cornerPickBaseD = useUIStore((s) => s.cornerPickBaseD)
  const nodeEditPathId = useUIStore((s) => s.nodeEditPathId)
  const selectedCorners = useUIStore((s) => s.selectedCorners)
  const treatedCorners = useUIStore((s) => s.treatedCorners)
  const toggleCorner = useUIStore((s) => s.toggleCorner)
  const path = usePathsStore((s) => s.paths.find((p) => p.id === cornerPickPathId))
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)

  const corners = useMemo(() => (cornerPickBaseD ? getTreatableCorners(cornerPickBaseD) : []), [cornerPickBaseD])

  // Suppressed during point-edit so markers don't overlap node-edit anchors
  if (!path || nodeEditPathId || corners.length === 0) return null

  const s = viewport.scale

  return (
    <Group>
      {corners.map(({ idx, x, y }) => {
        const isSelected = selectedCorners.includes(idx)
        const isTreated = treatedCorners.includes(idx)
        const isHovered = hoveredIdx === idx
        return (
          <Circle
            key={idx}
            x={x}
            y={y}
            radius={(isHovered ? MARKER_R + 2 : MARKER_R) / s}
            fill={isSelected ? SELECTED_COLOR : isTreated ? TREATED_COLOR : 'rgba(15,23,42,0.6)'}
            stroke={isHovered ? HOVER_COLOR : isSelected ? SELECTED_COLOR : isTreated ? TREATED_COLOR : STROKE_COLOR}
            strokeWidth={1.5 / s}
            listening
            onMouseEnter={() => setHoveredIdx(idx)}
            onMouseLeave={() => setHoveredIdx(null)}
            onMouseDown={(e) => {
              e.cancelBubble = true
              toggleCorner(idx)
            }}
          />
        )
      })}
    </Group>
  )
}
