// placeShape: what releasing a shape tool does, and the one thing it does LATER — redraw a
// shape once a font it needed has arrived. Fonts are fetched, so the font module is stood
// in for by a gate per family that the test opens by hand; everything else is the real
// store and the real generators.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { placeShape } from './placeShape'
import { usePathsStore } from '../store/pathsStore'
import { useTimelineStore } from '../timeline/timelineStore'
import { shapeParamsFromConfig, DEFAULT_SHAPE_CONFIG, type ShapeParams } from './shapeGenerators'
import { SINGLE_LINE_FONT_FAMILY } from './textGenerator'

vi.mock('../cam/regenerate', () => ({
  regenerateAffectedMany: vi.fn(), regenerateAffected: vi.fn(), regenerateMany: vi.fn(),
  regenerateOperation: vi.fn(), regenerateAll: vi.fn(),
}))

const fonts = vi.hoisted(() => {
  const loaded = new Set<string>()
  const gates = new Map<string, { p: Promise<void>; open: () => void }>()
  const gate = (family: string) => {
    let g = gates.get(family)
    if (!g) {
      let open!: () => void
      const p = new Promise<void>((r) => { open = r })
      g = { p, open: () => { loaded.add(family); open() } }
      gates.set(family, g)
    }
    return g
  }
  return { loaded, gates, gate }
})

// A stand-in font module: a family draws once its gate has opened, and text in a family
// still loading is drawn in Roboto when THAT is in — as the real generateTextD does. The
// glyphs are a box whose width says which font drew them.
vi.mock('./textGenerator', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./textGenerator')>()
  const width = (family: string) => (family === 'Roboto' ? 1 : family === 'Times New Roman' ? 3 : 4)
  return {
    ...orig,
    loadFont: (family: string) => fonts.gate(family).p,
    isFontLoaded: (family: string) => fonts.loaded.has(family),
    generateTextD: (p: { x: number; y: number; text: string; fontFamily: string }) => {
      const family = fonts.loaded.has(p.fontFamily) ? p.fontFamily : fonts.loaded.has('Roboto') ? 'Roboto' : null
      if (!family || !p.text.trim()) return ''
      const w = width(family) * p.text.length
      return `M${p.x} ${p.y} L${p.x + w} ${p.y} L${p.x + w} ${p.y + 2} L${p.x} ${p.y + 2} Z`
    },
  }
})

let clock = 1_000_000
async function step() {
  clock += 1000
  vi.setSystemTime(clock)
  await vi.dynamicImportSettled()
  for (let i = 0; i < 5; i++) await Promise.resolve()
}
const S = () => usePathsStore.getState()
const live = (id: string) => S().paths.find((p) => p.id === id)

beforeEach(async () => {
  vi.useFakeTimers()
  fonts.loaded.clear()
  fonts.gates.clear()
  usePathsStore.setState({ paths: [], selectedIds: [] })
  await step()
  useTimelineStore.getState().resetToCurrentState()
})

const text = (over: Record<string, unknown> = {}): ShapeParams =>
  ({ type: 'text', x: 0, y: 0, text: 'AB', fontSize: 10, fontFamily: 'Times New Roman', ...over } as ShapeParams)

describe('placeShape — a shape waiting on a font', () => {
  it('redraws a gear from the parameters it has when the font arrives, not the ones it was placed with', async () => {
    const gear = { ...shapeParamsFromConfig('gear', 50, 50, DEFAULT_SHAPE_CONFIG), teeth: 24, toothLabel: true } as ShapeParams
    const [first] = placeShape(gear)
    await step()
    expect(S().paths.some((p) => p.shapePart === 'label')).toBe(false)   // no font, no number yet

    S().updateShapeParams(first, { ...gear, teeth: 30 } as ShapeParams)
    await step()
    fonts.gate(SINGLE_LINE_FONT_FAMILY).open()
    await step()

    const parts = S().paths
    expect(parts.every((p) => p.shapeParams?.type === 'gear' && (p.shapeParams as { teeth: number }).teeth === 30)).toBe(true)
    expect(parts.some((p) => p.shapePart === 'label')).toBe(true)
  })

  it('leaves a gear alone when its number was switched off while the font was loading', async () => {
    const gear = { ...shapeParamsFromConfig('gear', 50, 50, DEFAULT_SHAPE_CONFIG), toothLabel: true } as ShapeParams
    const [first] = placeShape(gear)
    await step()
    S().updateShapeParams(first, { ...gear, toothLabel: false } as ShapeParams)
    await step()
    for (const g of fonts.gates.values()) g.open()
    await step()
    expect(S().paths.some((p) => p.shapePart === 'label')).toBe(false)
    expect(S().paths.every((p) => (p.shapeParams as { toothLabel: boolean }).toothLabel === false)).toBe(true)
  })

  it('redraws text in its own font when the default font drew it as a stand-in', async () => {
    fonts.gate('Roboto').open()
    await step()
    const [id] = placeShape(text())
    await step()
    expect(live(id)!.d).toContain('L2 0')                 // two Roboto glyphs, 1 wide each

    fonts.gate('Times New Roman').open()
    await step()
    expect(live(id)!.d).toContain('L6 0')                 // two Times glyphs, 3 wide each
  })

  it('redraws text as it was retyped, not as it was first typed, when its font arrives', async () => {
    const [id] = placeShape(text())
    await step()
    S().updateShapeParams(id, text({ text: 'ABCD' }))
    await step()
    fonts.gate('Times New Roman').open()
    await step()
    expect((live(id)!.shapeParams as { text: string }).text).toBe('ABCD')
    expect(live(id)!.d).toContain('L12 0')
  })
})
