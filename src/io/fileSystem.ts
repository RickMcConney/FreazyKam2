import { buildProjectData } from './projectSave'
import { useTimelineStore } from '../timeline/timelineStore'
import { sanitizeFileName } from './filename'
import { useProjectStore } from '../store/projectStore'
import { useSaveDialogStore } from '../store/saveDialogStore'
import { generateGcode, generateGcodePerTool, downloadGcode } from '../cam/gcode'
import { buildGcodeInputs } from './gcodeExport'

// ─── File System Access API (Chromium only) — minimal local typing ──────────
// We type just what we use so this compiles regardless of the TS DOM lib version.
interface FsWritable { write(data: string): Promise<void>; close(): Promise<void> }
interface FsFileHandle { readonly name: string; createWritable(): Promise<FsWritable> }
interface FsDirHandle { getFileHandle(name: string, opts?: { create?: boolean }): Promise<FsFileHandle> }
interface SaveFilePickerOptions {
  suggestedName?: string
  types?: { description?: string; accept: Record<string, string[]> }[]
}
type ShowSaveFilePicker = (opts?: SaveFilePickerOptions) => Promise<FsFileHandle>
type ShowDirectoryPicker = () => Promise<FsDirHandle>

function getPicker(): ShowSaveFilePicker | null {
  const p = (window as unknown as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker
  return typeof p === 'function' ? p : null
}

function getDirPicker(): ShowDirectoryPicker | null {
  const p = (window as unknown as { showDirectoryPicker?: ShowDirectoryPicker }).showDirectoryPicker
  return typeof p === 'function' ? p : null
}

function supportsFsAccess(): boolean {
  return getPicker() !== null
}

// No file handle is remembered between exports — for G-code or for the project. Every
// save opens the OS picker, which is the one place that already names the file, chooses
// the folder and confirms an overwrite. Caching the handle bought a silent re-export but
// pinned the name to whatever the first export chose, so a second set of toolpaths could
// not be sent to a second file from inside the app.

async function writeFile(handle: FsFileHandle, content: string) {
  const w = await handle.createWritable()
  await w.write(content)
  await w.close()
}

const stripExt = (name: string): string => name.replace(/\.[^.]+$/, '')

// True if the user cancelled the native picker — treat as "handled, do nothing".
const isAbort = (e: unknown): boolean => (e as DOMException)?.name === 'AbortError'

// Returns true when the save was handled natively; false means the caller should
// fall back to the in-app filename modal.
// Every project save opens the picker, pre-filled with the current name: reusing a remembered
// handle meant the name was fixed at the first save with no way to change it from inside the
// app. The OS dialog is also where "overwrite?" belongs, so plain re-saves still take two
// keystrokes (Ctrl+S, Enter).
async function saveProjectNative(): Promise<boolean> {
  const picker = getPicker()
  if (!picker) return false
  try {
    const suggested = sanitizeFileName(useProjectStore.getState().name || 'project')
    const projectHandle = await picker({
      suggestedName: `${suggested}.fkam`,
      types: [{ description: 'FreazyKam project', accept: { 'application/json': ['.fkam'] } }],
    })
    // Name the project from the chosen file so the toolbar header matches.
    useProjectStore.getState().setName(stripExt(projectHandle.name))
    const json = JSON.stringify(buildProjectData(), null, 2)
    await writeFile(projectHandle, json)
    useProjectStore.getState().markClean()
    useTimelineStore.getState().markSaved()
    return true
  } catch (e) {
    if (isAbort(e)) return true
    console.error('Native project save failed:', e)
    return false
  }
}

async function exportGcodeNative(): Promise<boolean> {
  const picker = getPicker()
  if (!picker) return false
  try {
    // Open the picker FIRST, while the click's user-activation is still live —
    // before the async toolpath optimization, which would otherwise expire the
    // gesture and make showSaveFilePicker throw.
    const suggested = sanitizeFileName(useProjectStore.getState().name || 'gcode')
    const handle = await picker({
      suggestedName: `${suggested}.gcode`,
      types: [{ description: 'G-code', accept: { 'text/plain': ['.gcode', '.nc', '.ngc', '.tap'] } }],
    })
    const { operations, toolsById, profile } = await buildGcodeInputs()
    // Name the program from the file the user actually chose, so the header comment the
    // operator reads on the machine matches the filename.
    const gcode = generateGcode(operations, toolsById, stripExt(handle.name), profile)
    await writeFile(handle, gcode)
    return true
  } catch (e) {
    if (isAbort(e)) return true
    console.error('Native G-code export failed:', e)
    return false
  }
}

// ─── Public entry points ────────────────────────────────────────────────────
// Use the native OS save dialog where available (Chromium), otherwise fall back
// to the in-app filename modal (Firefox/Safari). Both a project save and a G-code export
// always prompt for the filename, so either can be written somewhere new at any time.

export async function triggerProjectSave(): Promise<void> {
  if (supportsFsAccess() && await saveProjectNative()) return
  useSaveDialogStore.getState().openSaveDialog('project')
}

export async function triggerGcodeExport(): Promise<void> {
  if (supportsFsAccess() && await exportGcodeNative()) return
  useSaveDialogStore.getState().openSaveDialog('gcode')
}

// Export one G-code file per tool/spindle speed. On Chromium the user picks a
// folder (one prompt) and all files are written into it; elsewhere each file is
// downloaded in turn. The directory picker is opened first so the click's
// user-activation is still live before the async toolpath optimization.
export async function triggerGcodeExportSplit(prefix?: string): Promise<void> {
  const baseName = sanitizeFileName(prefix?.trim() || useProjectStore.getState().name || 'gcode')
  const dirPicker = getDirPicker()
  let dir: FsDirHandle | null = null
  if (dirPicker) {
    try {
      dir = await dirPicker()
    } catch (e) {
      if (isAbort(e)) return // user cancelled the folder prompt
      dir = null // fall through to downloads
    }
  }

  const { operations, toolsById, profile } = await buildGcodeInputs()
  const files = generateGcodePerTool(operations, toolsById, baseName, profile)
  if (files.length === 0) return

  if (dir) {
    for (const file of files) {
      const handle = await dir.getFileHandle(`${file.filename}.gcode`, { create: true })
      await writeFile(handle, file.gcode)
    }
  } else {
    // Sequential downloads — a short gap so browsers don't coalesce/block them.
    for (let i = 0; i < files.length; i++) {
      downloadGcode(files[i].gcode, files[i].filename)
      if (i < files.length - 1) await new Promise((r) => setTimeout(r, 350))
    }
  }
}
