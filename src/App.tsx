import { useEffect, lazy, Suspense } from 'react'
import { preloadFonts, loadFont, SINGLE_LINE_FONT_FAMILY } from './shapes/textGenerator'
import Toolbar from './components/Toolbar'
import Sidebar from './components/Sidebar'
import StatusBar from './components/StatusBar'
import ToolLibraryPanel from './panels/ToolLibraryPanel'
import PostProcessorPanel from './panels/PostProcessorPanel'
import { useUIStore, type WorkspaceTab } from './store/uiStore'
import { usePathsStore } from './store/pathsStore'
import { openProjectFile, newProject } from './io/projectLoad'
import { triggerProjectSave } from './io/fileSystem'
import SaveDialog from './components/SaveDialog'
import EscapementInfoPanel from './panels/EscapementInfoPanel'
import ClockInfoPanel from './panels/ClockInfoPanel'
import { useWorkpieceStore } from './store/workpieceStore'
import { useToolpathStore } from './store/toolpathStore'
import { useTimelineStore } from './timeline/timelineStore'
import { regenerateOperation } from './cam/regenerate'
import { useSimStore } from './store/simStore'
import { installSimAutoReload } from './sim/simAutoReload'
import { installPathClipboard } from './io/pathClipboard'
import { installAutosave, armAutosave, readSnapshot, clearSnapshot, applySnapshot, pruneSnapshots, tabWasDiscarded } from './io/autosave'

const CanvasStage = lazy(() => import('./canvas/CanvasStage'))
const ThreeView = lazy(() => import('./three/ThreeView'))
const TimelinePanel = lazy(() => import('./panels/TimelinePanel'))
const OperationsPanel = lazy(() => import('./panels/OperationsPanel'))

const WORKSPACE_TABS: { id: WorkspaceTab; label: string }[] = [
  { id: '2d', label: '2D View' },
  { id: '3d', label: '3D View' },
  { id: 'tools', label: 'Tool Library' },
  { id: 'postprocessor', label: 'Post-Processor' },
]

function MainWorkspace() {
  // Individual selectors — whole-store destructuring re-rendered the entire
  // workspace on every uiStore change (bugs.md H5).
  const workspaceTab = useUIStore((s) => s.workspaceTab)
  const bottomTab = useUIStore((s) => s.bottomTab)
  const setWorkspaceTab = useUIStore((s) => s.setWorkspaceTab)

  return (
    <main className="flex-1 flex flex-col overflow-hidden">
      {/* Tab bar */}
      <div className="flex border-b border-gray-300 dark:border-neutral-700 bg-gray-200 dark:bg-neutral-800 flex-shrink-0">
        {WORKSPACE_TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setWorkspaceTab(tab.id)}
            className={[
              'px-4 py-1.5 text-body border-r border-gray-300 dark:border-neutral-700 transition-colors',
              workspaceTab === tab.id
                ? 'bg-gray-50 dark:bg-neutral-900 text-gray-900 dark:text-neutral-100 border-b-2 border-b-blue-500 -mb-px'
                : 'text-gray-600 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200 hover:bg-gray-300 dark:hover:bg-neutral-800',
            ].join(' ')}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content area (flex-col: canvas takes remaining space, viewer is fixed-height below) */}
      <div className="flex-1 flex flex-col overflow-hidden bg-gray-50 dark:bg-neutral-900">
        {/* Canvas + overlays */}
        <div className="flex-1 relative overflow-hidden">
          {workspaceTab === '2d' && (
            <Suspense fallback={<div className="w-full h-full flex items-center justify-center text-gray-600 dark:text-neutral-400 text-sm">Loading canvas…</div>}>
              <CanvasStage />
            </Suspense>
          )}

          {workspaceTab === '3d' && (
            <Suspense fallback={<div className="w-full h-full flex items-center justify-center text-gray-600 dark:text-neutral-400 text-sm">Loading 3D view…</div>}>
              <ThreeView />
            </Suspense>
          )}
          {workspaceTab === 'tools' && <ToolLibraryPanel />}
          {workspaceTab === 'postprocessor' && <PostProcessorPanel />}
        </div>

        {workspaceTab === '2d' && (
          <Suspense fallback={null}>
            {bottomTab === 'operations' ? <OperationsPanel /> : <TimelinePanel />}
          </Suspense>
        )}
      </div>
    </main>
  )
}

function useKeyboardShortcuts() {
  // No store subscriptions: the handler reads getState() at keypress time, so
  // App no longer re-renders its whole subtree on every path edit / selection
  // change / history push (bugs.md H5).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const inInput =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      if (inInput && !e.ctrlKey && !e.metaKey) return

      const mod = e.ctrlKey || e.metaKey

      if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); void triggerProjectSave(); return }
      if (mod && e.key === 'o') { e.preventDefault(); void openProjectFile(); return }
      if (mod && e.key === 'n') { e.preventDefault(); newProject(); return }

      if (inInput) return

      if (mod && e.key === 'z') {
        e.preventDefault()
        // Local (node-edit/pen/drill) undo only while it has something to undo;
        // otherwise fall through to timeline undo — e.g. a cross-path join clears
        // the local stack and is undone via the timeline event it wrote.
        const { nodeEditUndo, nodeEditCanUndo } = useUIStore.getState()
        if (nodeEditUndo && nodeEditCanUndo) { nodeEditUndo(); return }
        useTimelineStore.getState().undo()
        return
      }
      if (mod && (e.key === 'y' || e.key === 'Z')) {
        e.preventDefault()
        const { nodeEditRedo, nodeEditCanRedo } = useUIStore.getState()
        if (nodeEditRedo && nodeEditCanRedo) { nodeEditRedo(); return }
        useTimelineStore.getState().redo()
        return
      }
      if (mod && e.key === 'd') { e.preventDefault(); usePathsStore.getState().duplicateSelected(); return }
      // Group / Ungroup. Shift+G arrives as 'G' on most layouts, so both are tested.
      if (mod && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault()
        const ps = usePathsStore.getState()
        if (e.shiftKey) ps.ungroupSelected(); else ps.groupSelected()
        return
      }

      // EVERYTHING BELOW IS A BARE LETTER, so a held modifier disqualifies it.
      // Without this line the single-key tool shortcuts also fired for the
      // browser's own chords: Ctrl+C / Cmd+C copied the selection AND toggled
      // the Constrain tool on the way past.
      if (mod) return

      if (e.code === 'Space') {
        const sim = useSimStore.getState()
        if (sim.gcode) { e.preventDefault(); sim.playing ? sim.pause() : sim.play(); return }
      }
      if (e.key === 's' || e.key === 'S') { useUIStore.getState().toggleSnap(); return }
      // C enters (and leaves) the Constrain tool. Escape also leaves it, so this
      // is the shortcut for turning it ON without the toolbar.
      if (e.key === 'c' || e.key === 'C') {
        const ui = useUIStore.getState()
        ui.setActiveTool(ui.activeTool === 'constrain' ? 'select' : 'constrain')
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!useUIStore.getState().nodeEditPathId) usePathsStore.getState().deleteSelected()
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

function useSurfaceWorkpieceSync() {
  useEffect(() => {
    return useWorkpieceStore.subscribe((state, prev) => {
      if (
        state.widthMM === prev.widthMM &&
        state.heightMM === prev.heightMM &&
        state.origin === prev.origin
      ) return
      for (const op of useToolpathStore.getState().operations) {
        if (op.type === 'surface') regenerateOperation(op.id)
      }
    })
  }, [])
}

// While the simulator is up, keep it in step with the program — see sim/simAutoReload.ts.
function useSimAutoReload() {
  useEffect(() => installSimAutoReload(), [])
}

// Ctrl+C / Ctrl+V on the document, carrying paths as the app's own objects so a
// gear pasted into another project is still a gear — see io/pathClipboard.ts.
function usePathClipboard() {
  useEffect(() => installPathClipboard(), [])
}

// Crash / tab-discard recovery — see io/autosave.ts for why this exists.
//
// UNSAVED WORK IS PUT BACK, NEVER OFFERED BACK. This asked first, in a modal, and
// the question had only one answer: the snapshot exists because the session
// ended without the user's say-so, so the choice on the table was between their
// own work and an empty screen. A dialog in front of that is a step to get past,
// not a decision — and the way to an empty screen was never the dialog anyway,
// it is New Project, which is one keystroke and undoable.
//
// Order still matters: installAutosave() subscribes immediately but writes
// nothing until armed, and arming waits on the boot-time read. Otherwise the
// empty document this mounts over would overwrite the snapshot before it is
// read back.
function useAutosave() {
  useEffect(() => {
    const dispose = installAutosave()
    void (async () => {
      const snap = await readSnapshot()
      // A snapshot of a document that WAS saved is just a stale mirror of a file
      // on disk: it is on disk under its own name, so it is dropped rather than
      // reopened behind the user's back.
      if (snap && snap.dirty && (snap.pathCount > 0 || snap.opCount > 0)) {
        const ok = applySnapshot(snap)
        // SAID OUT LOUD, because the one thing a silent restore could hide is
        // that this document is not saved anywhere. The wording separates the
        // two ways a session ends: a discard is the browser's doing and worth
        // naming, anything else the user may have half-expected.
        useUIStore.getState().showStatus(
          ok
            ? `Restored ${snap.name} — unsaved work from ${tabWasDiscarded()
                ? 'before the browser put this tab to sleep'
                : 'your last session'}. Ctrl+N for an empty project.`
            : 'Could not restore the last session — the backup was unreadable.',
          ok ? 'info' : 'error',
        )
      } else if (snap) {
        await clearSnapshot()
      }
      armAutosave()
      // Last, and unawaited: the records of tabs that closed weeks ago are
      // landfill, and clearing them must never delay the project appearing.
      void pruneSnapshots()
    })()
    return dispose
  }, [])
}

function useDarkMode() {
  const darkMode = useUIStore((s) => s.darkMode)
  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode)
  }, [darkMode])
}

export default function App() {
  useKeyboardShortcuts()
  useSurfaceWorkpieceSync()
  useSimAutoReload()
  usePathClipboard()
  useAutosave()
  useDarkMode()
  const activeTool = useUIStore(s => s.activeTool)
  useEffect(() => {
    if (activeTool === 'text') preloadFonts()
    // A gear carries its tooth count in the single-stroke face, so fetch just
    // that one when the gear tool is picked — it is needed before the first gear
    // is drawn, not after.
    if (activeTool === 'gear') loadFont(SINGLE_LINE_FONT_FAMILY)
  }, [activeTool])
  return (
    <div className="h-screen w-screen flex flex-col bg-gray-50 dark:bg-neutral-900 text-gray-900 dark:text-neutral-100 overflow-hidden">
      <Toolbar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <MainWorkspace />
      </div>
      <StatusBar />
      <SaveDialog />
      {/* Floats over everything and takes no focus — it is a readout being
          watched while a spinner is held down, not a dialog. */}
      <EscapementInfoPanel />
      <ClockInfoPanel />
    </div>
  )
}
