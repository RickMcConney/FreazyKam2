// ─── Double-Sided form ────────────────────────────────────────────────────────
// Cut side A, turn the board over on two dowel pins, cut side B (cam/doubleSided). Side B
// is the sheet beside the stock. The dowel holes are an ORDINARY PATH of two circles on
// side A, made the moment the job turns double-sided and moved with every change to the
// pins, so they can be drilled from here or from the Drill form like any other holes.
import { FormShell, ToggleRow, LengthInput, FormNotice, ToolSelector } from './shared'
import { holeTool } from '../../tools/registrationOps'
import { applyDoubleSided, changeFlip, dowelD, makeSingleSided } from '../../tools/doubleSidedRun'
import { useMemo } from 'react'
import { useWorkpieceStore, fmtLen } from '../../store/workpieceStore'
import { usePathsStore, useSelectedPaths, type PathUpdate } from '../../store/pathsStore'
import { useToolpathStore } from '../../store/toolpathStore'
import { useToolStore } from '../../store/toolStore'
import { useUIStore } from '../../store/uiStore'
import { useActiveSheet, pathCell } from '../../canvas/useSheets'
import { opCell, sameCell, STOCK_CELL } from '../../cam/sheets'
import {
  backCell, pinProblem, otherSideSteps, dowelDepthMM, normalizeDoubleSided, DOUBLE_SIDED_DEFAULTS,
  type DoubleSided, type FlipDirection,
} from '../../cam/doubleSided'
import { applyTransformSteps } from '../../canvas/selectionUtils'
import { HELICAL_TOOL_TYPES, toolsOfType } from './opDefaults'

const FLIPS = ['left-right', 'top-bottom'] as const
const FLIP_LABELS: Record<FlipDirection, string> = { 'left-right': 'Left ↔ Right', 'top-bottom': 'Top ↔ Bottom' }
const LABEL_CLS = 'block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1'
const HINT_CLS = 'text-label text-gray-600 dark:text-neutral-400'
const BTN_CLS = 'w-full py-1.5 rounded text-body font-medium border border-gray-400 dark:border-neutral-600 text-gray-800 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700 disabled:opacity-40 disabled:hover:bg-transparent transition-colors'

export function DoubleSidedForm({ onClose }: { onClose: () => void }) {
  // Read through the normaliser: a setting written by an older build in this same session
  // (hot reload) never passed the store's rehydrate.
  const raw = useWorkpieceStore((s) => s.doubleSided)
  const ds = useMemo(() => normalizeDoubleSided(raw), [raw])
  const { cells } = useActiveSheet()
  if (ds) return <DoubleSidedSettings ds={ds} onClose={onClose} />

  // A double-sided job is ONE board: its only other sheet is its own back — and it is not
  // also cut in tiles.
  const tiled = !!useWorkpieceStore.getState().tiling
  const otherSheets = cells.length > 1 || tiled
  return (
    <FormShell title="Double-Sided" onClose={onClose}>
      <p className={HINT_CLS}>
        Cut side A, turn the board over onto two dowel pins, then cut side B. Side B gets a
        sheet of its own beside the stock, showing the board as you will see it after the flip.
      </p>
      {/* Picking the flip IS making the job: there is nothing else to decide first, and a
          separate Make button was one more click that was easy to miss. */}
      <ToggleRow label="Pick the Flip to Start" options={FLIPS} value={null}
        onChange={(f) => { if (!otherSheets) applyDoubleSided({ flip: f, ...DOUBLE_SIDED_DEFAULTS }, true) }} labels={FLIP_LABELS} />
      <p className={HINT_CLS}>
        Side B goes to the right of the stock for a left ↔ right flip, below it for top ↔ bottom. The dowel holes are placed and drilled for you.
      </p>
      <FormNotice msg={tiled ? 'A tiled job cannot also be double-sided — make it a single board first.'
        : otherSheets ? 'A double-sided job is one board — move the parts on the other sheets onto the stock first.' : null} />
    </FormShell>
  )
}

function DoubleSidedSettings({ ds, onClose }: { ds: DoubleSided; onClose: () => void }) {
  const widthMM = useWorkpieceStore((s) => s.widthMM)
  const heightMM = useWorkpieceStore((s) => s.heightMM)
  const thicknessMM = useWorkpieceStore((s) => s.thicknessMM)
  const zOrigin = useWorkpieceStore((s) => s.zOrigin)
  const units = useWorkpieceStore((s) => s.units)
  const paths = usePathsStore((s) => s.paths)
  const operations = useToolpathStore((s) => s.operations)
  const tools = useToolStore((s) => s.tools)
  const selected = useSelectedPaths()
  const activeSheet = useUIStore((s) => s.activeSheet)
  const stock = { widthMM, heightMM }
  const up = <K extends keyof DoubleSided>(k: K, v: DoubleSided[K]) => applyDoubleSided({ ...ds, [k]: v })
  const back = backCell(ds.flip)
  const onBack = sameCell(activeSheet, back)

  // Toolpaths on side B with no path to carry them (peck points placed by hand) cannot
  // follow a change of flip — they stay where they are, which is no longer side B.
  const strandedOnB = operations.filter((op) => sameCell(opCell(op, stock), back)
    && !(op as { pathId?: string }).pathId).length

  const problem = pinProblem(ds, stock)
  const [start, end] = ds.flip === 'left-right' ? ['bottom', 'top'] : ['left', 'right']

  // ── The dowel holes ──
  // Drilled automatically (tools/registrationOps): this only picks the end mill.
  const dowelPath = ds.dowelPathId ? paths.find((p) => p.id === ds.dowelPathId) : undefined
  const dowelOp = dowelPath
    ? operations.find((op) => op.type === 'drill' && (op as { pathId?: string }).pathId === dowelPath.id)
    : undefined
  // HELICAL ONLY: the two holes are different sizes, and a peck makes every hole the size
  // of its bit — one bit pecking both would make the pins the same size again.
  const helicalTools = toolsOfType(tools, HELICAL_TOOL_TYPES)
  const tool = holeTool(tools, ds.toolId, ds.pin1DiaMM)
  const depthMM = dowelDepthMM(ds, thicknessMM)
  const toolNote = helicalTools.length === 0
    ? 'The dowel holes are bored helically, which needs an end mill — add one in the Tool Library.'
    : !tool ? `No end mill is small enough for the ${fmtLen(ds.pin1DiaMM, units)} small hole — add a smaller one, or make the pins bigger.`
    : ds.toolId && ds.toolId !== tool.id ? `That end mill does not fit the ${fmtLen(ds.pin1DiaMM, units)} small hole, so the ${tool.name} is used.` : null

  // ── Send to other side ──
  // Each selected path on side A goes to side B and each on side B to side A, mirrored
  // about the flip axis — one edit, so one undo.
  const sendable = selected.filter((p) => {
    const c = pathCell(p, stock)
    return p.id !== ds.dowelPathId && (sameCell(c, STOCK_CELL) || sameCell(c, back))
  })
  function sendToOtherSide() {
    const updates: PathUpdate[] = sendable.map((p) => {
      const steps = otherSideSteps(ds.flip, pathCell(p, stock), stock)
      const res = applyTransformSteps(p, steps)
      return { id: p.id, d: res.d, shapeParams: res.shapeParams, transforms: steps }
    })
    if (updates.length > 0) usePathsStore.getState().applyPathEdit({ updates, gesture: 'transform', label: 'Send to other side' })
  }

  return (
    <FormShell title="Double-Sided" onClose={onClose}>
      <div>
        <ToggleRow label="Flip" options={FLIPS} value={ds.flip}
          onChange={(f) => changeFlip(ds, f)} labels={FLIP_LABELS} />
        <p className={`${HINT_CLS} mt-0.5`}>
          Side B is the sheet {ds.flip === 'left-right' ? 'to the right of' : 'below'} the stock. Changing the flip takes side B's parts and the dowel holes with it.
        </p>
        <FormNotice msg={strandedOnB > 0
          ? `${strandedOnB} toolpath${strandedOnB > 1 ? 's' : ''} on side B ${strandedOnB > 1 ? 'have' : 'has'} no path (hand-placed drill points) and will not follow a change of flip.`
          : null} />
      </div>

      <div>
        <div className={LABEL_CLS}>Dowel Pins</div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label htmlFor="ds-dia1" className={HINT_CLS}>Pin 1 Ø (small)</label>
            <LengthInput id="ds-dia1" valueMM={ds.pin1DiaMM} minMM={1} stepMM={0.1} onChangeMM={(v) => up('pin1DiaMM', v)} />
          </div>
          <div>
            <label htmlFor="ds-dia2" className={HINT_CLS}>Pin 2 Ø (big)</label>
            <LengthInput id="ds-dia2" valueMM={ds.pin2DiaMM} minMM={1} stepMM={0.1} onChangeMM={(v) => up('pin2DiaMM', v)} />
          </div>
          <div>
            <label htmlFor="ds-pin1" className={HINT_CLS}>Pin 1 from {start}</label>
            <LengthInput id="ds-pin1" valueMM={ds.pin1MM} minMM={0} stepMM={1} onChangeMM={(v) => up('pin1MM', v)} />
          </div>
          <div>
            <label htmlFor="ds-pin2" className={HINT_CLS}>Pin 2 from {end}</label>
            <LengthInput id="ds-pin2" valueMM={ds.pin2MM} minMM={0} stepMM={1} onChangeMM={(v) => up('pin2MM', v)} />
          </div>
          <div>
            <label htmlFor="ds-spoil" className={HINT_CLS}>Into Spoilboard</label>
            <LengthInput id="ds-spoil" valueMM={ds.spoilDepthMM} minMM={0} stepMM={0.5} onChangeMM={(v) => up('spoilDepthMM', v)} />
          </div>
        </div>
        <p className={`${HINT_CLS} mt-0.5`}>
          Two pins on the flip axis, one bigger than the other — turned any other way, the big pin meets the small hole and the board will not go on.
        </p>
      </div>
      <FormNotice msg={problem} />

      <div>
        <div className={LABEL_CLS}>Dowel Holes</div>
        <div className="space-y-2">
          {dowelPath && dowelPath.d !== dowelD(ds) ? (
            // Moved or edited by hand (or made by an older build): say so rather than drill
            // holes that are not where the pins are.
            <div className="space-y-1">
              <FormNotice msg="The Dowel Holes path no longer matches the pins." />
              <button className={BTN_CLS} onClick={() => applyDoubleSided(ds)}>Put Dowel Holes Back on the Pins</button>
            </div>
          ) : dowelPath ? (
            <p className={HINT_CLS}>
              The "Dowel Holes" path on side A follows the pins.
            </p>
          ) : (
            <div className="space-y-1">
              <FormNotice msg="The dowel holes path has been deleted." />
              <button className={BTN_CLS} onClick={() => applyDoubleSided(ds, true)}>Add Dowel Holes</button>
            </div>
          )}
          <ToolSelector tools={helicalTools} value={tool?.id ?? ''} onChange={(id) => applyDoubleSided({ ...ds, toolId: id })} />
          <p className={HINT_CLS}>
            {dowelOp
              ? `Bored automatically, first in the program: ${fmtLen(depthMM, units)} deep — through the ${fmtLen(thicknessMM, units)} stock and ${fmtLen(ds.spoilDepthMM, units)} into the spoilboard. It follows every change here.`
              : `Bored automatically once a tool fits: ${fmtLen(depthMM, units)} deep, through the stock and into the spoilboard.`}
          </p>
          <FormNotice msg={toolNote} />
        </div>
      </div>

      <div>
        <div className={LABEL_CLS}>Side B</div>
        <div className="space-y-2">
          <p className={HINT_CLS}>
            Draw side B's parts on its sheet. Side A shows there faintly, mirrored, as it will lie after the flip.
          </p>
          <button className={BTN_CLS} onClick={() => useUIStore.getState().setActiveSheet(onBack ? STOCK_CELL : back)}>
            {onBack ? 'Show Side A' : 'Show Side B'}
          </button>
          <button className={BTN_CLS} disabled={sendable.length === 0} onClick={sendToOtherSide}
            title="Mirror the selected paths about the flip axis onto the other side — for a feature cut from both faces">
            Send {sendable.length > 0 ? `${sendable.length} Path${sendable.length > 1 ? 's' : ''}` : 'Selection'} to Other Side
          </button>
        </div>
      </div>

      <p className={HINT_CLS}>
        After the flip keep the XY zero — the pins hold the board where it was.{' '}
        {zOrigin === 'top'
          ? 'Z is set from the top of the stock, so re-zero Z on the new top face.'
          : 'Z is set from the spoilboard, so it stays as it was.'}
      </p>

      <button className={BTN_CLS} onClick={() => makeSingleSided(ds)}
        title="Back to an ordinary job. The dowel holes and their drilling are removed; side B's parts stay where they are, as a second sheet.">
        Make Single-Sided
      </button>
    </FormShell>
  )
}
