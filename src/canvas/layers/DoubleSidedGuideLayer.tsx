import { memo, useMemo } from 'react'
import { Circle, Group, Line, Path } from 'react-konva'
import type { Viewport } from '../CanvasStage'
import { useWorkpieceStore } from '../../store/workpieceStore'
import { usePathsStore } from '../../store/pathsStore'
import { useUIStore } from '../../store/uiStore'
import { backCell, guideTransform, normalizeDoubleSided, pinCentres } from '../../cam/doubleSided'
import { cellOffset, sameCell, STOCK_CELL } from '../../cam/sheets'
import { pathCell } from '../useSheets'

/**
 * A DOUBLE-SIDED job's guide (cam/doubleSided): side A drawn faintly onto side B as the
 * board will be seen after the flip, so side B can be drawn to line up with it. Display
 * only — nothing here is cut. Also the flip axis on both sheets, and the pins.
 *
 * Inside the Y-flipped CNC layer. Faint by OPACITY, not by dashing — a dash pattern is
 * laid along the whole outline every frame (see src/canvas/CLAUDE.md).
 */
export const DoubleSidedGuideLayer = memo(function DoubleSidedGuideLayer({ viewport }: { viewport: Viewport }) {
  const raw = useWorkpieceStore((s) => s.doubleSided)
  const ds = useMemo(() => normalizeDoubleSided(raw), [raw])
  const widthMM = useWorkpieceStore((s) => s.widthMM)
  const heightMM = useWorkpieceStore((s) => s.heightMM)
  const paths = usePathsStore((s) => s.paths)
  const dark = useUIStore((s) => s.darkMode)
  const stock = { widthMM, heightMM }
  // Side A is what lies on the stock, side B what lies on its sheet. Each is drawn on the
  // OTHER, so whichever side is being drawn on shows what the other face holds there — and
  // snapping lines up with the same images (otherSideBox). Hidden paths and images stay out.
  const [sideA, sideB] = useMemo(() => {
    if (!ds) return [[], []]
    const stock = { widthMM, heightMM }
    const back = backCell(ds.flip)
    const shown = paths.filter((p) => p.visible && !p.hidden && !p.imageSrc)
    return [
      shown.filter((p) => sameCell(pathCell(p, stock), STOCK_CELL)),
      shown.filter((p) => sameCell(pathCell(p, stock), back)),
    ]
  }, [ds, paths, widthMM, heightMM])
  if (!ds) return null

  const sw = 1 / viewport.scale
  const axisColor = dark ? '#fbbf24' : '#d97706'
  const g = guideTransform(ds.flip, stock)
  const back = cellOffset(backCell(ds.flip), stock)
  // The flip axis, on each sheet: the centre line the board turns over about.
  const axis = (ox: number, oy: number) => ds.flip === 'left-right'
    ? [ox + widthMM / 2, oy, ox + widthMM / 2, oy + heightMM]
    : [ox, oy + heightMM / 2, ox + widthMM, oy + heightMM / 2]
  const pins = pinCentres(ds, stock)

  return (
    <Group listening={false}>
      <Group x={g.x} y={g.y} scaleX={g.scaleX} scaleY={g.scaleY} opacity={0.3}>
        {/* The flip is its own inverse, so the one transform carries A onto B and B onto A. */}
        {[...sideA, ...sideB].map((p) => (
          <Path key={p.id} data={p.d} stroke={p.color} strokeWidth={sw} perfectDrawEnabled={false} />
        ))}
      </Group>
      <Line points={axis(0, 0)} stroke={axisColor} strokeWidth={sw} dash={[8 * sw, 6 * sw]} opacity={0.8} />
      <Line points={axis(back.x, back.y)} stroke={axisColor} strokeWidth={sw} dash={[8 * sw, 6 * sw]} opacity={0.8} />
      {/* The pins on side B. The axis maps onto itself, so a pin is where its hole was —
          on the back sheet's own axis, at the same distance along it. */}
      {pins.map((c, i) => {
        const x = g.x + g.scaleX * c.x, y = g.y + g.scaleY * c.y
        return <Circle key={i} x={x} y={y} radius={c.diaMM / 2} stroke={axisColor} strokeWidth={2 * sw} fill={axisColor} opacity={0.5} />
      })}
    </Group>
  )
})
