// THE UNIT COLUMN — the reserved strip at the right-hand end of a field row.
//
// A unit is not decoration hung off the end of a field: it is a COLUMN, and the
// box is what stops short of it. Left to size itself, every row in a panel ended
// at a different x — 'Module 4 mm' stopped 24px in, 'Teeth 24' (a count, no unit)
// ran to the panel edge, an angle's '°' stopped somewhere between the two, and a
// checkbox somewhere else again. Reserving the column at one width, and keeping
// it even when the row has no unit to put in it, is what gives a panel a single
// right edge.
//
// It lives here, outside both panel trees, because the draw sidebar and the
// properties panel both build rows out of it and had already drifted apart once:
// the slider readout below existed as six hand-copied class strings across the
// two files.

import type { ReactNode } from 'react'

/** 'mm' is the widest unit that has to fit — 20.9px at the 12px label size. A
 *  longer one ('min/rev', '×/mesh', 'mm/min') grows past this rather than being
 *  clipped, at the cost of its own row's box. */
export const UNIT_COL_W = 'min-w-[1.5rem]'

const unitCls = `flex-shrink-0 text-label text-gray-600 dark:text-neutral-400 select-none ${UNIT_COL_W}`

/** The unit itself, in the reserved column. Renders the column even with no
 *  children, which is the whole point — see the header. */
export const UnitLabel = ({ children }: { children?: ReactNode }) => (
  <span className={unitCls}>{children}</span>
)

/** The empty column, for a row that ends in something other than a numeric field
 *  — a select, a checkbox, a text field, a slider's readout. */
export const UnitSpacer = () => <span aria-hidden className={`flex-shrink-0 ${UNIT_COL_W}`} />

/**
 * The number beside a slider — a READOUT, never a field.
 *
 * A slider's value is arrived at by dragging it, so a box with stepper arrows
 * next to one is a second control for the same number, and it made two rows that
 * do the identical job (spirograph Loops and Pen p) look like different kinds of
 * thing. Tabular figures so the digits do not jitter under the handle as it
 * moves, and a floor of 2rem rather than a fixed width — Pen p runs to the loop
 * count, so '292.00' has to fit, and a fixed box either clipped that or spent the
 * width on every row that only ever reads '0%'.
 *
 * It carries the unit column itself, at the same 4px a field keeps between its
 * box and its unit, so a slider row ends exactly where a field row does.
 */
export const SliderValue = ({ children }: { children: ReactNode }) => (
  <span className="flex items-center gap-1 flex-shrink-0">
    <span className="text-gray-500 dark:text-neutral-400 text-label font-mono tabular-nums min-w-[2rem] text-right">{children}</span>
    <UnitSpacer />
  </span>
)
