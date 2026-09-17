import { useToolStore, type Tool } from '../store/toolStore'
import { useToolpathStore, type AnyOperation } from '../store/toolpathStore'
import { usePostProcessorStore, type PostProcessorProfile } from '../store/postProcessorStore'
import { generateGcode, downloadGcode } from '../cam/gcode'
import { optimizeStartPoints } from '../cam/startOptimizer'

// Everything generateGcode/generateGcodePerTool needs, gathered in the one
// order that's correct: optimizeStartPoints() REWRITES each operation's
// entryHint, so `operations` must be read from the store AFTER awaiting it —
// reading (or closing over) them first yields pre-optimization entry points.
//
// Single source of truth for the export side, the counterpart to importFile()
// on the import side. Used by the download, native-save, per-tool-split and
// simulate paths — don't re-derive it at a call site.
export async function buildGcodeInputs(): Promise<{
  operations: AnyOperation[]
  toolsById: Record<string, Tool>
  profile: PostProcessorProfile
}> {
  await optimizeStartPoints()
  const { tools } = useToolStore.getState()
  const toolsById = Object.fromEntries(tools.map((t) => [t.id, t]))
  const profile = usePostProcessorStore.getState().getActiveProfile()
  const { operations } = useToolpathStore.getState()
  return { operations, toolsById, profile }
}

// Generate Grbl G-code for the current toolpaths and download it as `<fileName>.gcode`.
// `fileName` (no extension) is also emitted as the first comment line in the file so
// the operator can confirm the program when loading it on the machine.
export async function exportGcode(fileName: string): Promise<void> {
  const { operations, toolsById, profile } = await buildGcodeInputs()
  const gcode = generateGcode(operations, toolsById, fileName, profile)
  downloadGcode(gcode, fileName)
}
