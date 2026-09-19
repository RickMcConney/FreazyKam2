import { importSvg } from '../importers/svgImporter'
import { importDxf, type DxfUnitsChoice } from '../importers/dxfImporter'
import { importStl } from '../importers/stlImporter'
import { getMultiBBox, translateD } from '../canvas/selectionUtils'
import { originWorldXY } from '../canvas/layers/WorkpieceLayer'
import { usePathsStore } from '../store/pathsStore'
import { useWorkpieceStore } from '../store/workpieceStore'
import { useUIStore } from '../store/uiStore'
import { useSimStore } from '../store/simStore'
import { useProjectStore } from '../store/projectStore'
import { useToolpathStore, GCODE_IMPORT_TOOL_ID, type GcodeOperation, type MotionSegment } from '../store/toolpathStore'
import { useTimelineStore } from '../timeline/timelineStore'
import { serializeOp } from '../timeline/events'
import { uid } from '../uid'
import { round4 } from '../util/num'

// Shared file-import entry point used by both the toolbar Import button and
// drag-and-drop onto the canvas. Handles every supported format; anything else
// gets a status-bar hint instead of silently doing nothing (tofix.md B8).


// Leave a vector import selected, so a pocket/profile can be generated straight away
// instead of making the user re-select what they just brought in. Replaces the selection
// rather than extending it — importing a second file is a new subject, not an addition to
// whatever was highlighted before. This also matches what scrubbing the timeline to the
// import event already does (paths.add records selectionAfter with the same ids).
function selectImported(paths: { id: string }[]) {
  if (paths.length > 0) usePathsStore.getState().setSelectedIds(paths.map((p) => p.id))
}

// Finish a DXF import once units are known — either straight from the file's
// $INSUNITS or from the units-prompt dialog (DxfUnitsDialog) after the user
// picks. Exported for that dialog.
export function completeDxfImport(text: string, fileName: string, units?: DxfUnitsChoice) {
  useUIStore.getState().setPendingDxfImport(null)
  const { widthMM, heightMM } = useWorkpieceStore.getState()
  const result = importDxf(text, fileName, units, { x: widthMM / 2, y: heightMM / 2 })
  if (result.paths.length > 0) {
    const store = usePathsStore.getState()
    store.addPaths(result.paths, { source: 'import', label: `Import DXF (${fileName})` })
    store.toggleGroupCollapsed(result.groupId)
    selectImported(result.paths)
    useUIStore.getState().setSidebarTab('draw')
  } else if (result.error) {
    useUIStore.getState().showStatus(`DXF import failed — ${result.error}`, 'error')
  } else if (!result.needsUnitsPrompt) {
    useUIStore.getState().showStatus('DXF import failed — no supported geometry in the file', 'warn')
  }
}

// G-code imports run one at a time, in the order they were started: dropping a split-by-tool
// set starts every file.text() at once, and the set's program order must be the drop order,
// not whichever read happens to finish first.
let gcodeImportQueue: Promise<void> = Promise.resolve()

/** Load every visible imported G-code file into the simulator as ONE program, in operation
 *  order — the machine running them back to back. Plain concatenation is exact: the parser
 *  ignores M30, and each app-generated file's header restates units, spindle and its tool
 *  comment (an external file without tool comments keeps the previous file's tool).
 *  Returns the files loaded; loads nothing when there are none. */
export function loadImportedGcode(): GcodeOperation[] {
  const imported = useToolpathStore.getState().operations.filter(
    (o): o is GcodeOperation => o.type === 'gcode' && o.visible && o.status === 'done' && !!o.gcode)
  if (imported.length > 0) {
    // autoReload:false — regenerating operations can't rebuild an imported program.
    useSimStore.getState().loadGcode(imported.map((o) => o.gcode).join('\n'), { autoReload: false })
  }
  return imported
}

export function importFile(file: File): void {
  const ui = useUIStore.getState()

  // A file that can't be read at all (moved after drag, cloud placeholder,
  // permissions) must still surface in the status bar (bugs.md B7).
  const readFailed = () =>
    useUIStore.getState().showStatus(`Import failed — could not read ${file.name}`, 'error')

  if (/\.(gcode|nc|ngc|tap)$/i.test(file.name)) {
    gcodeImportQueue = gcodeImportQueue.then(() => file.text()).then((text) => {
      // Parse this file ON ITS OWN first, to get its moves for the operation's segments;
      // the simulator is loaded with the whole imported set below. autoReload:false — this
      // program came from a file, not from the operations, so regenerating them must not
      // rebuild over it (generateGcode skips imported G-code ops). See sim/simAutoReload.ts.
      useSimStore.getState().loadGcode(text, { autoReload: false })

      // Convert parsed SimSegments (machine coords) → MotionSegments (workpiece coords)
      const { widthMM, heightMM, origin } = useWorkpieceStore.getState()
      const org = originWorldXY(origin, widthMM, heightMM)
      const simSegs = useSimStore.getState().segments
      const motionSegs: MotionSegment[] = simSegs.map((s) => ({
        x: s.x + org.x,
        y: s.y + org.y,
        z: s.z,
        rapid: s.rapid,
      }))

      // Replace an earlier import of the SAME file (re-importing an edited program) and keep
      // the rest: a split-by-tool export is several files meant to run in sequence.
      const tpStore = useToolpathStore.getState()
      const isSameFile = (o: { type: string; filename?: string }) => o.type === 'gcode' && o.filename === file.name
      const oldGcodeIds = tpStore.operations.filter(isSameFile).map((o) => o.id)
      tpStore.replaceOperations(
        tpStore.operations.filter((o) => !isSameFile(o))
      )
      if (oldGcodeIds.length > 0) {
        useTimelineStore.getState().record({ kind: 'op.delete', opIds: oldGcodeIds }, { label: 'Replace imported G-code' })
      }
      const filename = file.name
      const opName = filename.replace(/\.(gcode|nc|ngc|tap)$/i, '')
      // record:false — the op.add event is recorded manually below AFTER segments
      // are attached; a G-code op's segments live in the event (they can't be
      // regenerated from settings like other op types).
      const opId = tpStore.addOperation({
        type: 'gcode',
        name: opName,
        toolId: GCODE_IMPORT_TOOL_ID,
        filename,
        gcode: text,
      }, { record: false })
      useToolpathStore.getState().setSegments(opId, motionSegs)
      const gcodeOp = useToolpathStore.getState().operations.find((o) => o.id === opId)
      if (gcodeOp) {
        useTimelineStore.getState().record(
          { kind: 'op.add', op: serializeOp(gcodeOp) },
          { label: `Import G-code (${filename})` },
        )
      }

      // Show the whole imported set, this file appended to any already loaded.
      loadImportedGcode()

      // Rename project to match the imported file
      useProjectStore.getState().setName(opName)

      // Open the G-code viewer so the user sees the imported code immediately
      const simState = useSimStore.getState()
      if (!simState.gcodeViewerOpen) simState.toggleGcodeViewer()

      useUIStore.getState().setSidebarTab('draw')
      const cur = useUIStore.getState().workspaceTab
      if (cur !== '2d' && cur !== '3d') useUIStore.getState().setWorkspaceTab('2d')
    }).catch(readFailed)
    return
  }

  if (file.name.toLowerCase().endsWith('.svg') || file.type === 'image/svg+xml') {
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const { widthMM, heightMM } = useWorkpieceStore.getState()
        const gn = file.name.replace(/\.svg$/i, '')
        const result = importSvg(ev.target?.result as string, {}, gn)
        if (result.paths.length > 0) {
          // Center on workpiece by actual path bbox (handles SVGs where content
          // is smaller than the declared page size, e.g. tiny art on an A4 canvas)
          const bbox = getMultiBBox(result.paths.map(p => p.d))
          if (bbox) {
            const dx = widthMM / 2 - (bbox.minX + bbox.maxX) / 2
            const dy = heightMM / 2 - (bbox.minY + bbox.maxY) / 2
            if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001)
              for (const path of result.paths) path.d = translateD(path.d, dx, dy)
          }
          const store = usePathsStore.getState()
          store.addPaths(result.paths, { source: 'import', label: `Import SVG (${file.name})` })
          store.toggleGroupCollapsed(result.groupId)
          selectImported(result.paths)
          useUIStore.getState().setSidebarTab('draw')
        } else {
          useUIStore.getState().showStatus('SVG import failed — no usable paths in the file', 'warn')
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error'
        useUIStore.getState().showStatus(`SVG import failed — ${msg}`, 'error')
      }
    }
    reader.onerror = readFailed
    reader.readAsText(file)
    return
  }

  if (file.name.toLowerCase().endsWith('.dxf')) {
    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = ev.target?.result as string
      const fileName = file.name.replace(/\.dxf$/i, '')
      const result = importDxf(text, fileName)
      if (result.needsUnitsPrompt) {
        useUIStore.getState().setPendingDxfImport({ text, name: fileName })
      } else {
        completeDxfImport(text, fileName)
      }
    }
    reader.onerror = readFailed
    reader.readAsText(file)
    return
  }

  if (file.name.toLowerCase().endsWith('.stl')) {
    const reader = new FileReader()
    reader.onload = (ev) => {
      const buffer = ev.target?.result as ArrayBuffer
      try {
        const { widthMM, heightMM } = useWorkpieceStore.getState()
        const path = importStl(buffer, file.name.replace(/\.stl$/i, ''), widthMM / 2, heightMM / 2)
        const store = usePathsStore.getState()
        store.addPaths([path], { source: 'import', label: `Import STL (${file.name})` })
        store.selectPath(path.id)
        useUIStore.getState().setSidebarTab('draw')
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error'
        useUIStore.getState().showStatus(`STL import failed — ${msg}`, 'error')
      }
    }
    reader.onerror = readFailed
    reader.readAsArrayBuffer(file)
    return
  }

  if (/\.(png|jpe?g|webp)$/i.test(file.name) || file.type.startsWith('image/')) {
    const reader = new FileReader()
    reader.onload = (ev) => {
      const src = ev.target?.result as string
      const img = new window.Image()
      img.onload = () => {
        const { widthMM, heightMM } = useWorkpieceStore.getState()
        // Convert natural pixels → mm at 96 DPI, then scale to fit 80% of workpiece
        const PX_TO_MM = 25.4 / 96
        const naturalW = img.naturalWidth * PX_TO_MM
        const naturalH = img.naturalHeight * PX_TO_MM
        const scl = Math.min((widthMM * 0.8) / naturalW, (heightMM * 0.8) / naturalH, 1)
        const imgW = naturalW * scl
        const imgH = naturalH * scl
        // Center on the workpiece
        const cx = widthMM / 2, cy = heightMM / 2
        const hw = imgW / 2, hh = imgH / 2
        const d = `M${round4(cx - hw)},${round4(cy - hh)} L${round4(cx + hw)},${round4(cy - hh)} L${round4(cx + hw)},${round4(cy + hh)} L${round4(cx - hw)},${round4(cy + hh)} Z`
        usePathsStore.getState().addPaths([{
          id: uid('img'),
          name: file.name.replace(/\.[^.]+$/, ''),
          d,
          visible: true,
          color: '#94a3b8',
          imageSrc: src,
        }], { source: 'import', label: `Import image (${file.name})` })
        useUIStore.getState().setSidebarTab('draw')
      }
      img.onerror = () =>
        useUIStore.getState().showStatus(`Image import failed — could not decode ${file.name}`, 'error')
      img.src = src
    }
    reader.onerror = readFailed
    reader.readAsDataURL(file)
    return
  }

  ui.showStatus(`Unsupported file type: ${file.name} — supported: SVG, DXF, STL, image, G-code`, 'warn')
}
