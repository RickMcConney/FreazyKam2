// THE length field: held in mm, shown and typed in the user's units.
//
// Every length entry in the app is a layout shell round this one — LengthInput (machine
// forms), NumInput (draw panels), the Properties panel's EditField and the Stock panel's
// DimInput. They were four hand copies, and only one of them converted its bounds: an
// inch-mode `min={0.1}` read as 0.1 INCH, a 2.54 mm floor on stock thickness. So bounds
// and step are given in MM and converted here (displayFieldBounds), once.
//
// `integer` marks a COUNT — teeth, spokes, pins — which is unitless and passes through
// unconverted. `stepMM` left undefined takes the display default (1 mm / 1/16 in);
// LengthInput supplies its own 0.5 mm default on top. `units` overrides the store's
// toggle only for a caller already holding it; the two never differ on screen.

import { useWorkpieceStore, fromMM, toMM, displayFieldBounds, type Units } from '../store/workpieceStore'
import { NumericInput } from './NumericInput'

export function LengthField({ id, valueMM, onChangeMM, minMM, maxMM, stepMM, integer, unitCol, units: unitsProp, title, className }: {
  id?: string
  valueMM: number
  onChangeMM: (mm: number) => void
  minMM?: number
  maxMM?: number
  stepMM?: number
  integer?: boolean
  unitCol?: boolean
  units?: Units
  title?: string
  className?: string
}) {
  const storeUnits = useWorkpieceStore((s) => s.units)
  const units = unitsProp ?? storeUnits
  const bounds = displayFieldBounds(units, { min: minMM, max: maxMM, step: stepMM, integer })
  return (
    <NumericInput
      id={id}
      value={integer ? valueMM : fromMM(valueMM, units)}
      min={bounds.min}
      max={bounds.max}
      step={bounds.step}
      integer={integer}
      unit={integer ? undefined : units}
      unitCol={unitCol}
      onChange={(v) => onChangeMM(integer ? v : toMM(v, units))}
      className={className}
      title={title}
    />
  )
}
