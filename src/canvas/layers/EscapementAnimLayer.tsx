import { useEffect, useMemo, useRef, useState } from 'react'
import { Group, Path } from 'react-konva'
import type { Viewport } from '../CanvasStage'
import { usePathsStore } from '../../store/pathsStore'
import { useUIStore } from '../../store/uiStore'
import {
  generateEscapementParts, escapementDims, escapementPose, anchorOffset,
} from '../../shapes/escapementGenerator'

/**
 * The escapement, running.
 *
 * The parts are drawn CLEAR of each other — they are two pieces to be cut, and
 * overlapping outlines would be no use on the stock — which leaves the one
 * question a drawing cannot answer: put together, do they bind? So this puts
 * them together. The anchor is slid from where it is drawn down onto the true
 * centre distance and the pair is stepped through `escapementPose`, the
 * escapement's own kinematics, at a speed slow enough to watch a tooth go past
 * a pallet.
 *
 * Nothing here touches the document. The group's own paths are hidden while it
 * runs (a static wheel sitting under the turning one is unreadable), the
 * geometry is generated once per parameter change rather than per frame, and
 * every position is a Konva transform — so the cost of a frame is two rotations.
 */

/** Seconds for one full period — two beats, one swing out and back. Slow: the
 *  point is to see a tooth arrive at a pallet, not to watch a clock keep time. */
const PERIOD_S = 6

interface Props {
  viewport: Viewport
}

export function EscapementAnimLayer({ viewport }: Props) {
  const pathId = useUIStore((s) => s.meshAnimPathId)
  const paths = usePathsStore((s) => s.paths)
  const [phase, setPhase] = useState(0)
  const startRef = useRef(0)

  const params = paths.find((p) => p.id === pathId)?.shapeParams
  const spec = params?.type === 'escapement' ? params : null

  // Regenerating an escapement is ~10 ms; at 60 fps that would be most of the
  // frame budget, and none of it changes while it runs.
  const built = useMemo(() => {
    if (!spec) return null
    const parts = generateEscapementParts(spec)
    const pick = (keys: string[]) =>
      parts.filter((p) => keys.includes(p.key)).map((p) => p.d).join(' ')
    return {
      wheel: pick(['wheel', 'spokes', 'bore', 'ref']),
      anchor: pick(['anchor', 'anchorbore']),
      centreDistance: escapementDims(spec).centreDistance,
      drawnAt: anchorOffset(spec),
    }
  }, [spec])

  useEffect(() => {
    if (!spec) return
    let raf = 0
    startRef.current = performance.now()
    const tick = (now: number) => {
      setPhase((now - startRef.current) / (PERIOD_S * 1000))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [spec])

  if (!spec || !built) return null
  const { scale } = viewport
  const pose = escapementPose(spec, phase)
  const { cx, cy } = spec
  // Where the arbor really goes, and how far that is from where it is drawn.
  const ax = cx
  const ay = cy + built.centreDistance
  const drop = built.centreDistance - built.drawnAt

  const stroke = '#38bdf8'
  const common = { stroke, strokeWidth: 1.4 / scale, fill: '#38bdf822', listening: false }

  return (
    <Group listening={false}>
      {/* Both rotate about their own arbor: put the group AT the pivot and take
          the same point off as an offset, which is Konva's way of saying "spin
          about here". Inside the Y-flipped layer a positive angle reads CCW,
          the same way round as the CNC space it is quoted in. */}
      <Group x={cx} y={cy} offsetX={cx} offsetY={cy} rotation={pose.wheelDeg}>
        <Path data={built.wheel} {...common} />
      </Group>
      <Group x={ax} y={ay} offsetX={ax} offsetY={ay} rotation={pose.anchorDeg}>
        {/* Slid down onto the centre distance first, then rocked about it. */}
        <Group y={drop}>
          <Path data={built.anchor} {...common} />
        </Group>
      </Group>
    </Group>
  )
}
