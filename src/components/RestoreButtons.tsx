import { useState, type ReactNode } from 'react'
import { useUIStore } from '../store/uiStore'
import {
  planRestoreTools, applyToolReplace, planRestoreBuiltins, applyRestoreBuiltins,
  planRestoreMachine, applyRestoreMachine,
} from '../io/settingsFile'
import { DEFAULT_TOOLS } from '../store/toolStore'
import ConfirmSettingsDialog, { type ChangeGroup } from './ConfirmSettingsDialog'

// The three "back to how it came" buttons — Tool Library, post-processors, Setup's
// machine settings. Each plans its restore WHEN CLICKED, so the confirm describes the
// library as it is right then, and applies exactly that plan.

interface Props { className: string; title: string; children: ReactNode }

function useConfirm<P>(plan: () => P) {
  const [p, setP] = useState<P | null>(null)
  return { plan: p, open: () => setP(plan()), close: () => setP(null) }
}

export function RestoreToolsButton({ className, title, children }: Props) {
  const c = useConfirm(planRestoreTools)
  const p = c.plan
  const groups: ChangeGroup[] = p ? [
    { heading: `Removed from My Tools (${p.removed.length})`, items: p.removed, tone: 'remove' },
    { heading: `Default tools put back (${p.added.length})`, items: p.added, tone: 'change' },
    { heading: `Kept — the open project cuts with ${p.kept.length === 1 ? 'it' : 'them'} (${p.kept.length})`, items: p.kept, tone: 'keep' },
  ] : []
  return (<>
    <button className={className} title={title} onClick={c.open}>{children}</button>
    {p && (
      <ConfirmSettingsDialog title={`Restore the ${DEFAULT_TOOLS.length} default tools?`} groups={groups} confirmLabel="Restore defaults"
        intro="My Tools will be replaced by the tools FreazyKam comes with. Imported folders are not touched."
        onClose={c.close}
        onConfirm={() => {
          applyToolReplace(p)
          useUIStore.getState().showStatus(`Default tools restored${p.kept.length ? ` — ${p.kept.length} the project uses kept` : ''}.`, 'info')
        }} />
    )}
  </>)
}

export function RestoreBuiltinsButton({ className, title, children }: Props) {
  const c = useConfirm(planRestoreBuiltins)
  const p = c.plan
  return (<>
    <button className={className} title={title} onClick={c.open}>{children}</button>
    {p && (
      <ConfirmSettingsDialog title="Restore the built-in post-processors?" confirmLabel="Restore built-ins"
        intro="Every built-in profile goes back to its factory settings. Your own profiles are not touched."
        groups={[
          { heading: `Reset to factory — your edits to ${p.reset.length === 1 ? 'it' : 'these'} are lost (${p.reset.length})`, items: p.reset, tone: 'remove' },
          { heading: `Brought back — you had deleted ${p.returned.length === 1 ? 'it' : 'these'} (${p.returned.length})`, items: p.returned, tone: 'change' },
          { heading: `Your own, kept as they are (${p.keptOwn.length})`, items: p.keptOwn, tone: 'keep' },
        ]}
        onClose={c.close}
        onConfirm={() => {
          applyRestoreBuiltins(p)
          useUIStore.getState().showStatus('Built-in post-processors restored.', 'info')
        }} />
    )}
  </>)
}

export function RestoreMachineButton({ className, title, children }: Props) {
  const c = useConfirm(planRestoreMachine)
  const p = c.plan
  return (<>
    <button className={className} title={title} onClick={c.open}>{children}</button>
    {p && (
      <ConfirmSettingsDialog title="Restore the default machine settings?" confirmLabel="Restore defaults"
        intro="Machine limits, feeds & speeds, motion and spindle go back to their defaults. The stock, your tools and your post-processors are not touched."
        groups={[{ heading: `These change (${p.length})`, items: p, tone: 'change' }]}
        onClose={c.close}
        onConfirm={() => {
          applyRestoreMachine()
          useUIStore.getState().showStatus('Default machine settings restored.', 'info')
        }} />
    )}
  </>)
}
