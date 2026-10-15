import { useToolStore, type Tool } from '../store/toolStore'
import { useToolpathStore, type AnyOperation } from '../store/toolpathStore'
import { usePostProcessorStore, type PostProcessorProfile } from '../store/postProcessorStore'
import { generateGcode, downloadGcode } from '../cam/gcode'
import { optimizeStartPoints } from '../cam/startOptimizer'
import { opsOnCell, STOCK_CELL, type Cell } from '../cam/sheets'
import { sheetIndex, sheetLayoutNow } from '../canvas/useSheets'
import { useWorkpieceStore } from '../store/workpieceStore'
import { useUIStore } from '../store/uiStore'

// Everything generateGcode/generateGcodePerTool needs, gathered in the one
// order that's correct: optimizeStartPoints() REWRITES each operation's
// entryHint, so `operations` must be read from the store AFTER awaiting it —
// reading (or closing over) them first yields pre-optimization entry points.
//
// Single source of truth for the export side, the counterpart to importFile()
// on the import side. Used by the download, native-save, per-tool-split and
// simulate paths — don't re-derive it at a call site.
//
// ONE SHEET AT A TIME. When the parts are spread over several sheets of stock
// (cam/sheets), a G-code program is ONE of them — the operations on it, moved so its corner
// is the machine origin. `sheet` is an index into the sheet layout (default: the active
// sheet, which the simulator and the machine panel follow); `sheets` says how many there
// are. A sheet with nothing to cut gives an empty list — never another sheet's program. A
// single-sheet project is returned untouched.
//
// Two steps, so a caller that wants every sheet (the export) optimizes ONCE and builds
// each sheet from the same state of the program: `prepareProgram`, then `programForSheet`.
export interface PreparedProgram {
  all: AnyOperation[]
  toolsById: Record<string, Tool>
  profile: PostProcessorProfile
  cells: Cell[]
}

export interface SheetProgram {
  operations: AnyOperation[]
  toolsById: Record<string, Tool>
  profile: PostProcessorProfile
  sheet: number
  cell: Cell
  sheets: number
}

export async function prepareProgram(): Promise<PreparedProgram> {
  await optimizeStartPoints()
  const { tools } = useToolStore.getState()
  return {
    all: useToolpathStore.getState().operations,
    toolsById: Object.fromEntries(tools.map((t) => [t.id, t])),
    profile: usePostProcessorStore.getState().getActiveProfile(),
    cells: sheetLayoutNow(),
  }
}

export function programForSheet(p: PreparedProgram, sheet?: number): SheetProgram {
  const { all, toolsById, profile, cells } = p
  const sheets = cells.length
  if (sheets === 1) return { operations: all, toolsById, profile, sheet: 0, cell: STOCK_CELL, sheets }
  const k = Math.max(0, Math.min(sheets - 1, sheet ?? sheetIndex(cells, useUIStore.getState().activeSheet)))
  const cell = cells[k]
  return { operations: opsOnCell(all, cell, useWorkpieceStore.getState()), toolsById, profile, sheet: k, cell, sheets }
}

export async function buildGcodeInputs(sheet?: number): Promise<SheetProgram> {
  return programForSheet(await prepareProgram(), sheet)
}

// Generate Grbl G-code for the current toolpaths and download it as `<fileName>.gcode`.
// `fileName` (no extension) is also emitted as the first comment line in the file so
// the operator can confirm the program when loading it on the machine.
export async function exportGcode(fileName: string): Promise<void> {
  const { operations, toolsById, profile } = await buildGcodeInputs()
  const gcode = generateGcode(operations, toolsById, fileName, profile)
  downloadGcode(gcode, fileName)
}
