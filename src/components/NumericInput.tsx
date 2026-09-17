import { useRef, useState } from 'react'
import { ChevronUp, ChevronDown } from 'lucide-react'
import { parseNumeric, isPartialFraction, isExpression } from './parseNumeric'
import { UNIT_COL_W } from './UnitColumn'

interface NumericInputProps {
  /** Forwarded to the real <input> so a <label htmlFor> can point at it. */
  id?: string
  value: number
  min?: number
  max?: number
  step?: number
  integer?: boolean
  onChange: (v: number) => void
  className?: string
  title?: string
  /** Unit shown after the field ('mm', 'in', 'mm/min', 'RPM', '°'). Owned by this
   *  component so the box and its unit can never drift apart between panels. */
  unit?: string
  /** Reserve the unit column at a FIXED width, and keep it even when there is no
   *  unit at all. A panel that stacks rows of mixed kinds — 'mm' on one, a bare
   *  count on the next — otherwise ends every row at a different x, because the
   *  unit is what the box stops short of. Opt-in: a form whose fields all carry
   *  the same unit has nothing to line up and does not want the empty gutter. */
  unitCol?: boolean
  /** Shown when the box is empty. For a field whose blank state MEANS something —
   *  'auto (105°)' — it is the only place that meaning is written. */
  placeholder?: string
  /** The field is in its blank state: render empty rather than showing `value`.
   *  `value` is still what a stepper nudges from and what the parser clamps against,
   *  so it should be the number the blank state resolves to. */
  isEmpty?: boolean
  /** Called when the user clears the box. WITHOUT it a field cannot be emptied at
   *  all — blanking restores the last value on blur, which is what every ordinary
   *  field wants; a depth with no number in it is not a state that means anything. */
  onEmpty?: () => void
}


// Numeric input that holds local text state while focused so intermediate
// states like "-", "3.", or "" don't reset to the last valid value on every keystroke.
export function NumericInput({ id, value, min, max, step, integer, onChange, className, title, unit, unitCol, placeholder, isEmpty, onEmpty }: NumericInputProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const editing = draft !== null

  // WHERE A PENDING DRAFT LANDS, frozen for as long as one is in flight.
  //
  // Clicking a shape on canvas changes the selection on MOUSEDOWN; the browser
  // only blurs the focused field afterwards, as that mousedown's default action.
  // So by the time onBlur commits what was typed, this component has already
  // re-rendered carrying the newly selected object's props — and committing
  // through them sent the old field's number to the new shape. Type a radius on
  // one circle, click a second, and the second jumped to the first's radius (a
  // third was fine, the draft having been spent). A draft belongs to the object
  // that was on screen when it was typed, so the handler it commits through is
  // the one captured while the box was idle.
  const commitTo = useRef({ onChange, onEmpty, min, max, integer })
  if (!editing) commitTo.current = { onChange, onEmpty, min, max, integer }

  function fmt(v: number) {
    return integer ? String(Math.round(v)) : String(+v.toFixed(4))
  }

  function commit(raw: string) {
    const target = commitTo.current
    // A cleared box is a value of its own only where the caller says so; everywhere
    // else it falls through to the null below and the field keeps what it had.
    if (raw.trim() === '' && target.onEmpty) { target.onEmpty(); return }
    const v = parseNumeric(raw)
    if (v === null) return
    const clamped = target.min !== undefined
      ? (target.max !== undefined ? Math.min(target.max, Math.max(target.min, v)) : Math.max(target.min, v))
      : (target.max !== undefined ? Math.min(target.max, v) : v)
    target.onChange(target.integer ? Math.round(clamped) : clamped)
  }

  // One nudge, shared by the arrow keys and the stepper buttons. Reads the draft when the
  // user is mid-edit so clicking up after typing steps from what is on screen, not from the
  // last committed value. On an expression draft that means the nudge RESOLVES it — '=24/2'
  // stepped up becomes 12.5 — which is the only reading available: a step is arithmetic on
  // a value, and the value is what the formula says.
  function bump(dir: 1 | -1) {
    if (step === undefined) return
    const current = draft !== null ? (parseNumeric(draft) ?? value) : value
    const raw = fmt(current + dir * step)
    if (draft !== null) setDraft(raw)
    commit(raw)
  }

  // The caller's className styles the BOX (border, background, padding, width), so it moves
  // to the wrapper and the input inside goes transparent — otherwise the stepper would sit
  // outside the field's border. `focus:` becomes `focus-within:` so focusing the input still
  // lights the box up.
  const boxCls = (className ?? '').replace(/\bfocus:/g, 'focus-within:')

  // The unit sits outside the box, so the box is no longer the outermost element. When the
  // caller asks the field to fill its row, that has to apply to the whole thing — box plus
  // unit — or the unit lands outside the width the layout reserved and the box no longer
  // grows. The box keeps the class too, so it fills whatever the wrapper is given.
  const grows = /\b(?:flex-1|w-full)\b/.test(className ?? '')

  const box = (
    <span className={`flex items-center ${boxCls}`}>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        value={editing ? draft : (isEmpty ? '' : fmt(value))}
        placeholder={placeholder}
        onChange={(e) => {
          const raw = e.target.value
          setDraft(raw)
          // Fire live updates for valid intermediate values so sliders/previews stay
          // responsive — but never mid-fraction: '1/' would publish 1 on the way to 1/8.
          // An expression is held back for its WHOLE length, not just its invalid states:
          // '=25.4' evaluates cleanly on the way to '=25.4/8', so there is no partial
          // state to test for. It lands on Enter or blur.
          if (isPartialFraction(raw) || isExpression(raw)) return
          const v = parseNumeric(raw)
          if (v !== null) {
            const inRange = (min === undefined || v >= min) && (max === undefined || v <= max)
            if (inRange) onChange(integer ? Math.round(v) : v)
          }
        }}
        onFocus={(e) => {
          // A blank field opens blank, so its placeholder still says what blank means.
          // Seeding it with `value` would turn 'auto' into a typed number just by
          // clicking into the box.
          setDraft(isEmpty ? '' : fmt(value))
          e.target.select()
        }}
        onBlur={() => {
          if (draft !== null) commit(draft)
          setDraft(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            if (draft !== null) commit(draft)
            setDraft(null)
            ;(e.target as HTMLInputElement).blur()
          }
          if (e.key === 'Escape') {
            setDraft(null)
            ;(e.target as HTMLInputElement).blur()
          }
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            bump(e.key === 'ArrowUp' ? 1 : -1)
          }
        }}
        style={{ font: 'inherit', color: 'inherit', textAlign: 'inherit' }}
        className="w-full min-w-0 flex-1 bg-transparent border-0 p-0 m-0 outline-none"
      />
      {step !== undefined && (
        // Not tab stops: tabbing through a form should visit each field once, not three
        // times. mousedown is swallowed so clicking a chevron never pulls focus out of the
        // input the user is editing.
        <span className="flex flex-col flex-shrink-0 ml-1 leading-none">
          <button
            type="button" tabIndex={-1} aria-label="Increase"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => bump(1)}
            className="text-gray-600 dark:text-neutral-400 hover:text-blue-500 dark:hover:text-blue-400"
          >
            <ChevronUp size={11} />
          </button>
          <button
            type="button" tabIndex={-1} aria-label="Decrease"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => bump(-1)}
            className="text-gray-600 dark:text-neutral-400 hover:text-blue-500 dark:hover:text-blue-400"
          >
            <ChevronDown size={11} />
          </button>
        </span>
      )}
    </span>
  )

  // Box and unit are one entity — a caller cannot render one without the other, which is
  // what let them drift before (most panels put the unit outside, Setup overlaid it inside
  // the box with absolute positioning and a pr-8 gutter). A field with no unit stays a
  // single element deep, exactly as it was.
  const wrap = grows ? 'min-w-0 flex-1 w-full' : ''
  if (!unit && !unitCol) return <span title={title} className={`flex ${wrap}`}>{box}</span>
  return (
    <span title={title} className={`flex items-center gap-1 ${wrap}`}>
      {box}
      <span className={`flex-shrink-0 text-label text-gray-600 dark:text-neutral-400 select-none ${unitCol ? UNIT_COL_W : ''}`}>{unit}</span>
    </span>
  )
}
