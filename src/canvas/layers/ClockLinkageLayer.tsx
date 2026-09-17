import { useMemo } from 'react'
import { Circle, Group, Line, Path, Text } from 'react-konva'
import type Konva from 'konva'
import type { Viewport } from '../CanvasStage'
import { usePathsStore } from '../../store/pathsStore'
import { useUIStore } from '../../store/uiStore'
import { useWorkpieceStore } from '../../store/workpieceStore'
import { generateGearParts } from '../../shapes/gearGenerator'
import { generateEscapementParts, escapementDims, anchorOffset } from '../../shapes/escapementGenerator'
import { generatePendulumParts } from '../../shapes/pendulumGenerator'
import {
  MOTION_LINK, clockArborClashes, clockAssemblyFromPaths, clockMotionFromPaths,
  clockPendulumFromPaths, clockPlate, clockRoot, clockWheelClashes,
} from '../../shapes/clockTrain'

/**
 * The going train as a 4-bar chain, to be arranged by hand.
 *
 * A clock's five arbors are joined by four centre distances that the meshes
 * FORCE — but the directions are the plate designer's, and folding the train
 * into a case is the one thing the app could not do. So the chain is drawn with
 * its joints draggable: link lengths are fixed, angles are the user's, and the
 * wheels follow their nodes.
 *
 * ROOTED AT THE ESCAPEMENT, which never moves — see `clockRoot`. Nothing here
 * centres anything: the box changes as the user drags, so centring on it would
 * slide the whole clock out from under the cursor.
 *
 * Wheels are drawn translucent and hued per arbor because SUCCESSIVE WHEELS
 * OVERLAP IN PLAN VIEW and are meant to: each meshes with the NEXT arbor's
 * pinion and the two sit at different depths between the plates. Drawn solid it
 * reads as a crash. The pendulum is dashed — it is the swing envelope, not a
 * plate feature, and at a metre long it would otherwise dominate the picture.
 */

// One hue per arbor — the same set the running preview uses, so a wheel keeps
// its colour between arranging and animating.
const ARBOR_COLORS = ['#f472b6', '#fbbf24', '#a3e635', '#34d399', '#38bdf8']

// The motion work's own hues, the same pair the running preview uses — the hour
// wheel is concentric with the great wheel and would otherwise be lost in it.
const MOTION_COLORS = { minute: '#fb923c', hour: '#c084fc' }

/** Grab radius of a joint, in SCREEN px — so it stays grabbable at any zoom. */
export const LINK_NODE_PX = 9

interface Props {
  viewport: Viewport
  /** Live angles during a drag; falls back to the clock's committed ones. */
  liveAngles: number[] | null
  onNodeMouseDown: (nodeIdx: number, e: Konva.KonvaEventObject<MouseEvent>) => void
  /** Which joint is under the cursor or being dragged, for highlighting. */
  activeNode: number | null
}

export function ClockLinkageLayer({ viewport, liveAngles, onNodeMouseDown, activeNode }: Props) {
  const pathId = useUIStore((s) => s.clockLinkPathId)
  const paths = usePathsStore((s) => s.paths)
  const stockW = useWorkpieceStore((s) => s.widthMM)
  const stockH = useWorkpieceStore((s) => s.heightMM)

  const clockId = paths.find((p) => p.id === pathId)?.clockId ?? null

  // Read the assembly back out of the LIVE paths, not from the spec — every
  // wheel has been separately editable since it landed.
  const assembly = useMemo(() => clockId ? clockAssemblyFromPaths(paths, clockId) : null, [paths, clockId])
  const pendulum = useMemo(() => clockId ? clockPendulumFromPaths(paths, clockId) : null, [paths, clockId])
  // A BRANCH off the great arbor rather than more of the chain — its joint is
  // dragged like any other, but its angle is the last entry of `linkAngles`
  // (MOTION_LINK) and is measured from its host outwards. See dragLinkAngle.
  const motion = useMemo(() => clockId ? clockMotionFromPaths(paths, clockId) : null, [paths, clockId])

  // Geometry, once per parameter change. Angles are NOT in here — they change on
  // every mouse move, and none of the outlines depend on them.
  const built = useMemo(() => {
    if (!assembly || assembly.length < 2) return null
    const wheels = assembly.map((a) => a.params.type === 'gear'
      ? generateGearParts({ ...a.params, cx: 0, cy: 0, emitPinion: false }).map((p) => p.d).join(' ')
      : generateEscapementParts({ ...a.params, cx: 0, cy: 0 })
          .filter((p) => ['wheel', 'spokes', 'bore'].includes(p.key)).map((p) => p.d).join(' '))
    const esc = assembly[assembly.length - 1].params
    const anchor = esc.type === 'escapement'
      ? {
          d: generateEscapementParts({ ...esc, cx: 0, cy: 0 })
            .filter((p) => ['anchor', 'anchorbore'].includes(p.key)).map((p) => p.d).join(' '),
          drawnAt: anchorOffset(esc),
          gap: escapementDims(esc).centreDistance,
        }
      : null
    const pend = pendulum ? generatePendulumParts({ ...pendulum, cx: 0, cy: 0 }).map((p) => p.d).join(' ') : null
    const mot = motion ? {
      minute: generateGearParts({ ...motion.minute, cx: 0, cy: 0, emitPinion: false }).map((p) => p.d).join(' '),
      hour: generateGearParts({ ...motion.hour, cx: 0, cy: 0, emitPinion: false }).map((p) => p.d).join(' '),
    } : null
    return { wheels, anchor, pend, mot, root: clockRoot(stockW, stockH, esc) }
  }, [assembly, pendulum, motion, stockW, stockH])

  // Cheap, and it has to re-run on every frame of a drag.
  const plate = useMemo(
    () => assembly ? clockPlate(assembly, liveAngles ?? undefined, motion) : null,
    [assembly, liveAngles, motion])

  if (!assembly || !built || !plate) return null
  const { scale } = viewport
  const { wheels, anchor, pend, mot, root } = built
  const px = (n: number) => n / scale          // screen px → mm at this zoom

  const body = (color: string) => ({
    stroke: color, strokeWidth: 1.2 / scale, fill: `${color}18`, listening: false,
  })
  const boneCol = '#e2e8f0'

  // The frame the plate would have to be — the TRAIN's extent, not the whole
  // assembly's: the pendulum is a metre long and is not a plate feature.
  const frameW = plate.bbox.maxX - plate.bbox.minX
  const frameH = plate.bbox.maxY - plate.bbox.minY
  // Neighbours overlapping is normal and is never flagged; anything further
  // apart than that has no business sharing space. See clockWheelClashes.
  const clashes = clockWheelClashes(plate)
  const clashing = new Set(clashes.flat())
  // An ARBOR through a wheel is the worse fault — a rod from plate to plate is at
  // every depth, so "they run at different depths" cannot save it. Same red, and
  // it is the wheel that gets it: the wheel is what has nowhere to turn.
  const arborClashes = clockArborClashes(plate)
  for (const c of arborClashes) {
    const i = plate.arbors.findIndex((a) => a.key === c.wheel)
    if (i >= 0) clashing.add(i)
  }

  return (
    <Group x={root.x} y={root.y}>
      {/* Wheels first, so the bones and joints sit on top of them. */}
      <Group listening={false}>
        {plate.arbors.map((a, i) => (
          <Group key={`w${i}`} x={a.x} y={a.y}>
            <Path data={wheels[i]} {...body(clashing.has(i) ? '#f87171' : ARBOR_COLORS[i % ARBOR_COLORS.length])} />
          </Group>
        ))}
        {mot && plate.motion && (
          <>
            <Group x={plate.motion.x} y={plate.motion.y}>
              <Path data={mot.minute} {...body(MOTION_COLORS.minute)} />
            </Group>
            {/* Concentric with the great wheel — it turns on a tube over that
                same arbor, so it has no joint of its own to drag. */}
            <Group x={plate.arbors[plate.motion.hostIdx].x} y={plate.arbors[plate.motion.hostIdx].y}>
              <Path data={mot.hour} {...body(MOTION_COLORS.hour)} />
            </Group>
          </>
        )}
        {anchor && (
          <Group x={plate.anchor.x} y={plate.anchor.y}>
            <Group y={-anchor.drawnAt}><Path data={anchor.d} {...body('#38bdf8')} /></Group>
          </Group>
        )}
        {pend && (
          <Group x={plate.anchor.x} y={plate.anchor.y}>
            <Path data={pend} stroke="#e879f9" strokeWidth={1 / scale}
              dash={[6 / scale, 5 / scale]} listening={false} />
          </Group>
        )}
        {/* The frame the arbors need. */}
        <Line
          points={[
            plate.bbox.minX, plate.bbox.minY, plate.bbox.maxX, plate.bbox.minY,
            plate.bbox.maxX, plate.bbox.maxY, plate.bbox.minX, plate.bbox.maxY,
          ]}
          closed stroke="#94a3b8" strokeWidth={1 / scale}
          dash={[8 / scale, 6 / scale]} listening={false}
        />
        {/* Konva text is not mirrored by the layer's Y-flip on its own, so it is
            flipped back here or it reads upside down. */}
        <Text
          x={plate.bbox.minX} y={plate.bbox.maxY + px(16)}
          scaleY={-1} fontSize={px(12)} fill="#94a3b8" listening={false}
          text={`frame ${Math.round(frameW)} × ${Math.round(frameH)} mm`
            + (clashes.length > 0 ? `  ·  ${clashes.length} wheel clash${clashes.length > 1 ? 'es' : ''}` : '')
            + (arborClashes.length > 0
              ? `  ·  ${arborClashes.length} arbor${arborClashes.length > 1 ? 's' : ''} through a wheel`
              : '')}
        />
      </Group>

      {/* The bones — one per link, each at a length the meshes force. */}
      {plate.arbors.slice(0, -1).map((a, i) => (
        <Line
          key={`b${i}`}
          points={[a.x, a.y, plate.arbors[i + 1].x, plate.arbors[i + 1].y]}
          stroke={boneCol} strokeWidth={2 / scale} opacity={0.9} listening={false}
        />
      ))}

      {/* The motion branch: one more bone, off the great arbor, at a length the
          two motion meshes force. */}
      {plate.motion && (
        <Line
          points={[
            plate.arbors[plate.motion.hostIdx].x, plate.arbors[plate.motion.hostIdx].y,
            plate.motion.x, plate.motion.y,
          ]}
          stroke={boneCol} strokeWidth={2 / scale} opacity={0.9} listening={false}
        />
      )}

      {/* The joints. The escape arbor (last) is the fixed root and is drawn as a
          pinned square rather than a grab handle — it is what the whole
          arrangement hangs from, and moving it would tip the escapement. */}
      {plate.arbors.map((a, i) => {
        const isRoot = i === plate.arbors.length - 1
        const on = activeNode === i
        return isRoot ? (
          <Circle
            key={`n${i}`} x={a.x} y={a.y} radius={px(LINK_NODE_PX * 0.8)}
            fill="#0f172a" stroke="#38bdf8" strokeWidth={2.5 / scale} listening={false}
          />
        ) : (
          <Circle
            key={`n${i}`} x={a.x} y={a.y} radius={px(LINK_NODE_PX)}
            fill={on ? '#38bdf8' : '#0f172a'}
            stroke={on ? '#ffffff' : boneCol} strokeWidth={2 / scale}
            onMouseDown={(e) => { e.cancelBubble = true; onNodeMouseDown(i, e) }}
          />
        )
      })}

      {/* The motion arbor's joint. Its node index IS its angle index
          (MOTION_LINK), which the train's joints also have — there the two
          happen to coincide, and here it is what keeps one array and one drag
          path covering the whole arrangement. */}
      {plate.motion && (
        <Circle
          x={plate.motion.x} y={plate.motion.y} radius={px(LINK_NODE_PX)}
          fill={activeNode === MOTION_LINK ? '#38bdf8' : '#0f172a'}
          stroke={activeNode === MOTION_LINK ? '#ffffff' : MOTION_COLORS.minute} strokeWidth={2 / scale}
          onMouseDown={(e) => { e.cancelBubble = true; onNodeMouseDown(MOTION_LINK, e) }}
        />
      )}
    </Group>
  )
}
