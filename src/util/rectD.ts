import { round4 } from './num'

/**
 * The d-string of an axis-aligned rectangle centred on (cx, cy), half-sizes hw × hh: CCW
 * from the low-left corner, closed. The box-only paths an STL model or an image import is
 * drawn as are built by this one function, so they cannot drift in winding or start corner.
 */
export function centredRectD(cx: number, cy: number, hw: number, hh: number): string {
  return `M${round4(cx - hw)},${round4(cy - hh)} L${round4(cx + hw)},${round4(cy - hh)} L${round4(cx + hw)},${round4(cy + hh)} L${round4(cx - hw)},${round4(cy + hh)} Z`
}
