// ─── Tiling form ──────────────────────────────────────────────────────────────
// A board longer than the machine, cut in tiles and slid along on two dowel pins between
// them (cam/tiling). The stock is entered at its real size and everything is designed and
// generated as if the machine were that big; this form only says where the seams go and
// where the pins are; the pin holes drill themselves (tools/registrationOps). The seams
// can be dragged on the canvas.
import { FormShell, ToggleRow, LengthInput, FormNotice, ToolSelector } from './shared'
import { useMemo } from 'react'
import { useWorkpieceStore, fmtLen } from '../../store/workpieceStore'
import { usePathsStore } from '../../store/pathsStore'
import { useToolpathStore } from '../../store/toolpathStore'
import { useToolStore } from '../../store/toolStore'
import { useActiveSheet } from '../../canvas/useSheets'
import {
  anyTileTooLong, axisLengthMM, evenSeams, maxTileLengthMM, normalizeTiling, stationDepthMM, tileBounds, tileCount,
  tilingProblem, TILING_DEFAULTS, type TileAxis, type Tiling,
} from '../../cam/tiling'
import { applyTiling, removeTiling } from '../../tools/tilingRun'
import { holeTool } from '../../tools/registrationOps'
import { HELICAL_TOOL_TYPES, toolsOfType } from './opDefaults'

const AXES = ['y', 'x'] as const
const AXIS_LABELS: Record<TileAxis, string> = { y: 'Along Y', x: 'Along X' }
const LABEL_CLS = 'block text-label text-gray-600 dark:text-neutral-400 uppercase tracking-wider mb-1'
const HINT_CLS = 'text-label text-gray-600 dark:text-neutral-400'
const BTN_CLS = 'w-full py-1.5 rounded text-body font-medium border border-gray-400 dark:border-neutral-600 text-gray-800 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700 disabled:opacity-40 disabled:hover:bg-transparent transition-colors'
const SMALL_BTN = 'px-2 py-0.5 rounded border border-gray-400 dark:border-neutral-600 text-body text-gray-800 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700 disabled:opacity-40'

export function TilingForm({ onClose }: { onClose: () => void }) {
  const raw = useWorkpieceStore((s) => s.tiling)
  const t = useMemo(() => normalizeTiling(raw), [raw])
  const ds = useWorkpieceStore((s) => s.doubleSided)
  const widthMM = useWorkpieceStore((s) => s.widthMM)
  const heightMM = useWorkpieceStore((s) => s.heightMM)
  const tableW = useWorkpieceStore((s) => s.tableLimitWidthMM)
  const tableH = useWorkpieceStore((s) => s.tableLimitHeightMM)
  const units = useWorkpieceStore((s) => s.units)
  const { cells } = useActiveSheet()
  if (t) return <TilingSettings t={t} onClose={onClose} />

  // Tiling is ONE board, cut in windows: not with other sheets, and not with a flip.
  const blocked = ds ? 'A double-sided job cannot also be tiled — make it single-sided first.'
    : cells.length > 1 ? 'A tiled job is one board — move the parts on the other sheets onto the stock first.' : null
  // Picking the axis IS making the job — see the Double-Sided form.
  const start = (axis: TileAxis) => {
    if (blocked) return
    const base: Tiling = { axis, maxTravelMM: axis === 'y' ? tableH : tableW, seamsMM: [], ...TILING_DEFAULTS }
    applyTiling({ ...base, seamsMM: evenSeams(base, useWorkpieceStore.getState()) }, true)
  }
  return (
    <FormShell title="Tiling" onClose={onClose}>
      <p className={HINT_CLS}>
        For a board longer than the machine. Set the stock to the board's real size and design as if the machine
        were big enough; the job is then cut in tiles, sliding the board along on two dowel pins between them.
      </p>
      <ToggleRow label="Pick the Slide Axis to Start" options={AXES} value={null} onChange={start} labels={AXIS_LABELS} />
      <p className={HINT_CLS}>
        The board is {fmtLen(widthMM, units)} along X and {fmtLen(heightMM, units)} along Y. The machine travel starts at the Table Width or Height in Machine Limits ({fmtLen(tableW, units)} × {fmtLen(tableH, units)}) and can be changed once tiled. The pin holes are placed and drilled for you.
      </p>
      <FormNotice msg={blocked} />
    </FormShell>
  )
}

function TilingSettings({ t, onClose }: { t: Tiling; onClose: () => void }) {
  const widthMM = useWorkpieceStore((s) => s.widthMM)
  const heightMM = useWorkpieceStore((s) => s.heightMM)
  const thicknessMM = useWorkpieceStore((s) => s.thicknessMM)
  const units = useWorkpieceStore((s) => s.units)
  const paths = usePathsStore((s) => s.paths)
  const operations = useToolpathStore((s) => s.operations)
  const tools = useToolStore((s) => s.tools)
  const stock = { widthMM, heightMM }
  const up = <K extends keyof Tiling>(k: K, v: Tiling[K]) => applyTiling({ ...t, [k]: v })
  // A change that shrinks how far a tile may reach (the travel, the pins) re-splits the
  // board evenly when it leaves a tile too long, rather than leaving it to be found.
  const upFit = <K extends keyof Tiling>(k: K, v: Tiling[K]) => {
    const next = { ...t, [k]: v }
    applyTiling(anyTileTooLong(next, stock) ? { ...next, seamsMM: evenSeams(next, stock) } : next)
  }
  const n = tileCount(t)
  const b = tileBounds(t, stock)
  const problem = tilingProblem(t, stock)
  const [across0, across1] = t.axis === 'y' ? ['left', 'right'] : ['bottom', 'top']

  // ── Pin holes ──
  // Drilled automatically (tools/registrationOps): this only picks the end mill.
  const pinIds = t.pinPathIds ?? []
  const byId = new Map(paths.map((p) => [p.id, p]))
  const drilled = pinIds.filter((id) => operations.some((op) => op.type === 'drill' && (op as { pathId?: string }).pathId === id)).length
  // HELICAL ONLY: the two pins are different sizes, and a peck makes every hole its bit's size.
  const helicalTools = toolsOfType(tools, HELICAL_TOOL_TYPES)
  const tool = holeTool(tools, t.toolId, t.pin1DiaMM)
  const missing = pinIds.some((id) => !byId.has(id)) || pinIds.length !== n
  const toolNote = helicalTools.length === 0
    ? 'The pin holes are bored helically, which needs an end mill — add one in the Tool Library.'
    : !tool ? `No end mill is small enough for the ${fmtLen(t.pin1DiaMM, units)} small hole — add a smaller one, or make the pins bigger.`
    : t.toolId && t.toolId !== tool.id ? `That end mill does not fit the ${fmtLen(t.pin1DiaMM, units)} small hole, so the ${tool.name} is used.` : null

  const setTileCount = (count: number) => {
    const c = Math.max(1, count)
    applyTiling({ ...t, seamsMM: evenSeams(t, stock, c) })
  }
  const setSeam = (i: number, v: number) => {
    const seams = [...t.seamsMM]
    seams[i] = v
    up('seamsMM', seams.sort((x, y) => x - y))
  }

  return (
    <FormShell title="Tiling" onClose={onClose}>
      <ToggleRow label="Slide the Board" options={AXES} value={t.axis}
        onChange={(a) => { if (a !== t.axis) { const next = { ...t, axis: a }; applyTiling({ ...next, seamsMM: evenSeams(next, stock) }) } }}
        labels={AXIS_LABELS} />
      <div>
        <label htmlFor="tile-travel" className={LABEL_CLS}>Machine Travel along {t.axis.toUpperCase()}</label>
        <LengthInput id="tile-travel" valueMM={t.maxTravelMM} minMM={10} stepMM={10} onChangeMM={(v) => upFit('maxTravelMM', v)} />
        <p className={`${HINT_CLS} mt-0.5`}>
          How far the machine can cut along the slide axis. A tile can be at most {fmtLen(maxTileLengthMM(t, 0, Math.max(n, 2)), units)} — it also has to reach the next pair of pin holes.
        </p>
      </div>

      <div>
        <div className={LABEL_CLS}>Tiles</div>
        <div className="flex items-center gap-2 mb-1">
          <button className={SMALL_BTN} disabled={n <= 1} onClick={() => setTileCount(n - 1)} aria-label="Fewer tiles">−</button>
          <span className="text-body text-gray-800 dark:text-neutral-200 tabular-nums">{n} tile{n === 1 ? '' : 's'}</span>
          <button className={SMALL_BTN} onClick={() => setTileCount(n + 1)} aria-label="More tiles">+</button>
          <button className={SMALL_BTN} onClick={() => setTileCount(n)} title="Space the seams evenly">Even</button>
        </div>
        <div className="space-y-1">
          {t.seamsMM.map((v, i) => (
            <div key={i} className="flex items-center gap-2">
              <label htmlFor={`tile-seam-${i}`} className={`${HINT_CLS} w-20 shrink-0`}>Seam {i + 1}</label>
              <LengthInput id={`tile-seam-${i}`} valueMM={v} minMM={0} maxMM={axisLengthMM(t, stock)} stepMM={1} onChangeMM={(x) => setSeam(i, x)} />
            </div>
          ))}
        </div>
        <p className={`${HINT_CLS} mt-0.5`}>
          {Array.from({ length: n }, (_, k) => fmtLen(b[k + 1] - b[k], units, 0)).join(' · ')}.
          {' '}Drag a seam on the canvas — it snaps where it crosses no cut, and to whole {units === 'in' ? 'inch' : 'mm'} tile lengths.
        </p>
      </div>

      <div>
        <div className={LABEL_CLS}>Dowel Pins</div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label htmlFor="tile-dia1" className={HINT_CLS}>Pin 1 Ø (small)</label>
            <LengthInput id="tile-dia1" valueMM={t.pin1DiaMM} minMM={1} stepMM={0.1} onChangeMM={(v) => up('pin1DiaMM', v)} />
          </div>
          <div>
            <label htmlFor="tile-dia2" className={HINT_CLS}>Pin 2 Ø (big)</label>
            <LengthInput id="tile-dia2" valueMM={t.pin2DiaMM} minMM={1} stepMM={0.1} onChangeMM={(v) => upFit('pin2DiaMM', v)} />
          </div>
          <div>
            <label htmlFor="tile-p1" className={HINT_CLS}>Pin 1 from {across0}</label>
            <LengthInput id="tile-p1" valueMM={t.pin1MM} minMM={0} stepMM={1} onChangeMM={(v) => up('pin1MM', v)} />
          </div>
          <div>
            <label htmlFor="tile-p2" className={HINT_CLS}>Pin 2 from {across1}</label>
            <LengthInput id="tile-p2" valueMM={t.pin2MM} minMM={0} stepMM={1} onChangeMM={(v) => up('pin2MM', v)} />
          </div>
          <div>
            <label htmlFor="tile-pstart" className={HINT_CLS}>From Tile Start</label>
            <LengthInput id="tile-pstart" valueMM={t.pinFromStartMM} minMM={0} stepMM={1} onChangeMM={(v) => upFit('pinFromStartMM', v)} />
          </div>
          <div>
            <label htmlFor="tile-spoil" className={HINT_CLS}>Into Spoilboard</label>
            <LengthInput id="tile-spoil" valueMM={t.spoilDepthMM} minMM={0} stepMM={0.5} onChangeMM={(v) => up('spoilDepthMM', v)} />
          </div>
        </div>
        <p className={`${HINT_CLS} mt-0.5`}>
          The pins stay in the spoilboard; each tile drills the board's next pair before it slides on. One pin bigger than the other, so the board cannot go back on turned round. Keep them in the waste — every station lands on the board.
        </p>
      </div>
      <FormNotice msg={problem} />

      <div>
        <div className={LABEL_CLS}>Pin Holes</div>
        <div className="space-y-2">
          {missing && (
            <div className="space-y-1">
              <FormNotice msg="Some pin-hole paths are missing." />
              <button className={BTN_CLS} onClick={() => applyTiling(t, true)}>Put the Pin Holes Back</button>
            </div>
          )}
          <ToolSelector tools={helicalTools} value={tool?.id ?? ''} onChange={(id) => up('toolId', id)} />
          <p className={HINT_CLS}>
            {drilled === n
              ? `Bored automatically, first in every tile. The first pair goes ${fmtLen(t.spoilDepthMM, units)} into the spoilboard (${fmtLen(stationDepthMM(t, 0, thicknessMM), units)} deep) — that is where the pins go; the rest only through the board (${fmtLen(stationDepthMM(t, 1, thicknessMM), units)}). They follow every change here.`
              : `Bored automatically once a tool fits (${drilled} of ${n} so far).`}
          </p>
          <FormNotice msg={toolNote} />
        </div>
      </div>

      <p className={HINT_CLS}>
        Pick a tile in the toolbar to simulate or run it; Export writes one file per tile. Keep the XY and Z zero between tiles — the pins put each tile where the last one left off.
      </p>

      <button className={BTN_CLS} onClick={() => removeTiling(t)}
        title="Back to one program. The pin holes and their drilling are removed.">
        Make Single Board
      </button>
    </FormShell>
  )
}
