// The export preflight — the report read while deciding whether to run a job. Every
// warning here is the last chance to say that the file is not what the user thinks it
// is: an operation missing from it, a cut outside the stock or through it, a feed that
// will break the bit. Each is checked both ways: it fires when it should, and it stays
// quiet on a clean job, since a report that always warns is one nobody reads.
import { describe, it, expect, beforeEach } from 'vitest'
import { buildExportPreflight } from './exportPreflight'
import { targetChipLoad, rigidityFeedFactor } from './feeds'
import { useToolpathStore, type AnyOperation, type MotionSegment } from '../store/toolpathStore'
import { useToolStore, type Tool } from '../store/toolStore'
import { usePostProcessorStore } from '../store/postProcessorStore'
import { useWorkpieceStore, MATERIAL_INFO } from '../store/workpieceStore'

const endmill = (over: Partial<Tool> = {}): Tool => ({
  id: 'em', name: 'Endmill 6', type: 'endmill', diameterMM: 6, fluteCount: 2,
  rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 25, ...over,
})

// A tool whose programmed chip load is `ratio` × the target the preflight judges it by.
function toolAtChipLoad(ratio: number, over: Partial<Tool> = {}): Tool {
  const t = endmill(over)
  const { material, machineRigidity } = useWorkpieceStore.getState()
  const aim = targetChipLoad(t.type, t.diameterMM, MATERIAL_INFO[material].hardness) * rigidityFeedFactor(machineRigidity)
  return { ...t, xyFeedMmMin: Math.round(aim * ratio * t.rpm * t.fluteCount) }
}

// A square pass around (x0,y0)-(x1,y1) at depth z, entered and left by rapids.
const square = (x0: number, y0: number, x1: number, y1: number, z = -3): MotionSegment[] => [
  { x: x0, y: y0, z: 5, rapid: true },
  { x: x0, y: y0, z, rapid: false },
  { x: x1, y: y0, z, rapid: false },
  { x: x1, y: y1, z, rapid: false },
  { x: x0, y: y1, z, rapid: false },
  { x: x0, y: y0, z, rapid: false },
  { x: x0, y: y0, z: 5, rapid: true },
]

let seq = 0
function op(over: Record<string, unknown> = {}): AnyOperation {
  seq++
  return {
    id: `op${seq}`, name: `Pocket ${seq}`, type: 'pocket', toolId: 'em', status: 'done',
    segments: square(10, 10, 50, 40), color: '#fff', visible: true,
    pathId: 'p', islandIds: [], depthMM: 3, stepDownMM: 3, stepoverPercent: 40, passAngleDeg: 0,
    direction: 'climb', strategy: 'raster', rampIn: false,
    ...over,
  } as AnyOperation
}

const setOps = (...operations: AnyOperation[]) => useToolpathStore.setState({ operations })
const texts = () => buildExportPreflight().warnings.map(w => `${w.level}: ${w.text}`)
const has = (re: RegExp) => texts().some(t => re.test(t))

beforeEach(() => {
  seq = 0
  useWorkpieceStore.setState({
    widthMM: 200, heightMM: 100, thicknessMM: 18, origin: 'bottom-left', zOrigin: 'top',
    units: 'mm', material: 'mdf', safeHeightMM: 5, maxFeedMmMin: 0,
    minSpindleRpm: 8000, maxSpindleRpm: 24000, machineRigidity: 3, autoFeedEnabled: false,
    tableLimitWidthMM: 0, tableLimitHeightMM: 0, tableLimitDepthMM: 0,
  })
  useToolStore.setState({ tools: [toolAtChipLoad(1)] })
  const pp = usePostProcessorStore.getState()
  usePostProcessorStore.setState({ activeId: pp.profiles.find(p => p.unitMode === 'mm')!.id })
  setOps()
})

describe('a clean job', () => {
  it('reports no toolpaths and no warnings for an empty program', () => {
    const p = buildExportPreflight()
    expect(p.hasToolpaths).toBe(false)
    expect(p.job.extents).toBeNull()
    expect(p.job.estimatedTimeS).toBe(0)
    expect(p.warnings).toEqual([])
  })

  it('raises no warning for one in-stock operation with one well-fed tool', () => {
    setOps(op())
    const p = buildExportPreflight()
    expect(p.hasToolpaths).toBe(true)
    expect(p.job.operationCount).toBe(1)
    expect(p.warnings).toEqual([])
  })
})

describe('what the job summary counts', () => {
  it('counts only visible, generated operations with a toolpath — never imported G-code', () => {
    setOps(op(), op({ type: 'gcode' }), op({ visible: false }), op({ status: 'error' }), op({ segments: [] }))
    expect(buildExportPreflight().job.operationCount).toBe(1)
  })

  it('reports extents relative to the work origin, as the G-code writes them', () => {
    setOps(op({ segments: square(10, 20, 60, 70, -4) }))
    expect(buildExportPreflight().job.extents).toEqual({ minX: 10, maxX: 60, minY: 20, maxY: 70, minZ: -4, maxZ: 5 })
    useWorkpieceStore.setState({ origin: 'center' })
    expect(buildExportPreflight().job.extents).toEqual({ minX: -90, maxX: -40, minY: -30, maxY: 20, minZ: -4, maxZ: 5 })
  })

  it('reports the deepest cut as a positive depth', () => {
    setOps(op({ segments: square(10, 10, 20, 20, -2) }), op({ segments: square(30, 30, 40, 40, -7.5) }))
    expect(buildExportPreflight().job.deepestCutMM).toBe(7.5)
  })

  it('lists each tool once, in the order the job first uses it', () => {
    useToolStore.setState({ tools: [toolAtChipLoad(1), toolAtChipLoad(1, { id: 'small', name: 'Endmill 3', diameterMM: 3 })] })
    setOps(op({ toolId: 'small' }), op(), op({ toolId: 'small' }))
    expect(buildExportPreflight().job.tools.map(t => t.name)).toEqual(['Endmill 3', 'Endmill 6'])
  })

  it("counts a 3D profile's roughing tool only when the profile actually roughed", () => {
    useToolStore.setState({ tools: [toolAtChipLoad(1), toolAtChipLoad(1, { id: 'rough', name: 'Rougher' })] })
    const p3d = { type: 'profile3d', roughingToolId: 'rough' }
    setOps(op(p3d))
    expect(buildExportPreflight().job.tools.map(t => t.name)).toEqual(['Endmill 6'])
    setOps(op({ ...p3d, segments: [...square(10, 10, 20, 20), { x: 10, y: 10, z: 5, rapid: true, toolChange: 'em' }, ...square(10, 10, 20, 20)] }))
    expect(buildExportPreflight().job.tools.map(t => t.name)).toEqual(['Rougher', 'Endmill 6'])
  })

  it('estimates at least the time the cutting moves take at the programmed feed', () => {
    // 4 × 100 mm of cut at 1000 mm/min is 24 s; rapids and plunges only add to it.
    useToolStore.setState({ tools: [endmill({ xyFeedMmMin: 1000 })] })
    setOps(op({ segments: square(10, 0, 110, 100 - 0.001) }))
    const t = buildExportPreflight().job.estimatedTimeS
    expect(t).toBeGreaterThanOrEqual(24)
    expect(t).toBeLessThan(40)
  })
})

describe('operations that will not be in the file', () => {
  it('names a failed operation, quotes its error, and says it is NOT in the file', () => {
    setOps(op(), op({ name: 'Tiny pocket', status: 'error', errorMessage: 'too small for the selected tool diameter' }))
    const w = buildExportPreflight().warnings.find(w => /failed to generate/.test(w.text))!
    expect(w.level).toBe('warn')
    expect(w.text).toContain('1 operation failed to generate and is NOT in this file — Tiny pocket.')
    expect(w.text).toContain('First error: "too small for the selected tool diameter"')
    expect(w.text).toContain('Whatever it was meant to cut will be left uncut.')
  })

  it('keeps its grammar at n > 1 and truncates a long list of names', () => {
    setOps(...Array.from({ length: 6 }, (_, i) => op({ name: `F${i}`, status: 'error' })))
    const t = texts().find(t => /failed to generate/.test(t))!
    expect(t).toContain('6 operations failed to generate and are NOT in this file — F0, F1, F2, F3, +2 more.')
    expect(t).toContain('Whatever they were meant to cut')
  })

  it('says an out-of-date operation WILL be regenerated, not that it is missing', () => {
    setOps(op({ name: 'Stale', status: 'needs-update' }))
    const w = buildExportPreflight().warnings
    expect(w).toHaveLength(1)
    expect(w[0].level).toBe('info')
    expect(w[0].text).toMatch(/^1 operation is out of date and will be regenerated before the file is written — Stale\./)
  })

  it('warns about every visible operation with no toolpath: pending, generating, or generated empty', () => {
    setOps(op({ name: 'A', status: 'pending' }), op({ name: 'B', status: 'generating' }), op({ name: 'C', segments: [] }))
    expect(texts()).toContain('warn: 3 operations have no toolpath and are NOT in this file — A, B, C.')
  })

  it('reports hidden operations as a deliberate exclusion, and leaves them out of the extents', () => {
    setOps(op(), op({ name: 'Off', visible: false, segments: square(500, 500, 600, 600) }))
    const p = buildExportPreflight()
    expect(p.warnings).toEqual([{ level: 'info', text: '1 hidden operation is excluded from this file — Off.' }])
    expect(p.job.extents!.maxX).toBe(50)
  })

  it('does not report imported G-code, which is never exported by design', () => {
    setOps(op(), op({ type: 'gcode', status: 'error', visible: false }))
    expect(texts()).toEqual([])
  })
})

describe('where the tool goes', () => {
  it('warns when a toolpath leaves the stock, on any side', () => {
    for (const segs of [square(-1, 10, 20, 20), square(10, -1, 20, 20), square(10, 10, 201, 20), square(10, 10, 20, 101)]) {
      setOps(op({ segments: segs }))
      expect(has(/^warn: Toolpath extends outside the stock \(200\.0 mm × 100\.0 mm\)/)).toBe(true)
    }
  })

  it('allows a toolpath that runs exactly along the stock edge', () => {
    setOps(op({ segments: square(0, 0, 200, 100) }))
    expect(has(/outside the stock/)).toBe(false)
  })

  it('warns when the job spans more than the table can travel, and ignores a limit of 0', () => {
    setOps(op({ segments: square(0, 0, 150, 80, -30) }))
    useWorkpieceStore.setState({ tableLimitWidthMM: 100, tableLimitHeightMM: 50, tableLimitDepthMM: 20 })
    expect(texts()).toEqual(expect.arrayContaining([
      'warn: Toolpath X span 150.0 mm exceeds the table travel of 100.0 mm.',
      'warn: Toolpath Y span 80.0 mm exceeds the table travel of 50.0 mm.',
      'warn: Deepest cut 30.0 mm exceeds the max Z travel of 20.0 mm.',
    ]))
    useWorkpieceStore.setState({ tableLimitWidthMM: 0, tableLimitHeightMM: 0, tableLimitDepthMM: 0 })
    expect(has(/table travel|Z travel/)).toBe(false)
  })

  it('says when a cut goes through the stock, and not when it stops at the bottom face', () => {
    setOps(op({ segments: square(10, 10, 20, 20, -18) }))
    expect(has(/goes through/)).toBe(false)
    setOps(op({ segments: square(10, 10, 20, 20, -18.5) }))
    expect(texts()).toContain('info: Deepest cut 18.5 mm goes through the 18.0 mm stock — use a spoilboard or tabs to hold the part.')
  })

  it('speaks inches when the display is in inches', () => {
    useWorkpieceStore.setState({ units: 'in', widthMM: 254, heightMM: 127 })
    setOps(op({ segments: square(-1, 10, 20, 20) }))
    expect(has(/outside the stock \(10\.000" × 5\.000"\)/)).toBe(true)
  })

  it('warns when an inlay plug is cut on top of its own socket, and not when it is moved clear', () => {
    const female = op({ type: 'inlay', role: 'female', segments: square(10, 10, 50, 50) })
    setOps(female, op({ type: 'inlay', role: 'male', segments: square(15, 15, 55, 55) }))
    expect(has(/inlay plug \(male\) and pocket \(female\) toolpath overlap/)).toBe(true)
    setOps(female, op({ type: 'inlay', role: 'male', segments: square(100, 10, 140, 50) }))
    expect(has(/inlay plug/)).toBe(false)
  })
})

describe('tools, speeds and feeds', () => {
  it('says how many tool changes the job needs, and how many spindle speeds', () => {
    useToolStore.setState({ tools: [toolAtChipLoad(1), toolAtChipLoad(1, { id: 'b', name: 'B', rpm: 12000 })] })
    setOps(op(), op({ toolId: 'b' }))
    expect(texts()).toEqual(expect.arrayContaining([
      "info: This job uses 2 different spindle speeds (12000, 18000 RPM). If your machine can't set spindle speed from G-code, set it by hand at each change.",
      'info: This job uses 2 tools — 1 tool change required. Swap the tool and re-zero Z when the program pauses.',
    ]))
  })

  it('warns when the chip load is too high to be safe', () => {
    useToolStore.setState({ tools: [toolAtChipLoad(1.5)] })
    setOps(op())
    expect(has(/^warn: Chip load is too high on 1 tool \(Endmill 6\) — .* \(or turn on auto feeds & speeds\)\.$/)).toBe(true)
  })

  it('warns when the chip load is so low the tool will rub', () => {
    useToolStore.setState({ tools: [toolAtChipLoad(0.6)] })
    setOps(op())
    expect(has(/^warn: Chip load is too low on 1 tool \(Endmill 6\)/)).toBe(true)
  })

  it('accepts a chip load inside the band either side of the target', () => {
    for (const ratio of [0.8, 1, 1.35]) {
      useToolStore.setState({ tools: [toolAtChipLoad(ratio)] })
      setOps(op())
      expect(has(/Chip load/), `ratio ${ratio}`).toBe(false)
    }
  })

  it('does not judge a drill by chip load — it cuts by plunging', () => {
    useToolStore.setState({ tools: [toolAtChipLoad(5, { type: 'drill' })] })
    setOps(op())
    expect(has(/Chip load/)).toBe(false)
  })

  it('warns when the spindle cannot turn slowly enough for the material', () => {
    // Aluminium's surface speed ceiling puts a 6 mm bit at ~7960 RPM, under the 8000 floor.
    useWorkpieceStore.setState({ material: 'aluminum', autoFeedEnabled: true })
    setOps(op())
    expect(has(/^warn: The spindle can't run slow enough for the material's safe surface speed on 1 tool/)).toBe(true)
    useWorkpieceStore.setState({ minSpindleRpm: 5000 })
    expect(has(/can't run slow enough/)).toBe(false)
  })
})

it('notes when the file will be written in different units than the display', () => {
  const inch = usePostProcessorStore.getState().profiles.find(p => p.unitMode === 'in')!
  usePostProcessorStore.setState({ activeId: inch.id })
  setOps(op())
  expect(texts()).toContain('info: Display units (mm) differ from the post-processor output units (in). The file will be in in.')
})
