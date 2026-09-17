import { memo, Fragment } from 'react'
import { Group, Shape, Circle } from 'react-konva'
import type { Viewport } from '../CanvasStage'
import { useToolpathStore, type MotionSegment } from '../../store/toolpathStore'
import { useToolStore } from '../../store/toolStore'

interface Props {
  viewport: Viewport
}

interface SegmentGroups {
  cutting: number[][]
  rapid: number[][]
  travel: number[][]
  firstCut: [number, number] | null
}

type SegType = 'cutting' | 'rapid' | 'travel'

function segType(seg: MotionSegment): SegType {
  if (seg.rapid) return 'rapid'
  if (seg.travel) return 'travel'
  return 'cutting'
}

// Expands an arc MotionSegment to flat [x,y,...] polyline points starting after the given prev position.
function arcToPolyPts(px: number, py: number, seg: MotionSegment): number[] {
  const { cx, cy, cw } = seg.arc!
  const r = Math.hypot(px - cx, py - cy)
  if (r < 0.001) return [seg.x, seg.y]
  let a0 = Math.atan2(py - cy, px - cx)
  let a1 = Math.atan2(seg.y - cy, seg.x - cx)
  const isFullCircle = Math.abs(px - seg.x) < 0.001 && Math.abs(py - seg.y) < 0.001
  if (isFullCircle) a1 = a0 + (cw ? -2 * Math.PI : 2 * Math.PI)
  else if (cw) { if (a1 >= a0) a1 -= 2 * Math.PI }
  else { if (a1 <= a0) a1 += 2 * Math.PI }
  const steps = Math.max(8, Math.ceil(Math.abs(a1 - a0) / (5 * Math.PI / 180)))
  const pts: number[] = []
  for (let k = 1; k <= steps; k++) {
    const a = a0 + (a1 - a0) * (k / steps)
    pts.push(cx + r * Math.cos(a), cy + r * Math.sin(a))
  }
  return pts
}

function groupSegments(segments: MotionSegment[]): SegmentGroups {
  const cutting: number[][] = []
  const rapid: number[][] = []
  const travel: number[][] = []
  let cur: number[] = []
  let curType: SegType = segType(segments[0] ?? { rapid: true, x: 0, y: 0, z: 0 })
  let firstCut: [number, number] | null = null
  let prevX = segments[0]?.x ?? 0
  let prevY = segments[0]?.y ?? 0

  const pushCur = (t: SegType) => {
    if (cur.length >= 4) {
      if (t === 'rapid') rapid.push(cur)
      else if (t === 'travel') travel.push(cur)
      else cutting.push(cur)
    }
  }

  for (const seg of segments) {
    const pts = seg.arc ? arcToPolyPts(prevX, prevY, seg) : [seg.x, seg.y]
    const st = segType(seg)

    if (st !== curType) {
      pushCur(curType)
      cur = cur.length >= 2 ? [cur[cur.length - 2], cur[cur.length - 1], ...pts] : [...pts]
      curType = st
    } else {
      cur.push(...pts)
    }
    if (st === 'cutting' && firstCut === null) firstCut = [pts[0], pts[1]]
    prevX = seg.x; prevY = seg.y
  }
  pushCur(curType)

  return { cutting, rapid, travel, firstCut }
}

// GROUPED ONCE PER TOOLPATH, NOT ONCE PER RENDER. The layer re-renders on every pan and
// zoom frame (its viewport prop), and grouping walked every segment of every visible op,
// expanded every arc and allocated fresh point arrays each time. Segments arrays are
// replaced, never mutated, so an unchanged array has an unchanged grouping; the WeakMap lets
// a toolpath's grouping go when its segments do.
const groupCache = new WeakMap<MotionSegment[], SegmentGroups>()
function groupsFor(segments: MotionSegment[]): SegmentGroups {
  let g = groupCache.get(segments)
  if (!g) {
    g = groupSegments(segments)
    groupCache.set(segments, g)
  }
  return g
}

// One stroke over a set of runs — one beginPath and one strokeShape however many runs there
// are. The dash is set in mm-per-pixel terms by the caller and cleared again afterwards so it
// does not leak into the next shape drawn on the layer's context.
function RunStroke({ runs, stroke, strokeWidth, opacity, dash }: {
  runs: number[][]
  stroke: string
  strokeWidth: number
  opacity: number
  dash?: number[]
}) {
  return (
    <Shape
      sceneFunc={(ctx, shape) => {
        ctx.beginPath()
        if (dash) (ctx as unknown as CanvasRenderingContext2D).setLineDash(dash)
        for (const pts of runs) {
          if (pts.length < 4) continue
          ctx.moveTo(pts[0], pts[1])
          for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1])
        }
        ctx.strokeShape(shape)
        if (dash) (ctx as unknown as CanvasRenderingContext2D).setLineDash([])
      }}
      stroke={stroke}
      strokeWidth={strokeWidth}
      lineJoin="round"
      lineCap="round"
      opacity={opacity}
      listening={false}
    />
  )
}

export const ToolpathLayer = memo(function ToolpathLayer({ viewport }: Props) {
  // Selectors, not whole-store destructuring: the tool store has nothing to say about a
  // toolpath but its drill radius, and the toolpath store's other fields change on writes
  // this layer does not draw.
  const operations = useToolpathStore((s) => s.operations)
  const tools = useToolStore((s) => s.tools)
  const { scale } = viewport

  const visible = operations.filter((o) => o.visible && o.status === 'done' && o.segments.length > 0)
  const dashScale = 1 / scale

  return (
    <Group>
      {visible.map((op) => {
        const { cutting, rapid, travel, firstCut } = groupsFor(op.segments)

        return (
          <Fragment key={op.id}>
            <RunStroke
              key={`${op.id}-c`}
              runs={cutting}
              stroke={op.color}
              strokeWidth={1.5 / scale}
              opacity={0.9}
            />

            {rapid.length > 0 && (
              <RunStroke
                key={`${op.id}-r`}
                runs={rapid}
                stroke="#e53e3e"
                strokeWidth={1.2 / scale}
                opacity={0.75}
                dash={[5 * dashScale, 4 * dashScale]}
              />
            )}

            {travel.length > 0 && (
              <RunStroke
                key={`${op.id}-t`}
                runs={travel}
                stroke="#38a169"
                strokeWidth={1.2 / scale}
                opacity={0.75}
                dash={[4 * dashScale, 3 * dashScale]}
              />
            )}

            {op.type === 'drill'
              ? (() => {
                  const tool = tools.find((t) => t.id === op.toolId)
                  const r = tool ? tool.diameterMM / 2 : 3.5 / scale
                  return op.points.map((pt, i) => (
                    <Circle
                      key={`${op.id}-dp-${i}`}
                      x={pt.x}
                      y={pt.y}
                      radius={r}
                      fill="transparent"
                      stroke={op.color}
                      strokeWidth={1.5 / scale}
                      opacity={0.9}
                      listening={false}
                    />
                  ))
                })()
              : firstCut && (
                  <Circle
                    key={`${op.id}-start`}
                    x={firstCut[0]}
                    y={firstCut[1]}
                    radius={3.5 / scale}
                    fill={op.color}
                    stroke="#ffffff"
                    strokeWidth={1 / scale}
                    opacity={0.95}
                    listening={false}
                  />
                )}
          </Fragment>
        )
      })}
    </Group>
  )
})
