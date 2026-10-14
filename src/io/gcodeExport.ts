import { useToolStore, type Tool } from '../store/toolStore'
import { useToolpathStore, type AnyOperation } from '../store/toolpathStore'
import { usePostProcessorStore, type PostProcessorProfile } from '../store/postProcessorStore'
import { generateGcode, downloadGcode } from '../cam/gcode'
import { optimizeStartPoints } from '../cam/startOptimizer'
import { opsOnSheet, programSheetCount } from '../cam/sheets'
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
// ONE SHEET AT A TIME. When a nest has spread the parts over several sheets of stock
// (cam/sheets), a G-code program is ONE of them — the operations on it, moved so its corner
// is the machine origin. `sheet` picks which (default: the active sheet, which the
// simulator and the machine panel follow); `sheets` says how many there are. A single-
// sheet project is returned untouched.
export async function buildGcodeInputs(sheet?: number): Promise<{
  operations: AnyOperation[]
  toolsById: Record<string, Tool>
  profile: PostProcessorProfile
  sheet: number
  sheets: number
}> {
  await optimizeStartPoints()
  const { tools } = useToolStore.getState()
  const toolsById = Object.fromEntries(tools.map((t) => [t.id, t]))
  const profile = usePostProcessorStore.getState().getActiveProfile()
  const all = useToolpathStore.getState().operations
  const stock = useWorkpieceStore.getState()
  const sheets = programSheetCount(all, stock)
  if (sheets === 1) return { operations: all, toolsById, profile, sheet: 0, sheets }
  const k = Math.min(sheets - 1, sheet ?? useUIStore.getState().activeSheet)
  return { operations: opsOnSheet(all, k, stock), toolsById, profile, sheet: k, sheets }
}

// Generate Grbl G-code for the current toolpaths and download it as `<fileName>.gcode`.
// `fileName` (no extension) is also emitted as the first comment line in the file so
// the operator can confirm the program when loading it on the machine.
export async function exportGcode(fileName: string): Promise<void> {
  const { operations, toolsById, profile } = await buildGcodeInputs()
  const gcode = generateGcode(operations, toolsById, fileName, profile)
  downloadGcode(gcode, fileName)
}
