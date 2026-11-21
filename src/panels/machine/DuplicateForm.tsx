// ─── Duplicate form ──────────────────────────────────────────────────────────
import { useEffect } from 'react'
import { AlertCircle } from 'lucide-react'
import { FormShell, PathChip, PathListSection, GenerateBtn } from './shared'
import { ICON } from '../../theme'
import { useSelectedPathsInOrder } from '../../store/pathsStore'
import { useUIStore } from '../../store/uiStore'

// THE STAMP (Ctrl/⌘+D) as a Path Tools form, so it is found and explained the way every
// other tool is: always enabled, and with nothing selected it says what to do rather than
// sitting greyed out. The work is the canvas tool (canvas/useStampTool) — copies of the
// selection follow the mouse and each click places one — and this form is its front door
// and its off switch.
//
// Opened WITH a selection it starts stamping at once, the same as the shortcut: the panel
// is there to explain, not to add a click. Closing the form ends the stamp; Esc ends the
// stamp and leaves the form, whose button then starts it again.
export function DuplicateForm({ onClose }: { onClose: () => void }) {
  const selPaths = useSelectedPathsInOrder()
  const stamping = useUIStore((s) => s.activeTool === 'stamp')
  const count = useUIStore((s) => (s.activeTool === 'stamp' ? s.stampIds.length : 0))

  useEffect(() => {
    const ids = selPaths.map((p) => p.id)
    if (ids.length > 0) useUIStore.getState().toggleStamp(ids)
    return () => { if (useUIStore.getState().activeTool === 'stamp') useUIStore.getState().setActiveTool('select') }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = () => useUIStore.getState().toggleStamp(selPaths.map((p) => p.id))

  return (
    <FormShell title="Duplicate" onClose={onClose}>
      <p className="text-body text-gray-600 dark:text-neutral-400">
        Copies of the selected paths follow the mouse. Click on the canvas to place each copy —
        it snaps to the edges and corners of other parts, so copies can be butted together.
        Press Esc to finish. Shortcut: Ctrl/⌘+D.
      </p>
      {!stamping && selPaths.length === 0 && (
        <p className="text-body text-amber-600 dark:text-amber-400 flex items-center gap-1">
          <AlertCircle size={ICON.sm} /> Select one or more paths to duplicate
        </p>
      )}
      {stamping && (
        <p className="text-body text-blue-600 dark:text-blue-400">
          Placing copies of {count} path{count === 1 ? '' : 's'} — click the canvas, Esc to finish
        </p>
      )}
      <GenerateBtn
        disabled={!stamping && selPaths.length === 0}
        generating={false}
        onClick={toggle}
        label={stamping ? 'Stop Duplicating' : 'Start Duplicating'}
      />
      {!stamping && (
        <PathListSection count={selPaths.length} toggle>
          {selPaths.map((p) => <PathChip key={p.id} path={p} />)}
        </PathListSection>
      )}
    </FormShell>
  )
}
