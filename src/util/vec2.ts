// Point-tuple one-liners ([x, y]) that modules kept re-declaring. Plain arithmetic, so
// moving a copy here changes no result.

type P = readonly [number, number] | readonly number[]

export const dot = (a: P, b: P): number => a[0] * b[0] + a[1] * b[1]
/** z of a × b: positive when b is CCW of a (CNC Y-up). */
export const cross = (a: P, b: P): number => a[0] * b[1] - a[1] * b[0]
export const dist = (a: P, b: P): number => Math.hypot(a[0] - b[0], a[1] - b[1])
/** a + (b − a)·t */
export const lerpPt = (a: P, b: P, t: number): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
