import { useEffect, useState } from 'react'
import { BookOpen, Keyboard, X } from 'lucide-react'
import { ICON } from '../theme'
import { useUIStore } from '../store/uiStore'
import { HELP_HOME, helpUrl } from './helpTopics'

// "WHAT'S THIS?" HELP MODE. The toolbar's ? button (or the ? key) turns it on; the next
// click on any control opens that control's help page in a new tab, instead of doing what
// the control does, and the mode ends. Every page opens in the SAME help tab (openHelp). Esc leaves without opening anything.
//
// A CLICK, NOT A GESTURE OF ITS OWN, because a click is the one input every platform has:
// right-click is absent on touch (iPad Safari fires no contextmenu at all), hover is absent
// on touch, and F1 is the brightness key on a Mac. The cost is two clicks instead of one.
//
// Controls say what they are with `data-help` (helpAttr, helpTopics.ts); a click finds the
// NEAREST one, so a whole panel can be tagged and a button inside it tagged more precisely.
// While the mode is on, every pointer event is swallowed in the CAPTURE phase at the window
// — ahead of React's root listener and of Konva — so nothing under the click acts on it.
// Only the mode's own controls (`data-help-ui`: the banner, the ? button) get through.

const INPUT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])
const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement && (INPUT_TAGS.has(t.tagName) || t.isContentEditable)

const helpTarget = (t: EventTarget | null): HTMLElement | null =>
  t instanceof Element ? (t.closest('[data-help]') as HTMLElement | null) : null
/** The help target under a pointer event. A DISABLED control (Undo with nothing to undo,
 *  Simulate with no toolpaths) gets no mouse events at all — the browser drops the click
 *  rather than send it to the button or anything round it — so in help mode they are made
 *  transparent to the pointer (index.css), the event lands on whatever is behind, and they
 *  are found here by their box instead. */
function helpAt(e: MouseEvent): HTMLElement | null {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-help]:disabled, [data-help] :disabled'))) {
    const r = el.getBoundingClientRect()
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
      return el.closest('[data-help]') as HTMLElement | null
    }
  }
  return helpTarget(e.target)
}

const isModeUi = (t: EventTarget | null): boolean =>
  t instanceof Element && !!t.closest('[data-help-ui]')

/** The box to outline for an element. A `display: contents` wrapper has none of its own,
 *  so it is the union of its children's. */
function boxOf(el: HTMLElement): DOMRect | null {
  const r = el.getBoundingClientRect()
  if (r.width > 0 || r.height > 0) return r
  let l = Infinity, t = Infinity, rt = -Infinity, b = -Infinity
  for (const c of Array.from(el.children)) {
    const cr = c.getBoundingClientRect()
    if (cr.width === 0 && cr.height === 0) continue
    l = Math.min(l, cr.left); t = Math.min(t, cr.top); rt = Math.max(rt, cr.right); b = Math.max(b, cr.bottom)
  }
  return l < rt ? new DOMRect(l, t, rt - l, b - t) : null
}

// ONE HELP TAB, REUSED. A named target navigates the tab it named before rather than
// opening another, so a session of help clicks leaves one tab, not twenty. No 'noopener':
// with it the browser ignores the name and always opens a new tab — and the help pages
// are this site's own, so the opener link they get is nothing to guard against. focus()
// brings the tab forward when it is already open behind the app (a reused tab is not
// brought forward by the navigation alone).
const HELP_TAB = 'freazykam-help'
function openHelp(url: string) {
  const tab = window.open(url, HELP_TAB)
  tab?.focus()
}

export function HelpMode() {
  const on = useUIStore((s) => s.helpMode)
  const [hot, setHot] = useState<DOMRect | null>(null)

  // The ? key toggles the mode, and Esc leaves it — captured, so Esc does not also
  // deselect or cancel a canvas tool on its way out.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return
      const ui = useUIStore.getState()
      if (e.key === '?') { e.preventDefault(); ui.setHelpMode(!ui.helpMode); return }
      if (e.key === 'Escape' && ui.helpMode) { e.preventDefault(); e.stopImmediatePropagation(); ui.setHelpMode(false) }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  useEffect(() => {
    if (!on) { setHot(null); return }
    document.body.classList.add('help-mode')
    // Nothing a press starts may begin: no drag, no focus (preventDefault on the
    // press), no checkbox toggling or link following (on the click).
    const swallow = (e: Event) => {
      if (isModeUi(e.target)) return
      e.stopPropagation()
      e.stopImmediatePropagation()
      if (e.type === 'pointerdown' || e.type === 'mousedown' || e.type === 'contextmenu') e.preventDefault()
    }
    const onClick = (e: MouseEvent) => {
      if (isModeUi(e.target)) return
      e.stopPropagation()
      e.stopImmediatePropagation()
      e.preventDefault()
      const el = helpAt(e)
      const url = el && helpUrl(el.dataset.help ?? '')
      const ui = useUIStore.getState()
      if (!url) {
        ui.showStatus('No help page for that yet. Click a button or a panel, or press Esc to leave help mode.', 'info')
        return
      }
      openHelp(url)
      ui.setHelpMode(false)
    }
    const onOver = (e: PointerEvent) => {
      const el = isModeUi(e.target) ? null : helpAt(e)
      setHot(el ? boxOf(el) : null)
    }
    const kinds = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'contextmenu', 'touchstart', 'touchend'] as const
    for (const k of kinds) window.addEventListener(k, swallow, true)
    window.addEventListener('click', onClick, true)
    window.addEventListener('pointerover', onOver, true)
    return () => {
      document.body.classList.remove('help-mode')
      for (const k of kinds) window.removeEventListener(k, swallow, true)
      window.removeEventListener('click', onClick, true)
      window.removeEventListener('pointerover', onOver, true)
    }
  }, [on])

  if (!on || !hot) return null
  return (
    <div className="fixed pointer-events-none z-[1000] rounded border-2 border-blue-500 bg-blue-500/10"
      style={{ left: hot.left, top: hot.top, width: hot.width, height: hot.height }} />
  )
}

/** The help-mode tip. Rendered in the workspace (App), in the same spot as the canvas's own
 *  tips — the top centre of the view, under the view tabs — which CanvasHints gives up
 *  while help mode is on, so the two never stack. */
export function HelpModeBanner() {
  const on = useUIStore((s) => s.helpMode)
  if (!on) return null
  const leave = () => useUIStore.getState().setHelpMode(false)
  const btn = 'flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/15 hover:bg-white/25 transition-colors'
  return (
    <div data-help-ui
      className="absolute top-2 left-1/2 -translate-x-1/2 z-[1001] flex items-center gap-2 bg-blue-600 text-white text-body pl-3 pr-1 py-1 rounded-full shadow-lg whitespace-nowrap">
      <span>Help: click any button or panel to read about it</span>
      <button className={btn} onClick={() => { openHelp(HELP_HOME); leave() }}>
        <BookOpen size={ICON.sm} /> Help home
      </button>
      <button className={btn} onClick={() => { leave(); useUIStore.getState().setHelpOpen(true) }}>
        <Keyboard size={ICON.sm} /> Shortcuts
      </button>
      <button className={btn} onClick={leave} title="Leave help mode (Esc)">
        <X size={ICON.sm} /> Cancel
      </button>
    </div>
  )
}
