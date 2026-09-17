import { useEffect } from 'react'
import { useUIStore } from '../store/uiStore'
import { useCanvasStore } from '../store/canvasStore'
import { useWorkpieceStore, MATERIAL_INFO } from '../store/workpieceStore'
import { MATERIAL_COLORS } from '../colors'
import { RIGIDITY_INFO } from '../rigidity'
import { originWorldXY } from '../canvas/layers/WorkpieceLayer'
import { BUILD_DATE } from '../version'
import { shapeDisplayName, type ShapeType } from '../shapes/shapeGenerators'
import { majorStepMM, minorStepMM, formatRulerLabel } from '../canvas/gridUtils'

function modeLabel(activeTool: string, nodeEditPathId: string | null): string {
  if (nodeEditPathId) return 'Edit Points'
  if (activeTool === 'select') return 'Select'
  if (activeTool === 'pen') return 'Pen'
  if (activeTool === 'drill') return 'Drill'
  if (activeTool === 'constrain') return 'Constrain'
  return shapeDisplayName(activeTool as ShapeType)
}

export default function StatusBar() {
  const snapEnabled = useUIStore((s) => s.snapEnabled)
  const workspaceTab = useUIStore((s) => s.workspaceTab)
  const activeTool = useUIStore((s) => s.activeTool)
  const nodeEditPathId = useUIStore((s) => s.nodeEditPathId)
  const statusMessage = useUIStore((s) => s.statusMessage)
  const clearStatus = useUIStore((s) => s.clearStatus)
  const cursorMM = useCanvasStore((s) => s.cursorMM)
  // Stored under the name zoomPct, but the value is the viewport scale in px/mm —
  // which is what the grid step is chosen from (see gridUtils.majorStepMM).
  const viewScale = useCanvasStore((s) => s.zoomPct)
  const darkMode = useUIStore((s) => s.darkMode)
  const { units, origin, widthMM, heightMM, thicknessMM, material, machineRigidity } = useWorkpieceStore()

  const orgWorld = originWorldXY(origin, widthMM, heightMM)

  const formatCoord = (mm: number) =>
    units === 'in'
      ? (mm / 25.4).toFixed(3) + '"'
      : mm.toFixed(1) + 'mm'

  // Stock size as W × H × T in the active units (unit symbol appended once).
  const dim = (mm: number) => {
    const v = units === 'in' ? mm / 25.4 : mm
    return (Math.round(v * 100) / 100).toString()
  }
  const dims = `${dim(widthMM)} × ${dim(heightMM)} × ${dim(thicknessMM)}${units === 'in' ? '"' : ' mm'}`
  const swatch = MATERIAL_COLORS[material][darkMode ? 'dark' : 'light']

  const rig = RIGIDITY_INFO[machineRigidity] ?? RIGIDITY_INFO[3]
  const RigIcon = rig.Icon

  const cnc = cursorMM
    ? { x: cursorMM.x - orgWorld.x, y: cursorMM.y - orgWorld.y }
    : null

  const mode = modeLabel(activeTool, nodeEditPathId)

  // One minor grid square — the spacing of the finest line on screen, and the value
  // snapPoint() rounds to when snapping is on. Labelled "Grid", not "Snap": the grid
  // has this size either way, and it is what the drawn lines are measuring.
  const gridStepMM = minorStepMM(majorStepMM(viewScale, units), units)
  // Plain "1/16", never ⅛ — the step steps through eighths, sixteenths and
  // thirty-seconds as you zoom, and only some of those have a glyph.
  const gridLabel = formatRulerLabel(gridStepMM, units, false) + (units === 'in' ? '"' : ' mm')

  // Auto-dismiss transient messages; errors/warnings linger longer. Keyed on
  // seq so re-showing the same text restarts the timer.
  useEffect(() => {
    if (!statusMessage) return
    const ms = statusMessage.kind === 'info' ? 5000 : 10000
    const t = setTimeout(clearStatus, ms)
    return () => clearTimeout(t)
  }, [statusMessage, clearStatus])

  const msgColor =
    statusMessage?.kind === 'error' ? 'text-red-600 dark:text-red-500 dark:text-red-400'
    : statusMessage?.kind === 'warn' ? 'text-amber-600 dark:text-amber-400'
    : 'text-blue-500 dark:text-blue-400'

  return (
    <footer className="h-7 bg-gray-100 dark:bg-neutral-900 border-t border-gray-300 dark:border-neutral-700 flex items-center px-3 text-[15px] text-gray-600 dark:text-neutral-400 select-none flex-shrink-0">
      {/* Left section */}
      <div className="flex-1 min-w-0 flex items-center gap-4">
        <span>Mode: {mode}</span>

        {snapEnabled && <span className="text-blue-400 font-medium">SNAP</span>}

        {workspaceTab === '2d' && cnc && (
          <span className="font-mono">
            X: {formatCoord(cnc.x)}&nbsp;&nbsp;Y: {formatCoord(cnc.y)}
          </span>
        )}

        {statusMessage && (
          <span
            className={`${msgColor} font-medium truncate min-w-0 cursor-pointer`}
            title={statusMessage.text}
            onClick={clearStatus}
          >
            {statusMessage.text}
          </span>
        )}
      </div>

      {/* Center section — material/stock + machine rigidity, always shown (2D and
          3D) so the current setup is visible at a glance. */}
      <div className="flex items-center gap-3 px-4 flex-shrink-0">
        {/* Material + stock size; swatch matches the workpiece fill.
            Width is deliberately left to the content: this cluster does change
            width when the persisted store rehydrates, but reserving its
            worst-case width (~20rem, for "Aluminum" plus a 24ch stock string
            like "609.6 × 304.8 × 19.05 mm") was measured to make no difference
            to CLS — 0.00001 either way — and cost ~90px of blank bar. */}
        <span className="flex items-center gap-1.5" title="Stock material and size">
          <span
            className="inline-block w-3 h-3 rounded-sm border border-black/20 dark:border-white/25"
            style={{ backgroundColor: swatch }}
          />
          <span>{MATERIAL_INFO[material].label}</span>
          <span className="text-gray-600 dark:text-neutral-400">·</span>
          <span className="font-mono">{dims}</span>
        </span>

        {/* Machine rigidity — icon + color escalate with how aggressive the auto
            feeds/speeds get, so a wrong setting is easy to catch. */}
        <span
          className="flex items-center gap-1.5 pl-3 border-l border-gray-300 dark:border-neutral-700"
          title={`Machine rigidity ${machineRigidity} of 5 · ${rig.label} — sets how aggressive auto feeds & speeds are`}
        >
          <RigIcon size={16} className={rig.color} />
          <span>{rig.label}</span>
        </span>
      </div>

      {/* Right section */}
      <div className="flex-1 min-w-0 flex items-center justify-end gap-4">
        {workspaceTab === '2d' && (
          <span
            className="font-mono"
            title={`Grid square at this zoom — ${snapEnabled ? 'points snap to it (S turns snapping off)' : 'snapping is off (S)'}`}
          >
            {/* Fixed-width value box, 6ch = the longest label this can produce
                ("0.1 mm", "200 mm", "6 1/4\""). Keeps the number from jittering
                as the step changes on zoom. Not a CLS fix: measured load CLS is
                0.00001 with or without it — Lighthouse's "avoid large layout
                shifts" entry for this element is a diagnostic listing of a
                sub-pixel wobble, not a real shift. */}
            Grid: <span className="inline-block min-w-[6ch] text-right">{gridLabel}</span>
          </span>
        )}
        {/* nowrap because the centre cluster is flex-shrink-0: on a narrow window
            this is what gets squeezed, and wrapping would break it onto a second
            line inside the h-7 bar. */}
        <span className="flex-shrink-0 whitespace-nowrap">FreazyKam {BUILD_DATE}</span>
      </div>
    </footer>
  )
}
