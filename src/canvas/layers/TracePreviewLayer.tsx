import { Group, Path } from 'react-konva'
import type { Viewport } from '../CanvasStage'
import { useUIStore } from '../../store/uiStore'

// The open Trace form's result, drawn exactly as the paths Trace / Update Trace will make
// (uiStore.tracePreview) — same colours, same stroke as DesignLayer's unselected paths —
// so pressing the button changes nothing on screen but locks it in. The trace being
// re-done is hidden meanwhile (CanvasStage), so old and new never show together.
export function TracePreviewLayer({ viewport }: { viewport: Viewport }) {
  const preview = useUIStore((s) => s.tracePreview)
  if (!preview || preview.ds.length === 0) return null
  const sw = 1.5 / viewport.scale
  return (
    <Group listening={false}>
      {preview.ds.map((d, i) => (
        <Path key={i} data={d} stroke={preview.colors[i]} strokeWidth={sw} listening={false} />
      ))}
    </Group>
  )
}
