import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DEFAULT_SHAPE_CONFIG, type ShapeToolConfig, type ShapeType } from '../shapes/shapeGenerators'
import type { PenCurveType } from '../cam/penCurves'
import type { ClockSpec } from '../shapes/clockTrain'


export type SidebarTab = 'draw' | 'paths'
type StatusKind = 'info' | 'warn' | 'error'

// Transient message shown in the StatusBar (import failures, sim warnings, …).
// `seq` bumps on every showStatus so an identical repeated message still
// restarts the auto-dismiss timer.
interface StatusMessage {
  text: string
  kind: StatusKind
  seq: number
}
export type WorkspaceTab = '2d' | '3d' | 'tools' | 'postprocessor'
// 'constrain' is the Constrain tool: click a point on one part, then a point on
// another, and the constraint holding them where they stand is created — see
// canvas/layers/ConstraintPickLayer.tsx.
type ActiveTool = 'select' | 'drill' | 'pen' | 'constrain' | ShapeType

export type PenNode = {
  x: number
  y: number
  outHandle?: { x: number; y: number }
  inHandle?: { x: number; y: number }
  corner?: boolean
}

interface UIState {
  sidebarTab: SidebarTab
  workspaceTab: WorkspaceTab
  snapEnabled: boolean
  activeTool: ActiveTool
  /** How the Constrain tool states a new constraint. Remembered across uses,
   *  like `shapeToolConfig` — the mode is a working preference, not a per-
   *  constraint decision, and an individual one can still be switched later. */
  constrainMode: 'polar' | 'xy'
  /** The constraint just created, so its first field takes the keyboard — the
   *  whole point of the tool is that a number can be typed without reaching for
   *  the sidebar. Cleared once that field has claimed focus. */
  focusConstraintId: string | null
  /**
   * WHAT WAS SELECTED WHEN THE CONSTRAIN TOOL WAS ENTERED.
   *
   * Entering the tool clears the selection — a selected part carries resize
   * handles that swallow the very clicks the tool needs — and that took the
   * panel's rows with it: pick the part whose constraints you are about to edit,
   * press the button, and the list you were looking at empties. The subject
   * outlives the selection so the section goes on answering the same question.
   * Emptied when the tool is left.
   */
  constrainSubjectIds: string[]
  shapeToolConfig: ShapeToolConfig
  lastShapeType: ShapeType
  pendingDrillPoints: { x: number; y: number }[]
  penNodes: PenNode[]
  penCurveType: PenCurveType
  nodeEditPathId: string | null
  // While non-null, the shape whose path this is runs IN MESH in the canvas: its
  // mate is moved onto the true centre distance and the pair animated, so the
  // question a drawing cannot answer — do they actually run together — can be
  // watched. An escapement runs against its anchor and a gear against its mate
  // (a second gear, or the lantern a cycloidal wheel was cut for); one field
  // rather than one per shape, because only one can run at a time and the
  // canvas has to hide exactly one group. Each layer takes the ones it knows and
  // ignores the rest. The group's own paths are hidden meanwhile, or a static
  // copy would sit under the turning one. Nothing is written to the document.
  meshAnimPathId: string | null
  // The whole-clock preview (canvas/layers/ClockAnimLayer). Its own field rather
  // than another meshAnimPathId user: that one names ONE group to stand aside,
  // and a clock is five. Only one animation runs at a time, so the two setters
  // clear each other.
  clockAnimPathId: string | null
  // While non-null, the clock this path belongs to is being ARRANGED: the going
  // train is drawn as a 4-bar chain rooted at the escapement, and dragging a
  // joint sets that link's angle. The link LENGTHS are the centre distances and
  // are not negotiable, so the angles are the whole of what a user may change.
  clockLinkPathId: string | null
  // Corner-pick mode for the Corner Treatment form: while non-null, treatable
  // corners render as clickable markers; selectedCorners holds the node indices
  // the treatment applies to (empty = all corners). Markers come from
  // cornerPickBaseD — a snapshot of the path taken when the session started —
  // so corners stay pickable after a treatment replaces their geometry;
  // treatedCorners marks which of them currently carry a treatment.
  cornerPickPathId: string | null
  cornerPickBaseD: string | null
  selectedCorners: number[]
  treatedCorners: number[]
  darkMode: boolean
  machineFormActive: boolean
  tabsFormActive: boolean
  shapesPanelOpen: boolean
  // The clock designer (panels/draw/ClockPanel). Its own flag rather than an
  // activeTool, because a clock is not one shape placed by a click — it works
  // out a whole train and emits five independent shapes, one chip each.
  clockPanelOpen: boolean
  // Which clock the designer is EDITING, or null for a fresh one. Set by a
  // clock chip click; the panel then rewrites that clock's parts in place
  // rather than emitting a second clock.
  clockEditId: string | null
  setupPanelOpen: boolean
  helpOpen: boolean
  // The escapement's readout, in a window big enough to read it. Non-modal and
  // live: it follows whichever escapement the panels are editing and stays up
  // until it is closed, which is the point — the numbers are what a parameter is
  // being stepped against, so they have to be legible WHILE it is stepped.
  escapementInfoOpen: boolean
  // The clock readout window, and the spec it reads. Unlike the escapement's —
  // which finds its subject in the selection or the shape-tool config, both of
  // them store state — a clock being designed lives in ClockPanel's own form
  // state, so the panel publishes it here for the window to follow live.
  clockInfoOpen: boolean
  clockDraft: ClockSpec | null
  timelineOpen: boolean
  // Which strip the bottom bar shows: history (timeline) or the ordered program
  // (operations). They are different orderings of different things — see OperationsPanel.
  bottomTab: 'timeline' | 'operations'
  // Ask MachinePanel to open an operation's edit form (set by TimelinePanel
  // when an op chip is clicked, consumed + cleared by MachinePanel).
  requestEditOpId: string | null
  // Ask MachinePanel to open a generator form (boolean/offset/pattern) in edit
  // mode for a GENERATED PATH — the object carries the parameters (see
  // ImportedPath.definition), so the form is opened on the thing rather than on
  // the event that once made it.
  requestEditPathId: string | null
  // Ask MachinePanel to open a specific form (timeline tabs/corner chips —
  // those forms edit the current selection, which the chip click sets).
  requestMachineForm: string | null
  // Bumped when a path chip is clicked so PropertiesPanel briefly highlights —
  // it's the editor for the chip's shape/text parameters.
  propertiesFlashSeq: number
  // Set by a timeline chip click for a move/scale/rotate/skew/mirror (or
  // merged 'transform') paths.edit event: PropertiesPanel shows that event's
  // recorded TransformStep values (editable) instead of the selection's
  // plain shape/position fields. PropertiesPanel itself clears this back to
  // null once the timeline cursor or selection no longer matches the event
  // (scrubbing away, selecting something else, recording a new edit).
  // Local undo/redo for point-edit sessions — registered by CanvasStage, used by Toolbar + App
  nodeEditUndo: (() => void) | null
  nodeEditRedo: (() => void) | null
  nodeEditCanUndo: boolean
  nodeEditCanRedo: boolean
  statusMessage: StatusMessage | null
  showStatus: (text: string, kind?: StatusKind) => void
  clearStatus: () => void
  // DXF file waiting on the units-prompt dialog (no $INSUNITS in the file).
  // Lives here so both import entry points (toolbar button, canvas drop) can
  // trigger the dialog; DxfUnitsDialog renders when non-null.
  pendingDxfImport: { text: string; name: string } | null
  setPendingDxfImport: (p: { text: string; name: string } | null) => void
  setMachineFormActive: (active: boolean) => void
  setTabsFormActive: (active: boolean) => void
  setShapesPanelOpen: (open: boolean) => void
  setClockPanelOpen: (open: boolean) => void
  setClockEdit: (clockId: string | null) => void
  setSetupPanelOpen: (open: boolean) => void
  // Close every draw-tab panel, leaving the properties panel for the selection.
  // The four booleans below are really ONE mode — ClockPanel overrides the whole
  // draw tab and suppresses the properties panel (see Sidebar's TabContent) — so
  // a caller switching to "just show me what is selected" has to clear all of
  // them. Doing that by hand is how the clock panel got left open: clicking the
  // clock chip opened it, and clicking any other chip closed setup and shapes
  // but not clock, so the sidebar went on showing the designer and neither the
  // properties panel nor a machine form could appear.
  closeDrawPanels: () => void
  setHelpOpen: (open: boolean) => void
  setEscapementInfoOpen: (open: boolean) => void
  setClockInfoOpen: (open: boolean) => void
  setClockDraft: (spec: ClockSpec | null) => void
  setTimelineOpen: (open: boolean) => void
  setBottomTab: (tab: 'timeline' | 'operations') => void
  setRequestEditOpId: (id: string | null) => void
  setRequestEditPathId: (id: string | null) => void
  setRequestMachineForm: (form: string | null) => void
  flashProperties: () => void
  setSidebarTab: (tab: SidebarTab) => void
  setWorkspaceTab: (tab: WorkspaceTab) => void
  toggleSnap: () => void
  setSnap: (enabled: boolean) => void
  setActiveTool: (tool: ActiveTool) => void
  setConstrainMode: (mode: 'polar' | 'xy') => void
  setFocusConstraint: (id: string | null) => void
  setConstrainSubject: (ids: string[]) => void
  setShapeToolConfig: (config: ShapeToolConfig) => void
  // Drag out a shape from its CENTRE rather than corner-to-corner, and the
  // DEFAULT for the `fromCenter` each shape drawn from here is stamped with. A
  // tool mode rather than per-shape config: it changes what a drag MEANS, and it
  // means the same thing for every shape — so it is shown with the active shape
  // tool's own defaults, never on its own when no shape tool is in use.
  // Persisted, like the other drawing preferences — someone laying out
  // concentric work wants it to still be on tomorrow.
  shapeFromCenter: boolean
  setShapeFromCenter: (v: boolean) => void
  setLastShapeType: (type: ShapeType) => void
  addDrillPoint: (pt: { x: number; y: number }) => void
  setDrillPoints: (pts: { x: number; y: number }[]) => void
  clearDrillPoints: () => void
  setPenCurveType: (type: PenCurveType) => void
  addPenNode: (node: PenNode) => void
  setPenNodes: (nodes: PenNode[]) => void
  clearPenNodes: () => void
  setNodeEditPathId: (id: string | null) => void
  setMeshAnim: (id: string | null) => void
  setClockAnim: (id: string | null) => void
  setClockLink: (id: string | null) => void
  setCornerPickSession: (id: string | null, baseD: string | null) => void
  setTreatedCorners: (idxs: number[]) => void
  toggleCorner: (idx: number) => void
  clearSelectedCorners: () => void
  toggleDarkMode: () => void
  setNodeEditUndoRedo: (undo: (() => void) | null, redo: (() => void) | null) => void
  setNodeEditHistoryFlags: (canUndo: boolean, canRedo: boolean) => void
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
  sidebarTab: 'draw',
  workspaceTab: '2d',
  snapEnabled: true,
  activeTool: 'select',
  constrainMode: 'xy',
  focusConstraintId: null,
  constrainSubjectIds: [],
  shapeToolConfig: DEFAULT_SHAPE_CONFIG,
  lastShapeType: 'rectangle',
  pendingDrillPoints: [],
  penNodes: [],
  penCurveType: 'catmull-rom',
  nodeEditPathId: null,
  cornerPickPathId: null,
  cornerPickBaseD: null,
  selectedCorners: [],
  treatedCorners: [],
  darkMode: true,
  machineFormActive: false,
  tabsFormActive: false,
  shapesPanelOpen: false,
  clockPanelOpen: false,
  clockEditId: null,
  setupPanelOpen: false,
  meshAnimPathId: null,
  clockAnimPathId: null,
  clockLinkPathId: null,
  helpOpen: false,
  escapementInfoOpen: false,
  clockInfoOpen: false,
  clockDraft: null,
  timelineOpen: true,
  bottomTab: 'timeline' as const,
  requestEditOpId: null,
  requestEditPathId: null,
  requestMachineForm: null,
  propertiesFlashSeq: 0,
  nodeEditUndo: null,
  nodeEditRedo: null,
  nodeEditCanUndo: false,
  nodeEditCanRedo: false,
  statusMessage: null,
  showStatus: (text, kind = 'info') =>
    set((s) => ({ statusMessage: { text, kind, seq: (s.statusMessage?.seq ?? 0) + 1 } })),
  clearStatus: () => set({ statusMessage: null }),
  pendingDxfImport: null,
  setPendingDxfImport: (p) => set({ pendingDxfImport: p }),
  setMachineFormActive: (active) => set({ machineFormActive: active }),
  setTabsFormActive: (active) => set({ tabsFormActive: active }),
  setShapesPanelOpen: (open) => set({ shapesPanelOpen: open }),
  // Closing the designer always drops the edit target, so the next time it is
  // opened from the shapes grid it starts a NEW clock rather than silently
  // rewriting the last one.
  setClockPanelOpen: (open) => set({ clockPanelOpen: open, ...(open ? {} : { clockEditId: null }) }),
  setClockEdit: (clockId) => set({ clockEditId: clockId }),
  setSetupPanelOpen: (open) => set({ setupPanelOpen: open }),
  closeDrawPanels: () => set({
    setupPanelOpen: false, shapesPanelOpen: false, machineFormActive: false,
    clockPanelOpen: false, clockEditId: null,
    clockInfoOpen: false, clockDraft: null,
  }),
  setHelpOpen: (open) => set({ helpOpen: open }),
  setEscapementInfoOpen: (open) => set({ escapementInfoOpen: open }),
  setClockInfoOpen: (open) => set({ clockInfoOpen: open }),
  setClockDraft: (spec) => set({ clockDraft: spec }),
  setTimelineOpen: (open) => set({ timelineOpen: open }),
  setBottomTab: (tab) => set({ bottomTab: tab }),
  setRequestEditOpId: (id) => set({ requestEditOpId: id }),
  setRequestEditPathId: (id) => set({ requestEditPathId: id }),
  setRequestMachineForm: (form) => set({ requestMachineForm: form }),
  flashProperties: () => set((s) => ({ propertiesFlashSeq: s.propertiesFlashSeq + 1 })),
  setSidebarTab: (tab) => set({ sidebarTab: tab, activeTool: 'select' }),
  setWorkspaceTab: (tab) => set({ workspaceTab: tab }),
  toggleSnap: () => set((s) => ({ snapEnabled: !s.snapEnabled })),
  setSnap: (enabled) => set({ snapEnabled: enabled }),
  setActiveTool: (tool) => set({ activeTool: tool, nodeEditPathId: null }),
  setConstrainMode: (mode) => set({ constrainMode: mode }),
  setFocusConstraint: (id) => set({ focusConstraintId: id }),
  setConstrainSubject: (ids) => set({ constrainSubjectIds: ids }),
  setShapeToolConfig: (config) => set({ shapeToolConfig: config }),
  setMeshAnim: (id) => set({ meshAnimPathId: id, clockAnimPathId: null, clockLinkPathId: null }),
  setClockAnim: (id) => set({ clockAnimPathId: id, meshAnimPathId: null, clockLinkPathId: null }),
  setClockLink: (id) => set({ clockLinkPathId: id, meshAnimPathId: null, clockAnimPathId: null }),
  shapeFromCenter: false,
  setShapeFromCenter: (v) => set({ shapeFromCenter: v }),
  setLastShapeType: (type) => set({ lastShapeType: type }),
  addDrillPoint: (pt) => set((s) => ({ pendingDrillPoints: [...s.pendingDrillPoints, pt] })),
  setDrillPoints: (pts) => set({ pendingDrillPoints: pts }),
  clearDrillPoints: () => set({ pendingDrillPoints: [] }),
  setPenCurveType: (type) => set({ penCurveType: type }),
  addPenNode: (node) => set((s) => ({ penNodes: [...s.penNodes, node] })),
  setPenNodes: (nodes) => set({ penNodes: nodes }),
  clearPenNodes: () => set({ penNodes: [] }),
  setNodeEditPathId: (id) => set({ nodeEditPathId: id }),
  setCornerPickSession: (id, baseD) =>
    set({ cornerPickPathId: id, cornerPickBaseD: baseD, selectedCorners: [], treatedCorners: [] }),
  setTreatedCorners: (idxs) => set({ treatedCorners: idxs }),
  toggleCorner: (idx) =>
    set((s) => ({
      selectedCorners: s.selectedCorners.includes(idx)
        ? s.selectedCorners.filter((i) => i !== idx)
        : [...s.selectedCorners, idx],
    })),
  clearSelectedCorners: () => set({ selectedCorners: [] }),
  toggleDarkMode: () => set((s) => ({ darkMode: !s.darkMode })),
  setNodeEditUndoRedo: (undo, redo) => set({ nodeEditUndo: undo, nodeEditRedo: redo, nodeEditCanUndo: false, nodeEditCanRedo: false }),
  setNodeEditHistoryFlags: (canUndo, canRedo) => set({ nodeEditCanUndo: canUndo, nodeEditCanRedo: canRedo }),
    }),
    {
      name: 'freazykam-ui',
      // Deliberate whitelist — most of this store is session state, and some of it is
      // functions (the node-edit undo/redo callbacks) that must not be serialised.
      // A preference the user sets explicitly belongs here; darkMode was missing, so
      // every reload snapped back to the `darkMode: true` default.
      partialize: (s) => ({ penCurveType: s.penCurveType, lastShapeType: s.lastShapeType, timelineOpen: s.timelineOpen, bottomTab: s.bottomTab, darkMode: s.darkMode, shapeFromCenter: s.shapeFromCenter }),
    }
  )
)
