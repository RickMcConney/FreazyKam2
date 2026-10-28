// THE OTHER SIDE OF A DOUBLE-SIDED BOARD, for the 3D view (cam/doubleSided).
//
// Each side is cut by a 3-axis machine from its own face, so neither can undercut the
// other, and the board is exactly two heights per column: side A's surface coming down and
// side B's coming up, with material wherever the first is above the second. The view
// carves the side being simulated as it always has, and carves the OTHER side's finished
// program into a second grid from underneath (`HeightfieldMaterial`'s `under`).
//
// That program is the other sheet's, built the way the export builds it, then MIRRORED
// about the flip axis into this side's frame. Mirroring is safe here though it never is for
// cutting: the carve asks only where the tool went, never which way round, and every
// cutter is symmetric about its axis.
//
// What shows underneath follows the order things are really cut in:
//  - on side B, side A is always already cut;
//  - on side A, side B shows as cut while the player is on the finished part (where it
//    opens), and goes back to bare board once playback runs or scrubs from the start —
//    when side A is being cut, side B has not been yet.

import type { SimSegment, ToolState } from './gcodeParser'
import { parseGcode } from './gcodeParser'
import { movesToDrawing } from '../cam/machineFrame'
import { generateGcode } from '../cam/gcode'
import { programForSheet } from '../io/gcodeExport'
import { sheetLayoutNow, sheetIndex } from '../canvas/useSheets'
import { originWorldXY } from '../canvas/layers/WorkpieceLayer'
import { sameCell, opCell, STOCK_CELL, type Cell } from '../cam/sheets'
import { reachesProgram } from '../cam/programOps'
import { backCell, type FlipDirection } from '../cam/doubleSided'
import { useWorkpieceStore, zDatumOffsetMM } from '../store/workpieceStore'
import { useToolpathStore } from '../store/toolpathStore'
import { useToolStore } from '../store/toolStore'
import { usePostProcessorStore } from '../store/postProcessorStore'
import { useProjectStore } from '../store/projectStore'
import { useSimStore } from '../store/simStore'

export interface UnderProgram {
  /** The other side's finished program, mirrored into this side's segment frame. */
  segments: SimSegment[]
  toolStates: ToolState[]
  /** Side A: playback from the start shows side B uncut (see the header). */
  hideOnRewind: boolean
}

/**
 * The other side's segments in THIS side's frame. Segment XY is origin-relative
 * (workpiece-local minus `org`); the flip mirrors workpiece-local x → W − x (left-right)
 * or y → H − y (top-bottom), the same map both ways.
 */
export function mirrorForOtherSide(
  segs: SimSegment[], flip: FlipDirection, W: number, H: number, orgX: number, orgY: number,
): SimSegment[] {
  if (flip === 'left-right') {
    const k = W - 2 * orgX
    return segs.map((s) => ({ ...s, x: k - s.x, prevX: k - s.prevX }))
  }
  const k = H - 2 * orgY
  return segs.map((s) => ({ ...s, y: k - s.y, prevY: k - s.prevY }))
}

// Built once per state of the other side: the program, its parse and the mirror cost a
// few hundred ms on a big job, and the view rebuilds on every load.
let cacheKey: unknown[] = []
let cached: UnderProgram | null = null

function sameKey(a: unknown[], b: unknown[]) {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/** The two cells of a double-sided job: the one the loaded program is for, and the other. */
function sides(): { here: Cell; other: Cell; flip: FlipDirection } | null {
  const ds = useWorkpieceStore.getState().doubleSided
  const sim = useSimStore.getState()
  if (!ds || !sim.autoReload || !sim.gcode) return null
  const back = backCell(ds.flip)
  if (sameCell(sim.sheet, STOCK_CELL)) return { here: STOCK_CELL, other: back, flip: ds.flip }
  if (sameCell(sim.sheet, back)) return { here: back, other: STOCK_CELL, flip: ds.flip }
  return null
}

/** What the other side's program is built from — compared by identity, like simAutoReload. */
export function otherSideKey(): unknown[] {
  const sd = sides()
  if (!sd) return []
  const wp = useWorkpieceStore.getState()
  const key: unknown[] = [cellKeyOf(sd.here), wp.doubleSided, wp.widthMM, wp.heightMM, wp.thicknessMM, wp.origin, wp.zOrigin,
    useToolStore.getState().tools, usePostProcessorStore.getState().getActiveProfile()]
  for (const op of useToolpathStore.getState().operations) {
    if (!reachesProgram(op) || !sameCell(opCell(op, wp), sd.other)) continue
    key.push(op.id, op.toolId, op.segments, op.entryHint)
  }
  return key
}

const cellKeyOf = (c: Cell) => `${c.col},${c.row}`

/** The other side's finished program for the 3D view, or null for an ordinary job. */
export function otherSideProgram(): UnderProgram | null {
  const sd = sides()
  if (!sd) return null
  const key = otherSideKey()
  if (sameKey(key, cacheKey)) return cached
  cacheKey = key
  cached = null

  const wp = useWorkpieceStore.getState()
  const cells = sheetLayoutNow()
  const k = sheetIndex(cells, sd.other)
  if (!sameCell(cells[k], sd.other)) return null
  const { tools } = useToolStore.getState()
  const prog = programForSheet({
    all: useToolpathStore.getState().operations,
    toolsById: Object.fromEntries(tools.map((t) => [t.id, t])),
    profile: usePostProcessorStore.getState().getActiveProfile(),
    cells,
  }, k)
  if (!prog.operations.some(reachesProgram)) return null
  const gcode = generateGcode(prog.operations, prog.toolsById, useProjectStore.getState().name, prog.profile)
  const genZOff = zDatumOffsetMM(wp.zOrigin, wp.thicknessMM)
  const parsed = parseGcode(gcode, wp.safeHeightMM + genZOff)
  // Top-referenced, as simStore.loadGcode makes the program being played.
  if (genZOff) for (const s of parsed.segments) { s.z -= genZOff; s.prevZ -= genZOff }
  movesToDrawing(parsed.segments, wp.machineXDir)
  const org = originWorldXY(wp.origin, wp.widthMM, wp.heightMM)
  cached = {
    segments: mirrorForOtherSide(parsed.segments, sd.flip, wp.widthMM, wp.heightMM, org.x, org.y),
    toolStates: parsed.toolStates,
    hideOnRewind: sameCell(sd.here, STOCK_CELL),
  }
  return cached
}
