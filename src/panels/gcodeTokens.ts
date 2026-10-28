// A G-code line split so the viewer can colour its axis words the way the canvas draws the
// axes (AXIS_COLORS). Only CODE is split: an X inside a comment — "(Max X travel)", a tool
// named "1/8 X 1/2" — is text, not a coordinate.

export type Axis = 'x' | 'y' | 'z'
export interface LinePiece { text: string; axis?: Axis }

const AXIS_WORD = /([XYZ])(\s*[-+]?(?:\d+\.?\d*|\.\d+))/gi

export function axisPieces(line: string): LinePiece[] {
  // Code runs to the first comment, `;` or `(` — whichever comes first.
  const cut = [line.indexOf(';'), line.indexOf('(')].filter((i) => i >= 0)
  const end = cut.length ? Math.min(...cut) : line.length
  const code = line.slice(0, end)
  const out: LinePiece[] = []
  let at = 0
  for (const m of code.matchAll(AXIS_WORD)) {
    if (m.index! > at) out.push({ text: code.slice(at, m.index) })
    out.push({ text: m[0], axis: m[1].toLowerCase() as Axis })
    at = m.index! + m[0].length
  }
  if (at < line.length) out.push({ text: line.slice(at) })
  return out
}
