// Exact squared Euclidean distance transform (Felzenszwalb & Huttenlocher 2012), in cells.
//
// Separable and exact: a 1-D transform down every column, then across every row of that
// result. The 1-D step is the lower envelope of the parabolas rooted at each sample, walked
// in O(n) — `v` holds the roots currently on the envelope and `z` the boundaries between
// them. Because the result of each 1-D pass is an exact squared distance, the two passes
// commute: column-then-row and row-then-column give the same array.
//
// Cells with no feature anywhere on the grid come back at EDT_INF plus their in-pass
// offset — a sentinel, not a distance. Callers compare it against a real squared radius,
// so only its magnitude matters; do not sqrt it without checking for a feature first.

/** Stand-in for "no feature on this line". Larger than any squared distance a CAM grid can
 *  hold (grids are capped in the millions of cells, so ~1e7 is the real ceiling), and small
 *  enough that adding q² to it stays exact in a double. */
export const EDT_INF = 1e10

/** One 1-D transform of `f[0..n)` into `d`. `v` and `z` are scratch, reused across lines. */
function dt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0
  v[0] = 0
  z[0] = -EDT_INF
  z[1] = EDT_INF
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (s <= z[k]) {
      k--
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = EDT_INF
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]
  }
}

/** Squared distance (in cells) from every cell of a `w`×`h` row-major grid to the nearest
 *  cell where `isFeature(i)` is true. */
export function edtSq(w: number, h: number, isFeature: (i: number) => boolean): Float64Array {
  const m = Math.max(w, h)
  const f = new Float64Array(m)
  const d = new Float64Array(m)
  const v = new Int32Array(m)
  const z = new Float64Array(m + 1)
  const out = new Float64Array(w * h)
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = isFeature(y * w + x) ? 0 : EDT_INF
    dt1d(f, h, d, v, z)
    for (let y = 0; y < h; y++) out[y * w + x] = d[y]
  }
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) f[x] = out[row + x]
    dt1d(f, w, d, v, z)
    for (let x = 0; x < w; x++) out[row + x] = d[x]
  }
  return out
}
