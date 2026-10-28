import { opCell, opsAtSheetOrigins, opsOnCell, programSheetCount, sameCell, STOCK_CELL } from './sheets'
import { dowelDepthMM } from './doubleSided'
import { tileCount, tileOps, tilingProblem } from './tiling'
import { reachesProgram } from './programOps'
import { sheetLayoutNow } from '../canvas/useSheets'
import { useToolpathStore, nothingToCut, type AnyOperation } from '../store/toolpathStore'
import { useToolStore } from '../store/toolStore'
import { usePostProcessorStore } from '../store/postProcessorStore'
import { useWorkpieceStore, fmtLen, zDatumOffsetMM, machineMotionLimits, MATERIAL_INFO, type Material } from '../store/workpieceStore'
import { feedsForTool, aimChipLoad, toolChipCeilingMM } from './feeds'
import { feedDiameterMM } from './geom'
import { generateGcodeWithOps, initialToolId } from './gcode'
import { movesToDrawing, toMachine } from './machineFrame'
import { parseGcode, segTool, toolTypeOf, feedDiameterOf, type ParsedGcode } from '../sim/gcodeParser'
import { lengthBelowSpeed } from '../sim/motionPlanner'
import { originWorldXY } from '../canvas/layers/WorkpieceLayer'
import { findRapidGouges } from '../sim/rapidGouge'

interface PreflightWarning {
  level: 'warn' | 'info'
  text: string
}

interface PreflightTool {
  name: string
  diameterMM: number
  rpm: number
}

export interface ExportPreflight {
  hasToolpaths: boolean
  units: 'mm' | 'in'
  machine: {
    profileName: string
    outputUnits: 'mm' | 'in'
    origin: string
    zOrigin: 'top' | 'bottom'
    safeHeightMM: number
    maxFeedMmMin: number
    minSpindleRpm: number
    maxSpindleRpm: number
    rigidity: number
    autoFeed: boolean
  }
  stock: { widthMM: number; heightMM: number; thicknessMM: number }
  job: {
    operationCount: number
    /** How many sheets of stock there are (cam/sheets) — more than one, and the export
     *  writes one file per sheet that has something to cut. */
    sheets: number
    /** How many of them have something to cut — the files that export writes. */
    sheetsWithCuts: number
    /** The programs are a tiled job's tiles (cam/tiling), not sheets. */
    tiled: boolean
    tools: PreflightTool[]
    spindleSpeeds: number[]
    extents: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } | null
    deepestCutMM: number
    estimatedTimeS: number
  }
  warnings: PreflightWarning[]
}

// Gather a summary + safety warnings for the toolpaths about to be exported.
// Mirrors the operation filter used by generateGcode so the report matches the
// file that will actually be written.
export function buildExportPreflight(): ExportPreflight {
  // Each operation in the frame it is CUT in — its own sheet's (cam/sheets). Judged where
  // it lies on the canvas, every part below the first sheet reads as off the stock.
  // A TILED job (cam/tiling) is judged tile by tile, each at its own origin, as it will be
  // cut: the whole board at once would read as wider than the machine every time.
  const stored = useToolpathStore.getState().operations
  const stock = useWorkpieceStore.getState()
  const tiling = stock.tiling
  const tilePrograms = tiling
    ? Array.from({ length: tileCount(tiling) }, (_, k) => tileOps(
      stored.filter((op) => sameCell(opCell(op, stock), STOCK_CELL)), tiling, stock, k,
      (op) => op.generatedWith?.safeHeightMM ?? stock.safeHeightMM))
    : null
  const operations = tilePrograms ? tilePrograms.flat() : opsAtSheetOrigins(stored, stock)
  const sheets = tilePrograms ? tilePrograms.length : sheetLayoutNow().length
  const sheetsWithCuts = tilePrograms ? tilePrograms.filter((ops) => ops.some(reachesProgram)).length : programSheetCount(stored, stock)
  const { tools } = useToolStore.getState()
  const toolsById = Object.fromEntries(tools.map((t) => [t.id, t]))
  const profile = usePostProcessorStore.getState().getActiveProfile()
  const wp = useWorkpieceStore.getState()
  const {
    widthMM, heightMM, thicknessMM, origin, zOrigin, units, material,
    maxFeedMmMin, minSpindleRpm, maxSpindleRpm, safeHeightMM, machineRigidity, autoFeedEnabled,
    tableLimitWidthMM, tableLimitHeightMM, tableLimitDepthMM,
  } = wp
  const xDir = wp.machineXDir ?? 'right'
  // The table's width and height are as the drawing shows it; name each by the machine
  // axis that runs that way, which a turned machine swaps.
  const [wAxis, hAxis] = xDir === 'right' || xDir === 'left' ? ['X', 'Y'] : ['Y', 'X']

  const fmt = (mm: number) => fmtLen(mm, units, 1)
  // These warnings are read while deciding whether to run a job, so the grammar has to
  // hold at n = 1 rather than fall back to "operation(s)".
  const nS = (n: number) => (n === 1 ? '' : 's')
  const nIsAre = (n: number) => (n === 1 ? 'is' : 'are')

  const doneOps = operations.filter(reachesProgram)

  // A double-sided job's dowel holes go into the spoilboard ON PURPOSE (cam/doubleSided):
  // they are judged against their own allowance, never as the job cutting through.
  const ds = wp.doubleSided
  const dowelOp = ds?.dowelPathId
    ? doneOps.find((op) => op.type === 'drill' && (op as { pathId?: string }).pathId === ds.dowelPathId)
    : undefined
  // …and so do a tiled job's pin holes.
  const pinPathIds = new Set(tiling?.pinPathIds ?? [])
  const isRegistration = (op: AnyOperation) => op === dowelOp
    || (op.type === 'drill' && pinPathIds.has((op as { pathId?: string }).pathId ?? ''))
  let partMinZ = Infinity

  // Distinct tools in order of first use (roughing tool first for 3D profiles).
  const usedToolIds: string[] = []
  const addTool = (id?: string) => {
    if (id && toolsById[id] && !usedToolIds.includes(id)) usedToolIds.push(id)
  }
  for (const op of doneOps) {
    // The same rule the G-code follows: a roughing tool counts only if it roughed.
    addTool(initialToolId(op))
    addTool(op.toolId)
  }
  const toolList: PreflightTool[] = usedToolIds.map((id) => {
    const t = toolsById[id]
    return { name: t.name, diameterMM: t.diameterMM, rpm: feedsForTool(t).rpm }
  })
  const spindleSpeeds = [...new Set(toolList.map((t) => t.rpm))].sort((a, b) => a - b)
  const tooFastTools = usedToolIds.filter((id) => feedsForTool(toolsById[id]).spindleTooFast)

  // Extents in machine coordinates (relative to the work origin, matching the
  // exported G-code). Span is origin-independent so it's used for table checks.
  const org = originWorldXY(origin, widthMM, heightMM)
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity
  // Raw workpiece-coord extents (stock is [0,W] × [0,H]) for the out-of-stock check.
  let wpMinX = Infinity, wpMaxX = -Infinity, wpMinY = Infinity, wpMaxY = -Infinity
  for (const op of doneOps) {
    for (const s of op.segments) {
      const mx = s.x - org.x, my = s.y - org.y
      if (mx < minX) minX = mx
      if (mx > maxX) maxX = mx
      if (my < minY) minY = my
      if (my > maxY) maxY = my
      if (s.z < minZ) minZ = s.z
      if (s.z > maxZ) maxZ = s.z
      if (!isRegistration(op) && s.z < partMinZ) partMinZ = s.z
      if (s.x < wpMinX) wpMinX = s.x
      if (s.x > wpMaxX) wpMaxX = s.x
      if (s.y < wpMinY) wpMinY = s.y
      if (s.y > wpMaxY) wpMaxY = s.y
    }
  }
  const hasExtents = doneOps.length > 0 && Number.isFinite(minX)
  const extents = hasExtents ? { minX, maxX, minY, maxY, minZ, maxZ } : null
  const deepestCutMM = hasExtents ? Math.max(0, -minZ) : 0
  const spanX = hasExtents ? maxX - minX : 0
  const spanY = hasExtents ? maxY - minY : 0

  // Run-time estimate: generate the G-code and run it through the same parser the
  // simulator uses, timed by the machine's planner (acceleration, cornering, max rates).
  // Tool-change pauses are not in it.
  const program = doneOps.length > 0 ? generateGcodeWithOps(operations, toolsById, 'estimate', profile) : null
  const parsed = program ? parseGcode(program.gcode, undefined, machineMotionLimits()) : null
  const estimatedTimeS = parsed ? parsed.totalTimeS : 0

  const warnings: PreflightWarning[] = []

  // Operations that will NOT be in the file. `doneOps` is the export filter, so anything
  // an operation-shaped thing that isn't in it is silently missing from the job — a pocket
  // too small for its cutter leaves that detail uncut with nothing in the G-code to say
  // so. Imported G-code operations are never exported by design, so they aren't reported.
  const exportable = operations.filter((o) => o.type !== 'gcode')
  const named = (ops: typeof operations, max = 4) =>
    ops.slice(0, max).map((o) => o.name).join(', ') + (ops.length > max ? `, +${ops.length - max} more` : '')

  const failed = exportable.filter((o) => o.visible && o.status === 'error')
  if (failed.length > 0) {
    // One representative message: a run of failures over the same selection is almost
    // always the same cause (usually "too small for the selected tool diameter").
    const reason = failed.find((o) => o.errorMessage)?.errorMessage
    warnings.push({
      level: 'warn',
      text: `${failed.length} operation${nS(failed.length)} failed to generate and ${nIsAre(failed.length)} NOT in this file — ${named(failed)}.` +
        (reason ? ` First error: "${reason}".` : '') +
        ` Whatever ${failed.length === 1 ? 'it was' : 'they were'} meant to cut will be left uncut.`,
    })
  }

  // Out-of-date ops are regenerated by the export itself (optimizeStartPoints, in program
  // order) before the file is written — this report is built before that runs, so it says
  // what WILL happen rather than calling them missing.
  const stale = exportable.filter((o) => o.visible && o.status === 'needs-update')
  if (stale.length > 0) {
    warnings.push({
      level: 'info',
      text: `${stale.length} operation${nS(stale.length)} ${nIsAre(stale.length)} out of date and will be regenerated before the file is written — ${named(stale)}. ` +
        `If ${stale.length === 1 ? 'it fails' : 'any fails'} to regenerate, ${stale.length === 1 ? 'it is' : 'those are'} left out of the file.`,
    })
  }

  // An inlay half its partner already cuts completely (thin text: the V-bit's walls meet
  // and take the whole socket) is empty on PURPOSE. It is out of the file for the same
  // reason, and no tool change is emitted for it — but saying so as a warning, in the
  // words used for an op that failed, read as something having gone wrong.
  const noCut = exportable.filter((o) => o.visible && nothingToCut(o, operations))
  if (noCut.length > 0) {
    warnings.push({
      level: 'info',
      text: `${named(noCut)}: nothing to cut — the V-bit clears ${noCut.length === 1 ? 'it' : 'them'} completely, so ` +
        `${noCut.length === 1 ? 'it is' : 'they are'} not in this file and ${noCut.length === 1 ? 'its tool is' : 'their tools are'} not called for.`,
    })
  }

  const ungenerated = exportable.filter(
    (o) => o.visible && !nothingToCut(o, operations)
      && (o.status === 'pending' || o.status === 'generating' || (o.status === 'done' && o.segments.length === 0))
  )
  if (ungenerated.length > 0) {
    warnings.push({
      level: 'warn',
      text: `${ungenerated.length} operation${nS(ungenerated.length)} ${ungenerated.length === 1 ? 'has' : 'have'} no toolpath and ${nIsAre(ungenerated.length)} NOT in this file — ${named(ungenerated)}.`,
    })
  }

  const hiddenOps = exportable.filter((o) => !o.visible)
  if (hiddenOps.length > 0) {
    // Deliberate, so info rather than warn — but it still changes what gets cut.
    warnings.push({
      level: 'info',
      text: `${hiddenOps.length} hidden operation${nS(hiddenOps.length)} ${nIsAre(hiddenOps.length)} excluded from this file — ${named(hiddenOps)}.`,
    })
  }

  // Toolpath crosses the stock edge — the bit will cut into the spoilboard or air.
  const tol = 0.01
  if (hasExtents && (wpMinX < -tol || wpMinY < -tol || wpMaxX > widthMM + tol || wpMaxY > heightMM + tol)) {
    warnings.push({
      level: 'warn',
      text: `Toolpath extends outside the stock (${fmt(widthMM)} × ${fmt(heightMM)}). ` +
        `The tool will cut beyond the stock — reposition the geometry or enlarge the workpiece.`,
    })
  }

  if (spindleSpeeds.length > 1) {
    warnings.push({
      level: 'info',
      text: `This job uses ${spindleSpeeds.length} different spindle speeds (${spindleSpeeds.join(', ')} RPM). ` +
        `If your machine can't set spindle speed from G-code, set it by hand at each change.`,
    })
  }

  if (toolList.length > 1) {
    warnings.push({
      level: 'info',
      text: `This job uses ${toolList.length} tools — ${toolList.length - 1} tool change${nS(toolList.length - 1)} required. ` +
        `Swap the tool and re-zero Z when the program pauses.`,
    })
  }

  if (tableLimitWidthMM > 0 && spanX > tableLimitWidthMM) {
    warnings.push({ level: 'warn', text: `Toolpath ${wAxis} span ${fmt(spanX)} exceeds the table travel of ${fmt(tableLimitWidthMM)}.` })
  }
  if (tableLimitHeightMM > 0 && spanY > tableLimitHeightMM) {
    warnings.push({ level: 'warn', text: `Toolpath ${hAxis} span ${fmt(spanY)} exceeds the table travel of ${fmt(tableLimitHeightMM)}.` })
  }
  if (tableLimitDepthMM > 0 && deepestCutMM > tableLimitDepthMM) {
    warnings.push({ level: 'warn', text: `Deepest cut ${fmt(deepestCutMM)} exceeds the max Z travel of ${fmt(tableLimitDepthMM)}.` })
  }

  const deepestPartCutMM = Number.isFinite(partMinZ) ? Math.max(0, -partMinZ) : 0
  if (deepestPartCutMM > thicknessMM + 1e-3) {
    warnings.push({
      level: 'info',
      text: `Deepest cut ${fmt(deepestPartCutMM)} goes through the ${fmt(thicknessMM)} stock — use a spoilboard or tabs to hold the part.`,
    })
  }

  if (tiling) {
    const problem = tilingProblem(tiling, stock)
    if (problem) warnings.push({ level: 'warn', text: problem })
    const pinsDrilled = pinPathIds.size > 0 && doneOps.some((op) => isRegistration(op))
    if (!pinsDrilled) {
      warnings.push({ level: 'warn', text: 'Tiled job with no pin holes drilled — the tiles will not line up. They drill themselves once an end mill fits the small hole: pick one in the Tiling form.' })
    }
    warnings.push({
      level: 'info',
      text: `Tiled: ${sheets} tiles, one file each. Put the pins in the first holes after tile 1; after each tile slide the board ${tiling.axis === 'y' ? 'along Y' : 'along X'} until the next holes drop onto the pins. Keep the XY and Z zero.`,
    })
  }

  if (ds) {
    const allowedMM = dowelDepthMM(ds, thicknessMM)
    if (!dowelOp) {
      warnings.push({ level: 'warn', text: 'Double-sided job with no dowel holes drilled — side B will not line up with side A. They drill themselves once an end mill fits the small hole: pick one in the Double-Sided form.' })
    } else {
      const dowelDepth = Math.max(0, -Math.min(...dowelOp.segments.map((s) => s.z)))
      if (dowelDepth > allowedMM + 1e-3) {
        warnings.push({ level: 'warn', text: `The dowel holes go ${fmt(dowelDepth - thicknessMM)} into the spoilboard, deeper than the ${fmt(ds.spoilDepthMM)} allowed.` })
      }
      // First on SIDE A: side B is its own program, cut after the flip.
      const firstOnA = stored.find((op) => reachesProgram(op) && sameCell(opCell(op, stock), STOCK_CELL))
      if (firstOnA?.id !== dowelOp.id) {
        warnings.push({ level: 'warn', text: 'The dowel holes are not the first cut — drill them before anything is cut loose, or the board can shift.' })
      }
    }
    warnings.push({
      level: 'info',
      text: `Double-sided: cut Side A, put the pins in the dowel holes, turn the board over ${ds.flip === 'left-right' ? 'left to right' : 'top to bottom'} onto them, then cut Side B. ` +
        `Keep the XY zero; ${zOrigin === 'top' ? 're-zero Z on the new top face' : 'Z is set from the spoilboard, so it stays'}.`,
    })
  }

  if (tooFastTools.length > 0) {
    warnings.push({
      level: 'warn',
      text: `The spindle can't run slow enough for the material's safe surface speed on ${tooFastTools.length} tool${nS(tooFastTools.length)} — ` +
        `risk of overheating/built-up edge. Use a smaller bit or a slower spindle.`,
    })
  }

  // Chip-load sanity per tool: judge the exported feed's chip load against the
  // rigidity-adjusted target the same way the simulator's gauge does. Chips that
  // are too large can break the bit or stall the spindle; chips that are too small
  // make the edge rub and overheat. (Drills cut by plunging, not feed-per-tooth
  // side load, so they're excluded.)
  const heavyTools: string[] = []
  const rubbingTools: string[] = []
  for (const id of usedToolIds) {
    const t = toolsById[id]
    if (t.type === 'drill') continue
    const f = feedsForTool(t)
    const flutes = t.fluteCount > 0 ? t.fluteCount : 1
    if (f.rpm <= 0 || f.xyFeedMmMin <= 0) continue
    const aimFz = aimChipLoad(t.type, feedDiameterMM(t), material, machineRigidity, toolChipCeilingMM(t))
    if (aimFz <= 0) continue
    const ratio = (f.xyFeedMmMin / (f.rpm * flutes)) / aimFz
    if (ratio > 1.4) heavyTools.push(t.name)
    else if (ratio < 0.75) rubbingTools.push(t.name)
  }
  if (heavyTools.length > 0) {
    warnings.push({
      level: 'warn',
      text: `Chip load is too high on ${heavyTools.length} tool${nS(heavyTools.length)} (${heavyTools.join(', ')}) — ` +
        `the chips are too large for the programmed feed and speed, risking tool breakage or a stalled spindle. ` +
        `Lower the feed or raise the RPM${autoFeedEnabled ? '' : ' (or turn on auto feeds & speeds)'}.`,
    })
  }
  if (rubbingTools.length > 0) {
    warnings.push({
      level: 'warn',
      text: `Chip load is too low on ${rubbingTools.length} tool${nS(rubbingTools.length)} (${rubbingTools.join(', ')}) — ` +
        `the tool will rub instead of cut and run hot. ` +
        `Raise the feed or lower the RPM${autoFeedEnabled ? '' : ' (or turn on auto feeds & speeds)'}.`,
    })
  }

  // Chip load lost to the machine SLOWING DOWN: the programmed feed is right, but on a
  // corner-heavy cut the machine never reaches it, and the spindle doesn't slow with it.
  if (parsed && program) {
    const slowed = slowedCuts(parsed, program.opStarts, zDatumOffsetMM(zOrigin, thicknessMM), material, machineRigidity)
    if (slowed.length > 0) {
      const plastic = MATERIAL_INFO[material].kind === 'plastic'
      const list = slowed.slice(0, 4).map((o) => {
        const name = operations.find((op) => op.id === o.opId)?.name ?? 'operation'
        return `${name} ${Math.round(o.fraction * 100)}%`
      }).join(', ') + (slowed.length > 4 ? `, +${slowed.length - 4} more` : '')
      warnings.push({
        level: 'warn',
        text: `The machine slows below a cutting chip on part of ${slowed.length} operation${nS(slowed.length)} (${list} of the cut) — ` +
          `corners and short moves it cannot reach full feed on, with the spindle still at full speed. ` +
          (plastic ? `In ${MATERIAL_INFO[material].label} that is where it melts. ` : `That is where it burns. `) +
          // FIXES IN THE JOB, NEVER IN THE MACHINE. Acceleration and junction deviation are
          // the controller's tuning — set for what the machine can actually do — and raising
          // them to save a cut buys lost steps, ringing or a crash. Chip load is
          // feed ÷ (RPM × flutes), so at the slower real feed it comes back with less RPM or
          // fewer flutes; chips cleared away cannot rub and reheat.
          `Lower the RPM, use a tool with fewer flutes, or blow the chips clear.`,
      })
    }
  }

  // Rapids that cut (sim/rapidGouge.ts). Judged per SHEET: each sheet's program starts at
  // the same corner of fresh stock, so a combined program would judge one sheet's rapids
  // against another sheet's cuts.
  if (doneOps.length > 0) {
    const zOff = zDatumOffsetMM(zOrigin, thicknessMM)
    const org = originWorldXY(origin, widthMM, heightMM)
    const hits: { opId: string; depthMM: number; x: number; y: number; sheet: number }[] = []
    // One program per sheet — or per tile, on a tiled job.
    const programs = tilePrograms ?? sheetLayoutNow().map((cell) => opsOnCell(stored, cell, stock))
    programs.forEach((onCell, k) => {
      if (!onCell.some(reachesProgram)) return
      const single = sheetsWithCuts <= 1 && parsed && program
      const prog = single ? program : generateGcodeWithOps(onCell, toolsById, 'estimate', profile)
      const p = single ? parsed : parseGcode(prog.gcode)
      // The check wants TOP-referenced Z, as the simulator holds it.
      // ...and on the drawing's axes, which the stock box is in (cam/machineFrame.ts).
      const segs = zOff || xDir !== 'right' ? p.segments.map((g) => ({ ...g, z: g.z - zOff, prevZ: g.prevZ - zOff })) : p.segments
      movesToDrawing(segs, xDir)
      for (const g of findRapidGouges(segs, p.toolStates, { widthMM, heightMM, thicknessMM, orgX: org.x, orgY: org.y })) {
        let j = 0
        while (j + 1 < prog.opStarts.length && g.lineIdx >= prog.opStarts[j + 1].line) j++
        // Reported in the PROGRAM's X/Y, so it can be found in the file and on the machine.
        const [x, y] = toMachine(g.x, g.y, xDir)
        hits.push({ opId: prog.opStarts[j]?.opId ?? '', depthMM: g.depthMM, x, y, sheet: k + 1 })
      }
    })
    if (hits.length > 0) {
      const deepest = [...hits].sort((a, b) => b.depthMM - a.depthMM)
      const where = (h: typeof hits[number]) =>
        `${fmt(h.depthMM)} deep in ${stored.find((o) => o.id === h.opId)?.name ?? 'the program'}` +
        `${programs.length > 1 ? ` on ${tilePrograms ? 'tile' : 'sheet'} ${h.sheet}` : ''} at X${h.x.toFixed(1)} Y${h.y.toFixed(1)}`
      warnings.push({
        level: 'warn',
        text: `${hits.length} rapid (G0) move${nS(hits.length)} run${hits.length === 1 ? 's' : ''} into stock at full speed — ` +
          `${deepest.slice(0, 3).map(where).join('; ')}${hits.length > 3 ? `; +${hits.length - 3} more` : ''}. ` +
          `It may be stock a later pass clears anyway, but the tool still takes that cut at rapid speed. ` +
          `Simulate in 3D: anything the finished part keeps is shown red.`,
      })
    }
  }

  // Inlay male/female overlap: a male plug and its female pocket must be cut at
  // separate spots on the stock. If both roles are present and their toolpaths
  // overlap in XY, the user likely ran "inlay in place" without moving the male
  // copy, so the plug sits on top of the pocket.
  type BB = { mnx: number; mny: number; mxx: number; mxy: number }
  const opBBox = (op: { segments: { x: number; y: number }[] }): BB | null => {
    let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity
    for (const s of op.segments) {
      if (s.x < mnx) mnx = s.x
      if (s.x > mxx) mxx = s.x
      if (s.y < mny) mny = s.y
      if (s.y > mxy) mxy = s.y
    }
    return Number.isFinite(mnx) ? { mnx, mny, mxx, mxy } : null
  }
  const bbOverlap = (a: BB, b: BB): boolean => {
    const ix = Math.min(a.mxx, b.mxx) - Math.max(a.mnx, b.mnx)
    const iy = Math.min(a.mxy, b.mxy) - Math.max(a.mny, b.mny)
    if (ix <= 0 || iy <= 0) return false
    const minArea = Math.min((a.mxx - a.mnx) * (a.mxy - a.mny), (b.mxx - b.mnx) * (b.mxy - b.mny))
    return minArea > 0 && (ix * iy) / minArea > 0.25
  }
  const femaleBoxes = doneOps.filter((o) => o.type === 'inlay' && o.role === 'female').map(opBBox)
  const maleBoxes = doneOps.filter((o) => o.type === 'inlay' && o.role === 'male').map(opBBox)
  const inlayOverlap = femaleBoxes.some((f) => f && maleBoxes.some((m) => m && bbOverlap(f, m)))
  if (inlayOverlap) {
    warnings.push({
      level: 'warn',
      text: `An inlay plug (male) and pocket (female) toolpath overlap on the stock — they must be cut at ` +
        `separate positions. If you used "inlay in place", duplicate the male part and move it clear of the ` +
        `female pocket before exporting.`,
    })
  }

  if (profile.unitMode !== units) {
    warnings.push({
      level: 'info',
      text: `Display units (${units}) differ from the post-processor output units (${profile.unitMode}). The file will be in ${profile.unitMode}.`,
    })
  }

  return {
    hasToolpaths: doneOps.length > 0,
    units,
    machine: {
      profileName: profile.name,
      outputUnits: profile.unitMode,
      origin,
      zOrigin,
      safeHeightMM,
      maxFeedMmMin,
      minSpindleRpm,
      maxSpindleRpm,
      rigidity: machineRigidity,
      autoFeed: autoFeedEnabled,
    },
    stock: { widthMM, heightMM, thicknessMM },
    job: {
      operationCount: doneOps.length,
      sheets,
      sheetsWithCuts,
      tiled: !!tiling,
      tools: toolList,
      spindleSpeeds,
      extents,
      deepestCutMM,
      estimatedTimeS,
    },
    warnings,
  }
}

// An operation's cut is reported once this share of it runs too slow for its chip.
const SLOWED_SHARE = 0.15

/**
 * Operations whose steady side-cutting spends at least SLOWED_SHARE of its length slower
 * than the chip-load gauge's "rubbing" band, BECAUSE THE MACHINE SLOWS DOWN — moves whose
 * programmed feed is already too slow are the plain low-chip warning's business, not this.
 * Judged exactly as the simulator's gauge judges a move: in the material, not descending,
 * not a drill, against 0.75 × the aimed chip.
 */
export function slowedCuts(
  parsed: ParsedGcode,
  opStarts: { opId: string; line: number }[],
  zOffMM: number,
  material: Material,
  rigidity: number,
): { opId: string; fraction: number }[] {
  if (opStarts.length === 0) return []
  const judged = new Map<string, number>()
  const slow = new Map<string, number>()
  let k = 0
  for (const seg of parsed.segments) {
    while (k + 1 < opStarts.length && seg.lineIdx >= opStarts[k + 1].line) k++
    if (seg.rapid || seg.acc === undefined) continue
    const z0 = seg.prevZ - zOffMM, z1 = seg.z - zOffMM
    if (z0 >= -0.001 || z1 >= -0.001 || z1 < z0 - 1e-3) continue
    const ts = segTool(seg, parsed.toolStates)
    const type = toolTypeOf(ts)
    if (type === 'drill' || !(ts.spindleRpm > 0) || !(ts.fluteCount > 0)) continue
    const perSec = (ts.spindleRpm * ts.fluteCount) / 60
    const vRub = 0.75 * aimChipLoad(type, feedDiameterOf(ts), material, rigidity, ts.toolChipCeilingMM) * perSec
    if (seg.feedRateMmMin / 60 < vRub) continue
    const L = Math.hypot(seg.x - seg.prevX, seg.y - seg.prevY, seg.z - seg.prevZ)
    const id = opStarts[k].opId
    judged.set(id, (judged.get(id) ?? 0) + L)
    const tr = { v0: seg.v0!, vc: seg.vc!, v1: seg.v1!, acc: seg.acc, durationS: seg.durationS }
    slow.set(id, (slow.get(id) ?? 0) + lengthBelowSpeed(tr, L, vRub))
  }
  const out: { opId: string; fraction: number }[] = []
  for (const { opId } of opStarts) {
    const total = judged.get(opId) ?? 0
    const fraction = total > 0 ? (slow.get(opId) ?? 0) / total : 0
    if (fraction >= SLOWED_SHARE && !out.some((o) => o.opId === opId)) out.push({ opId, fraction })
  }
  return out
}
