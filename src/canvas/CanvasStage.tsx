import { ptSegDistSq, pointInPolygon } from '../cam/geom'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRefState } from './useRefState'
import { pushLocalHistory } from './localHistory'
import { useNodeEditSession, collectCrossPathEntries, refineCrossEntry, type CrossPathView } from './useNodeEditSession'
import { usePenTool } from './usePenTool'
import { ICON } from '../theme'
import { Stage, Layer, Group, Circle } from 'react-konva'
import type Konva from 'konva'
import { Maximize2, ZoomIn, ZoomOut } from 'lucide-react'
import { useWorkpieceStore } from '../store/workpieceStore'
import { useCanvasStore } from '../store/canvasStore'
import { usePathsStore, clockSpecOf, setClockSpec, useSelectedPaths, expandUserGroups } from '../store/pathsStore'
import { regenerateAffected, regenerateAffectedMany } from '../cam/regenerate'
import { flattenPath, signedArea } from '../cam/pathFlattener'
import type { ImportedPath, PathUpdate } from '../store/pathsStore'
import type { PathEditGesture } from '../timeline/events'
import { useUIStore } from '../store/uiStore'
import { nextPathColor } from '../importers/svgImporter'
import { importFile } from '../io/importFile'
import { GridLayer } from './layers/GridLayer'
import { WorkpieceLayer, originWorldXY } from './layers/WorkpieceLayer'
import { majorStepMM, minorStepMM } from './gridUtils'
import { OriginLayer } from './layers/OriginLayer'
import { DesignLayer } from './layers/DesignLayer'
import { ToolpathLayer } from './layers/ToolpathLayer'
import { SelectionLayer, SelectionHandleLayer } from './layers/SelectionLayer'
import { ConstraintLayer } from './layers/ConstraintLayer'
import { useConstraintsStore } from '../store/constraintsStore'
import {
  planConstraints, runPlan, allAnchorCandidates, nearestCandidate, measureBetween, bodyKeyOf,
  bodyPathsOf, constraintFrame,
  type ConstraintPlan, type AnchorCandidate,
} from '../store/constraints'
import { ConstraintPickLayer } from './layers/ConstraintPickLayer'
import { SnapGuideLayer, type SnapGuides } from './layers/SnapGuideLayer'
import { collectSnapTargets, snapAxisDelta, nudgeStopDelta, nextStepPoint, type SnapTargets } from './objectSnap'
import { ShapePreviewLayer } from './layers/ShapePreviewLayer'
import { createRegionFinder, regionToD, type RegionFinder } from '../cam/regionPick'
import { EscapementAnimLayer } from './layers/EscapementAnimLayer'
import { GearAnimLayer } from './layers/GearAnimLayer'
import { ClockAnimLayer } from './layers/ClockAnimLayer'
import { ClockLinkageLayer } from './layers/ClockLinkageLayer'
import { clockAssemblyFromPaths, clockMotionFromPaths, clockPlate, clockRoot, defaultLinkAngles, dragLinkAngle, linkAngleAt } from '../shapes/clockTrain'
import { CornerPickLayer } from './layers/CornerPickLayer'
import { PenLayer } from './layers/PenLayer'
import { penNodesToPathD, type PenCurveType } from '../cam/penCurves'
import { SimulationLayer } from './layers/SimulationLayer'
import SimulationPlayer from '../sim/SimulationPlayer'
import { useSimStore } from '../store/simStore'
import { HandleType, LiveTransform , RULER_W, RULER_H } from './types'
import { getMultiBBox, applyTransformStep, isIdentityStep, extractCircles, dragBoxEncloses, wholeGroupsOnly, type TransformStep, type CircleInfo } from './selectionUtils'
import type { BBox } from './selectionUtils'
import {
  generateShapeD,
  generateShapeParts,
  shapeParamsFromDrag,
  shapeParamsFromConfig,
  shapeDisplayName,
  isScaleLocked,
  SCALE_LOCKED_SHAPES,
  type ShapeType,
} from '../shapes/shapeGenerators'
import type { PenNode } from '../store/uiStore'
import { NodeEditLayer } from './layers/NodeEditLayer'
import { TabLayer } from './layers/TabLayer'
import { nodesToD, removeNode, insertNodeOnSegment, splitCompoundPath, weldNodes, deleteSegment, joinPaths, joinPathsConnect, endpointToMidpointWeld, connectEndpointToInterior, toggleNodeCurvature } from './nodeUtils'
import type { PathNode } from './nodeUtils'
import type { CrossPathEntry } from './layers/NodeEditLayer'
import { uid } from '../uid'

export interface Viewport {
  x: number
  y: number
  scale: number
}

// ── Path proximity helpers ────────────────────────────────────────────────────

// A path participates in canvas hit-tests/snaps only when it's actually drawn.
// `hidden` paths (soft-hidden by boolean ops) render nowhere, so they must not
// be clickable, editable, weldable, or snappable (bugs.md B1).
const onCanvas = (p: ImportedPath) => p.visible && !p.hidden
// Fine enough that a region's curved edges sit well inside any pocket tolerance
// (POCKET_FLATTEN_TOL_MM is 0.05), since the region is emitted as a polyline.
const REGION_FLATTEN_TOL_MM = 0.01

function distToPolylines(px: number, py: number, polys: [number, number][][]): number {
  let minSq = Infinity
  for (const poly of polys) {
    for (let i = 1; i < poly.length; i++) {
      const [ax, ay] = poly[i - 1], [bx, by] = poly[i]
      const d = ptSegDistSq(px, py, ax, ay, bx, by)
      if (d < minSq) minSq = d
    }
  }
  return Math.sqrt(minSq)
}

function closestVisiblePath(
  px: number, py: number,
  paths: ImportedPath[],
  thresholdMM: number,
  getPolys: (p: ImportedPath) => [number, number][][],
): ImportedPath | null {
  let best: ImportedPath | null = null
  let bestDist = thresholdMM
  for (const p of paths) {
    const dist = distToPolylines(px, py, getPolys(p))
    if (dist < bestDist) { bestDist = dist; best = p }
  }
  return best
}

// ─────────────────────────────────────────────────────────────────────────────

// Slack the Fit button leaves around the workpiece.
const FIT_MARGIN = 0.85
// How far past a full fit the wheel may keep zooming out. Must be BELOW FIT_MARGIN, or
// the wheel's floor lands above the zoom the Fit button produces and scrolling out stops
// while still more zoomed in than Fit.
const ZOOM_OUT_SLACK = 0.4
// Highest zoom (px/mm) any gesture may reach.
const MAX_ZOOM = 500
// One click of the zoom buttons. Coarser than a wheel notch (1.12) on purpose: a button
// is pressed a few times, not spun, so a notch-sized step would feel like nothing moved.
const ZOOM_BUTTON_STEP = 1.4

// bg-panel/bg-raised/border-ridge/text-norm were never defined in the Tailwind config or
// any stylesheet, so these buttons had no fill and no border colour — just `border`'s
// default gray-200, which reads on a dark canvas and disappears on a light one. Same
// treatment as the simulator's floating controls, which sit over the same canvas.
const ZOOM_BTN_CLASS = 'bg-gray-50/95 dark:bg-neutral-900/95 hover:bg-gray-200 dark:hover:bg-neutral-800 border border-gray-400 dark:border-neutral-700 rounded p-1.5 text-gray-600 dark:text-neutral-300 transition-colors'

function fitViewport(sw: number, sh: number, ww: number, wh: number): Viewport {
  const uw = sw - RULER_W
  const uh = sh - RULER_H
  const scale = Math.min(uw / ww, uh / wh) * FIT_MARGIN
  return {
    scale,
    x: RULER_W + (uw - ww * scale) / 2,
    y: RULER_H + uh - (uh - wh * scale) / 2,
  }
}

// Smallest zoom (px/mm) the wheel may reach, so the view can't shrink to a speck.
//
// Sized off whichever is larger, the table or the WORKPIECE: a workpiece can legitimately
// be set bigger than the configured table limits, and clamping to the table alone made it
// impossible to zoom out far enough to see all of it. The slack factor then lets the view
// pull back past a bare fit — without it the floor sat above the zoom the Fit button
// produces (which carries FIT_MARGIN), so scrolling out stopped while still more zoomed in
// than Fit. Falls back to a tiny floor if sizes aren't known yet.
function minZoomScale(
  sw: number, sh: number, tableW: number, tableH: number, wpW: number, wpH: number,
): number {
  const uw = sw - RULER_W
  const uh = sh - RULER_H
  const w = Math.max(tableW, wpW)
  const h = Math.max(tableH, wpH)
  if (uw <= 0 || uh <= 0 || w <= 0 || h <= 0) return 0.01
  return Math.max(0.01, Math.min(uw / w, uh / h) * ZOOM_OUT_SLACK)
}

function screenToCNC(sx: number, sy: number, vp: Viewport): { x: number; y: number } {
  return { x: (sx - vp.x) / vp.scale, y: (vp.y - sy) / vp.scale }
}

// What the canvas is showing, in CNC mm. The weld/connect candidate gatherer
// takes it so a document full of gears does not offer a target for every node
// in it — see collectCrossPathEntries.
function visibleCNC(
  vp: Viewport,
  size: { width: number; height: number },
  near: { x: number; y: number },
): CrossPathView {
  const a = screenToCNC(0, 0, vp)
  const b = screenToCNC(size.width, size.height, vp)
  return {
    minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x),
    minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y),
    scale: vp.scale, near,
  }
}

type CanvasMode =
  | { type: 'idle' }
  | { type: 'pan' }
  // `pick` is the Constrain tool borrowing this mode: the second point of a
  // half-made constraint is being DRAGGED, and mouseup creates the constraint
  // holding wherever it landed. Borrowed rather than given a mode of its own so
  // the drag gets object snap, grid snap, Shift axis-lock and the live preview
  // of the part's OWN constraints for nothing — and so the two kinds of drag
  // cannot bake differently.
  | { type: 'move'; pathIds: string[]; startCNC: { x: number; y: number }; initBbox: BBox; snapTargets: SnapTargets; pick?: { held: AnchorCandidate; hot: AnchorCandidate } }
  | { type: 'resize'; pathIds: string[]; handle: HandleType; anchor: { x: number; y: number }; initHandle: { x: number; y: number }; initBbox: BBox; shiftHeld: boolean; snapTargets: SnapTargets }
  | { type: 'rotate'; pathIds: string[]; center: { x: number; y: number }; initAngle: number }
  | { type: 'dragbox'; startScreen: { x: number; y: number } }
  | { type: 'drawshape'; startCNC: { x: number; y: number }; currentCNC: { x: number; y: number } }
  | { type: 'pendraw'; anchorCNC: { x: number; y: number }; closing: boolean }
  | { type: 'nodedit-drag'; nodeIdx: number; kind: 'anchor' | 'handle-in' | 'handle-out' }
  // Dragging a joint of a clock's going train. Only ONE angle changes — the link
  // from this arbor to the next — and everything on the drive side of it
  // translates rigidly; see onMoveClockLink.
  | { type: 'clocklink-drag'; nodeIdx: number }

const MOVE_THRESHOLD_PX = 4  // pixels before a click is treated as a drag
const OBJECT_SNAP_PX = 8     // screen px within which a dragged bbox edge snaps to another shape's edge
const PICK_SHOW_PX = 70      // screen px within which a part offers its constraint points
const PICK_HOT_PX = 16       // screen px within which one of those points would be taken by a click

// One step in the node-edit local undo stack. `globalStep` marks gestures that
// ALSO wrote one atomic entry to the global paths history (cross-path join,
// loop split, trim split): undoing/redoing such a step replays that global
// entry too, so the other path involved is restored/re-removed in the same
// keystroke — without leaving point-edit mode.

function snapPoint(
  cnc: { x: number; y: number },
  vp: Viewport,
  units: 'mm' | 'in',
  orgWorld: { x: number; y: number },
): { x: number; y: number } {
  const step = minorStepMM(majorStepMM(vp.scale, units), units)
  if (step <= 0) return cnc
  return {
    x: Math.round((cnc.x - orgWorld.x) / step) * step + orgWorld.x,
    y: Math.round((cnc.y - orgWorld.y) / step) * step + orgWorld.y,
  }
}

function NodeEditDimensionOverlay({
  viewport,
  nodes,
  closed,
  dragNodeIdx,
  hoverSegIdx,
}: {
  viewport: Viewport
  nodes: PathNode[]
  closed: boolean
  dragNodeIdx: number | null
  hoverSegIdx: number | null
}) {
  const { units } = useWorkpieceStore()
  if (nodes.length < 2) return null

  const fmt = (d: number) =>
    units === 'in' ? (d / 25.4).toFixed(3) + '"' : d.toFixed(2) + ' mm'

  const segLabel = (fromIdx: number, toIdx: number) => {
    const a = nodes[fromIdx], b = nodes[toIdx]
    const dist = Math.hypot(b.x - a.x, b.y - a.y)
    if (dist < 0.01) return null
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2
    return { sx: viewport.x + mx * viewport.scale, sy: viewport.y - my * viewport.scale, text: fmt(dist) }
  }

  const labels: { sx: number; sy: number; text: string }[] = []

  if (dragNodeIdx !== null && nodes[dragNodeIdx]) {
    const prevIdx = dragNodeIdx > 0 ? dragNodeIdx - 1 : closed ? nodes.length - 1 : -1
    if (prevIdx >= 0) {
      const l = segLabel(prevIdx, dragNodeIdx)
      if (l) labels.push(l)
    }
    const nextIdx = dragNodeIdx < nodes.length - 1 ? dragNodeIdx + 1 : closed ? 0 : -1
    if (nextIdx >= 0 && nextIdx !== prevIdx) {
      const l = segLabel(dragNodeIdx, nextIdx)
      if (l) labels.push(l)
    }
  } else if (hoverSegIdx !== null) {
    const toIdx = (hoverSegIdx + 1) % nodes.length
    if (closed || toIdx !== 0) {
      const l = segLabel(hoverSegIdx, toIdx)
      if (l) labels.push(l)
    }
  }

  if (labels.length === 0) return null

  return (
    <>
      {labels.map((l, i) => (
        <div
          key={i}
          className="absolute pointer-events-none bg-black/70 text-white text-xs px-1.5 py-0.5 rounded font-mono whitespace-nowrap z-10"
          style={{ left: l.sx, top: l.sy - 36, transform: 'translateX(-50%)' }}
        >
          {l.text}
        </div>
      ))}
    </>
  )
}

// THE CONSTRAIN TOOL'S LIVE DIMENSION — the one thing the stage drew that follows the bare
// cursor. It reads `cursorMM` HERE rather than in CanvasStage: subscribed there, the cursor
// re-ran the whole stage body and rebuilt every layer's JSX on EVERY mouse move, whatever
// tool was in use, for the sake of this one line. The selector hands back null unless a
// first point is held with no candidate under the pointer, so even this stays still until
// the line actually has to track the cursor.
function ConstraintLayerLive({ viewport, hideCommitted, held, hot, drag }: {
  viewport: Viewport
  hideCommitted: boolean
  held: AnchorCandidate | null
  hot: AnchorCandidate | null
  drag: { dx: number; dy: number } | null
}) {
  const activeTool = useUIStore((s) => s.activeTool)
  const constrainMode = useUIStore((s) => s.constrainMode)
  const paths = usePathsStore((s) => s.paths)
  const following = activeTool === 'constrain' && !!held && !hot
  const cursorMM = useCanvasStore((s) => (following ? s.cursorMM : null))

  // THE DIMENSION BEING MADE, in CNC mm, or null when nothing is half-made.
  //
  // The far end is the point a mouse-up would take: the hot candidate when one
  // is under the cursor — so what is drawn is what will be stored, to the digit
  // — displaced by the drag when the part is being dragged there, and the bare
  // cursor otherwise, which is what makes the line follow the pointer across
  // empty canvas the way it always did.
  const pending = useMemo(() => {
    if (activeTool !== 'constrain' || !held) return null
    const q = hot
      ? { x: hot.x + (drag?.dx ?? 0), y: hot.y + (drag?.dy ?? 0) }
      : cursorMM
    if (!q) return null
    // Stated in the first part's frame, which is what the constraint will hold.
    const frame = constraintFrame(paths, held.ref)
    return {
      p: { x: held.x, y: held.y }, q, mode: constrainMode,
      frameDeg: frame.deg, frameFlip: frame.flip,
    }
  }, [activeTool, held, hot, drag, cursorMM, constrainMode, paths])

  return <ConstraintLayer viewport={viewport} hideCommitted={hideCommitted} pending={pending} />
}

function PenLengthOverlay({ viewport, draggingHandle, snappedCursor }: { viewport: Viewport; draggingHandle: boolean; snappedCursor?: { x: number; y: number } | null }) {
  const activeTool = useUIStore((s) => s.activeTool)
  const penNodes = useUIStore((s) => s.penNodes)
  const snapEnabled = useUIStore((s) => s.snapEnabled)
  const cursorMM = useCanvasStore((s) => s.cursorMM)
  const { units, origin, widthMM, heightMM } = useWorkpieceStore()

  if (activeTool !== 'pen' || penNodes.length === 0 || !cursorMM || draggingHandle) return null

  let cursor = cursorMM
  if (snappedCursor) {
    cursor = snappedCursor
  } else if (snapEnabled) {
    const org = originWorldXY(origin, widthMM, heightMM)
    cursor = snapPoint(cursorMM, viewport, units, org)
  }

  const last = penNodes[penNodes.length - 1]
  const dist = Math.hypot(cursor.x - last.x, cursor.y - last.y)
  if (dist < 0.01) return null

  const sx = viewport.x + cursor.x * viewport.scale
  const sy = viewport.y - cursor.y * viewport.scale
  const label = units === 'in'
    ? (dist / 25.4).toFixed(3) + '"'
    : dist.toFixed(2) + ' mm'

  return (
    <div
      className="absolute pointer-events-none bg-black/70 text-white text-xs px-1.5 py-0.5 rounded font-mono whitespace-nowrap z-10"
      style={{ left: sx + 14, top: sy - 22 }}
    >
      {label}
    </div>
  )
}

export default function CanvasStage() {
  const containerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<Konva.Stage>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  // Read inside the gesture callbacks, which must not re-create on a resize.
  const sizeRef = useRef(size)
  sizeRef.current = size
  const [viewport, setViewportState] = useState<Viewport>({ x: 0, y: 0, scale: 2 })
  const viewportRef = useRef<Viewport>(viewport)
  const spaceHeldRef = useRef(false)
  const shiftHeldRef = useRef(false)

  const modeRef = useRef<CanvasMode>({ type: 'idle' })
  // The linkage being arranged. Held HERE rather than in a store for the same
  // reason liveTransform is: it changes on every mouse move, and only the
  // committed value (on the clock's own chip) has to outlive the gesture.
  const [linkAngles, linkAnglesRef, setLinkAngles] = useRefState<number[] | null>(null)
  const [hoverLinkNode, setHoverLinkNode] = useState<number | null>(null)
  // Ref pair, not plain state: mouseup bakes from liveTransformRef so a mouseup
  // that lands before React commits the last mousemove's render still bakes the
  // final transform, not the previous frame's (bugs.md B6).
  const [liveTransform, liveTransformRef, setLiveTransform] = useRefState<LiveTransform | null>(null)

  // THE CONSTRAINT SOLVE FOR THE DRAG IN FLIGHT, previewed live.
  //
  // Built ONCE on mousedown (`planConstraints` flattens geometry and settles the
  // walk order) and then run as pure arithmetic on every mousemove — the `d`
  // strings do not change until mouse-up, and every constrained move is a
  // translation, so nothing has to be re-resolved. Re-solving from scratch each
  // frame would flatten every path of every constrained body at pointer rate,
  // which on a gear is exactly the kind of per-frame cost this canvas avoids
  // everywhere else. Same code path as the real solve, so what is previewed is
  // what lands.
  const constraintPlanRef = useRef<ConstraintPlan | null>(null)
  const [followTransforms, setFollowTransforms] = useState<LiveTransform[] | null>(null)

  // ── The Constrain tool ─────────────────────────────────────────────────────
  // Two clicks: a point on one part, a point on another. `pickCandidates` is
  // what the hovered part offers, `pickHot` the one a click would take, and
  // `pickHeld` the first point once it has been taken. The tool STAYS ON after
  // placing one, so a row of holes is one gesture each; Escape drops a half-made
  // constraint, and Escape again leaves the tool.
  //
  // THE SECOND CLICK MAY BE A DRAG, which is the other half of the gesture: a
  // press on a point of another part moves that part, with the dimension and its
  // numbers live on screen, and the constraint is created holding wherever it is
  // let go. Placing by eye and placing by number are the same gesture then —
  // drag it roughly right, then type the figure into the row that has just taken
  // the keyboard. It borrows the `move` mode to do it (see `CanvasMode`).
  const [pickCandidates, setPickCandidates] = useState<AnchorCandidate[]>([])
  const [pickHot, pickHotRef, setPickHot] = useRefState<AnchorCandidate | null>(null)
  const [pickHeld, pickHeldRef, setPickHeld] = useRefState<AnchorCandidate | null>(null)
  // How far the second point has been DRAGGED, while it is being dragged. The
  // pending dimension is drawn from the hot candidate plus this — every body
  // moves by a pure translation, so the point the constraint will measure to
  // moves by exactly the drag, and the numbers on screen are the numbers that
  // will be stored.
  const [pickDrag, setPickDrag] = useState<{ dx: number; dy: number } | null>(null)
  // Ref-backed like liveTransform: mouseup reads the ref, so a release that lands before
  // React commits the last mousemove's box selects with THAT box, not the frame before.
  const [dragBox, dragBoxRef, setDragBox] = useRefState<{ sx: number; sy: number; ex: number; ey: number } | null>(null)
  const [snapGuides, setSnapGuides] = useState<SnapGuides | null>(null)
  // Object-snapped cursor while the pen tool is active — feeds the pen live
  // preview so it shows exactly where a click would land.
  const [penSnapCursor, setPenSnapCursor] = useState<{ x: number; y: number } | null>(null)
  const [liveShapeD, setLiveShapeD] = useState<string | null>(null)
  const [altDown, altDownRef, setAltDown] = useRefState(false)
  const didDragRef = useRef(false)
  // Tracks the active shape-tool session: once the user has dragged out at least
  // one shape, the tool stays selected for more drags and a subsequent click
  // (no drag) exits to select mode instead of placing another shape.
  const shapeDragSessionRef = useRef<{ tool: string | null; dragged: boolean }>({ tool: null, dragged: false })
  // Flattened-polyline cache for hit-testing/vertex-snap, keyed by path id and
  // invalidated when the path's d changes. (The old cache keyed on the full d
  // string never evicted, so every baked transform grew it — tofix.md H2.)
  const flatCacheRef = useRef(new Map<string, { d: string; byTol: Map<number, [number, number][][]> }>())
  const getFlat = useCallback((p: ImportedPath, tol: number): [number, number][][] => {
    const cache = flatCacheRef.current
    let entry = cache.get(p.id)
    if (!entry || entry.d !== p.d) {
      entry = { d: p.d, byTol: new Map() }
      cache.set(p.id, entry)
    }
    let polys = entry.byTol.get(tol)
    if (!polys) {
      polys = flattenPath(p.d, tol)
      entry.byTol.set(tol, polys)
    }
    return polys
  }, [])

  // Region picking (cam/regionPick.ts), on while the Pocket form is open. The planar graph of every visible stroke is
  // built once per paths state, so hovering — which previews the region under the
  // cursor — only runs the face lookup. Paths are replaced, never mutated, so the
  // array's identity is the cache key.
  const [regionPreviewD, setRegionPreviewD] = useState<string | null>(null)
  const regionFinderRef = useRef<{ paths: ImportedPath[]; find: RegionFinder } | null>(null)
  const getRegionFinder = useCallback((): RegionFinder => {
    const { paths } = usePathsStore.getState()
    const cached = regionFinderRef.current
    if (cached && cached.paths === paths) return cached.find
    const strokes = paths.filter(onCanvas).flatMap((p) => getFlat(p, REGION_FLATTEN_TOL_MM))
    const find = createRegionFinder(strokes)
    regionFinderRef.current = { paths, find }
    return find
  }, [getFlat])
  // Region picking shares the canvas with ordinary selection, so the area under the
  // cursor is previewed only where a click would pick it: off every line (a click
  // there selects that path) and outside point edit.
  const onMoveRegionHover = useCallback((cnc: { x: number; y: number }, vp: Viewport) => {
    const { paths } = usePathsStore.getState()
    const onLine = !!useUIStore.getState().nodeEditPathId ||
      !!closestVisiblePath(cnc.x, cnc.y, paths.filter(onCanvas), 8 / vp.scale, (p) => getFlat(p, 0.05))
    const region = onLine ? null : getRegionFinder()([cnc.x, cnc.y])
    const d = region ? regionToD(region) : null
    setRegionPreviewD((prev) => (prev === d ? prev : d))
  }, [getRegionFinder, getFlat])
  // Pick the enclosed area around `cnc` and select it (added to the selection with
  // shift). An area that one existing closed path already bounds, with nothing inside
  // it, selects that path rather than stacking a copy on it. False when `cnc` is not
  // enclosed.
  const pickRegionAt = useCallback((cnc: { x: number; y: number }, additive: boolean): boolean => {
    const region = getRegionFinder()([cnc.x, cnc.y])
    if (!region) return false
    const store = usePathsStore.getState()
    let id: string | undefined
    if (region.holes.length === 0) {
      const area = Math.abs(signedArea(region.outer))
      id = store.paths.find((p) => {
        if (!onCanvas(p)) return false
        const rings = getFlat(p, REGION_FLATTEN_TOL_MM)
        if (rings.length !== 1) return false
        const ring = rings[0]
        const [a, b] = [ring[0], ring[ring.length - 1]]
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-3) return false
        return Math.abs(Math.abs(signedArea(ring)) - area) <= area * 1e-3 &&
          pointInPolygon(cnc.x, cnc.y, ring)
      })?.id
    }
    if (!id) {
      id = uid('region')
      store.addPaths([{ id, name: 'Region', d: regionToD(region), visible: true, color: nextPathColor() }], { source: 'region' })
    }
    const { selectedIds } = usePathsStore.getState()
    usePathsStore.getState().setSelectedIds(additive
      ? (selectedIds.includes(id) ? selectedIds : [...selectedIds, id])
      : [id])
    setRegionPreviewD(null)
    return true
  }, [getRegionFinder, getFlat])

  // Individual selectors (not whole-store destructuring) so the Stage doesn't
  // re-render on unrelated store changes — e.g. undo-stack pushes or workpiece
  // machine settings (tofix.md H3).
  const widthMM = useWorkpieceStore((s) => s.widthMM)
  const heightMM = useWorkpieceStore((s) => s.heightMM)
  // Written, never subscribed: the cursor changes on every mouse move, and a subscription
  // here re-ran this whole component each time. Whatever follows the cursor subscribes
  // for itself (ConstraintLayerLive, PenLengthOverlay).
  const setCursorMM = useCanvasStore((s) => s.setCursorMM)
  const setZoomPct = useCanvasStore((s) => s.setZoomPct)
  const setLiveRotationAngle = useCanvasStore((s) => s.setLiveRotationAngle)
  const setLiveBBox = useCanvasStore((s) => s.setLiveBBox)
  const paths = usePathsStore((s) => s.paths)
  const selectedIds = usePathsStore((s) => s.selectedIds)
  const selectPath = usePathsStore((s) => s.selectPath)
  const setSelectedIds = usePathsStore((s) => s.setSelectedIds)

  // Drop cache entries for paths that no longer exist (updates are already
  // replaced in place by the id+d check in getFlat).
  useEffect(() => {
    const cache = flatCacheRef.current
    if (cache.size === 0) return
    const live = new Set(paths.map((p) => p.id))
    for (const id of [...cache.keys()]) if (!live.has(id)) cache.delete(id)
  }, [paths])

  const selectedPaths = useSelectedPaths()
  // Selection bbox, computed once per store change instead of per mousemove —
  // SelectionLayer + SelectionHandleLayer used to each re-flatten every selected
  // path on every liveTransform frame to derive this themselves (tofix.md H1).
  const selectionBBox = useMemo(() => getMultiBBox(selectedPaths.map((p) => p.d)), [selectedPaths])
  const selectionBBoxRef = useRef<BBox | null>(null)
  selectionBBoxRef.current = selectionBBox
  // A selection holding any mechanism whose size is set by its own parameters
  // gets no resize handles — see SCALE_LOCKED_SHAPES. Any, not every: dragging
  // a corner scales the WHOLE selection, so one gear in it is enough to make
  // the gesture wrong.
  const selectionScaleLocked = useMemo(
    () => selectedPaths.some((p) => isScaleLocked(p.shapeParams)),
    [selectedPaths],
  )
  const selectionScaleLockedRef = useRef(false)
  selectionScaleLockedRef.current = selectionScaleLocked
  // A selection holding an IMAGE cannot be skewed — Alt + corner scales it instead. The
  // picture and the photo V-carve are both pinned to the path's rectangle
  // (extractRectInfo), so a skew turned the outline into a parallelogram while the picture
  // stayed a rectangle and the carve followed the picture: what was drawn and what was cut
  // disagreed. Any, not every, for the same reason as the scale lock above.
  const selectionSkewLocked = useMemo(
    () => selectedPaths.some((p) => !!p.imageSrc),
    [selectedPaths],
  )
  const selectionSkewLockedRef = useRef(false)
  selectionSkewLockedRef.current = selectionSkewLocked
  const shapeFromCenterPref = useUIStore((s) => s.shapeFromCenter)
  // ANY flagged path in the selection is enough: scaling the group about its
  // middle is the only reading of "centred" that a mixed selection has.
  const centreResize = useMemo(() => selectedPaths.some((p) => p.fromCenter), [selectedPaths])
  const centreResizeRef = useRef(false)
  centreResizeRef.current = centreResize
  const pendingDrillPoints = useUIStore((s) => s.pendingDrillPoints)
  const penNodes = useUIStore((s) => s.penNodes)
  const penCurveType = useUIStore((s) => s.penCurveType)
  const nodeEditPathId = useUIStore((s) => s.nodeEditPathId)
  // A running mesh animation draws the whole group itself, in mesh, so the
  // group's own paths step aside for it — an escapement's wheel and anchor, or a
  // gear and the lantern it emitted.
  const meshAnimPathId = useUIStore((s) => s.meshAnimPathId)
  const meshAnimGroupId = usePathsStore((s) =>
    s.paths.find((p) => p.id === meshAnimPathId)?.groupId ?? null)
  // A running CLOCK draws all its wheels itself, in mesh, so every one of its
  // groups steps aside — which is why this is a separate exclusion from the
  // single-group one above rather than another user of it.
  const clockAnimPathId = useUIStore((s) => s.clockAnimPathId)
  const clockLinkPathId = useUIStore((s) => s.clockLinkPathId)
  // Both previews draw the whole clock themselves, so its paths step aside for
  // either. One id covers both because the two modes are mutually exclusive.
  const clockAnimId = usePathsStore((s) => {
    const id = clockAnimPathId ?? clockLinkPathId
    return s.paths.find((p) => p.id === id)?.clockId ?? null
  })
  const cornerPickPathId = useUIStore((s) => s.cornerPickPathId)

  // The assembly and root the linkage drag works against — the same ones the
  // layer draws, so a joint lands where the cursor is rather than near it.
  const linkFrame = useCallback(() => {
    const st = usePathsStore.getState()
    const clockId = st.paths.find((p) => p.id === useUIStore.getState().clockLinkPathId)?.clockId
    if (!clockId) return null
    const assembly = clockAssemblyFromPaths(st.paths, clockId)
    if (assembly.length < 2) return null
    const wp = useWorkpieceStore.getState()
    const root = clockRoot(wp.widthMM, wp.heightMM, assembly[assembly.length - 1].params)
    // The motion work too, or its joint has no plate entry to be dragged around.
    return { clockId, assembly, motion: clockMotionFromPaths(st.paths, clockId), root }
  }, [])

  const handleLinkNodeDown = useCallback((nodeIdx: number, e: Konva.KonvaEventObject<MouseEvent>) => {
    e.cancelBubble = true
    didDragRef.current = false
    setHoverLinkNode(nodeIdx)
    setMode2({ type: 'clocklink-drag', nodeIdx })
  }, [])

  /**
   * Swing one link so its far joint follows the cursor.
   *
   * The LENGTH is not negotiable — it is the centre distance the mesh runs at —
   * so the joint rides a circle about the arbor it hangs from and only the ANGLE
   * changes. `angles[k]` alone is written: everything toward the drive wheel then
   * translates rigidly (it is built off this joint with its own angles intact)
   * and everything toward the escapement stays exactly where it was. One drag,
   * one angle, which is what makes this arrangeable rather than whippy.
   */
  const onMoveClockLink = useCallback((m: Extract<CanvasMode, { type: 'clocklink-drag' }>, cnc: { x: number; y: number }, shift: boolean) => {
    const f = linkFrame()
    const cur = linkAnglesRef.current
    if (!f || !cur) return
    const plate = clockPlate(f.assembly, cur, f.motion)
    if (!plate) return
    // Shift snaps to 15° — an ANGLE snap, deliberately separate from the object
    // snap in uiStore, which is about edges lining up and means nothing here.
    const deg = dragLinkAngle(plate, f.root, m.nodeIdx, cnc, shift ? 15 : 0)
    if (deg === null) return
    const next = cur.slice()
    next[m.nodeIdx] = deg
    setLinkAngles(next)
  }, [linkFrame, linkAnglesRef, setLinkAngles])

  /** Write the arrangement onto the clock's parts, which is where its spec
   *  lives. No geometry moves — the parts are still cut flat where they lie — so
   *  there is nothing to regenerate and nothing to record. */
  const commitClockLink = useCallback(() => {
    const f = linkFrame()
    const angles = linkAnglesRef.current
    if (!f || !angles) return
    const spec = clockSpecOf(usePathsStore.getState().paths, f.clockId)
    if (spec) setClockSpec(f.clockId, { ...spec, linkAngles: angles })
  }, [linkFrame, linkAnglesRef])

  // Entering linkage mode takes a working copy of the clock's committed angles;
  // leaving drops it. Defaults fill in per element, so a clock that predates the
  // field arranges from the lean it was drawn with rather than from nothing.
  useEffect(() => {
    if (!clockLinkPathId) { setLinkAngles(null); setHoverLinkNode(null); return }
    const allPaths = usePathsStore.getState().paths
    const clockId = allPaths.find((p) => p.id === clockLinkPathId)?.clockId
    const stored = clockSpecOf(allPaths, clockId)?.linkAngles
    const n = defaultLinkAngles().length
    setLinkAngles(Array.from({ length: n }, (_, i) => (linkAngleAt(stored, i) * 180) / Math.PI))
  }, [clockLinkPathId, setLinkAngles])
  const effectiveCurveType: PenCurveType = altDown
    ? (penCurveType === 'linear' ? 'catmull-rom' : 'linear')
    : penCurveType

  // Node-edit session state + local undo + commit/exit lifecycle (tofix.md R3)
  const {
    editNodes, editNodesRef, setEditNodes,
    editClosed, editClosedRef, setEditClosed,
    hoveredEditNode, hoveredEditNodeRef, setHoveredEditNode,
    dragNodeIdx, setDragNodeIdx,
    hoverSegIdx, hoverSegIdxRef, setHoverSegIdx,
    weldTargetIdx, weldTargetIdxRef, setWeldTargetIdx,
    connectSource, connectSourceRef, setConnectSource,
    connectPreviewTo, setConnectPreviewTo,
    connectSnapTargetIdx, setConnectSnapTargetIdx,
    crossPathEntriesRef, crossPathCandidates, setCrossPathCandidates,
    crossPathWeldTarget, crossPathWeldTargetRef, setCrossPathWeldTarget,
    editDragInitRef, selfWriteRef,
    pushLocalUndo,
    commitEditNodes, exitNodeEdit, clearConnectState,
  } = useNodeEditSession()
  // Pen-tool session state + pen-local undo/redo (tofix.md R3)
  const { livePen, setLivePen, penClosing, penClosingRef, setPenClosing, penPast, penFuture } = usePenTool()
  // Reset the shape-drag session whenever the active tool changes (incl. exit
  // via Escape or re-activating the same shape) so a fresh session starts clean.
  useEffect(() => useUIStore.subscribe((s, prev) => {
    if (s.activeTool !== prev.activeTool) shapeDragSessionRef.current = { tool: null, dragged: false }
  }), [])

  const drillPast = useRef<{ x: number; y: number }[][]>([])

  const drillUndo = useCallback(() => {
    if (drillPast.current.length === 0) return
    const prev = drillPast.current[drillPast.current.length - 1]
    drillPast.current = drillPast.current.slice(0, -1)
    useUIStore.getState().setDrillPoints(prev)
  }, [])

  const setMode2 = useCallback((m: CanvasMode) => {
    modeRef.current = m
  }, [])

  const snapCNC = useCallback((cnc: { x: number; y: number }): { x: number; y: number } => {
    const { snapEnabled } = useUIStore.getState()
    if (!snapEnabled) return cnc
    const { units, origin, widthMM, heightMM } = useWorkpieceStore.getState()
    const org = originWorldXY(origin, widthMM, heightMM)
    return snapPoint(cnc, viewportRef.current, units, org)
  }, [])

  // Circles a path holds, cached on the path object — paths are replaced, never
  // mutated, so identity is a safe key and a click costs no re-parsing.
  const circleCache = useRef(new WeakMap<ImportedPath, CircleInfo[]>())
  const circlesOf = useCallback((p: ImportedPath): CircleInfo[] => {
    let cs = circleCache.current.get(p)
    if (!cs) { cs = extractCircles(p); circleCache.current.set(p, cs) }
    return cs
  }, [])

  // Snap to a circle CENTRE first, then to the nearest visible path vertex within
  // 10 screen px, then fall back to grid snap.
  //
  // A click near a hole means "drill that hole", not "drill where I clicked" — and
  // the drill tool owns the canvas while it is up, so clicking the circle is the only
  // way left to say it. Near means within the tolerance of the CENTRE or of the RIM,
  // never just "inside": a board outline is a circle too, and its open middle has to
  // stay free ground for the free-placed points this tool also exists for. A hole
  // small enough to be one click wide qualifies anywhere inside it either way. The
  // SMALLEST qualifying circle wins, so a hole nested in a bigger ring is the one
  // that gets drilled.
  const snapDrillPoint = useCallback((cnc: { x: number; y: number }): { x: number; y: number } => {
    const vp = viewportRef.current
    const radiusCNC = 10 / vp.scale
    const { paths: allPaths } = usePathsStore.getState()
    let bestCircle: CircleInfo | null = null
    for (const p of allPaths) {
      if (!onCanvas(p)) continue
      for (const c of circlesOf(p)) {
        const d = Math.hypot(c.cx - cnc.x, c.cy - cnc.y)
        if (d > radiusCNC && Math.abs(d - c.radiusMM) > radiusCNC) continue
        if (!bestCircle || c.radiusMM < bestCircle.radiusMM) bestCircle = c
      }
    }
    if (bestCircle) return { x: bestCircle.cx, y: bestCircle.cy }
    let bestDist = radiusCNC
    let best: { x: number; y: number } | null = null
    for (const p of allPaths) {
      if (!onCanvas(p)) continue
      const polys = getFlat(p, 0.5)
      for (const poly of polys) {
        for (const [vx, vy] of poly) {
          const d = Math.hypot(vx - cnc.x, vy - cnc.y)
          if (d < bestDist) { bestDist = d; best = { x: vx, y: vy } }
        }
      }
    }
    if (best) return best
    return snapCNC(cnc)
  }, [snapCNC, getFlat, circlesOf])

  // Pen-tool snapping: nearest path vertex first (crosshair guides through it),
  // then bbox edge/center axis alignment (same dashed guides as drag snapping),
  // then grid. Committed pen nodes count as vertices/alignment targets too so
  // grid-like pen drawings line up with themselves.
  const snapPenPoint = useCallback((cnc: { x: number; y: number }): { point: { x: number; y: number }; guides: SnapGuides | null } => {
    const { snapEnabled, penNodes } = useUIStore.getState()
    if (!snapEnabled) return { point: cnc, guides: null }
    const vp = viewportRef.current
    const tolMM = OBJECT_SNAP_PX / vp.scale
    const { paths: allPaths } = usePathsStore.getState()
    const { widthMM: wMM, heightMM: hMM } = useWorkpieceStore.getState()

    let bestDist = tolMM
    let bestVert: { x: number; y: number } | null = null
    const xs: number[] = [0, wMM, wMM / 2]
    const ys: number[] = [0, hMM, hMM / 2]
    for (const p of allPaths) {
      if (!onCanvas(p)) continue
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const poly of getFlat(p, 0.5)) {
        for (const [vx, vy] of poly) {
          const d = Math.hypot(vx - cnc.x, vy - cnc.y)
          if (d < bestDist) { bestDist = d; bestVert = { x: vx, y: vy } }
          if (vx < minX) minX = vx; if (vx > maxX) maxX = vx
          if (vy < minY) minY = vy; if (vy > maxY) maxY = vy
        }
      }
      if (isFinite(minX)) {
        xs.push(minX, maxX, (minX + maxX) / 2)
        ys.push(minY, maxY, (minY + maxY) / 2)
      }
    }
    for (const n of penNodes) {
      const d = Math.hypot(n.x - cnc.x, n.y - cnc.y)
      if (d < bestDist) { bestDist = d; bestVert = { x: n.x, y: n.y } }
      xs.push(n.x)
      ys.push(n.y)
    }
    if (bestVert) return { point: bestVert, guides: { x: bestVert.x, y: bestVert.y } }

    const ox = snapAxisDelta([cnc.x], xs, tolMM)
    const oy = snapAxisDelta([cnc.y], ys, tolMM)
    let x = cnc.x + (ox?.correction ?? 0)
    let y = cnc.y + (oy?.correction ?? 0)
    const grid = snapCNC({ x, y })
    if (!ox) x = grid.x
    if (!oy) y = grid.y
    return { point: { x, y }, guides: ox || oy ? { x: ox?.guide, y: oy?.guide } : null }
  }, [snapCNC, getFlat])

  // Dropped files go through the same shared import pipeline as the toolbar
  // Import button (io/importFile.ts) — all formats, same prompts and messages.
  const handleCanvasDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    for (const file of e.dataTransfer.files) importFile(file)
  }, [])

  const setViewport = useCallback((v: Viewport | ((p: Viewport) => Viewport)) => {
    const next = typeof v === 'function' ? v(viewportRef.current) : v
    viewportRef.current = next
    setViewportState(next)
    setZoomPct(next.scale)
  }, [setZoomPct])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect
      if (width > 0 && height > 0) setSize({ width, height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ─── Coming back from sleep ────────────────────────────────────────────────
  //
  // A CANVAS CAN COME BACK BLANK WITH ITS SCENE GRAPH INTACT. The browser is
  // free to throw away a canvas element's backing store when the machine sleeps
  // or memory gets tight — the element and everything Konva holds survive, the
  // pixels do not — and Konva only paints when something asks it to, so nothing
  // ever repaints and the drawing is simply gone until the next pan or click.
  // That is the "my project vanished after the screen went off" report: the
  // document is still there in full (a reload is what actually loses it, which
  // is why refreshing then offers the autosave back).
  //
  // Repainting from the scene graph is the whole fix, and it is cheap enough to
  // do on any of the three signals that can mean "you are being looked at
  // again" — none of them is reliable on its own across browsers, and a
  // redundant redraw of a canvas that is already correct costs one frame.
  useEffect(() => {
    const repaint = () => {
      if (document.visibilityState !== 'visible') return
      // Re-measure first: the same purge can leave the stage sized to a window
      // that has since changed, and a ResizeObserver that fired while hidden may
      // have been the last word on it.
      const el = containerRef.current
      if (el && el.clientWidth > 0 && el.clientHeight > 0) {
        setSize((cur) => cur.width === el.clientWidth && cur.height === el.clientHeight
          ? cur : { width: el.clientWidth, height: el.clientHeight })
      }
      stageRef.current?.batchDraw()
    }
    document.addEventListener('visibilitychange', repaint)
    window.addEventListener('pageshow', repaint)
    window.addEventListener('focus', repaint)
    return () => {
      document.removeEventListener('visibilitychange', repaint)
      window.removeEventListener('pageshow', repaint)
      window.removeEventListener('focus', repaint)
    }
  }, [])

  const fitRequest = useCanvasStore((s) => s.fitRequest)
  const didFitRef = useRef(false)
  useEffect(() => {
    if (size.width > 100 && !didFitRef.current) {
      didFitRef.current = true
      setViewport(fitViewport(size.width, size.height, widthMM, heightMM))
    }
  }, [size, widthMM, heightMM, setViewport])

  useEffect(() => {
    if (fitRequest === 0 || size.width <= 100) return
    setViewport(fitViewport(size.width, size.height, widthMM, heightMM))
  }, [fitRequest, size, widthMM, heightMM, setViewport])

  const fitToWorkpiece = useCallback(() => {
    setViewport(fitViewport(size.width, size.height, widthMM, heightMM))
  }, [size, widthMM, heightMM, setViewport])

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return
      if (e.code === 'Space' && !useSimStore.getState().gcode) { e.preventDefault(); spaceHeldRef.current = true }
      if (e.shiftKey) shiftHeldRef.current = true
      if (e.key === 'Alt') {
        if (useUIStore.getState().activeTool === 'pen') e.preventDefault()
        setAltDown(true)
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const { nodeEditPathId: pid } = useUIStore.getState()
        if (pid) {
          if (hoveredEditNodeRef.current !== null) {
            // Delete hovered node
            e.stopImmediatePropagation()
            e.preventDefault()
            const idx = hoveredEditNodeRef.current
            pushLocalUndo(editNodesRef.current, editClosedRef.current)
            const next = removeNode(editNodesRef.current, idx)
            setEditNodes(next)
            setHoveredEditNode(null)
          } else if (hoverSegIdxRef.current !== null) {
            // Trim hovered segment
            e.stopImmediatePropagation()
            e.preventDefault()
            const segIdx = hoverSegIdxRef.current
            const old = editNodesRef.current
            const oldClosed = editClosedRef.current
            const result = deleteSegment(old, segIdx, editClosedRef.current)
            setEditNodes(result.nodes)
            if (result.closed !== editClosedRef.current) {
              setEditClosed(result.closed)
            }
            const { nodeEditPathId: currentPid } = useUIStore.getState()
            const secondD = result.secondPath ? nodesToD(result.secondPath, false) : null
            if (secondD && currentPid) {
              // Trim split also adds a new path — commit remainder + add it as ONE
              // atomic global entry, and mark this local step as global so a
              // single local undo removes the split-off path again.
              pushLocalUndo(old, oldClosed, true)
              const { paths: allPaths } = usePathsStore.getState()
              const srcPath = allPaths.find((p) => p.id === currentPid)
              selfWriteRef.current = true
              usePathsStore.getState().applyPathEdit({
                gesture: 'trim',
                updates: [{ id: currentPid, d: nodesToD(result.nodes, result.closed), shapeParams: null }],
                add: [{
                  id: uid('trim'),
                  name: srcPath?.name ?? 'Path',
                  d: secondD,
                  visible: true,
                  color: srcPath?.color ?? nextPathColor(),
                }],
              })
              selfWriteRef.current = false
              // As every other join/split here does: applyPathEdit regenerates only what a
              // CONSTRAINT carried along, and the exit commit finds this d already written
              // and skips — so without this the path's ops kept cutting the deleted segment.
              regenerateAffected(currentPid)
            } else {
              // Plain trim — pure node edit, local undo handles it.
              pushLocalUndo(old, oldClosed)
            }
            setHoverSegIdx(null)
          }
        }
      }

      if (e.code === 'Escape') {
        // Arranging is committed on every mouseup, so Escape just leaves — it is
        // "done", not "cancel", and there is nothing uncommitted to throw away.
        if (useUIStore.getState().clockLinkPathId) {
          useUIStore.getState().setClockLink(null)
          return
        }
        const { nodeEditPathId: neid } = useUIStore.getState()
        if (neid) {
          if (connectSourceRef.current !== null) {
            clearConnectState()
          } else {
            exitNodeEdit()
          }
          return
        }
        const { activeTool, setActiveTool, clearDrillPoints, penNodes: nodes, clearPenNodes, penCurveType: ct } = useUIStore.getState()
        if (activeTool === 'pen') {
          if (nodes.length >= 2) {
            const d = penNodesToPathD(nodes, false, ct)
            if (d) {
              const id = uid('pen')
              usePathsStore.getState().addPaths([{ id, name: 'Pen Path', d, visible: true, color: nextPathColor() }], { source: 'pen' })
              usePathsStore.getState().selectPath(id)
            }
          }
          clearPenNodes()
          setActiveTool('select')
          setLivePen(null)
          setPenClosing(false)
          setMode2({ type: 'idle' })
        } else if (activeTool === 'constrain' && pickHeldRef.current) {
          // A half-made constraint goes first; the tool stays on. Same two-stage
          // Escape the pen has, and for the same reason — the commonest thing to
          // want out of is the gesture, not the tool. A drag in flight is part of
          // that gesture: dropping the preview without dropping the mode would
          // leave the part hanging at an offset nothing will ever bake.
          if (modeRef.current.type === 'move' && modeRef.current.pick) {
            setLiveTransform(null)
            setFollowTransforms(null)
            setLiveBBox(null)
            setSnapGuides(null)
            constraintPlanRef.current = null
            setMode2({ type: 'idle' })
          }
          setPickDrag(null)
          setPickHeld(null)
        } else if (activeTool !== 'select' && activeTool !== 'region') {
          if (activeTool === 'drill') clearDrillPoints()
          setActiveTool('select')
          setLiveShapeD(null)
          setPickHeld(null)
          setPickCandidates([])
          setMode2({ type: 'idle' })
        }
      }
    }
    const onUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceHeldRef.current = false
      if (!e.shiftKey) shiftHeldRef.current = false
      if (e.key === 'Alt') setAltDown(false)
    }
    // Alt+Tab / Cmd+Tab / dialogs swallow the keyup, so a held modifier would
    // stick until tapped again — clear them all when the window loses focus.
    const onBlur = () => {
      spaceHeldRef.current = false
      shiftHeldRef.current = false
      setAltDown(false)
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [setMode2, exitNodeEdit, pushLocalUndo])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const prevent = (e: WheelEvent) => e.preventDefault()
    el.addEventListener('wheel', prevent, { passive: false })
    return () => el.removeEventListener('wheel', prevent)
  }, [])

  // Scales about a fixed screen point, which is what keeps whatever you are looking at
  // from sliding away as the zoom changes. The wheel and the zoom buttons go through here
  // so both are clamped identically — a button that could pass minZoomScale would leave a
  // view the wheel cannot undo.
  //
  // The wheel passes the cursor. The buttons pass nothing and zoom about the SELECTED
  // part, so a click grows the thing you are working on instead of whatever happens to be
  // mid-screen; with nothing selected they fall back to the centre of the drawing area.
  const zoomBy = useCallback((factor: number, anchor?: { x: number; y: number }) => {
    // Cap zoom-out so the table/workpiece can't shrink to a speck; see minZoomScale.
    const wp = useWorkpieceStore.getState()
    const minScale = minZoomScale(size.width, size.height,
      wp.tableLimitWidthMM, wp.tableLimitHeightMM, wp.widthMM, wp.heightMM)
    const midX = RULER_W + (size.width - RULER_W) / 2
    const midY = RULER_H + (size.height - RULER_H) / 2
    const sel = anchor ? null : selectionBBoxRef.current
    setViewport((vp) => {
      const newScale = Math.min(Math.max(vp.scale * factor, minScale), MAX_ZOOM)
      const ratio = newScale / vp.scale
      if (sel) {
        // Hold the part's centre at the screen position it already occupies, exactly as
        // the wheel holds the point under the cursor. If it is currently off-screen there
        // is no such position worth keeping — anchoring out there would zoom about a point
        // you cannot see and leave the part just as invisible — so bring it to the middle.
        const sx = vp.x + sel.cx * vp.scale
        const sy = vp.y - sel.cy * vp.scale
        const visible = sx >= RULER_W && sx <= size.width && sy >= RULER_H && sy <= size.height
        const ax = visible ? sx : midX
        const ay = visible ? sy : midY
        // Solving vp.x + cx*scale = ax and vp.y - cy*scale = ay for the new viewport.
        return { scale: newScale, x: ax - sel.cx * newScale, y: ay + sel.cy * newScale }
      }
      const ax = anchor ? anchor.x : midX
      const ay = anchor ? anchor.y : midY
      return {
        scale: newScale,
        x: ax - (ax - vp.x) * ratio,
        y: ay + (vp.y - ay) * ratio,
      }
    })
  }, [setViewport, size])

  const handleWheel = useCallback((e: Konva.KonvaEventObject<WheelEvent>) => {
    const pointer = stageRef.current?.getPointerPosition()
    if (!pointer) return
    zoomBy(e.evt.deltaY < 0 ? 1.12 : 1 / 1.12, pointer)
  }, [zoomBy])

  // Start drawing a shape from the given CNC point (used by both stage and path mousedown when shape tool active)
  const startDrawShape = useCallback((pointer: { x: number; y: number }) => {
    const vp = viewportRef.current
    const cnc = snapCNC(screenToCNC(pointer.x, pointer.y, vp))
    didDragRef.current = false
    setMode2({ type: 'drawshape', startCNC: cnc, currentCNC: cnc })
  }, [setMode2, snapCNC])

  // Start placing a pen node from the given screen pointer position
  const startPenDraw = useCallback((pointer: { x: number; y: number }) => {
    const vp = viewportRef.current
    const cnc = snapPenPoint(screenToCNC(pointer.x, pointer.y, vp)).point
    const { penNodes: nodes } = useUIStore.getState()

    if (nodes.length >= 2) {
      const first = nodes[0]
      const fsx = vp.x + first.x * vp.scale
      const fsy = vp.y - first.y * vp.scale
      if (Math.hypot(pointer.x - fsx, pointer.y - fsy) < 10) {
        didDragRef.current = false
        setMode2({ type: 'pendraw', anchorCNC: cnc, closing: true })
        return
      }
    }

    didDragRef.current = false
    setMode2({ type: 'pendraw', anchorCNC: cnc, closing: false })
    setLivePen({ anchor: cnc, handle: null })
  }, [setMode2, snapPenPoint, setLivePen])

  // Register drill-local undo only while there are pending drill points to undo.
  // When points are empty (e.g. after generation or after undoing all), unregister so
  // the toolbar button and keyboard shortcut fall through to the global path undo.
  const activeTool = useUIStore((s) => s.activeTool)

  // A region preview belongs to one hover session of region picking.
  useEffect(() => { if (activeTool !== 'region') setRegionPreviewD(null) }, [activeTool])

  // Clear pen snap feedback whenever the pen tool deactivates (Escape, closing
  // commit, and toolbar switches all reset activeTool to 'select').
  useEffect(() => {
    if (activeTool !== 'pen') {
      setPenSnapCursor(null)
      setSnapGuides(null)
    }
  }, [activeTool])

  useEffect(() => {
    if (activeTool === 'drill' && pendingDrillPoints.length > 0) {
      useUIStore.getState().setNodeEditUndoRedo(drillUndo, null)
      useUIStore.getState().setNodeEditHistoryFlags(true, false)
    } else {
      drillPast.current = []
      if (useUIStore.getState().nodeEditUndo === drillUndo) {
        useUIStore.getState().setNodeEditUndoRedo(null, null)
        useUIStore.getState().setNodeEditHistoryFlags(false, false)
      }
    }
  }, [activeTool, pendingDrillPoints.length, drillUndo])

  const handleNodeMouseDown = useCallback((nodeIdx: number, kind: 'anchor' | 'handle-in' | 'handle-out', e: Konva.KonvaEventObject<MouseEvent>) => {
    if (kind === 'anchor' && (e.evt.altKey || altDownRef.current)) {
      e.cancelBubble = true
      e.evt.preventDefault()
      const old = editNodesRef.current
      const next = toggleNodeCurvature(old, nodeIdx, editClosedRef.current)
      pushLocalUndo(old, editClosedRef.current)
      setEditNodes(next)
      return
    }

    const vp = viewportRef.current
    const pointer = e.target.getStage()?.getPointerPosition()
    if (!pointer) return
    const cnc = { x: (pointer.x - vp.x) / vp.scale, y: (vp.y - pointer.y) / vp.scale }

    editDragInitRef.current = {
      initialNodes: editNodesRef.current.map((n) => ({
        ...n,
        handleIn: n.handleIn ? { ...n.handleIn } : undefined,
        handleOut: n.handleOut ? { ...n.handleOut } : undefined,
      })),
      startCNC: cnc,
    }
    didDragRef.current = false
    setMode2({ type: 'nodedit-drag', nodeIdx, kind })
    setDragNodeIdx(kind === 'anchor' ? nodeIdx : null)

    // Gather cross-path weld candidates when dragging an endpoint of an open path
    crossPathEntriesRef.current = []
    setCrossPathWeldTarget(null)
    if (kind === 'anchor' && !editClosedRef.current) {
      const curNodes = editNodesRef.current
      if (nodeIdx === 0 || nodeIdx === curNodes.length - 1) {
        const { nodeEditPathId: pid } = useUIStore.getState()
        const entries = collectCrossPathEntries(pid, visibleCNC(vp, sizeRef.current, curNodes[nodeIdx]))
        crossPathEntriesRef.current = entries
        setCrossPathCandidates(entries)
      }
    } else {
      setCrossPathCandidates([])
    }
  }, [setMode2])

  const handleSegmentMouseDown = useCallback((segIdx: number, cncX: number, cncY: number) => {
    const { nodeEditPathId: pid } = useUIStore.getState()
    if (!pid) return
    const old = editNodesRef.current
    const next = insertNodeOnSegment(old, segIdx, cncX, cncY, editClosedRef.current)
    pushLocalUndo(old, editClosedRef.current)
    setEditNodes(next)
  }, [pushLocalUndo])

  const handlePathDblClick = useCallback((id: string) => {
    const path = usePathsStore.getState().paths.find((p) => p.id === id)
    if (!path) return
    const subDs = splitCompoundPath(path.d)
    if (subDs.length > 1) {
      usePathsStore.getState().splitPath(id, subDs)
      return
    }
    const { setNodeEditPathId, setActiveTool } = useUIStore.getState()
    setActiveTool('select')
    usePathsStore.getState().selectPath(id)
    setNodeEditPathId(id)
  }, [])

  const handleHoveredNodeChange = useCallback((idx: number | null) => {
    setHoveredEditNode(idx)
  }, [])

  const handleStageDblClick = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    if (e.evt.button !== 0) return
    const { activeTool, nodeEditPathId: neid } = useUIStore.getState()
    if (activeTool !== 'select' && activeTool !== 'region') return
    const pointer = stageRef.current?.getPointerPosition()
    if (!pointer) return
    const vp = viewportRef.current
    const cnc = screenToCNC(pointer.x, pointer.y, vp)
    const { paths } = usePathsStore.getState()
    const candidates = paths.filter((p) => onCanvas(p) && p.id !== neid)
    const hit = closestVisiblePath(cnc.x, cnc.y, candidates, 8 / vp.scale, (p) => getFlat(p, 0.05))
    if (hit) handlePathDblClick(hit.id)
  }, [handlePathDblClick, getFlat])

  // Called by SelectionLayer resize handles
  const handleResizeHandleDown = useCallback((handle: HandleType, e: Konva.KonvaEventObject<MouseEvent>) => {
    if (e.evt.button !== 0) return

    // Handles only exist for the rendered selection, so the memoized bbox is current.
    const { selectedIds: ids } = usePathsStore.getState()
    const bbox = selectionBBoxRef.current
    if (!bbox) return
    // Belt-and-braces: the handles are not drawn for a scale-locked selection,
    // so this is unreachable through the UI — but a scale is one of the
    // gestures that silently changes what a mechanism IS, so it is refused
    // here as well rather than trusted to stay unreachable.
    if (selectionScaleLockedRef.current) return

    const { minX, minY, maxX, maxY, cx, cy } = bbox
    const midX = cx, midY = cy

    // Anchor = opposite corner/edge in CNC space
    const anchorMap: Record<HandleType, { x: number; y: number }> = {
      tl: { x: maxX, y: minY }, tr: { x: minX, y: minY },
      bl: { x: maxX, y: maxY }, br: { x: minX, y: maxY },
      t:  { x: midX, y: minY }, b:  { x: midX, y: maxY },
      l:  { x: maxX, y: midY }, r:  { x: minX, y: midY },
    }
    const handlePosMap: Record<HandleType, { x: number; y: number }> = {
      tl: { x: minX, y: maxY }, tr: { x: maxX, y: maxY },
      bl: { x: minX, y: minY }, br: { x: maxX, y: minY },
      t:  { x: midX, y: maxY }, b:  { x: midX, y: minY },
      l:  { x: minX, y: midY }, r:  { x: maxX, y: midY },
    }

    const allPaths = usePathsStore.getState().paths
    const { widthMM, heightMM } = useWorkpieceStore.getState()
    const snapTargets = collectSnapTargets(allPaths.filter(p => onCanvas(p) && !ids.includes(p.id)), { widthMM, heightMM })

    didDragRef.current = false
    setMode2({
      type: 'resize',
      pathIds: ids,
      handle,
      // The whole scale is measured from the anchor (see onMoveResize), so
      // "from centre" is just a different anchor — corner handles, edge handles
      // and Alt-skew all follow with no other change. Off, the opposite corner
      // stays put; on, the shape grows both ways about its middle, which keeps a
      // resized ring concentric with what it was cut around.
      //
      // It is the OBJECT's own parameter that decides (see ShapeParams.fromCenter),
      // not a tool setting, so a shape drawn that way goes on resizing that way
      // and it can be changed from the shape's own panel. ANY flagged path in the
      // selection is enough: scaling the group about its middle is the only
      // reading of "centred" that a mixed selection has.
      anchor: centreResizeRef.current ? { x: cx, y: cy } : anchorMap[handle],
      initHandle: handlePosMap[handle],
      initBbox: bbox,
      shiftHeld: e.evt.shiftKey,
      snapTargets,
    })
  }, [setMode2])

  // Called by SelectionLayer rotation handle
  const handleRotateHandleDown = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    if (e.evt.button !== 0) return

    const vp = viewportRef.current
    const { selectedIds: ids } = usePathsStore.getState()
    const bbox = selectionBBoxRef.current
    if (!bbox) return

    const pointer = e.target.getStage()?.getPointerPosition()
    if (!pointer) return
    const cncMouse = screenToCNC(pointer.x, pointer.y, vp)
    const initAngle = Math.atan2(cncMouse.y - bbox.cy, cncMouse.x - bbox.cx) * 180 / Math.PI

    didDragRef.current = false
    setMode2({ type: 'rotate', pathIds: ids, center: { x: bbox.cx, y: bbox.cy }, initAngle })
  }, [setMode2])

  const panStartRef = useRef({ mouseX: 0, mouseY: 0, vpX: 0, vpY: 0 })

  // ENTERING THE TOOL CLEARS THE SELECTION, and that is not tidiness: a selected
  // shape carries resize/rotate handles in the interactive layer ABOVE the
  // stage, and those swallow the click before the tool ever sees it — so the
  // points nearest a selected part were exactly the ones that could not be
  // picked. The handles are suppressed below as well; this is the other half,
  // and it also leaves the canvas clean to work on.
  useEffect(() => {
    const ui = useUIStore.getState()
    if (activeTool !== 'constrain') {
      setPickHeld(null)
      setPickCandidates([])
      setPickDrag(null)
      ui.setFocusConstraint(null)
      ui.setConstrainSubject([])
      return
    }
    // WHAT WAS SELECTED IS REMEMBERED FIRST. Clearing the selection also cleared
    // the panel's rows, so pressing the button with the part you were about to
    // work on selected emptied the very list you had just been reading. The
    // subject outlives the selection; see `constrainSubjectIds`.
    ui.setConstrainSubject(usePathsStore.getState().selectedIds)
    usePathsStore.getState().selectPath(null)
  }, [activeTool, setPickHeld])

  // Hover for the Constrain tool: which part is under the pointer, what points
  // it offers, and which of them a click would take. Recomputed per frame, which
  // is affordable because it only ever looks at ONE path — the one the proximity
  // search already found — rather than at the whole drawing.
  // Every pickable point in the drawing, built once and reused for the whole
  // session — one bbox flatten per body, not one per frame.
  const allCandidates = useMemo(
    () => (activeTool === 'constrain' ? allAnchorCandidates(paths) : []),
    [activeTool, paths])
  // Mirrored into a ref, and the hover handler reads THAT. `handleMouseMove` is
  // one big memoized dispatcher, so a per-frame handler reached through it is
  // only as fresh as that dispatcher's dependency list — and a candidate list
  // captured in a closure goes stale the moment anything moves, which showed as
  // markers sitting where each part was when it was drawn. The dependency is
  // listed as well; this is what makes it not matter if the next one is missed.
  const allCandidatesRef = useRef(allCandidates)
  allCandidatesRef.current = allCandidates

  // Hover for the Constrain tool.
  //
  // SEARCHED AS POINTS, NOT AS PATHS. Finding the path under the cursor first
  // and then offering its anchors only worked while the cursor was near an
  // OUTLINE, so the centre of a big circle and the corners of a large rectangle
  // could not be reached at all — they are nowhere near the geometry they belong
  // to, and zooming in made it worse. Two radii, both in SCREEN pixels so they
  // feel the same at every zoom: a generous one decides whose points to show, so
  // a part lights up as it is approached, and a tight one decides which point a
  // click would actually take.
  const onMoveConstrainHover = useCallback((cnc: { x: number; y: number }, vp: Viewport) => {
    const all = allCandidatesRef.current
    const near = nearestCandidate(all, cnc.x, cnc.y, PICK_SHOW_PX / vp.scale)
    // Falling back to the outline keeps a part's points visible while the cursor
    // is over its edge but not near any one of them.
    let bodyKey = near?.body ?? null
    if (!bodyKey) {
      const { paths: live } = usePathsStore.getState()
      const hit = closestVisiblePath(cnc.x, cnc.y, live.filter((p) => onCanvas(p)), 12 / vp.scale, (p) => getFlat(p, 0.05))
      const self = hit ? live.find((p) => p.id === hit.id) : undefined
      bodyKey = self ? bodyKeyOf(self) : null
    }
    const list = bodyKey ? all.filter((c) => c.body === bodyKey) : []
    setPickCandidates(list)
    setPickHot(nearestCandidate(list, cnc.x, cnc.y, PICK_HOT_PX / vp.scale))
  }, [getFlat, setPickHot])

  /**
   * Make the constraint between two picked points, from where the parts stand
   * NOW.
   *
   * Read off the live store rather than off the candidates' own coordinates:
   * those were measured when the markers were drawn, and the second point may
   * since have been dragged and baked. Same reason `measureBetween` exists at
   * all — what is created is what is already there.
   */
  const commitConstraint = useCallback((held: AnchorCandidate, hot: AnchorCandidate) => {
    const ui = useUIStore.getState()
    const paths = usePathsStore.getState().paths
    const { widthMM, heightMM } = useWorkpieceStore.getState()
    const now = measureBetween(paths, held.ref, hot.ref, { widthMM, heightMM })
    if (!now) { setPickHeld(null); return }
    const id = uid('con')
    // ALIGNMENT COMES WITH IT. A follower that does not turn with the part
    // holding it is the surprising case — the chain is meant to behave like the
    // group the user thinks it is — and holding the angle the parts ALREADY
    // stand at moves nothing, so this is free until something is rotated. Not
    // against the stock, which does not turn.
    const align = held.ref.kind === 'stock' || hot.ref.kind === 'stock'
      ? {} : { alignDeg: now.alignDeg }
    useConstraintsStore.getState().addConstraint(ui.constrainMode === 'xy'
      ? { id, mode: 'xy', from: held.ref, to: hot.ref, offsetXMM: now.offsetXMM, offsetYMM: now.offsetYMM, ...align }
      : { id, from: held.ref, to: hot.ref, distanceMM: now.distanceMM, angleDeg: now.angleDeg, ...align })
    setPickHeld(null)
    // Hand the keyboard to the new constraint's first number — two clicks and
    // then type, without reaching for the sidebar. Deliberately WITHOUT
    // selecting the two parts: a selection puts handles back over them and the
    // next pick cannot get through. The panel finds the constraint through
    // `focusConstraintId` instead, which is what that field is for.
    ui.setFocusConstraint(id)
  }, [setPickHeld])

  /** Which body a picked point belongs to, or null for a stock edge. */
  const bodyOfRef = useCallback((r: AnchorCandidate['ref']): string | null => {
    if (r.kind === 'stock') return null
    const p = usePathsStore.getState().paths.find((q) => q.id === r.id)
    return p ? bodyKeyOf(p) : null
  }, [])

  /** Take a point. The second one creates the constraint. */
  const onConstrainClick = useCallback(() => {
    const hot = pickHotRef.current
    if (!hot) return
    const held = pickHeldRef.current
    if (!held) {
      // A new pick supersedes the last constraint's row: `focusConstraintId` is
      // what keeps that row on screen with nothing selected, so it has to go
      // when the user moves on, or the panel would show a stale one while the
      // next dimension is being drawn.
      useUIStore.getState().setFocusConstraint(null)
      setPickHeld(hot)
      return
    }
    // Two points on the SAME body is a measurement, not a constraint — a part
    // cannot hold itself at a distance from itself, and the solver ignores it.
    // Treat the second click as re-picking the first instead of making a dud.
    const heldBody = bodyOfRef(held.ref)
    if (heldBody !== null && heldBody === bodyOfRef(hot.ref)) { setPickHeld(hot); return }
    commitConstraint(held, hot)
  }, [pickHotRef, pickHeldRef, setPickHeld, commitConstraint, bodyOfRef])

  // The dimension being made is built by ConstraintLayerLive, which reads the cursor itself.

  const handleStageMouseDown = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    if (connectSourceRef.current !== null) {
      if (crossPathWeldTargetRef.current !== null) {
        // Snapped to a cross-path node — let mouseup complete the connection
        didDragRef.current = false
        return
      }
      clearConnectState()
    }
    if (e.evt.button === 1 || spaceHeldRef.current) {
      e.evt.preventDefault()
      const vp = viewportRef.current
      panStartRef.current = { mouseX: e.evt.clientX, mouseY: e.evt.clientY, vpX: vp.x, vpY: vp.y }
      setMode2({ type: 'pan' })
      return
    }
    if (e.evt.button !== 0) return

    const { activeTool, nodeEditPathId: neid } = useUIStore.getState()

    // Pen tool — start placing a node
    if (activeTool === 'pen') {
      const stagePointer = stageRef.current?.getPointerPosition()
      if (stagePointer) startPenDraw(stagePointer)
      return
    }

    // Constrain tool: a click takes a point. Never a selection change or a drag
    // box — the tool owns the click while it is on.
    //
    // THE SECOND POINT MAY BE DRAGGED THERE. Once the first point is down, a
    // press on a point of ANOTHER part starts moving that part, and mouseup
    // creates the constraint holding wherever it was let go — so an offset can
    // be dialled in by eye, with the numbers live on the dimension, instead of
    // being placed and then typed. A press that never moves is still a click and
    // still just takes the point (see `handleMouseUp`), so nothing about the
    // two-click gesture changes.
    if (activeTool === 'constrain') {
      didDragRef.current = false
      const heldPick = pickHeldRef.current
      const hotPick = pickHotRef.current
      const hotRef = hotPick?.ref
      const heldBody = heldPick ? bodyOfRef(heldPick.ref) : null
      const hotBody = hotPick ? bodyOfRef(hotPick.ref) : null
      if (heldPick && hotPick && hotRef && hotRef.kind !== 'stock' && hotBody !== null && hotBody !== heldBody) {
        const stagePointer = stageRef.current?.getPointerPosition()
        const vp = viewportRef.current
        if (stagePointer) {
          const cnc = screenToCNC(stagePointer.x, stagePointer.y, vp)
          const { paths: allPaths } = usePathsStore.getState()
          // The whole BODY, which is the unit a constraint moves — dragging a
          // gear's rim away from its bore would take the gear apart.
          const moveIds = bodyPathsOf(allPaths, hotRef.id).map((p) => p.id)
          if (moveIds.length > 0) {
            const moveBbox = getMultiBBox(allPaths.filter((p) => moveIds.includes(p.id)).map((p) => p.d))
            const { widthMM, heightMM } = useWorkpieceStore.getState()
            const snapTargets = collectSnapTargets(
              allPaths.filter((p) => onCanvas(p) && !moveIds.includes(p.id)), { widthMM, heightMM })
            constraintPlanRef.current = planConstraints(
              allPaths, useConstraintsStore.getState().constraints, { widthMM, heightMM }, moveIds).plan
            setPickDrag(null)
            setMode2({
              type: 'move', pathIds: moveIds, startCNC: cnc, snapTargets,
              initBbox: moveBbox ?? { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0, cx: 0, cy: 0 },
              pick: { held: heldPick, hot: hotPick },
            })
            return
          }
        }
      }
      onConstrainClick()
      setMode2({ type: 'idle' })
      return
    }

    // Drill tool: capture click for placement in mouseup, don't deselect or start dragbox
    if (activeTool === 'drill') {
      didDragRef.current = false
      setMode2({ type: 'idle' })
      return
    }

    // Shape draw tool active
    if (activeTool !== 'select' && activeTool !== 'region') {
      const stagePointer = stageRef.current?.getPointerPosition()
      if (stagePointer) startDrawShape(stagePointer)
      return
    }

    const stagePointer = stageRef.current?.getPointerPosition()
    if (!stagePointer) return
    const vp = viewportRef.current
    const cnc = screenToCNC(stagePointer.x, stagePointer.y, vp)

    // Find the closest visible path within 8 screen pixels
    const { paths } = usePathsStore.getState()
    const candidates = paths.filter((p) => onCanvas(p) && p.id !== neid)
    const hit = closestVisiblePath(cnc.x, cnc.y, candidates, 8 / vp.scale, (p) => getFlat(p, 0.05))

    if (hit) {
      if (neid && neid !== hit.id) exitNodeEdit()
      const { selectedIds: currentIds, paths: allNow } = usePathsStore.getState()
      // A user group is ONE thing to click: hitting any member takes the whole
      // group. Alt is the way back to a single path inside one — double-click is
      // already point-edit/split, and the paths list reaches a member directly.
      const hitIds = e.evt.altKey ? [hit.id] : expandUserGroups([hit.id], allNow)
      if (e.evt.shiftKey) {
        // Toggle the whole group's membership, not one path's: half a group in
        // the selection is a state no click could get back out of.
        const allIn = hitIds.every((id) => currentIds.includes(id))
        usePathsStore.getState().setSelectedIds(allIn
          ? currentIds.filter((id) => !hitIds.includes(id))
          : [...currentIds, ...hitIds.filter((id) => !currentIds.includes(id))])
      } else if (!currentIds.includes(hit.id)) {
        usePathsStore.getState().setSelectedIds(hitIds)
      }
      didDragRef.current = false
      const moveIds = usePathsStore.getState().selectedIds
      const allPaths = usePathsStore.getState().paths
      const moveBbox = getMultiBBox(allPaths.filter(p => moveIds.includes(p.id)).map(p => p.d))
      const { widthMM, heightMM } = useWorkpieceStore.getState()
      const snapTargets = collectSnapTargets(allPaths.filter(p => onCanvas(p) && !moveIds.includes(p.id)), { widthMM, heightMM })
      constraintPlanRef.current = planConstraints(
        allPaths, useConstraintsStore.getState().constraints, { widthMM, heightMM }, moveIds).plan
      setMode2({ type: 'move', pathIds: moveIds, startCNC: cnc, initBbox: moveBbox ?? { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0, cx: 0, cy: 0 }, snapTargets })
    } else {
      if (neid) { exitNodeEdit(); return }
      // Region picking (on while the Pocket form is open) decides on mouseup: a
      // press that never moves picks the enclosed area under it, so the selection
      // has to survive until then — a drag is still a drag box.
      if (activeTool !== 'region') selectPath(null)
      didDragRef.current = false
      setMode2({ type: 'dragbox', startScreen: { x: stagePointer.x, y: stagePointer.y } })
      setDragBox({ sx: stagePointer.x, sy: stagePointer.y, ex: stagePointer.x, ey: stagePointer.y })
    }
  }, [selectPath, setMode2, startDrawShape, startPenDraw, exitNodeEdit, getFlat,
      onConstrainClick, bodyOfRef, pickHeldRef, pickHotRef])


  // ─── per-mode mousemove handlers ──────────────────────────────────────────
  // handleMouseMove was a ~275-line chain of `if (m.type === …)` guards. Each
  // one is its own callback now; the dispatcher below keeps the ORIGINAL control
  // flow, which is not a plain switch: pan/move/resize/rotate consume the event,
  // but dragbox and drawshape deliberately fall through to the pen close-hover
  // check, and idle runs both that and the connect preview. Collapsing those
  // into returning switch cases would silently kill the pen hover indicator.
  // All handlers close over the same refs/setters and share one dependency list
  // of stable references, so this is a pure restructuring.

  const onMovePan = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    // Pan uses clientX/Y deltas — both are in screen pixels so delta is correct
    const { mouseX, mouseY, vpX, vpY } = panStartRef.current
    setViewport((v) => ({ ...v, x: vpX + (e.evt.clientX - mouseX), y: vpY + (e.evt.clientY - mouseY) }))
  }, [setCursorMM, setViewport, setLiveRotationAngle, snapCNC, snapPenPoint])

  const onMoveTranslate = useCallback((m: Extract<CanvasMode, { type: 'move' }>, cncMouse: { x: number; y: number }, pointer: { x: number; y: number }, vp: Viewport) => {
    const dx = cncMouse.x - m.startCNC.x
    const dy = cncMouse.y - m.startCNC.y
    // Threshold check in stage pixels
    const startScreenX = vp.x + m.startCNC.x * vp.scale
    const startScreenY = vp.y - m.startCNC.y * vp.scale
    if (Math.hypot(pointer.x - startScreenX, pointer.y - startScreenY) > MOVE_THRESHOLD_PX) {
      didDragRef.current = true
    }
    if (didDragRef.current) {
      let finalDx = dx, finalDy = dy
      if (shiftHeldRef.current) {
        if (Math.abs(dx) > Math.abs(dy)) finalDy = 0
        else finalDx = 0
      }
      // Object snap first (bbox edges/centers to other shapes' edges/centers),
      // then grid snap only on the axes that didn't object-snap.
      const ib = m.initBbox
      const snapOn = useUIStore.getState().snapEnabled
      const tolMM = OBJECT_SNAP_PX / vp.scale
      const ox = snapOn ? snapAxisDelta([ib.minX + finalDx, ib.maxX + finalDx, ib.cx + finalDx], m.snapTargets.xs, tolMM) : null
      const oy = snapOn ? snapAxisDelta([ib.minY + finalDy, ib.maxY + finalDy, ib.cy + finalDy], m.snapTargets.ys, tolMM) : null
      if (ox) finalDx += ox.correction
      if (oy) finalDy += oy.correction
      const gridSnapped = snapCNC({ x: ib.minX + finalDx, y: ib.minY + finalDy })
      if (!ox) finalDx = gridSnapped.x - ib.minX
      if (!oy) finalDy = gridSnapped.y - ib.minY
      setSnapGuides(ox || oy ? { x: ox?.guide, y: oy?.guide } : null)
      setLiveTransform({ kind: 'translate', pathIds: new Set(m.pathIds), dx: finalDx, dy: finalDy })
      setLiveBBox({ minX: ib.minX + finalDx, minY: ib.minY + finalDy, width: ib.width, height: ib.height })
      // The Constrain tool's second point riding along: the dimension being made
      // is redrawn from this, so the numbers on it are the ones mouseup stores.
      if (m.pick) setPickDrag({ dx: finalDx, dy: finalDy })
      // Everything the constraints carry along, previewed with the drag. The
      // dragged bodies are in here too — a part pinned to a stock edge is
      // CORRECTED by its constraint rather than following the cursor, and the
      // preview has to show that or the part jumps on mouse-up.
      // A move-drag turns nothing, so `mv.rotDeg` is absent on every move it can
      // produce (a follower only turns when the part holding it CHANGES ANGLE,
      // and a translation cannot) — which is why one transform per body is
      // enough here, DesignLayer taking the first that matches a path.
      const plan = constraintPlanRef.current
      setFollowTransforms(plan
        ? runPlan(plan, { dx: finalDx, dy: finalDy }).map((mv) => ({
          kind: 'translate' as const, pathIds: new Set(mv.pathIds), dx: mv.dx, dy: mv.dy,
        }))
        : null)
    }
  }, [setCursorMM, setViewport, setLiveRotationAngle, snapCNC, snapPenPoint])

  const onMoveResize = useCallback((m: Extract<CanvasMode, { type: 'resize' }>, cncMouse: { x: number; y: number }, e: Konva.KonvaEventObject<MouseEvent>, vp: Viewport) => {
    didDragRef.current = true
    const { anchor, initHandle, pathIds, handle, shiftHeld } = m
    const isCorner = handle === 'tl' || handle === 'tr' || handle === 'bl' || handle === 'br'
    // An image refuses skew (see selectionSkewLocked); Alt then just scales.
    const skewing = (altDownRef.current || e.evt.altKey) && isCorner && !selectionSkewLockedRef.current

    // The dragged handle IS the moving edge/corner of the bbox (the anchor is the
    // opposite one and stays put), so object-snapping the handle position aligns
    // those edges to other shapes' edges/centers — same targets and guides as a
    // drag. Grid snap then applies only on the axes that didn't object-snap.
    // Uniform (Shift) scaling and Alt-skew derive both axes from one combined
    // gesture, so a per-axis snap would draw a guide the shape never lands on:
    // those keep plain grid snap and no guides.
    const snapOn = useUIStore.getState().snapEnabled && !skewing && !(shiftHeld && isCorner)
    const tolMM = OBJECT_SNAP_PX / vp.scale
    // Edge handles only move one axis; the other is the bbox mid-line and must not snap.
    const ox = snapOn && handle !== 't' && handle !== 'b' ? snapAxisDelta([cncMouse.x], m.snapTargets.xs, tolMM) : null
    const oy = snapOn && handle !== 'l' && handle !== 'r' ? snapAxisDelta([cncMouse.y], m.snapTargets.ys, tolMM) : null
    const gridSnapped = snapCNC(cncMouse)
    const snappedMouse = {
      x: ox ? cncMouse.x + ox.correction : gridSnapped.x,
      y: oy ? cncMouse.y + oy.correction : gridSnapped.y,
    }
    setSnapGuides(ox || oy ? { x: ox?.guide, y: oy?.guide } : null)

    const dhx = initHandle.x - anchor.x
    const dhy = initHandle.y - anchor.y
    const newHx = snappedMouse.x - anchor.x
    const newHy = snappedMouse.y - anchor.y

    // Alt + corner handle = skew (shear) instead of scale
    if (skewing) {
      const dx = newHx - dhx
      const dy = newHy - dhy
      const kx = Math.abs(dx) >= Math.abs(dy) && dhy !== 0 ? dx / dhy : 0
      const ky = Math.abs(dy) >  Math.abs(dx) && dhx !== 0 ? dy / dhx : 0
      setLiveTransform({ kind: 'skew', pathIds: new Set(pathIds), kx, ky, ax: anchor.x, ay: anchor.y })
      return
    }

    let sx = dhx !== 0 ? newHx / dhx : 1
    let sy = dhy !== 0 ? newHy / dhy : 1

    // Edge handles constrain one axis
    if (handle === 't' || handle === 'b') sx = 1
    if (handle === 'l' || handle === 'r') sy = 1

    // Uniform scale for corners with Shift
    if (shiftHeld && !['t','b','l','r'].includes(handle)) {
      const s = Math.sign(sx) * Math.hypot(newHx, newHy) / Math.hypot(dhx, dhy)
      sx = s; sy = Math.sign(sy) * Math.abs(s)
    }

    // Prevent degenerate scales
    if (Math.abs(sx) < 0.001) sx = Math.sign(sx) * 0.001
    if (Math.abs(sy) < 0.001) sy = Math.sign(sy) * 0.001

    setLiveTransform({ kind: 'scale', pathIds: new Set(pathIds), sx, sy, ax: anchor.x, ay: anchor.y })
    const ib = m.initBbox
    const x1 = anchor.x + (ib.minX - anchor.x) * sx, x2 = anchor.x + (ib.maxX - anchor.x) * sx
    const y1 = anchor.y + (ib.minY - anchor.y) * sy, y2 = anchor.y + (ib.maxY - anchor.y) * sy
    setLiveBBox({ minX: Math.min(x1, x2), minY: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) })
  }, [setCursorMM, setViewport, setLiveRotationAngle, snapCNC, snapPenPoint])

  const onMoveRotate = useCallback((m: Extract<CanvasMode, { type: 'rotate' }>, cncMouse: { x: number; y: number }) => {
    didDragRef.current = true
    const currentAngle = Math.atan2(cncMouse.y - m.center.y, cncMouse.x - m.center.x) * 180 / Math.PI
    let delta = currentAngle - m.initAngle
    if (useUIStore.getState().snapEnabled) delta = Math.round(delta / 5) * 5
    setLiveTransform({ kind: 'rotate', pathIds: new Set(m.pathIds), angle: delta, cx: m.center.x, cy: m.center.y })
    setLiveRotationAngle(delta)
  }, [setCursorMM, setViewport, setLiveRotationAngle, snapCNC, snapPenPoint])

  const onMoveDragbox = useCallback((pointer: { x: number; y: number }) => {
    const db = dragBoxRef.current
    if (db) setDragBox({ ...db, ex: pointer.x, ey: pointer.y })
  }, [setCursorMM, setViewport, setLiveRotationAngle, snapCNC, snapPenPoint])

  const onMoveDrawShape = useCallback((m: Extract<CanvasMode, { type: 'drawshape' }>, cncMouse: { x: number; y: number }, pointer: { x: number; y: number }, vp: Viewport) => {
    const startScreenX = vp.x + m.startCNC.x * vp.scale
    const startScreenY = vp.y - m.startCNC.y * vp.scale
    if (Math.hypot(pointer.x - startScreenX, pointer.y - startScreenY) > MOVE_THRESHOLD_PX) {
      didDragRef.current = true
    }
    const snappedCNC = snapCNC(cncMouse)
    // Update currentCNC in the mode ref (no state re-render needed — liveShapeD handles rendering)
    modeRef.current = { ...m, currentCNC: snappedCNC }

    if (didDragRef.current) {
      const { activeTool, shapeToolConfig, shapeFromCenter } = useUIStore.getState()
      if (activeTool !== 'select') {
        const type = activeTool as ShapeType
        // A mechanism sized by its own parameters ignores the drag's SIZE but
        // not its destination: it previews at full size under the cursor and
        // lands where the drag is released. Sizing it by how far the cursor
        // travelled would be the same nonsense the resize handles refuse (see
        // SCALE_LOCKED_SHAPES): a gear dragged to m4.37 meshes with nothing.
        const params = SCALE_LOCKED_SHAPES.has(type)
          ? shapeParamsFromConfig(type, snappedCNC.x, snappedCNC.y, shapeToolConfig)
          : shapeParamsFromDrag(type, m.startCNC, snappedCNC, shapeToolConfig, shapeFromCenter)
        setLiveShapeD(generateShapeD(params))
      }
    }
  }, [setCursorMM, setViewport, setLiveRotationAngle, snapCNC, snapPenPoint])

  // Runs for every mode EXCEPT pendraw — highlights the pen's first node when
  // the cursor is near enough to close the path, and tracks the snapped cursor.
  const onMovePenHover = useCallback((cncMouse: { x: number; y: number }, pointer: { x: number; y: number }, vp: Viewport) => {
    const { activeTool: at, penNodes: nodes } = useUIStore.getState()
    if (at === 'pen') {
      const snap = snapPenPoint(cncMouse)
      setPenSnapCursor(snap.point)
      setSnapGuides(snap.guides)
    }
    if (at === 'pen' && nodes.length >= 2) {
      const first = nodes[0]
      const fsx = vp.x + first.x * vp.scale
      const fsy = vp.y - first.y * vp.scale
      const close = Math.hypot(pointer.x - fsx, pointer.y - fsy) < 10
      if (close !== penClosingRef.current) {
        setPenClosing(close)
      }
    } else if (penClosingRef.current) {
      setPenClosing(false)
    }
  }, [setCursorMM, setViewport, setLiveRotationAngle, snapCNC, snapPenPoint])

  const onMoveConnectPreview = useCallback((cncMouse: { x: number; y: number }, vp: Viewport) => {
    // Caller already checks this, but the narrowing doesn't cross the call.
    const srcIdx = connectSourceRef.current
    if (srcIdx === null) return
    const nodes = editNodesRef.current
    if (nodes[srcIdx]) {
      const snapMM = 16 / vp.scale
      let bestDist = snapMM
      let snapSameIdx: number | null = null
      let snapCrossEntry: CrossPathEntry | null = null
      let snapPos = cncMouse

      for (let j = 0; j < nodes.length; j++) {
        if (j === srcIdx) continue
        const dist = Math.hypot(cncMouse.x - nodes[j].x, cncMouse.y - nodes[j].y)
        if (dist < bestDist) {
          bestDist = dist
          snapSameIdx = j
          snapPos = { x: nodes[j].x, y: nodes[j].y }
        }
      }

      for (const cand of crossPathEntriesRef.current) {
        const dist = Math.hypot(cncMouse.x - cand.x, cncMouse.y - cand.y)
        if (dist < bestDist) {
          bestDist = dist
          snapCrossEntry = cand
          snapSameIdx = null
        }
      }
      if (snapCrossEntry) {
        // As in the drag weld: the thinned rings choose the PATH, the full node
        // list of that path chooses the node.
        snapCrossEntry = refineCrossEntry(snapCrossEntry, cncMouse)
        snapPos = { x: snapCrossEntry.x, y: snapCrossEntry.y }
      }

      setConnectPreviewTo(snapPos)
      setConnectSnapTargetIdx(snapSameIdx)
      setCrossPathWeldTarget(snapCrossEntry)
    }
  }, [setCursorMM, setViewport, setLiveRotationAngle, snapCNC, snapPenPoint])

  const onMovePenDraw = useCallback((m: Extract<CanvasMode, { type: 'pendraw' }>, cncMouse: { x: number; y: number }, pointer: { x: number; y: number }, vp: Viewport) => {
    const asx = vp.x + m.anchorCNC.x * vp.scale
    const asy = vp.y - m.anchorCNC.y * vp.scale
    if (Math.hypot(pointer.x - asx, pointer.y - asy) > MOVE_THRESHOLD_PX) {
      didDragRef.current = true
    }
    if (didDragRef.current && !m.closing) {
      // Only track drag handles in bezier mode; other modes auto-compute curves
      if (useUIStore.getState().penCurveType === 'bezier') {
        setLivePen({ anchor: m.anchorCNC, handle: cncMouse })
      }
    }
  }, [setCursorMM, setViewport, setLiveRotationAngle, snapCNC, snapPenPoint])

  const onMoveNodeEditDrag = useCallback((m: Extract<CanvasMode, { type: 'nodedit-drag' }>, cncMouse: { x: number; y: number }, e: Konva.KonvaEventObject<MouseEvent>) => {
    // Caller already checks init, but the narrowing doesn't cross the call.
    const init = editDragInitRef.current
    if (!init) return
    didDragRef.current = true
    const dx = cncMouse.x - init.startCNC.x
    const dy = cncMouse.y - init.startCNC.y
    const WELD_THRESHOLD_MM = 16 / viewportRef.current.scale
    let newWeldTarget: number | null = null
    let newCrossTarget: CrossPathEntry | null = null
    const updatedNodes = init.initialNodes.map((n, i) => {
      if (i !== m.nodeIdx) return n
      if (m.kind === 'anchor') {
        const snapped = snapCNC({ x: n.x + dx, y: n.y + dy })
        const sdx = snapped.x - n.x
        const sdy = snapped.y - n.y
        // Check for same-path weld snap first
        for (let j = 0; j < init.initialNodes.length; j++) {
          if (j === m.nodeIdx) continue
          const other = init.initialNodes[j]
          const distSq = (snapped.x - other.x) ** 2 + (snapped.y - other.y) ** 2
          if (distSq < WELD_THRESHOLD_MM ** 2) {
            newWeldTarget = j
            const wdx = other.x - n.x
            const wdy = other.y - n.y
            return { ...n, x: other.x, y: other.y,
              handleIn: n.handleIn ? { x: n.handleIn.x + wdx, y: n.handleIn.y + wdy } : undefined,
              handleOut: n.handleOut ? { x: n.handleOut.x + wdx, y: n.handleOut.y + wdy } : undefined,
            }
          }
        }
        // Check for cross-path weld snap (only available for endpoints of open paths)
        for (const cand of crossPathEntriesRef.current) {
          const distSq = (snapped.x - cand.x) ** 2 + (snapped.y - cand.y) ** 2
          if (distSq < WELD_THRESHOLD_MM ** 2) {
            // The rings drawn for a closed path are a thinned set; the weld
            // itself lands on the node actually nearest the cursor.
            const entry = refineCrossEntry(cand, snapped)
            newCrossTarget = entry
            const wdx = entry.x - n.x
            const wdy = entry.y - n.y
            return { ...n, x: entry.x, y: entry.y,
              handleIn: n.handleIn ? { x: n.handleIn.x + wdx, y: n.handleIn.y + wdy } : undefined,
              handleOut: n.handleOut ? { x: n.handleOut.x + wdx, y: n.handleOut.y + wdy } : undefined,
            }
          }
        }
        return {
          ...n,
          x: snapped.x,
          y: snapped.y,
          handleIn: n.handleIn ? { x: n.handleIn.x + sdx, y: n.handleIn.y + sdy } : undefined,
          handleOut: n.handleOut ? { x: n.handleOut.x + sdx, y: n.handleOut.y + sdy } : undefined,
        }
      }
      if (m.kind === 'handle-in') {
        const handleIn = { x: (n.handleIn?.x ?? n.x) + dx, y: (n.handleIn?.y ?? n.y) + dy }
        const handleOut = (altDownRef.current || e.evt.altKey) && n.handleOut
          ? { x: 2 * n.x - handleIn.x, y: 2 * n.y - handleIn.y }
          : n.handleOut
        return { ...n, handleIn, handleOut }
      }
      const handleOut = { x: (n.handleOut?.x ?? n.x) + dx, y: (n.handleOut?.y ?? n.y) + dy }
      const handleIn = (altDownRef.current || e.evt.altKey) && n.handleIn
        ? { x: 2 * n.x - handleOut.x, y: 2 * n.y - handleOut.y }
        : n.handleIn
      return { ...n, handleIn, handleOut }
    })
    setWeldTargetIdx(newWeldTarget)
    setCrossPathWeldTarget(newCrossTarget)
    setEditNodes(updatedNodes)
  }, [setCursorMM, setViewport, setLiveRotationAngle, snapCNC, snapPenPoint])

  const moveBody = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    const stage = stageRef.current
    const vp = viewportRef.current

    // Stage pointer position is in Konva stage coords (same as container coords)
    const pointer = stage?.getPointerPosition()

    if (pointer) {
      setCursorMM({ x: (pointer.x - vp.x) / vp.scale, y: (vp.y - pointer.y) / vp.scale })
    }

    const m = modeRef.current

    // Pan works off screen-pixel deltas, so it runs before the CNC conversion
    // and without needing a stage pointer.
    if (m.type === 'pan') return onMovePan(e)

    if (!pointer) return
    const cncMouse = screenToCNC(pointer.x, pointer.y, vp)

    // Modes that fully consume the move.
    if (m.type === 'move')   return onMoveTranslate(m, cncMouse, pointer, vp)
    if (m.type === 'resize') return onMoveResize(m, cncMouse, e, vp)
    if (m.type === 'rotate') return onMoveRotate(m, cncMouse)

    // Modes that handle the move and then fall through to the shared checks.
    if (m.type === 'dragbox')   onMoveDragbox(pointer)
    if (m.type === 'drawshape') onMoveDrawShape(m, cncMouse, pointer, vp)

    if (m.type !== 'pendraw') onMovePenHover(cncMouse, pointer, vp)

    if (m.type === 'idle' && connectSourceRef.current !== null) onMoveConnectPreview(cncMouse, vp)
    if (useUIStore.getState().activeTool === 'constrain') { onMoveConstrainHover(cncMouse, vp); return }
    if (useUIStore.getState().activeTool === 'region') {
      if (m.type === 'idle') onMoveRegionHover(cncMouse, vp)
      else setRegionPreviewD(null)
    }
    if (m.type === 'pendraw') onMovePenDraw(m, cncMouse, pointer, vp)
    if (m.type === 'clocklink-drag') { onMoveClockLink(m, cncMouse, e.evt.shiftKey); return }
    if (m.type === 'nodedit-drag' && editDragInitRef.current) onMoveNodeEditDrag(m, cncMouse, e)
  }, [setCursorMM, onMovePan, onMoveTranslate, onMoveResize, onMoveRotate, onMoveDragbox,
      onMoveDrawShape, onMovePenHover, onMoveConnectPreview, onMovePenDraw, onMoveNodeEditDrag,
      onMoveConstrainHover, onMoveRegionHover])

  const handleMouseMove = moveBody


  // Shared commit for the move/resize/skew/rotate bakes: batch-update the
  // touched paths and regenerate each affected operation ONCE (bugs.md H1/R4).
  // `gesture` names the timeline chip (Move/Scale/Rotate/Skew).
  const bakeTransform = useCallback((pathIds: string[], gesture: PathEditGesture, makeUpdate: (p: ImportedPath) => PathUpdate) => {
    const { paths: allPaths, batchUpdatePaths } = usePathsStore.getState()
    const updates = pathIds.flatMap((id) => {
      const path = allPaths.find((p) => p.id === id)
      return path ? [makeUpdate(path)] : []
    })
    if (updates.length) {
      batchUpdatePaths(updates, gesture)
      regenerateAffectedMany(pathIds)
    }
  }, [])

  // ARROW KEYS NUDGE THE SELECTION — 1 mm (0.1" in inch mode), Shift ×10, Alt ÷10.
  // A run of presses is ONE move: each press only previews (the same liveTransform
  // a drag uses, constraint followers included) and the bake lands once the keys go
  // quiet, so holding an arrow down neither floods the history with Move chips nor
  // regenerates every affected toolpath on each key repeat. Anything else — a click
  // anywhere, any other key, the window losing focus — commits the pending nudge
  // first, so an undo or a drag never starts on top of a half-done one.
  useEffect(() => {
    const NUDGE_COMMIT_MS = 400
    const DIRS: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1],
    }
    // A nudge does not snap within a window — it STOPS on a line it would cross
    // (`nudgeStopDelta`) — so its guides say EXACTLY aligned; the drag's 8 px
    // window would draw a guide under an edge still visibly short of the line.
    const ALIGNED_MM = 0.005
    type Pending = {
      ids: string[]; dx: number; dy: number; timer: number
      bbox: BBox | null
      plan: ReturnType<typeof planConstraints>['plan']
      targets: ReturnType<typeof collectSnapTargets>
    }
    let pending: Pending | null = null
    // The guides OUTLIVE the commit: the bake lands just as the user is looking to
    // see whether the edges line up. There is no mouseup to end the gesture, so
    // they go on the next thing the user does instead — a click, another key,
    // leaving the window — or on the next press that aligns nothing.
    let guidesShown = false
    const clearGuides = () => {
      if (!guidesShown) return
      guidesShown = false
      setSnapGuides(null)
    }

    const flush = () => {
      if (!pending) return
      const { ids, dx, dy, timer } = pending
      window.clearTimeout(timer)
      pending = null
      if (dx !== 0 || dy !== 0) {
        const step: TransformStep = { kind: 'translate', dx, dy }
        bakeTransform(ids, 'move', (path) => {
          const r = applyTransformStep(path, step)
          return { id: path.id, d: r.d, shapeParams: r.shapeParams, transforms: [step] }
        })
      }
      setLiveTransform(null)
      setFollowTransforms(null)
      setLiveBBox(null)
    }

    const onKey = (e: KeyboardEvent) => {
      // A modifier pressed mid-run changes the step, not the gesture.
      if (e.key === 'Shift' || e.key === 'Alt' || e.key === 'Control' || e.key === 'Meta') return
      const dir = DIRS[e.key]
      if (!dir) { flush(); clearGuides(); return }
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return
      if (e.ctrlKey || e.metaKey) return
      if (modeRef.current.type !== 'idle') return
      const ui = useUIStore.getState()
      if ((ui.activeTool !== 'select' && ui.activeTool !== 'region') || ui.nodeEditPathId) return
      const { selectedIds, paths: allPaths } = usePathsStore.getState()
      if (selectedIds.length === 0) return
      e.preventDefault()

      if (pending && (pending.ids.length !== selectedIds.length || pending.ids.some((id, i) => id !== selectedIds[i]))) flush()
      if (!pending) {
        const { widthMM, heightMM } = useWorkpieceStore.getState()
        pending = {
          ids: selectedIds, dx: 0, dy: 0, timer: 0,
          bbox: getMultiBBox(allPaths.filter((p) => selectedIds.includes(p.id)).map((p) => p.d)),
          plan: planConstraints(allPaths, useConstraintsStore.getState().constraints, { widthMM, heightMM }, selectedIds).plan,
          // The same targets a drag aligns to: every other shape's edges and centre, and the stock's.
          targets: collectSnapTargets(allPaths.filter((q) => onCanvas(q) && !selectedIds.includes(q.id)), { widthMM, heightMM }),
        }
      }
      const base = useWorkpieceStore.getState().units === 'in' ? 2.54 : 1
      const stepMM = base * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1)
      const p = pending
      const b = p.bbox
      // Snap on, a press goes to the NEXT MULTIPLE OF THE STEP — measured as the
      // drag's grid snap measures it, the bbox's min corner from the stock origin —
      // and a guide line it would jump over on the way is a STOP. Measured off the
      // stock rather than off where the press started, a stop on a guide does not
      // shift the presses after it, and neither does the commit resetting dx to 0.
      // Snap off (S), a press is a plain step and goes straight through.
      const stepAxis = (axis: 0 | 1, cur: number): number => {
        const d = dir[axis]
        if (d === 0 || !b || !useUIStore.getState().snapEnabled) return cur + d * stepMM
        const { origin, widthMM, heightMM } = useWorkpieceStore.getState()
        const org = originWorldXY(origin, widthMM, heightMM)
        const [lo, hi, mid, o, targets] = axis === 0
          ? [b.minX, b.maxX, b.cx, org.x, p.targets.xs]
          : [b.minY, b.maxY, b.cy, org.y, p.targets.ys]
        const onStep = nextStepPoint(lo + cur - o, stepMM, d, ALIGNED_MM) + o - lo
        return nudgeStopDelta([lo, hi, mid], targets, cur, onStep, ALIGNED_MM)
      }
      // Rounded so ten 0.1 mm taps land on 1 mm, not 0.9999999999999999.
      p.dx = Math.round(stepAxis(0, p.dx) * 1e6) / 1e6
      p.dy = Math.round(stepAxis(1, p.dy) * 1e6) / 1e6

      setLiveTransform({ kind: 'translate', pathIds: new Set(p.ids), dx: p.dx, dy: p.dy })
      if (p.bbox) {
        const b = p.bbox
        setLiveBBox({ minX: b.minX + p.dx, minY: b.minY + p.dy, width: b.width, height: b.height })
        const ox = snapAxisDelta([b.minX + p.dx, b.maxX + p.dx, b.cx + p.dx], p.targets.xs, ALIGNED_MM)
        const oy = snapAxisDelta([b.minY + p.dy, b.maxY + p.dy, b.cy + p.dy], p.targets.ys, ALIGNED_MM)
        guidesShown = !!(ox || oy)
        setSnapGuides(guidesShown ? { x: ox?.guide, y: oy?.guide } : null)
      }
      setFollowTransforms(p.plan
        ? runPlan(p.plan, { dx: p.dx, dy: p.dy }).map((mv) => ({
          kind: 'translate' as const, pathIds: new Set(mv.pathIds), dx: mv.dx, dy: mv.dy,
        }))
        : null)
      window.clearTimeout(p.timer)
      p.timer = window.setTimeout(flush, NUDGE_COMMIT_MS)
    }

    // Capture phase, so the commit lands before App's Ctrl+Z handler or the
    // stage's mousedown ever sees the event.
    const commitAndClear = () => { flush(); clearGuides() }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', commitAndClear, true)
    window.addEventListener('blur', commitAndClear)
    return () => {
      commitAndClear()
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', commitAndClear, true)
      window.removeEventListener('blur', commitAndClear)
    }
  }, [bakeTransform])

  const handleMouseUp = useCallback((_e: Konva.KonvaEventObject<MouseEvent>) => {
    const m = modeRef.current
    const vp = viewportRef.current

    // Complete cross-path connection from connect mode (user clicked while snapped to other-path node)
    if (connectSourceRef.current !== null && crossPathWeldTargetRef.current !== null && m.type === 'idle') {
      const cs = connectSourceRef.current
      const crossTarget = crossPathWeldTargetRef.current
      const nodes = editNodesRef.current
      const joined = joinPathsConnect(
        nodes, cs,
        crossTarget.nodes, crossTarget.nodeIdx, crossTarget.closed,
      )
      if (joined) {
        const newD = nodesToD(joined, false)
        const { nodeEditPathId: pid } = useUIStore.getState()
        if (pid && newD) {
          // Join deletes the other path via ONE atomic global entry; a global-
          // marked local step lets Ctrl+Z revert both, in-session, in one press.
          pushLocalUndo(nodes, editClosedRef.current, true)
          selfWriteRef.current = true
          usePathsStore.getState().applyPathEdit({ gesture: 'join', updates: [{ id: pid, d: newD }], deleteIds: [crossTarget.pathId] })
          selfWriteRef.current = false
          regenerateAffected(pid)
          setEditNodes(joined)
          setEditClosed(false)
        }
      }
      clearConnectState()
      return
    }

    if (m.type === 'pan') {
      setMode2({ type: 'idle' })
      return
    }

    if (m.type === 'move' && didDragRef.current) {
      const lt = liveTransformRef.current
      if (lt && lt.kind === 'translate') {
        const { dx, dy } = lt
        const step: TransformStep = { kind: 'translate', dx, dy }
        // A drag that snapped back to where it began changes nothing, so it records
        // nothing and regenerates nothing (see isIdentityStep).
        // Only the DRAGGED paths are baked. What the constraints carried along
        // was a preview of the solve, and the solve itself runs inside
        // applyPathEdit against the geometry as it will BE — baking the preview
        // here as well would move those bodies twice.
        if (!isIdentityStep(step)) {
          bakeTransform(m.pathIds, 'move', (path) => {
            const r = applyTransformStep(path, step)
            return { id: path.id, d: r.d, shapeParams: r.shapeParams, transforms: [step] }
          })
        }
      }
      setLiveTransform(null)
      setFollowTransforms(null)
      constraintPlanRef.current = null
      setLiveBBox(null)
      setSnapGuides(null)
      setPickDrag(null)
      // AFTER the bake, so the constraint is measured off where the part now IS
      // — it is created holding what is already there, and what is already there
      // is the drag that has just landed. Two history entries, the move and the
      // constraint, which is what they are: the part really did move.
      if (m.pick) {
        commitConstraint(m.pick.held, m.pick.hot)
        // The markers were measured before the part moved, so every one of them
        // is now in the wrong place. Dropped rather than left to the next
        // mousemove, which is only "immediately" if the pointer moves at all.
        setPickCandidates([])
        setPickHot(null)
      }
      setMode2({ type: 'idle' })
      return
    }

    if (m.type === 'resize' && didDragRef.current) {
      const lt = liveTransformRef.current
      if (lt && lt.kind === 'scale') {
        const { sx, sy, ax, ay } = lt
        const step: TransformStep = { kind: 'scale', sx, sy, ax, ay }
        if (!isIdentityStep(step)) bakeTransform(m.pathIds, 'scale', (path) => {
          const r = applyTransformStep(path, step)
          return { id: path.id, d: r.d, shapeParams: r.shapeParams, name: r.name, transforms: [step] }
        })
      } else if (lt && lt.kind === 'skew') {
        const { kx, ky, ax, ay } = lt
        const step: TransformStep = { kind: 'skew', kx, ky, ax, ay }
        if (!isIdentityStep(step)) bakeTransform(m.pathIds, 'skew', (path) => {
          const r = applyTransformStep(path, step)
          return { id: path.id, d: r.d, shapeParams: r.shapeParams, transforms: [step] }
        })
      }
      setLiveTransform(null)
      setLiveBBox(null)
      setSnapGuides(null)
      setMode2({ type: 'idle' })
      return
    }

    if (m.type === 'rotate' && didDragRef.current) {
      const lt = liveTransformRef.current
      if (lt && lt.kind === 'rotate') {
        const { angle, cx, cy } = lt
        const step: TransformStep = { kind: 'rotate', angle, cx, cy }
        if (!isIdentityStep(step)) bakeTransform(m.pathIds, 'rotate', (path) => {
          const r = applyTransformStep(path, step)
          return { id: path.id, d: r.d, shapeParams: r.shapeParams, transforms: [step] }
        })
      }
      setLiveTransform(null)
      setLiveRotationAngle(null)
      setMode2({ type: 'idle' })
      return
    }

    if (m.type === 'move' && !didDragRef.current) {
      // Pure click without drag — selection already updated on mousedown. Under
      // the Constrain tool there was no selection to update: a press that never
      // moved is the ordinary second click, and takes the point where it is.
      constraintPlanRef.current = null
      setPickDrag(null)
      if (m.pick) onConstrainClick()
      setMode2({ type: 'idle' })
      return
    }

    if (m.type === 'dragbox') {
      const dragBox = dragBoxRef.current
      if (dragBox) {
        const { sx, sy, ex, ey } = dragBox
        const x1 = Math.min(sx, ex), x2 = Math.max(sx, ex)
        const y1 = Math.min(sy, ey), y2 = Math.max(sy, ey)

        if (Math.hypot(ex - sx, ey - sy) > MOVE_THRESHOLD_PX) {
          // Convert drag box to CNC bounds
          const cncMin = screenToCNC(x1, y2, vp)  // y2 is lower on screen = lower CNC y
          const cncMax = screenToCNC(x2, y1, vp)  // y1 is higher on screen = higher CNC y

          // WHICH WAY THE BOX WAS DRAWN CHOOSES WHAT IT CATCHES — the CAD
          // convention, and the reason for it is that on a crowded drawing the two
          // questions are genuinely different: "everything this line runs across"
          // and "these things and nothing they overlap". Drawn rightwards it
          // catches anything TOUCHED, which is what it always did; drawn back to
          // the left it catches only what is wholly INSIDE. Taken from x alone,
          // not from the diagonal, so every drag has an answer — a box dragged
          // straight down has no other axis to ask, and the hand remembers left
          // and right rather than a quadrant.
          const enclose = dragBoxEncloses(dragBox)

          const { paths: allPaths } = usePathsStore.getState()
          const caught = allPaths.filter((p) => {
            if (!onCanvas(p)) return false
            // bbox from the per-path flatten cache (same 0.5 tolerance as
            // getBBox) — box-select over hundreds of paths used to re-flatten
            // every path on every mouseup (tofix.md H5)
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
            for (const poly of getFlat(p, 0.5)) {
              for (const [x, y] of poly) {
                if (x < minX) minX = x; if (x > maxX) maxX = x
                if (y < minY) minY = y; if (y > maxY) maxY = y
              }
            }
            if (!isFinite(minX)) return false
            return enclose
              ? minX >= cncMin.x && maxX <= cncMax.x && minY >= cncMin.y && maxY <= cncMax.y
              : minX <= cncMax.x && maxX >= cncMin.x && minY <= cncMax.y && maxY >= cncMin.y
          })
          // Catching part of a group catches all of it — same rule as a click.
          const ids = expandUserGroups(caught.map((p) => p.id), allPaths)
          // …which is exactly what an ENCLOSING box must not do. A group is ONE
          // object, so "wholly inside" is a question about the whole of it: expand
          // first (a group half in the box would otherwise come back as its
          // enclosed parts, which is not a thing the user can see or click), then
          // drop any group with a part left outside. Hidden members are not in the
          // running either way, so they cannot hold a group out of the selection.
          setSelectedIds(enclose ? wholeGroupsOnly(ids, caught, allPaths) : ids)
        } else if (useUIStore.getState().activeTool === 'region') {
          // A click off every line: pick the enclosed area there, or deselect
          // when nothing encloses it, as a click on empty canvas always does.
          const cnc = screenToCNC(sx, sy, vp)
          if (!pickRegionAt(cnc, _e.evt.shiftKey)) usePathsStore.getState().selectPath(null)
        }
      }
      setDragBox(null)
      setMode2({ type: 'idle' })
      return
    }

    if (m.type === 'drawshape') {
      setLiveShapeD(null)
      setMode2({ type: 'idle' })

      const { activeTool, shapeToolConfig, shapeFromCenter } = useUIStore.getState()
      if (activeTool !== 'select') {
        const shapeType = activeTool as ShapeType
        const session = shapeDragSessionRef.current
        if (session.tool !== activeTool) { session.tool = activeTool; session.dragged = false }
        // For a scale-locked shape a drag IS a click: there is no size to drag
        // out, so it places one at the mousedown point and exits to select, the
        // same as a click does. Nothing here special-cases it beyond this line —
        // the placement and the drag-to-repeat session both follow.
        const dragged = didDragRef.current && !SCALE_LOCKED_SHAPES.has(shapeType)

        // A click (no drag) after the user has already dragged out at least one
        // shape this session means "done" — exit to select without adding a shape.
        if (!dragged && session.dragged) {
          shapeDragSessionRef.current = { tool: null, dragged: false }
          useUIStore.getState().setActiveTool('select')
          return
        }

        // Where it lands: normally the mousedown point, but a scale-locked shape
        // follows the cursor and drops where it was released — the drag chooses
        // its position even though it cannot choose its size. For a plain click
        // the two are the same point (currentCNC starts as startCNC).
        const at = SCALE_LOCKED_SHAPES.has(shapeType) ? m.currentCNC : m.startCNC
        const params = dragged
          ? shapeParamsFromDrag(shapeType, m.startCNC, m.currentCNC, shapeToolConfig, shapeFromCenter)
          : shapeParamsFromConfig(shapeType, at.x, at.y, shapeToolConfig)

        const id = uid('shape')
        const { addPaths: add, selectPath: sel, setSelectedIds } = usePathsStore.getState()
        const d = generateShapeD(params)
        // A multi-part shape lands as one path per part (a gear's teeth, bore and
        // spokes each want their own operation — see generateShapeParts). They
        // share a groupId so the paths list keeps them together, and each carries
        // the same shapeParams so the set stays editable as one shape.
        const parts = generateShapeParts(params)
        // The id to regenerate this shape through if a font has to arrive first —
        // any member of a group works, since updateShapeParams regenerates all of
        // it.
        let regenId = id
        if (parts && parts.length > 1) {
          const groupId = uid('shape-group')
          const name = shapeDisplayName(shapeType)
          const color = nextPathColor()
          const made = parts.map((pt) => ({
            id: uid('shape'), name: `${name} ${pt.label}`, d: pt.d,
            visible: true, color, shapeParams: params, shapePart: pt.part,
            groupId, groupName: name,
            // The tool's setting is the DEFAULT for what is drawn from it; from
            // here on it is the object's own, changed from its panel.
            ...(shapeFromCenter ? { fromCenter: true } : {}),
          }))
          add(made, { source: 'shape' })
          setSelectedIds(made.map((p) => p.id))
          regenId = made[0].id
        } else {
          add([{
            id, name: shapeDisplayName(shapeType), d, visible: true, color: nextPathColor(), shapeParams: params,
            ...(shapeFromCenter ? { fromCenter: true } : {}),
          }], { source: shapeType === 'text' ? 'text' : 'shape' })
          sel(id)
        }

        // If text font wasn't loaded yet, update d once it loads — via
        // updateShapeParams so the fix amends the Text chip in place rather
        // than recording a separate edit event.
        if (params.type === 'text' && !d) {
          import('../shapes/textGenerator').then(({ loadFont }) => {
            loadFont(params.fontFamily).then(() => {
              const newD = generateShapeD(params)
              if (newD) usePathsStore.getState().updateShapeParams(id, params)
            })
          })
        }

        // Same story for a gear's tooth-count number: the single-stroke font is
        // fetched on demand, so a gear drawn before it lands has every part but
        // that one. Regenerating the group once it is here adds the part.
        if (params.type === 'gear' && params.toothLabel && !parts?.some((pt) => pt.part === 'label')) {
          import('../shapes/textGenerator').then(({ loadFont, SINGLE_LINE_FONT_FAMILY }) => {
            loadFont(SINGLE_LINE_FONT_FAMILY).then(() => {
              usePathsStore.getState().updateShapeParams(regenId, params)
            })
          })
        }

        if (dragged) {
          // Keep the shape tool selected so more shapes can be dragged out.
          session.dragged = true
        } else {
          // A click placed a default-sized shape — exit to select as before.
          shapeDragSessionRef.current = { tool: null, dragged: false }
          useUIStore.getState().setActiveTool('select')
        }
      }
      return
    }

    if (m.type === 'clocklink-drag') {
      setMode2({ type: 'idle' })
      commitClockLink()
      return
    }

    if (m.type === 'nodedit-drag') {
      setMode2({ type: 'idle' })
      const initSnap = editDragInitRef.current?.initialNodes
      editDragInitRef.current = null
      setDragNodeIdx(null)
      setCrossPathCandidates([])
      crossPathEntriesRef.current = []
      const crossTgt = crossPathWeldTargetRef.current
      setCrossPathWeldTarget(null)
      const tgt = weldTargetIdxRef.current
      setWeldTargetIdx(null)

      if (crossTgt !== null && didDragRef.current) {
        // Cross-path join: merge the current path with another path at their endpoints
        const joined = joinPaths(
          editNodesRef.current, m.nodeIdx, editClosedRef.current,
          crossTgt.nodes, crossTgt.nodeIdx, crossTgt.closed,
        )
        if (joined) {
          const newD = nodesToD(joined, false)
          const { nodeEditPathId: pid } = useUIStore.getState()
          if (pid && newD) {
            // Join deletes the other path via ONE atomic global entry; a global-
            // marked local step lets Ctrl+Z revert both, in-session, in one press.
            if (initSnap) pushLocalUndo(initSnap, editClosedRef.current, true)
            selfWriteRef.current = true
            usePathsStore.getState().applyPathEdit({ gesture: 'join', updates: [{ id: pid, d: newD }], deleteIds: [crossTgt.pathId] })
            selfWriteRef.current = false
            regenerateAffected(pid)
            setEditNodes(joined)
            setEditClosed(false)
          }
        }
      } else if (tgt !== null && didDragRef.current) {
        const curNodes = editNodesRef.current
        const curClosed = editClosedRef.current
        const n = curNodes.length
        const srcIsEndpoint = !curClosed && (m.nodeIdx === 0 || m.nodeIdx === n - 1)
        const tgtIsEndpoint = tgt === 0 || tgt === n - 1
        const lollipop = srcIsEndpoint && !tgtIsEndpoint
          ? endpointToMidpointWeld(curNodes, m.nodeIdx, tgt) : null

        if (lollipop) {
          // Endpoint-to-midpoint: create a closed loop and keep the remainder
          const { loopNodes, remainNodes } = lollipop
          const loopD = nodesToD(loopNodes, true)
          const remainD = nodesToD(remainNodes, false)
          const { nodeEditPathId: pid } = useUIStore.getState()
          if (pid && remainD) {
            const { paths: allPaths } = usePathsStore.getState()
            const srcPath = allPaths.find((p) => p.id === pid)
            // Loop split adds a new path via ONE atomic global entry; a global-
            // marked local step lets Ctrl+Z revert both, in-session, in one press.
            if (initSnap) pushLocalUndo(initSnap, curClosed, true)
            selfWriteRef.current = true
            usePathsStore.getState().applyPathEdit({
              gesture: 'weld',
              updates: [{ id: pid, d: remainD }],
              add: loopD ? [{
                id: uid('weld-loop'),
                name: srcPath?.name ?? 'Path',
                d: loopD,
                visible: true,
                color: srcPath?.color ?? nextPathColor(),
              }] : [],
            })
            selfWriteRef.current = false
            regenerateAffected(pid)
            setEditNodes(remainNodes)
            setEditClosed(false)
          }
        } else {
          // Standard same-path weld (endpoint→endpoint close, or mid→any merge) —
          // pure node edit, store untouched until commit, so local undo handles it.
          if (initSnap) pushLocalUndo(initSnap, curClosed)
          const result = weldNodes(curNodes, m.nodeIdx, tgt, curClosed)
          setEditNodes(result.nodes)
          if (result.closed !== curClosed) {
            setEditClosed(result.closed)
          }
        }
      } else if (initSnap && didDragRef.current) {
        pushLocalUndo(initSnap, editClosedRef.current)
      }

      // No-drag on an anchor: toggle connect mode or complete connection
      if (!didDragRef.current && m.kind === 'anchor') {
        const cs = connectSourceRef.current
        const nodes = editNodesRef.current
        const closed = editClosedRef.current
        const n = nodes.length
        const mIsEndpoint = !closed && (m.nodeIdx === 0 || m.nodeIdx === n - 1)


        if (cs !== null && cs !== m.nodeIdx) {
          if (mIsEndpoint) {
            // Connect source endpoint to other endpoint → close path
            pushLocalUndo(nodes, editClosedRef.current)
            setEditClosed(true)
            clearConnectState()
          } else {
            // Connect source endpoint to interior node — split into closed loop + open remainder,
            // both nodes preserved (no merging, no deletion)
            const result = connectEndpointToInterior(nodes, cs, m.nodeIdx)
            if (result) {
              const { loopNodes, remainNodes } = result
              const loopD = nodesToD(loopNodes, true)
              const remainD = nodesToD(remainNodes, false)
              const { nodeEditPathId: pid } = useUIStore.getState()
              if (pid && remainD) {
                const { paths: allPaths } = usePathsStore.getState()
                const srcPath = allPaths.find((p) => p.id === pid)
                // Loop split adds a new path via ONE atomic global entry; a global-
                // marked local step lets Ctrl+Z revert both, in-session, in one press.
                pushLocalUndo(nodes, editClosedRef.current, true)
                selfWriteRef.current = true
                usePathsStore.getState().applyPathEdit({
                  gesture: 'weld',
                  updates: [{ id: pid, d: remainD }],
                  add: loopD ? [{
                    id: uid('connect-loop'),
                    name: srcPath?.name ?? 'Path',
                    d: loopD,
                    visible: true,
                    color: srcPath?.color ?? nextPathColor(),
                  }] : [],
                })
                selfWriteRef.current = false
                regenerateAffected(pid)
                setEditNodes(remainNodes)
                setEditClosed(false)
              }
              clearConnectState()
            }
            // else: degenerate (adjacent endpoints only, nothing to split) — stay in connect mode
          }
        } else if (cs === m.nodeIdx) {
          // Cancel: click source again
          clearConnectState()
        } else if (cs === null && mIsEndpoint) {
          // Enter connect mode — populate cross-path candidates
          setConnectSource(m.nodeIdx)
          const { nodeEditPathId: pid } = useUIStore.getState()
          const entries = collectCrossPathEntries(pid, visibleCNC(viewportRef.current, sizeRef.current, editNodesRef.current[m.nodeIdx]))
          crossPathEntriesRef.current = entries
          setCrossPathCandidates(entries)
        }
        // else: non-endpoint click with no connect mode active → do nothing
      }

      return
    }

    if (m.type === 'pendraw') {
      setMode2({ type: 'idle' })

      if (m.closing) {
        const { penNodes: nodes, clearPenNodes, penCurveType: ct } = useUIStore.getState()
        if (nodes.length >= 2) {
          const closeNodes = altDownRef.current
            ? [{ ...nodes[0], corner: true }, ...nodes.slice(1)]
            : nodes
          const d = penNodesToPathD(closeNodes, true, ct)
          if (d) {
            const id = uid('pen')
            const { addPaths: add, selectPath: sel } = usePathsStore.getState()
            add([{ id, name: 'Pen Path', d, visible: true, color: nextPathColor() }], { source: 'pen' })
            sel(id)
          }
        }
        clearPenNodes()
        useUIStore.getState().setActiveTool('select')
        setLivePen(null)
        setPenClosing(false)
        return
      }

      const { addPenNode, penCurveType: ct } = useUIStore.getState()
      const newNode: PenNode = { x: m.anchorCNC.x, y: m.anchorCNC.y }
      if (ct === 'bezier' && didDragRef.current && livePen?.handle) {
        const dx = livePen.handle.x - m.anchorCNC.x
        const dy = livePen.handle.y - m.anchorCNC.y
        newNode.outHandle = livePen.handle
        newNode.inHandle = { x: m.anchorCNC.x - dx, y: m.anchorCNC.y - dy }
      } else if (ct !== 'linear' && altDownRef.current) {
        // Alt held: mark incoming segment as linear (corner). Only affects the segment
        // ending at this node — the outgoing segment uses normal curve logic.
        newNode.corner = true
      }
      pushLocalHistory(penPast.current, [...useUIStore.getState().penNodes])
      penFuture.current = []
      addPenNode(newNode)
      useUIStore.getState().setNodeEditHistoryFlags(true, false)
      setLivePen(null)
      return
    }

    // Drill tool: place a point on any non-drag LEFT click — right/middle
    // releases never placed a mousedown here (button !== 0 returns early), so
    // without the button check they'd inherit a stale didDragRef (bugs.md B5)
    {
      const { activeTool: curTool } = useUIStore.getState()
      if (curTool === 'drill' && !didDragRef.current && _e.evt.button === 0) {
        const pointer = stageRef.current?.getPointerPosition()
        if (pointer) {
          const cnc = screenToCNC(pointer.x, pointer.y, viewportRef.current)
          const { pendingDrillPoints } = useUIStore.getState()
          drillPast.current = [...drillPast.current, pendingDrillPoints]
          useUIStore.getState().addDrillPoint(snapDrillPoint(cnc))
        }
      }
    }

    setMode2({ type: 'idle' })
  }, [livePen, setMode2, setSelectedIds, setLiveRotationAngle, setLiveBBox, commitEditNodes, pushLocalUndo, getFlat, bakeTransform, commitConstraint, onConstrainClick, setPickHot, pickRegionAt])

  // A GESTURE RELEASED OFF THE CANVAS STILL ENDS. Konva only hears a mouseup on its own
  // content element, so a resize (or move, rotate, drag box, point drag…) let go over the
  // sidebar never reached handleMouseUp: the mode stayed live, the next mouse move went on
  // transforming with no button held, and the preview transform was never cleared — the
  // shape was drawn where it was not, so clicking it missed. The window hears every
  // release, including one outside the browser (the browser keeps delivering to the page
  // that saw the press). A release ON the canvas reaches the stage first, on the way up to
  // the window, and every branch of handleMouseUp leaves the mode idle — so this only ever
  // runs for the releases the stage missed. Losing focus mid-drag (Alt+Tab) has no mouseup
  // at all and ends the gesture the same way.
  const handleMouseUpRef = useRef(handleMouseUp)
  handleMouseUpRef.current = handleMouseUp
  useEffect(() => {
    const finish = (evt: MouseEvent) => {
      if (modeRef.current.type === 'idle') return
      handleMouseUpRef.current({ evt } as unknown as Konva.KonvaEventObject<MouseEvent>)
    }
    const onBlur = () => finish(new MouseEvent('mouseup'))
    window.addEventListener('mouseup', finish)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('mouseup', finish)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  const getCursor = () => {
    if (nodeEditPathId) return 'default'
    if (activeTool === 'drill') return 'crosshair'
    if (activeTool === 'pen') return 'crosshair'
    if (activeTool !== 'select' && activeTool !== 'region') return 'crosshair'
    switch (modeRef.current.type) {
      case 'pan': return 'grabbing'
      case 'move': return 'move'
      case 'resize': return 'crosshair'
      case 'rotate': return 'crosshair'
      case 'dragbox': return 'crosshair'
      default: return spaceHeldRef.current ? 'grab' : 'default'
    }
  }

  // dragBox coords are in Konva stage space = container-relative pixels, no offset needed
  const dragBoxStyle = dragBox ? {
    left: Math.min(dragBox.sx, dragBox.ex),
    top: Math.min(dragBox.sy, dragBox.ey),
    width: Math.abs(dragBox.ex - dragBox.sx),
    height: Math.abs(dragBox.ey - dragBox.sy),
  } : null

  return (
    <div
      ref={containerRef}
      data-testid="canvas-stage"
      className="w-full h-full relative overflow-hidden select-none"
      style={{ cursor: getCursor() }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleCanvasDrop}
    >
      {size.width > 0 && size.height > 0 && <Stage
        ref={stageRef}
        width={size.width}
        height={size.height}
        onWheel={handleWheel}
        onMouseDown={handleStageMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => {
          setCursorMM(null)
          setPenSnapCursor(null)
          if (modeRef.current.type === 'idle') setSnapGuides(null)
        }}
        onDblClick={handleStageDblClick}
      >
        {/* Layer 1: All CNC-space content (Y-flipped). Groups render in z-order within this single canvas. */}
        <Layer x={viewport.x} y={viewport.y} scaleX={viewport.scale} scaleY={-viewport.scale}>
          <WorkpieceLayer viewport={viewport} />
          <GridLayer viewport={viewport} stageWidth={size.width} stageHeight={size.height} />
          <DesignLayer
            viewport={viewport}
            liveTransform={liveTransform}
            followTransforms={followTransforms}
            excludePathId={nodeEditPathId}
            excludeGroupId={meshAnimGroupId}
            excludeClockId={clockAnimId}
          />
          {nodeEditPathId && (
            <NodeEditLayer
              viewport={viewport}
              nodes={editNodes}
              closed={editClosed}
              hoveredNodeIdx={hoveredEditNode}
              spaceHeldRef={spaceHeldRef}
              onNodeMouseDown={handleNodeMouseDown}
              onSegmentMouseDown={handleSegmentMouseDown}
              onHoveredNodeChange={handleHoveredNodeChange}
              onHoverSegChange={(idx) => setHoverSegIdx(idx)}
              weldTargetIdx={weldTargetIdx}
              crossPathCandidates={crossPathCandidates}
              crossPathWeldTarget={crossPathWeldTarget}
              connectSourceIdx={connectSource}
              connectPreviewTo={connectPreviewTo}
              connectSnapTargetIdx={connectSnapTargetIdx}
            />
          )}
          <ToolpathLayer viewport={viewport} />
          <TabLayer viewport={viewport} />
          <SimulationLayer viewport={viewport} />
          <ShapePreviewLayer viewport={viewport} d={liveShapeD} />
          {activeTool === 'region' && <ShapePreviewLayer viewport={viewport} d={regionPreviewD} />}
          <EscapementAnimLayer viewport={viewport} />
          <GearAnimLayer viewport={viewport} />
          <ClockAnimLayer viewport={viewport} />
          {clockLinkPathId && (
            <ClockLinkageLayer
              viewport={viewport}
              liveAngles={linkAngles}
              onNodeMouseDown={handleLinkNodeDown}
              activeNode={hoverLinkNode}
            />
          )}
          <CornerPickLayer viewport={viewport} />
          {activeTool === 'constrain' && (
            <ConstraintPickLayer
              viewport={viewport}
              candidates={pickCandidates}
              hot={pickHot}
              held={pickHeld}
              drag={pickDrag}
            />
          )}
          {activeTool === 'pen' && (
            <PenLayer
              viewport={viewport}
              penNodes={penClosing && altDown && penNodes.length >= 1
                ? [{ ...penNodes[0], corner: true }, ...penNodes.slice(1)]
                : penNodes}
              livePen={livePen}
              penClosing={penClosing}
              curveType={effectiveCurveType}
              snappedCursor={penSnapCursor}
            />
          )}
          {activeTool === 'drill' && pendingDrillPoints.length > 0 && (
            <Group listening={false}>
              {pendingDrillPoints.map((pt, i) => (
                <Circle
                  key={i}
                  x={pt.x}
                  y={pt.y}
                  radius={3 / viewport.scale}
                  fill="#f97316"
                  stroke="#ffffff"
                  strokeWidth={1 / viewport.scale}
                  listening={false}
                />
              ))}
            </Group>
          )}
        </Layer>


        {/* Layer 2: Screen-space overlay — origin indicator, selection outline, rulers. */}
        <Layer listening={false}>
          <OriginLayer viewport={viewport} />
          {/* COMMITTED DIMENSIONS ARE HIDDEN WHILE ANYTHING IS BEING DRAGGED. One
              is drawn from the baked `d`, which does not change until mouse-up,
              so mid-drag it would hang behind at the old positions while the
              geometry moves out from under it. Re-deriving it every frame is the
              one thing not to do here: resolving a constraint's ends means
              re-flattening every path of every body it touches, which is the
              cost the plan/run split exists to keep out of the pointer path (see
              store/constraints.ts). The parts are what the user is looking at
              during a drag; the numbers come back the moment it lands.

              THE ONE BEING MADE IS THE EXCEPTION, and it is exactly the case
              that pays for itself: its two ends are known points translating
              rigidly, so it costs two additions a frame and it is the only thing
              telling the user what the offset they are dragging out actually
              is. */}
          <ConstraintLayerLive viewport={viewport} hideCommitted={!!liveTransform} held={pickHeld} hot={pickHot} drag={pickDrag} />
          {!nodeEditPathId && !cornerPickPathId && activeTool !== 'constrain' && selectionBBox && (
            <SelectionLayer
              viewport={viewport}
              bbox={selectionBBox}
              liveTransform={liveTransform}
            />
          )}
          {snapGuides && (
            <SnapGuideLayer viewport={viewport} guides={snapGuides} width={size.width} height={size.height} />
          )}
        </Layer>

        {/* Layer 3: Interactive handles — selection resize/rotate circles. */}
        <Layer>
          {!nodeEditPathId && !cornerPickPathId && activeTool !== 'constrain' && selectionBBox && (
            <SelectionHandleLayer
              viewport={viewport}
              bbox={selectionBBox}
              liveTransform={liveTransform}
              onResizeHandleDown={handleResizeHandleDown}
              onRotateHandleDown={handleRotateHandleDown}
              scaleLocked={selectionScaleLocked}
            />
          )}
        </Layer>
      </Stage>}


      {/* Drag-box selection overlay. SOLID means the box takes only what it wholly
          contains, DASHED that touching is enough — the CAD convention, and the
          only thing on screen that says which of the two a drag is going to do. */}
      {dragBox && dragBoxStyle && (
        <div
          className={`absolute border border-blue-400 bg-blue-400/10 pointer-events-none ${
            dragBoxEncloses(dragBox) ? '' : 'border-dashed'}`}
          style={dragBoxStyle}
        />
      )}

      <PenLengthOverlay viewport={viewport} draggingHandle={livePen !== null} snappedCursor={penSnapCursor} />
      <NodeEditDimensionOverlay viewport={viewport} nodes={editNodes} closed={editClosed} dragNodeIdx={dragNodeIdx} hoverSegIdx={hoverSegIdx} />

      {/* Linkage arranging indicator */}
      {clockLinkPathId && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-amber-600/90 text-white text-body px-3 py-1 rounded-full pointer-events-none">
          Drag a joint to fold the train · Shift snaps 15° · the escapement is fixed · Esc to finish
        </div>
      )}

      {/* Node edit indicator */}
      {nodeEditPathId && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-emerald-700/90 text-white text-body px-3 py-1 rounded-full pointer-events-none">
          {connectSource !== null
            ? 'Click any point to connect · Esc to cancel'
            : hoveredEditNode !== null
              ? 'Delete key to remove point'
              : hoverSegIdx !== null
                ? 'Click to insert point · Delete key to delete segment'
              : 'Drag points or handles · Alt-click point to toggle curve · Click segment to insert · Esc to finish'}
        </div>
      )}

      {/* Tool active indicator */}
      {activeTool === 'drill' && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-blue-600/90 text-white text-body px-3 py-1 rounded-full pointer-events-none">
          Drill Point Mode — click to place points, Esc to exit
        </div>
      )}
      {activeTool === 'pen' && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-violet-600/90 text-white text-body px-3 py-1 rounded-full pointer-events-none">
          {penClosing
            ? 'Click to close path'
            : penNodes.length === 0
              ? penCurveType === 'bezier'
                ? 'Pen Tool — click for corner, drag to curve'
                : 'Pen Tool — click to place points'
              : penCurveType === 'bezier'
                ? 'Click to add point, drag to curve, Alt for straight segment, click first point to close, Esc to finish'
                : 'Click to add point, Alt for straight segment, click first point to close, Esc to finish'}
        </div>
      )}
      {/* The Constrain tool is not a shape, and the catch-all below read as one:
          it announced "Drawing constrain — click to place, drag to size". It says
          the gesture instead, and the gesture has two halves. */}
      {activeTool === 'constrain' && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-purple-600/90 text-white text-body px-3 py-1 rounded-full pointer-events-none">
          {pickHeld
            ? 'Now a point on another part — or press on it and drag the part into place · Esc to cancel'
            : 'Constrain — click a corner, edge or centre on one part, then a point on another and drag to set the dimensions of the constraint · Esc to exit'}
        </div>
      )}
      {activeTool === 'region' && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-blue-600/90 text-white text-body px-3 py-1 rounded-full pointer-events-none">
          Pocket — click a path to select it, or click inside any area the lines enclose to pocket that area · Shift to add
        </div>
      )}
      {activeTool !== 'select' && activeTool !== 'drill' && activeTool !== 'pen' && activeTool !== 'constrain' && activeTool !== 'region' && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-blue-600/90 text-white text-body px-3 py-1 rounded-full pointer-events-none">
          Drawing {shapeDisplayName(activeTool as ShapeType)} — {SCALE_LOCKED_SHAPES.has(activeTool as ShapeType)
            ? 'click to place at its designed size, Esc to cancel'
            : `click to place, drag to size${shapeFromCenterPref ? ' from the centre' : ''}, Esc to cancel`}
        </div>
      )}
      {cornerPickPathId && !nodeEditPathId && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-amber-600/90 text-white text-body px-3 py-1 rounded-full pointer-events-none">
          Corner Treatment — click corner markers to pick corners, none picked = all
        </div>
      )}
      {activeTool === 'select' && selectedIds.length > 0 && !nodeEditPathId && !cornerPickPathId && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-gray-700/80 text-white text-body px-3 py-1 rounded-full pointer-events-none">
          Drag to move · corner handles to scale{centreResize ? ' about the centre' : ''} · rotate handle to rotate{selectionSkewLocked ? '' : ' · Alt+corner to skew'}
        </div>
      )}

      <SimulationPlayer />

      {/* Zoom in / fit / out, in that order top to bottom — fit is the middle of the
          range, so the stack reads as one zoom axis. The two step buttons exist because
          pinch-zooming a trackpad over the canvas is awkward; they do the same thing the
          wheel does, anchored on the selected part (or the centre of the view) rather than
          on the cursor. */}
      <div className="absolute bottom-3 right-3 flex flex-col gap-1.5">
        <button onClick={() => zoomBy(ZOOM_BUTTON_STEP)} title={selectedIds.length > 0 ? 'Zoom in on the selection' : 'Zoom in'} className={ZOOM_BTN_CLASS}>
          <ZoomIn size={ICON.md} />
        </button>
        <button onClick={fitToWorkpiece} title="Zoom to fit stock" className={ZOOM_BTN_CLASS}>
          <Maximize2 size={ICON.md} />
        </button>
        <button onClick={() => zoomBy(1 / ZOOM_BUTTON_STEP)} title={selectedIds.length > 0 ? 'Zoom out from the selection' : 'Zoom out'} className={ZOOM_BTN_CLASS}>
          <ZoomOut size={ICON.md} />
        </button>
      </div>
    </div>
  )
}
