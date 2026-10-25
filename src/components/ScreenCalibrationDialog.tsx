import { useEffect, useState } from 'react'
import { Minus, Plus } from 'lucide-react'
import { useUIStore } from '../store/uiStore'
import { useWorkpieceStore, fmtLen } from '../store/workpieceStore'
import { LengthInput } from '../panels/machine/shared'
import { CARD_MM, NOMINAL_PX_PER_MM, displayKey, useRealScale, useScreenScaleStore } from '../canvas/screenScale'
import { ICON } from '../theme'

// Calibrate screen: match a card (or a ruler) held against the display, so the canvas's
// 1:1 button can show parts at their real size. See canvas/screenScale.ts for why a
// browser cannot work this out for itself. Driven by uiStore.screenCalibrationOpen.

/** The short edge and corner radius of an ID-1 card, mm — drawn so the outline is the card. */
const CARD_SHORT_MM = 53.98
const CARD_CORNER_MM = 3.18
// The slider's reach in CSS px per mm: 1/127" to 1/51" a pixel covers every desktop and
// laptop panel at any sensible scaling.
const MIN_PX = 2
const MAX_PX = 8
/** One press of − / +: a tenth of a millimetre over a card's length. */
const FINE = 0.1 / CARD_MM

export default function ScreenCalibrationDialog() {
  const open = useUIStore((s) => s.screenCalibrationOpen)
  const setOpen = useUIStore((s) => s.setScreenCalibrationOpen)
  if (!open) return null
  return <CalibrationBody close={() => setOpen(false)} />
}

function CalibrationBody({ close }: { close: () => void }) {
  const { display, pxPerMM: current } = useRealScale()
  const setCalibration = useScreenScaleStore((s) => s.setCalibration)
  const units = useWorkpieceStore((s) => s.units)
  const [px, setPx] = useState(current ?? NOMINAL_PX_PER_MM)
  const [refMM, setRefMM] = useState(CARD_MM)
  const card = Math.abs(refMM - CARD_MM) < 1e-6

  // Escape cancels, in the capture phase so App's own key handler does not read it as
  // "leave the current tool" — as ConfirmNewProjectDialog does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [close])

  const clamp = (v: number) => Math.min(MAX_PX, Math.max(MIN_PX, v))
  const save = () => {
    setCalibration(displayKey(display), { pxPerMM: px, dpr: display.dpr })
    close()
  }
  const forget = () => {
    setCalibration(displayKey(display), null)
    close()
  }
  const widthPx = refMM * px
  const btn = 'px-3 py-1.5 text-sm rounded text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-700 transition-colors'
  const fineBtn = 'p-1.5 rounded border border-gray-300 dark:border-neutral-600 text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-700'

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={close}>
      <div
        className="bg-white dark:bg-neutral-800 rounded-lg shadow-2xl border border-gray-200 dark:border-neutral-700 w-[760px] max-w-[95vw] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-gray-200 dark:border-neutral-700">
          <h2 className="text-base font-semibold text-gray-900 dark:text-neutral-100">Calibrate Screen</h2>
        </div>

        <div className="px-5 py-4 flex flex-col gap-4">
          <p className="text-sm text-gray-600 dark:text-neutral-400">
            Hold a bank card (or any ID-sized card) flat against the screen, its left edge on the
            line, and drag the slider until the outline is exactly as long as the card. A ruler
            works too — set the length you are matching. Used by the canvas's <b>1:1</b> button
            to show parts at their real size.
          </p>

          {/* The thing to match. Left-aligned so the card has an edge to butt against. */}
          <div className="overflow-hidden py-1">
            <div
              className="border-2 border-blue-500 bg-blue-500/10 flex items-center justify-center text-sm text-blue-700 dark:text-blue-300"
              style={{
                width: widthPx,
                height: card ? CARD_SHORT_MM * px : 40,
                borderRadius: card ? CARD_CORNER_MM * px : 2,
              }}
            >
              {fmtLen(refMM, units, 1)}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button className={fineBtn} title="Shorter by a tenth of a millimetre" onClick={() => setPx((v) => clamp(v * (1 - FINE)))}>
              <Minus size={ICON.sm} />
            </button>
            <input
              type="range" min={MIN_PX} max={MAX_PX} step={0.001} value={px}
              onChange={(e) => setPx(+e.target.value)}
              className="flex-1 accent-blue-500"
              aria-label="Outline length"
            />
            <button className={fineBtn} title="Longer by a tenth of a millimetre" onClick={() => setPx((v) => clamp(v * (1 + FINE)))}>
              <Plus size={ICON.sm} />
            </button>
          </div>

          <div className="flex items-center gap-3 text-sm text-gray-600 dark:text-neutral-400">
            <label htmlFor="cal-ref">Matching</label>
            <div className="w-28">
              <LengthInput id="cal-ref" valueMM={refMM} onChangeMM={setRefMM} minMM={20} maxMM={160} stepMM={1} />
            </div>
            {!card && (
              <button className="text-blue-600 dark:text-blue-400 hover:underline" onClick={() => setRefMM(CARD_MM)}>
                Use a card
              </button>
            )}
            <span className="ml-auto" title="Kept for this display only — another monitor calibrates separately">
              This display: {display.width} × {display.height} · {(px * 25.4 * display.dpr).toFixed(0)} pixels per inch
            </span>
          </div>
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-gray-200 dark:border-neutral-700">
          {current !== null && (
            <button onClick={forget} className={`${btn} mr-auto`} title="Forget this display's calibration">
              Clear
            </button>
          )}
          <button onClick={close} className={btn}>Cancel</button>
          <button onClick={save} autoFocus className="px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-500 text-white transition-colors">
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
