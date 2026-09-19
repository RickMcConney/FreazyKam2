// Small numeric helpers shared across importers, shape generators and CAM.

/** Round to 4 decimals (0.1 µm in mm) — the precision every generated d-string is written at. */
export function round4(n: number): number { return +n.toFixed(4) }

/** `round4` as the string written into a d-string. */
export function fmt4(n: number): string { return String(round4(n)) }

export function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)) }

/** Seeded PRNG (mulberry32) returning floats in [0, 1). The seed is taken as an int32. */
export function mulberry32(seed: number): () => number {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
