// Number entry that understands the way a shop actually writes lengths.
//
// `parseFloat` is not merely unhelpful on a fraction, it is WRONG in the dangerous
// direction: parseFloat('1/2') is 1, and parseFloat('1-1/2') is 1 — it takes the leading
// digits and silently discards the rest, so a typed 1/8 becomes a 1 mm cut. So fractions
// are parsed everywhere, not only in inch mode; a fraction in a mm field is still
// unambiguous arithmetic, and reading it as 0.5 beats reading it as 1.
//
// Accepted, with optional sign and any spacing:
//   3/16      → 0.1875     simple fraction
//   1 1/2     → 1.5        mixed number, space separated
//   1-1/2     → 1.5        mixed number, hyphen separated (the hyphen is a separator here,
//                          not a minus — a leading sign is read before the whole part)
//   -1-1/2    → -1.5
//   1/2"      → 0.5        trailing inch marks are ignored
//   .5, 2., 1e3            fall through to parseFloat as before
//   =24/2     → 12         arithmetic — see expr.ts for what '=' changes about '-'

import { evalExpression } from './expr'

/** Tooltip for fields that accept this input, so the capability is discoverable. */
export const NUMERIC_HINT = 'Accepts fractions (1/8, 3/16, 1-1/2) and formulas (=24/2, =25.4/8)'

// sign, optional whole part (space- or hyphen-separated), numerator, denominator
const FRACTION = /^([+-])?\s*(?:(\d+)\s*[-\s]\s*)?(\d+)\s*\/\s*(\d+)$/

/** Parse user input to a number, or null if it isn't one. */
export function parseNumeric(raw: string): number | null {
  const s = raw.replace(/["″]/g, '').trim()
  if (s === '') return null

  // A leading '=' hands the rest to the expression parser and nothing else. It is the
  // same binding-choice rule as the slash below: once the user has said which notation
  // this is, a fallback to the other one can only ever produce a number they did not
  // ask for. Note '-' means subtraction from here on — `=1-1/2` is 0.5, not 1.5.
  if (s.startsWith('=')) return evalExpression(s.slice(1))

  // Once there is a slash the ONLY acceptable reading is a fraction. Falling through to
  // parseFloat here is what makes the failure dangerous: parseFloat('1/') is 1, so a
  // half-typed or malformed fraction would land in the field as a real, wrong number.
  if (s.includes('/')) {
    const m = FRACTION.exec(s)
    if (!m) return null
    const [, sign, whole, num, den] = m
    const d = parseInt(den, 10)
    if (d === 0) return null   // 1/0 — must not reach the field as Infinity
    const v = (whole ? parseInt(whole, 10) : 0) + parseInt(num, 10) / d
    return sign === '-' ? -v : v
  }

  const v = parseFloat(s)
  return Number.isFinite(v) ? v : null
}

/**
 * True when `raw` is still being typed toward a fraction ('1/', '1 1/', '-3/').
 *
 * The input fires live updates for valid intermediate text so previews keep up, but a
 * half-typed fraction must not: parseFloat('1/') is 1, so '1/8' would push 1 into the
 * store on the way to 0.125 — a real value, briefly, in a field that drives a cut.
 */
export function isPartialFraction(raw: string): boolean {
  return raw.includes('/') && parseNumeric(raw) === null
}

/**
 * True when `raw` is an expression — anything starting `=`.
 *
 * An expression NEVER publishes on a keystroke, complete or not, which is a stronger rule
 * than the one above and needs to be: `=25.4` is a perfectly valid expression on the way
 * to `=25.4/8`, so there is no half-typed state to detect. It commits on Enter or blur,
 * once the user has said they are done.
 */
export function isExpression(raw: string): boolean {
  return raw.trimStart().startsWith('=')
}

/**
 * Whether leaving a field (blur, or Enter) should write its text back.
 *
 * NOT when the user typed nothing. The text a field opens with is its value FORMATTED —
 * rounded for display (4 places, or 2 for an angle) and in inch mode converted too — so
 * parsing it back gives a slightly different number: tabbing through a 6 mm depth in inch
 * mode wrote 5.99948 mm, a 0.05 mm chip load came back 0.0508, and a shape turned to
 * 37.4821° was turned again by −0.0021° on a click in and out of Angle. Each was a real
 * edit — operations gone stale, an undo step — for nothing the user did.
 *
 * But YES when the text is back where it started after the field published values live on
 * the way (NumericInput sends each valid keystroke): the last of those is in the store, and
 * only the commit puts the field's own value back over it.
 */
export function shouldCommitDraft(draft: string | null, seeded: string | null, publishedLive = false): boolean {
  if (draft === null) return false
  return publishedLive || draft !== seeded
}
