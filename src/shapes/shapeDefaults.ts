import type { ImportedPath } from '../importers/svgImporter'
import { usePathsStore } from '../store/pathsStore'
import { useUIStore } from '../store/uiStore'
import { defaultsFromParams, type ShapeParams } from './shapeGenerators'

/** THE SELECTED SHAPE IS THE DEFAULT FOR THE NEXT ONE OF ITS TYPE — whatever was
 *  last selected, drawn or edited. Drawing selects what it drew, and an edit
 *  (typed, resized, undone) changes the params of what is selected, so ONE rule
 *  covers all of them: whenever the selection is one shape, or its params
 *  change, its parameters are written back as the defaults. The Shape panel
 *  hides its "Next …" block while that shape is selected with its tool on, and
 *  can, because the two then say the same thing — one set of fields on screen.
 *
 *  The cost, accepted: selecting a shape for any other reason (to profile it, to
 *  move it) sets the defaults too, so defaults typed with nothing selected last
 *  until the next shape of that type is selected or drawn.
 *
 *  ONE shape only — a lone path or the parts of one multi-part shape; a mixed or
 *  multiple selection leaves the defaults alone. A clock part is skipped: its
 *  wheel's numbers come from the train, and clicking round a clock is not a
 *  statement about the next gear drawn by hand. `fromCenter` is the tool's mode,
 *  global rather than per type, so it follows only while the shape's own tool is
 *  on — the one time the defaults' own checkbox is hidden. */
export function selectedShapeOf(paths: ImportedPath[], selectedIds: string[]): ImportedPath | null {
  if (selectedIds.length === 0) return null
  const first = paths.find((p) => p.id === selectedIds[0])
  if (!first?.shapeParams) return null
  if (selectedIds.length === 1) return first
  if (!first.groupId) return null
  const ids = new Set(selectedIds)
  const sel = paths.filter((p) => ids.has(p.id))
  return sel.length === selectedIds.length && sel.every((p) => p.groupId === first.groupId && p.shapePart !== undefined)
    ? first : null
}

// HELD WHILE A SLIDER IS DRAGGED. A Properties slider rewrites the shape's params on
// every pixel (`updateLive`), and the defaults are persisted, so following along
// would write localStorage once a frame for figures nobody stopped at. The slider's
// pointerdown holds the sync and ANY pointerup or pointercancel in the window
// releases it — listened on the window, so a release off the slider still lands —
// then syncs once with what the drag ended on. A keyboard step has no pointerdown,
// is discrete, and syncs as it goes.
let held = false
let syncNow: (() => void) | null = null
export function holdShapeDefaults(): void {
  if (held) return
  held = true
  const release = () => {
    window.removeEventListener('pointerup', release)
    window.removeEventListener('pointercancel', release)
    held = false
    syncNow?.()
  }
  window.addEventListener('pointerup', release)
  window.addEventListener('pointercancel', release)
}

/** Keep the tool defaults following the selected shape (see above). Returns the unsubscribe. */
export function startShapeDefaultsSync(): () => void {
  let lastParams: ShapeParams | undefined
  let lastFromCenter: boolean | undefined
  let lastTool: string | undefined
  const sync = () => {
    if (held) return
    const { paths, selectedIds } = usePathsStore.getState()
    const shape = selectedShapeOf(paths, selectedIds)
    const ui = useUIStore.getState()
    if (!shape?.shapeParams || shape.clockId) { lastParams = undefined; return }
    const params = shape.shapeParams
    const fromCenter = !!shape.fromCenter
    if (params === lastParams && fromCenter === lastFromCenter && ui.activeTool === lastTool) return
    lastParams = params; lastFromCenter = fromCenter; lastTool = ui.activeTool
    const next = defaultsFromParams(ui.shapeToolConfig, params)
    if (JSON.stringify(next[params.type]) !== JSON.stringify(ui.shapeToolConfig[params.type])) ui.setShapeToolConfig(next)
    if (ui.activeTool === params.type && ui.shapeFromCenter !== fromCenter) ui.setShapeFromCenter(fromCenter)
  }
  const unPaths = usePathsStore.subscribe((s, prev) => {
    if (s.paths !== prev.paths || s.selectedIds !== prev.selectedIds) sync()
  })
  const unUI = useUIStore.subscribe((s, prev) => { if (s.activeTool !== prev.activeTool) sync() })
  syncNow = sync
  sync()
  return () => { unPaths(); unUI(); if (syncNow === sync) syncNow = null }
}
