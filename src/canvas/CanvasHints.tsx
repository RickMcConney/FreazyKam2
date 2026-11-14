import { shapeDisplayName, SCALE_LOCKED_SHAPES, type ShapeType } from '../shapes/shapeGenerators'
import { usePathsStore } from '../store/pathsStore'
import { useUIStore } from '../store/uiStore'
import type { AnchorCandidate } from '../store/constraints'

/** The pills across the top of the canvas saying what the current mode wants next. */
export function CanvasHints({ connecting, hoveredEditNode, hoverSegIdx, penClosing, pickHeld, centreResize, skewLocked }: {
  connecting: boolean
  hoveredEditNode: number | null
  hoverSegIdx: number | null
  penClosing: boolean
  pickHeld: AnchorCandidate | null
  centreResize: boolean
  skewLocked: boolean
}) {
  const activeTool = useUIStore((s) => s.activeTool)
  const nodeEditPathId = useUIStore((s) => s.nodeEditPathId)
  const clockLinkPathId = useUIStore((s) => s.clockLinkPathId)
  const cornerPickPathId = useUIStore((s) => s.cornerPickPathId)
  const penNodes = useUIStore((s) => s.penNodes)
  const penCurveType = useUIStore((s) => s.penCurveType)
  const shapeFromCenterPref = useUIStore((s) => s.shapeFromCenter)
  const selectedIds = usePathsStore((s) => s.selectedIds)

  return (
    <>
      {/* Linkage arranging indicator */}
      {clockLinkPathId && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-amber-600/90 text-white text-body px-3 py-1 rounded-full pointer-events-none">
          Drag a joint to fold the train · Shift snaps 15° · the escapement is fixed · Esc to finish
        </div>
      )}

      {/* Node edit indicator */}
      {nodeEditPathId && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-emerald-700/90 text-white text-body px-3 py-1 rounded-full pointer-events-none">
          {connecting
            ? 'Click any point to connect · Esc to cancel'
            : hoveredEditNode !== null
              ? 'Delete key to remove point'
              : hoverSegIdx !== null
                ? 'Click to insert point · Delete key to delete segment'
              : 'Drag points or handles · Shift-click point to toggle curve · Click segment to insert · Esc to finish'}
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
                ? 'Click to add point, drag to curve, Shift for straight segment, click first point to close, Esc to finish'
                : 'Click to add point, Shift for straight segment, click first point to close, Esc to finish'}
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
      {activeTool === 'measure' && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-blue-600/90 text-white text-body px-3 py-1 rounded-full pointer-events-none">
          Measure — click two points · Shift for 15° steps · Esc to clear, Esc again to leave
        </div>
      )}
      {activeTool !== 'select' && activeTool !== 'drill' && activeTool !== 'pen' && activeTool !== 'constrain' && activeTool !== 'region' && activeTool !== 'measure' && (
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
          Drag to move · corner handles to scale (Shift keeps proportions){centreResize ? ' about the centre' : ''} · rotate handle to rotate{skewLocked ? '' : ' · Shift+middle handle to skew'}
        </div>
      )}
    </>
  )
}
