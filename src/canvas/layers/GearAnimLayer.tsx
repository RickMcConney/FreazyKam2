import { useEffect, useMemo, useRef, useState } from 'react'
import { Group, Path } from 'react-konva'
import type { Viewport } from '../CanvasStage'
import { usePathsStore } from '../../store/pathsStore'
import { useUIStore } from '../../store/uiStore'
import {
  generateGearParts, gearMesh, gearMateParts, gearMeshRefD, gearPose,
} from '../../shapes/gearGenerator'

/**
 * A gear, running against its mate.
 *
 * A gear is drawn alone and its lantern is drawn CLEAR of it, because they are
 * separate parts to go on the stock — which leaves the one question the drawing
 * cannot answer: put together at the centre distance the panel quotes, do they
 * actually run? So this puts them together and turns them.
 *
 * Paced by TEETH rather than by revolutions. A gear turning once every few
 * seconds is a blur at 24 teeth and nothing can be seen of the mesh, which is
 * the only reason to be looking; a fixed time per tooth reads the same whatever
 * the gear.
 *
 * Nothing here touches the document — the group's own paths are hidden while it
 * runs, the geometry is built once per parameter change, and a frame costs two
 * Konva rotations.
 */

/** Seconds for the gear to advance by one tooth. */
const SECONDS_PER_TOOTH = 1.1

interface Props {
  viewport: Viewport
}

export function GearAnimLayer({ viewport }: Props) {
  const pathId = useUIStore((s) => s.meshAnimPathId)
  const paths = usePathsStore((s) => s.paths)
  const [phase, setPhase] = useState(0)
  const startRef = useRef(0)

  const params = paths.find((p) => p.id === pathId)?.shapeParams
  const spec = params?.type === 'gear' ? params : null

  const built = useMemo(() => {
    if (!spec) return null
    // The gear's own parts only. The lantern it may already emit is drawn clear
    // of the wheel and is the very thing being replaced here, so it is dropped
    // rather than left sitting off to one side of a running mesh.
    const gear = generateGearParts(spec)
      .filter((p) => !p.key.startsWith('pinion') && p.key !== 'pinholes')
      .map((p) => p.d).join(' ')
    return { gear, mate: gearMateParts(spec), mesh: gearMesh(spec), ref: gearMeshRefD(spec) }
  }, [spec])

  useEffect(() => {
    if (!spec) return
    let raf = 0
    startRef.current = performance.now()
    const tick = (now: number) => {
      setPhase((now - startRef.current) / (SECONDS_PER_TOOTH * 1000))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [spec])

  if (!spec || !built) return null
  const { scale } = viewport
  const pose = gearPose(spec, phase)
  const { cx, cy } = spec
  // The mate sits along +x at the true centre distance — pitch circles tangent,
  // which is the number the panel quotes and a plate would be drilled from.
  const mx = cx + built.mesh.centreDistance

  const stroke = '#38bdf8'
  const common = { stroke, strokeWidth: 1.4 / scale, fill: '#38bdf822', listening: false }
  // The pitch circles, always drawn here whatever the shape's own `pitchCircle`
  // setting: two gears mesh when these are TANGENT, so they are the proof that
  // the pair is spaced right, and this is the one view where that can be seen.
  const ref = {
    stroke: '#64748b', strokeWidth: 1 / scale, dash: [4 / scale, 4 / scale],
    fill: undefined, listening: false,
  }

  return (
    <Group listening={false}>
      {/* Both spin about their own arbor: put the group AT the pivot and take the
          same point off as an offset, which is Konva's way of saying "spin about
          here". Inside the Y-flipped layer a positive angle reads CCW. */}
      <Group x={cx} y={cy} offsetX={cx} offsetY={cy} rotation={pose.gearDeg}>
        <Path data={built.gear} {...common} />
      </Group>
      {/* The mate's geometry is in its OWN frame, arbor at the origin, so it
          takes a plain place-and-turn: translate to the mate's centre, rotate
          about it. */}
      <Group x={mx} y={cy} rotation={pose.mateDeg}>
        {/* A lantern's cheek is DASHED, and that is not a shortcut: it is wider
            than the pin circle and the wheel's teeth reach inside that circle,
            so in plan view the cheek really does cover the teeth — the wheel
            runs between the two cheeks, axially. Solid, it reads as a crash. */}
        {built.mate.ghost && <Path data={built.mate.ghost} {...ref} />}
        <Path data={built.mate.solid} {...common} />
      </Group>
      {/* Circles, so they neither turn nor need to. */}
      <Path data={built.ref} {...ref} />
    </Group>
  )
}
