// Field rows shared by the Draw panels (ShapePanel, ClockPanel).
//
// These are the COMPACT rows the draw sidebar uses — a narrow label beside the
// field — which is a different layout from the stacked machine-form fields in
// panels/machine/shared.tsx. Both obey the same rule: every numeric field goes
// through NumericInput, never a bare <input type="number">, or the browser eats
// the '/' keystroke and a typed fraction can never be entered.

import { useId } from 'react'
import { fromMM, toMM } from '../../store/workpieceStore'
import { NumericInput } from '../../components/NumericInput'
// The unit column and the slider readout are shared with PropertiesPanel, so
// they live outside this file — re-exported here so a draw panel still has one
// place to import a row part from.
import { UnitSpacer } from '../../components/UnitColumn'
export { UnitSpacer, SliderValue } from '../../components/UnitColumn'

export const inputCls = 'flex-1 bg-gray-50 dark:bg-neutral-900 border border-gray-400 dark:border-neutral-700 rounded px-1.5 py-0.5 text-body text-gray-800 dark:text-neutral-200 font-mono w-0'
export const labelCls = 'text-gray-600 dark:text-neutral-400 text-label w-14 flex-shrink-0'
export const selectCls = inputCls + ' cursor-pointer'
export const noteCls = 'text-label text-gray-600 dark:text-neutral-400'

/**
 * A number field. `integer` marks a COUNT — teeth, spokes, pins — which is
 * unitless and must not be converted; everything else is a length held in mm and
 * shown in the user's units.
 */
export function NumInput({ label, valueMM, units, onChange, min = 0.1, max, step, integer }: {
  label: string; valueMM: number; units: string; onChange: (mm: number) => void
  min?: number; max?: number; step?: number; integer?: boolean
}) {
  const display = integer ? valueMM : fromMM(valueMM, units as 'mm' | 'in')
  const s = step ?? (integer ? 1 : units === 'in' ? 0.0625 : 1)
  const id = useId()

  return (
    <div className="flex items-center gap-1.5">
      <label className={labelCls} htmlFor={id}>{label}</label>
      <NumericInput
        id={id}
        value={display}
        min={min}
        max={max}
        step={s}
        integer={integer}
        unit={integer ? undefined : units}
        unitCol
        onChange={(v) => onChange(integer ? v : toMM(v, units as 'mm' | 'in'))}
        className={inputCls}
      />
    </div>
  )
}

/** A plain number field with a trailing unit that is NOT a length — degrees, seconds. */
export function PlainInput({ label, value, unit, onChange, min, max, step }: {
  label: string; value: number; unit?: string; onChange: (v: number) => void
  min?: number; max?: number; step?: number
}) {
  const id = useId()
  return (
    <div className="flex items-center gap-1.5">
      <label className={labelCls} htmlFor={id}>{label}</label>
      <NumericInput id={id} value={value} min={min} max={max} step={step} unit={unit} unitCol onChange={onChange} className={inputCls} />
    </div>
  )
}

export function Select<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: [T, string][]; onChange: (v: T) => void
}) {
  const id = useId()
  return (
    <div className="flex items-center gap-1.5">
      <label className={labelCls} htmlFor={id}>{label}</label>
      <span className="flex-1 w-0 flex items-center gap-1">
        <select id={id} value={value} onChange={(e) => onChange(e.target.value as T)} className={selectCls}>
          {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <UnitSpacer />
      </span>
    </div>
  )
}

// THE BOX ENDS WHERE THE FIELDS END, and this is the only row here that does not
// use `labelCls`. A checkbox is 14px wide where a field is the rest of the row,
// so lining the box up with the fields' LEFT edge left its caption the 3.5rem
// label column to sit in — and every one longer than about ten characters
// wrapped inside it ("From centre" broke into two lines, as did "Clockwise" and
// "Motion work"). Right-aligning it instead gives the caption the whole row, so
// none of them wrap; the trailing UnitSpacer is what puts the box's right edge
// on the fields' right edge rather than out at the panel's.
export function Check({ label, checked, onChange, title }: { label: string; checked: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <label className="flex items-center justify-between gap-1.5 cursor-pointer" title={title}>
      <span className="text-gray-600 dark:text-neutral-400 text-label">{label}</span>
      <span className="flex items-center gap-1 flex-shrink-0">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
          className="accent-blue-500 w-3.5 h-3.5" />
        <UnitSpacer />
      </span>
    </label>
  )
}

// Border/fill for a tool tile, split out so the shape cell can put it on a
// container div whose children are the actual buttons.
export const toolBtnState = (active: boolean) =>
  active
    ? 'border-blue-500 bg-blue-500/20'
    : 'border-gray-400 dark:border-neutral-600 hover:bg-gray-100 dark:hover:bg-neutral-700'

// justify-center so a tile stays centred when the grid stretches it to match a
// taller sibling (the shape cell is taller: it carries a chevron strip).
export const toolBtnCls = (active: boolean) =>
  [
    'flex flex-col items-center justify-center gap-0.5 py-1.5 rounded text-body transition-colors border',
    toolBtnState(active),
  ].join(' ')
