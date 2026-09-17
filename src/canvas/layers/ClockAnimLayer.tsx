import { useEffect, useMemo, useRef, useState } from 'react'
import { Group, Path } from 'react-konva'
import type { Viewport } from '../CanvasStage'
import { usePathsStore, clockSpecOf } from '../../store/pathsStore'
import { useUIStore } from '../../store/uiStore'
import { useWorkpieceStore } from '../../store/workpieceStore'
import { generateGearParts, gearMateParts } from '../../shapes/gearGenerator'
import { generateEscapementParts, escapementDims, anchorOffset } from '../../shapes/escapementGenerator'
import { generatePendulumParts } from '../../shapes/pendulumGenerator'
import {
  clockAssemblyFromPaths, clockMotionFromPaths, clockPendulumFromPaths,
  clockPlate, clockPose, clockRoot,
} from '../../shapes/clockTrain'

/**
 * The whole clock, assembled and running.
 *
 * The parts are cut flat and laid out CLEAR of each other on the stock,
 * which leaves the question the drawing cannot answer: put together at the
 * spacings the panel quotes, does the train run? So this stands the arbors up at
 * those spacings and turns everything off the escapement's own kinematics.
 *
 * THE WHEELS OVERLAP, AND THEY ARE MEANT TO. Two wheels a mesh apart are 200 mm
 * of diameter across a 120 mm centre distance, because each meshes with the NEXT
 * ARBOR'S PINION and the two sit at different depths between the plates. Drawn
 * solid that reads as a crash, so each arbor gets its own hue and a translucent
 * fill — the same problem, and the same answer, as `gearMateParts` drawing a
 * lantern's cheek dashed.
 *
 * The slow end barely creeps, and that is a clock: the great wheel is geared
 * 60:1 off the escape wheel, so it turns a tooth about once a minute of watching.
 * Whether the meshes actually clear is not an eye question — it is answered by
 * `scripts/clock-mesh-check.mts`, which steps the train through forty periods and
 * measures. This is for seeing the thing stand up and the escapement beat.
 *
 * Nothing here touches the document: every clock path is hidden while it runs,
 * geometry is built once per parameter change, and a frame is nine Konva
 * transforms.
 */

/** Seconds for one escapement period — two beats. Slower than real time on a
 *  seconds pendulum, because the escapement is the only part worth watching and
 *  a tooth arriving at a pallet is the whole of it. */
const PERIOD_S = 3

// One hue per arbor, so five overlapping wheels can be told apart. The
// escapement keeps the blue the other previews use.
const ARBOR_COLORS = ['#f472b6', '#fbbf24', '#a3e635', '#34d399', '#38bdf8']

// The motion work sits ON the great arbor and beside it, so it needs hues of its
// own or the hour wheel is lost inside the great wheel it is concentric with.
const MOTION_COLORS = { minute: '#fb923c', hour: '#c084fc' }

interface Props {
  viewport: Viewport
}

export function ClockAnimLayer({ viewport }: Props) {
  const pathId = useUIStore((s) => s.clockAnimPathId)
  const paths = usePathsStore((s) => s.paths)
  // Primitive selectors — a fresh object from a zustand selector compares
  // unequal every time and would re-render this on every store write.
  const stockW = useWorkpieceStore((s) => s.widthMM)
  const stockH = useWorkpieceStore((s) => s.heightMM)

  const [phase, setPhase] = useState(0)
  const startRef = useRef(0)

  const clockId = paths.find((p) => p.id === pathId)?.clockId ?? null

  // The assembly as it stands NOW — read back out of the live paths, not from
  // the spec the clock was built from. Every wheel has been separately editable
  // since the moment it landed, so the spec is only ever a memory of how it
  // started.
  const assembly = useMemo(() => clockId ? clockAssemblyFromPaths(paths, clockId) : null, [paths, clockId])
  // On no arbor — it hangs from the pallet arbor — so it is fetched separately
  // and never enters the mesh chain.
  const pendulum = useMemo(() => clockId ? clockPendulumFromPaths(paths, clockId) : null, [paths, clockId])
  // The hour hand's gearing, if this clock has any — a BRANCH off the great
  // arbor rather than more of the train, so it is fetched apart from the
  // assembly and handed to the plate and the pose separately.
  const motion = useMemo(() => clockId ? clockMotionFromPaths(paths, clockId) : null, [paths, clockId])
  // The arrangement lives on the clock's parts, which is where the linkage
  // editor writes it. `paths` is already subscribed, so an arrangement committed
  // while this is running takes effect.
  const linkAngles = useMemo(() => clockSpecOf(paths, clockId)?.linkAngles, [paths, clockId])

  const built = useMemo(() => {
    if (!assembly || assembly.length < 2) return null
    const plate = clockPlate(assembly, linkAngles, motion)
    if (!plate) return null

    // Each part's own geometry with its ARBOR AT THE ORIGIN, so placing it is a
    // plain rotate-then-translate.
    const wheels = assembly.map((a) => {
      if (a.params.type === 'gear') {
        // The pinion this gear emits belongs on the NEXT arbor and is drawn
        // there from `gearMateParts`, so the drawn-clear copy is dropped.
        return generateGearParts({ ...a.params, cx: 0, cy: 0, emitPinion: false })
          .map((p) => p.d).join(' ')
      }
      return generateEscapementParts({ ...a.params, cx: 0, cy: 0 })
        .filter((p) => ['wheel', 'spokes', 'bore'].includes(p.key))
        .map((p) => p.d).join(' ')
    })

    // The lantern each gear drives, in its own frame — it stands on the arbor
    // AFTER the gear that emitted it, which is what makes a clock a train.
    const pinions = assembly.map((a) =>
      a.params.type === 'gear' ? gearMateParts({ ...a.params, cx: 0, cy: 0 }) : null)

    const esc = assembly[assembly.length - 1].params
    const anchor = esc.type === 'escapement'
      ? {
          d: generateEscapementParts({ ...esc, cx: 0, cy: 0 })
            .filter((p) => ['anchor', 'anchorbore'].includes(p.key))
            .map((p) => p.d).join(' '),
          // Drawn clear at `anchorOffset` above the wheel; its arbor really goes
          // at `centreDistance`. Shifting by the offset puts the arbor at the
          // group origin, and the group then places and rocks it.
          drawnAt: anchorOffset(esc),
          centreDistance: escapementDims(esc).centreDistance,
        }
      : null

    // NOT centred on the bbox — see `clockRoot`. The plate is built with the
    // escape arbor at its own origin, so placing the clock is just moving that
    // origin to the root: X-centred on the stock, hanging from the top. The box
    // changes with the arrangement, so centring on it would slide the whole
    // clock under the cursor while the user drags the linkage.
    const { x: dx, y: dy } = clockRoot(stockW, stockH, assembly[assembly.length - 1]?.params)

    // Suspension point at the origin (that IS a pendulum's cx,cy), so it takes
    // the same place-and-rock as everything else.
    const pend = pendulum ? generatePendulumParts({ ...pendulum, cx: 0, cy: 0 }).map((p) => p.d).join(' ') : null

    // Each motion wheel with the lantern it runs against — which stands on the
    // OTHER of the two arbors, exactly as a train wheel's does. The cannon
    // pinion is the minute wheel's mate and sits on the great arbor; the minute
    // pinion is the hour wheel's mate and sits out on the branch.
    const mot = motion ? {
      minute: generateGearParts({ ...motion.minute, cx: 0, cy: 0, emitPinion: false }).map((p) => p.d).join(' '),
      hour: generateGearParts({ ...motion.hour, cx: 0, cy: 0, emitPinion: false }).map((p) => p.d).join(' '),
      cannon: gearMateParts({ ...motion.minute, cx: 0, cy: 0 }),
      minutePinion: gearMateParts({ ...motion.hour, cx: 0, cy: 0 }),
    } : null

    return { plate, wheels, pinions, anchor, pend, mot, dx, dy }
  }, [assembly, pendulum, motion, linkAngles, stockW, stockH])

  useEffect(() => {
    if (!built) return
    let raf = 0
    startRef.current = performance.now()
    const tick = (now: number) => {
      setPhase((now - startRef.current) / (PERIOD_S * 1000))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [built])

  if (!assembly || !built) return null
  const { scale } = viewport
  const { plate, wheels, pinions, anchor, pend, mot, dx, dy } = built
  const pose = clockPose(assembly, plate, phase, motion)

  const body = (color: string) => ({
    stroke: color, strokeWidth: 1.4 / scale, fill: `${color}22`, listening: false,
  })
  // A lantern's cheek is DASHED and that is not a shortcut — it is wider than the
  // pin circle and the wheel's teeth reach inside it, so in plan view the cheek
  // really does cover the teeth. The wheel runs BETWEEN two cheeks, axially.
  const ghost = {
    stroke: '#64748b', strokeWidth: 1 / scale, dash: [4 / scale, 4 / scale],
    fill: undefined, listening: false,
  }

  return (
    <Group listening={false} x={dx} y={dy}>
      {plate.arbors.map((a, i) => (
        <Group key={i}>
          {/* Geometry has its arbor at the origin, so Konva's own rotate-then-
              translate is exactly the placement wanted. A positive angle reads
              CCW inside the Y-flipped layer, matching the CNC space it is
              quoted in. */}
          <Group x={a.x} y={a.y} rotation={pose.wheelDeg[i]}>
            <Path data={wheels[i]} {...body(ARBOR_COLORS[i % ARBOR_COLORS.length])} />
          </Group>
          {/* The lantern standing on THIS arbor came off the previous wheel. */}
          {i > 0 && pinions[i - 1] && (
            <Group x={a.x} y={a.y} rotation={pose.pinionDeg[i]}>
              {pinions[i - 1]!.ghost && <Path data={pinions[i - 1]!.ghost} {...ghost} />}
              <Path data={pinions[i - 1]!.solid} {...body(ARBOR_COLORS[(i - 1) % ARBOR_COLORS.length])} />
            </Group>
          )}
        </Group>
      ))}
      {/* The motion work: the minute wheel on its own arbor out on the branch,
          the hour wheel CONCENTRIC with the great wheel, and each one's lantern
          standing on the other arbor. The hour wheel turns the same way as the
          great wheel and 12 times slower — both hands go round the same way,
          which is the one thing an eye can check here. */}
      {mot && plate.motion && pose.motion && (() => {
        const host = plate.arbors[plate.motion.hostIdx]
        const m = plate.motion, mp = pose.motion
        return (
          <Group>
            <Group x={m.x} y={m.y} rotation={mp.minuteDeg}>
              <Path data={mot.minute} {...body(MOTION_COLORS.minute)} />
            </Group>
            <Group x={host.x} y={host.y} rotation={mp.hourDeg}>
              <Path data={mot.hour} {...body(MOTION_COLORS.hour)} />
            </Group>
            <Group x={host.x} y={host.y} rotation={mp.cannonDeg}>
              {mot.cannon.ghost && <Path data={mot.cannon.ghost} {...ghost} />}
              <Path data={mot.cannon.solid} {...body(MOTION_COLORS.minute)} />
            </Group>
            <Group x={m.x} y={m.y} rotation={mp.minuteDeg}>
              {mot.minutePinion.ghost && <Path data={mot.minutePinion.ghost} {...ghost} />}
              <Path data={mot.minutePinion.solid} {...body(MOTION_COLORS.hour)} />
            </Group>
          </Group>
        )
      })()}
      {anchor && (
        <Group x={plate.anchor.x} y={plate.anchor.y} rotation={pose.anchorDeg}>
          <Group y={-anchor.drawnAt}>
            <Path data={anchor.d} {...body('#38bdf8')} />
          </Group>
        </Group>
      )}
      {/* The pendulum hangs from the SAME arbor and rocks by the same angle: in
          this model the crutch is rigid, so the anchor and the pendulum are one
          body — which is exactly the assumption `escapementPose` is built on.
          A real crutch lets the pendulum swing wider than the anchor. */}
      {pend && (
        <Group x={plate.anchor.x} y={plate.anchor.y} rotation={pose.anchorDeg}>
          <Path data={pend} {...body('#e879f9')} />
        </Group>
      )}
    </Group>
  )
}
