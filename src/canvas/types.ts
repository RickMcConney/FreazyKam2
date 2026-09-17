export type HandleType = 'tl' | 'tr' | 'bl' | 'br' | 't' | 'b' | 'l' | 'r'

export type LiveTransform =
  | { kind: 'translate'; pathIds: Set<string>; dx: number; dy: number }
  | { kind: 'scale'; pathIds: Set<string>; sx: number; sy: number; ax: number; ay: number }
  | { kind: 'rotate'; pathIds: Set<string>; angle: number; cx: number; cy: number }
  | { kind: 'skew'; pathIds: Set<string>; kx: number; ky: number; ax: number; ay: number }

// Ruler gutter size, used by the fit-viewport math. The RulerLayer component
// itself was removed (render was commented out) — restore from git history if
// rulers come back.
export const RULER_W = 40   // left ruler width (px)
export const RULER_H = 20   // top ruler height (px)
