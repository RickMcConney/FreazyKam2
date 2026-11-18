// A uniform grid over a bounding box: the cell layout and the square-ring walk that the
// pocket code's nearest searches share (SegmentGrid in shared.ts, EndpointGrid in raster.ts;
// clearance.ts's edge field uses the layout). The walk's termination test stays with each
// caller, since one compares squared distances and the other plain ones.

export class GridFrame {
  readonly cell: number
  readonly minX: number
  readonly minY: number
  readonly cols: number
  readonly rows: number

  constructor(minX: number, minY: number, maxX: number, maxY: number, cell: number) {
    this.cell = cell
    this.minX = minX; this.minY = minY
    this.cols = Math.max(1, Math.floor((maxX - minX) / cell) + 1)
    this.rows = Math.max(1, Math.floor((maxY - minY) / cell) + 1)
  }

  /** Column of `x`, clamped into the grid. */
  col(x: number): number { return Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.minX) / this.cell))) }
  /** Row of `y`, clamped into the grid. */
  row(y: number): number { return Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.minY) / this.cell))) }

  /** The most rings a walk can need to cover the grid from any cell. */
  get maxRing(): number { return Math.max(this.cols, this.rows) }

  /**
   * Visit each cell of the square ring at Chebyshev distance `r` from cell (cx, cy), clipped
   * to the grid, row by row and left to right — the order the copies walked in, so a
   * search's tie-breaks are unchanged. Any item in ring r is at least (r − 1) cells away.
   */
  forRing(cx: number, cy: number, r: number, visit: (cellIndex: number) => void): void {
    const y0 = Math.max(0, cy - r), y1 = Math.min(this.rows - 1, cy + r)
    const x0 = Math.max(0, cx - r), x1 = Math.min(this.cols - 1, cx + r)
    for (let j = y0; j <= y1; j++) {
      const onYEdge = j === cy - r || j === cy + r
      for (let i = x0; i <= x1; i++) {
        if (!onYEdge && i !== cx - r && i !== cx + r) continue
        visit(j * this.cols + i)
      }
    }
  }
}

/** A cell size giving roughly one of `n` items per cell over a box `span` wide. */
export function cellForCount(span: number, n: number): number {
  return span > 0 ? Math.max(span / Math.max(1, Math.ceil(Math.sqrt(n))), 1e-6) : 1
}
