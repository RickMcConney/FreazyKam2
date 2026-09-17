// A panel readout, as DATA rather than as markup.
//
// The pattern the escapement arrived at and the clock now shares: a sidebar 320 px
// wide is no place for a dozen lines of numbers set in the smallest type the app
// has, wrapped three ways, under the very controls being clicked — and those
// numbers are exactly what a parameter is being STEPPED AGAINST. So the lines are
// built once as data, the sidebar shows a single button carrying the WORST tone,
// and the text lives in a floating window big enough to read.
//
// The tone is what makes that trade safe: a fatal warning that only appeared in a
// window nobody had opened would be worse than one nobody could read.

/** How loudly a line reads. `error` means it will not work at all. */
export type Tone = 'plain' | 'note' | 'warn' | 'error'

export interface ReadoutLine {
  text: string
  tone: Tone
}

const RANK: Record<Tone, number> = { plain: 0, note: 1, warn: 2, error: 3 }

/** The worst tone in a set of lines — an info button's colour. */
export function worstTone(lines: ReadoutLine[]): Tone {
  return lines.reduce<Tone>((w, l) => (RANK[l.tone] > RANK[w] ? l.tone : w), 'plain')
}

export const TONE_CLASS: Record<Tone, string> = {
  plain: 'text-gray-600 dark:text-neutral-300',
  note: 'text-blue-500 dark:text-blue-400',
  warn: 'text-yellow-600 dark:text-yellow-500',
  error: 'text-red-600 dark:text-red-400 font-medium',
}

/** The info button's own colour, matching the worst line it stands for. */
export const TONE_BTN: Record<Tone, string> = {
  plain: 'border-gray-400/40 text-gray-600 dark:text-neutral-300 hover:bg-gray-400/10',
  note: 'border-blue-500/40 text-blue-500 dark:text-blue-400 hover:bg-blue-500/10',
  warn: 'border-yellow-500/50 text-yellow-600 dark:text-yellow-500 hover:bg-yellow-500/10',
  error: 'border-red-500/60 text-red-600 dark:text-red-400 font-medium hover:bg-red-500/10',
}
