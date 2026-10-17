// RAPIDS THAT CUT. A G0 is not a cut — the controller runs it at full speed, often
// doglegged, and nothing generates a rapid expecting it to touch material — so one that
// passes through stock is a wrong safe height, wrong stock bounds, a link the generator
// got wrong, or an imported program set up for other stock. The simulator never carved
// rapids, so such a move simply did not show.
//
// The check carves the program in order into a coarse grid of the WHOLE stock (a rapid
// can cut anywhere, not just where the cuts are) and sends every G0 through the same carve
// as a cut: what it removes is how far it went into material the program had not already
// cleared. The carve keeps it — the machine would have cut it too — so a second rapid
// along the same track is judged against what the first one left.
//
// A stay-down link written as G0 (`linksAsRapids`) rides half a millimetre over floor the
// generator verified is cleared, so it removes nothing — but a grid cannot see that at a
// wall. The carve claims every cell within half a cell diagonal of the tool (its coverage
// margin), so a rapid plunging into a cleared pocket beside its wall takes the wall's rim
// cells and, measured as the most removed from one cell, reads as the whole wall height.
// So a rapid is JUDGED with the tool slimmed by `margin` sideways — a narrower end mill or
// ball, or a V-cutter raised until its cone is that much narrower — which a graze of the
// rim cannot reach and a move into the material still does; then it is CARVED with its
// real size. The slim carve lies inside the real one, so the stock comes out the same.
import { Heightfield, type HeightfieldGrid } from './heightfield'
import { segTool, type SimSegment, type ToolState } from './gcodeParser'

/** A G0 that went into stock: the move, its line, how deep (mm) and where it ends (program X/Y, mm). */
export interface RapidGouge {
  segIdx: number
  lineIdx: number
  depthMM: number
  x: number
  y: number
}

// Finer than this costs time and finds nothing more worth reporting.
const MIN_CELL_MM = 0.25
const MAX_SAMPLES = 1_500_000
const MAX_AXIS = 4096
/** Removal below this is grid noise, not a rapid in the stock. */
export const RAPID_GOUGE_MIN_MM = 0.1

/**
 * Every G0 in `segments` that cut more than RAPID_GOUGE_MIN_MM into the stock. Segment Z
 * must be TOP-referenced (0 = stock top), as simStore holds it; X/Y are program
 * coordinates, `orgX/orgY` the origin's offset into the stock.
 */
export function findRapidGouges(
  segments: SimSegment[], toolStates: ToolState[],
  stock: { widthMM: number; heightMM: number; thicknessMM: number; orgX: number; orgY: number },
  cellMM?: number,
): RapidGouge[] {
  const { widthMM: W, heightMM: H, thicknessMM: T } = stock
  if (!(W > 0 && H > 0 && T > 0) || segments.length === 0) return []
  const cell = cellMM ?? Math.max(MIN_CELL_MM, Math.sqrt((W * H) / MAX_SAMPLES))
  const NX = Math.max(2, Math.min(MAX_AXIS, Math.round(W / cell) + 1))
  const NY = Math.max(2, Math.min(MAX_AXIS, Math.round(H / cell) + 1))
  const grid: HeightfieldGrid = {
    NX, NY, sx: W / (NX - 1), sy: H / (NY - 1), gx0: 0, gy0: 0, T, orgX: stock.orgX, orgY: stock.orgY,
  }
  const hf = new Heightfield(grid)
  // The carve's coverage margin (half a cell diagonal) plus a cell: past what a grid can
  // place, so a rapid has to go genuinely into the material to count.
  const margin = 1.5 * Math.hypot(grid.sx, grid.sy)

  const out: RapidGouge[] = []
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]
    // Wholly above the stock top: touches nothing, whatever kind of move it is.
    if (s.prevZ >= 0 && s.z >= 0) continue
    const ts = segTool(s, toolStates)
    if (s.rapid) {
      const tan = ts.toolVbitHalfAngleTan
      const lift = tan ? margin / tan : 0
      const d = tan ? ts.toolDiameterMM : Math.max(0, ts.toolDiameterMM - 2 * margin)
      const removed = d > 0 ? hf.carve(s.prevX, s.prevY, s.x, s.y, s.prevZ + lift, s.z + lift,
        tan, ts.toolBallNose, d, ts.toolTipRadiusMM, Math.min(ts.toolCornerRadiusMM ?? 0, d / 2)) : 0
      if (removed > RAPID_GOUGE_MIN_MM) {
        out.push({ segIdx: i, lineIdx: s.lineIdx, depthMM: removed, x: s.x, y: s.y })
      }
    }
    hf.carve(s.prevX, s.prevY, s.x, s.y, s.prevZ, s.z,
      ts.toolVbitHalfAngleTan, ts.toolBallNose, ts.toolDiameterMM, ts.toolTipRadiusMM, ts.toolCornerRadiusMM)
  }
  return out
}
