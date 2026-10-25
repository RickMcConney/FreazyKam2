// How many canvas pixels make one REAL millimetre on this screen — what "Actual size" zooms to.
//
// A browser will not say. A CSS pixel is nominally 1/96 inch, but on a Retina panel or a
// scaled external monitor it is anything from about 1/110 to 1/140 inch, and there is no API
// for the physical size of a display. So the user calibrates once per display: hold a card
// (ISO ID-1, 85.60 mm — every bank card, ID card and loyalty card is that size) or a ruler
// to the screen and drag a bar to match it.
//
// Two things change the answer after calibrating, and both are handled here:
//  - BROWSER ZOOM (Cmd +/−) makes a CSS pixel physically bigger, and moves devicePixelRatio
//    by the same factor, so the calibration stores the ratio it was taken at and scales by
//    the change (`realPxPerMM`).
//  - ANOTHER MONITOR is another physical size, so a calibration is kept per DISPLAY,
//    keyed by its size in screen pixels (`displayKey`), which page zoom leaves alone in
//    Chrome. Firefox reports that size scaled by page zoom, so there a zoomed page reads as
//    an uncalibrated display and asks again rather than being silently wrong.
//
// Stored with the other machine-local settings (localStorage), never in a project: it is a
// fact about this screen, not about the drawing.
import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** The long edge of an ISO/IEC 7810 ID-1 card, mm. */
export const CARD_MM = 85.6

/** The nominal CSS figure — what a fresh calibration starts from. */
export const NOMINAL_PX_PER_MM = 96 / 25.4

export interface ScreenCalibration {
  /** CSS pixels per real mm, at `dpr`. */
  pxPerMM: number
  /** `devicePixelRatio` when it was taken. */
  dpr: number
}

export interface DisplayInfo { width: number; height: number; dpr: number }

export const displayKey = (d: DisplayInfo) => `${d.width}x${d.height}`

/** CSS pixels per real mm now: a page zoomed since calibrating has bigger CSS pixels. */
export function realPxPerMM(cal: ScreenCalibration, dprNow: number): number {
  return cal.pxPerMM * cal.dpr / dprNow
}

/** How a view compares with real size — "1:1" within 1 %, else the factor. */
export function scaleLabel(viewPxPerMM: number, realPx: number): string {
  const k = viewPxPerMM / realPx
  if (Math.abs(k - 1) < 0.01) return '1:1'
  if (k >= 10) return `${Math.round(k)}×`
  if (k >= 1) return `${k.toFixed(1)}×`
  // Zoomed out: "1:4" reads better than "0.25×".
  const inv = 1 / k
  return inv >= 10 ? `1:${Math.round(inv)}` : `1:${inv.toFixed(1)}`
}

interface ScreenScaleState {
  calibrations: Record<string, ScreenCalibration>
  setCalibration: (key: string, cal: ScreenCalibration | null) => void
}

export const useScreenScaleStore = create<ScreenScaleState>()(
  persist(
    (set) => ({
      calibrations: {},
      setCalibration: (key, cal) => set((s) => {
        const next = { ...s.calibrations }
        if (cal) next[key] = cal
        else delete next[key]
        return { calibrations: next }
      }),
    }),
    { name: 'freazykam-screen' },
  ),
)

export function currentDisplay(): DisplayInfo {
  return { width: window.screen.width, height: window.screen.height, dpr: window.devicePixelRatio || 1 }
}

/**
 * This display, and its real px/mm right now (null until it is calibrated). Re-read on
 * resize, which fires both on a browser zoom and when the window moves to another monitor.
 */
export function useRealScale(): { display: DisplayInfo; pxPerMM: number | null } {
  const [display, setDisplay] = useState(currentDisplay)
  useEffect(() => {
    const onResize = () => setDisplay((d) => {
      const n = currentDisplay()
      return n.width === d.width && n.height === d.height && n.dpr === d.dpr ? d : n
    })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const cal = useScreenScaleStore((s) => s.calibrations[displayKey(display)])
  return { display, pxPerMM: cal ? realPxPerMM(cal, display.dpr) : null }
}
