import { describe, it, expect } from 'vitest'
import { generatePocket } from './pocket'
import { generateInlayFemale } from './inlay'
import { takeNotes, addNote } from './notes'
import { handlers } from '../workers/handlers'
import type { Tool } from '../store/toolStore'

const EM6: Tool = {
  id: 'em6', name: '6mm End Mill', type: 'endmill', diameterMM: 6, fluteCount: 2,
  rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 25,
}
const rect = (x: number, y: number, w: number, h: number) =>
  `M${x},${y} L${x + w},${y} L${x + w},${y + h} L${x},${y + h} Z`
const POCKET = {
  strategy: 'raster' as const, depthMM: 2, stepDownMM: 2, stepoverPercent: 40,
  direction: 'climb' as const, islandDs: [] as string[], rampIn: false, safeHeightMM: 5, angle: 0,
}

// Generation used to skip what it could not cut in silence — a pocket area narrower than
// the tool, a v-carve region, an inlay sub-cut — and the op still reported success. Each
// now leaves a note the UI shows (cam/notes.ts).
describe('generation notes', () => {
  it('a pocket with one area too narrow for the tool cuts the rest and says so', () => {
    takeNotes()
    // A 40 mm square and, beside it, a 2 mm slot a 6 mm cutter cannot enter.
    const segs = generatePocket(`${rect(0, 0, 40, 40)} ${rect(60, 0, 2, 40)}`, EM6, POCKET)
    expect(segs.length).toBeGreaterThan(0)
    const notes = takeNotes()
    expect(notes.map((n) => n.kind)).toContain('region-skipped')
    expect(notes.find((n) => n.kind === 'region-skipped')!.short).toMatch(/^1 of 2 /)
  })

  it('a pocket that cuts everything it was given says nothing', () => {
    takeNotes()
    generatePocket(rect(0, 0, 40, 40), EM6, POCKET)
    expect(takeNotes()).toEqual([])
  })

  it('does not repeat an identical note', () => {
    takeNotes()
    addNote({ kind: 'region-skipped', short: 'x' })
    addNote({ kind: 'region-skipped', short: 'x' })
    expect(takeNotes()).toHaveLength(1)
  })

  // Inlay skips a sub-cut only for a GEOMETRY failure. It used to match the message text
  // against /too small/, which caught "Stepover too small" — a setting — and swallowed it.
  it('inlay fails on a bad setting instead of swallowing it as "too small"', async () => {
    await expect(generateInlayFemale(rect(0, 0, 40, 40), EM6, null, {
      angleDeg: 60, pocketDepthMM: 2, stepDownMM: 2, stepoverPercent: 0,
      glueLineMM: 0, clearanceMM: 0, islandDs: [], safeHeightMM: 5,
    })).rejects.toThrow('Stepover too small')
  })

  it('the worker handler hands back only the notes of its own job', async () => {
    addNote({ kind: 'region-skipped', short: 'left over from a job that threw' })
    const r = await handlers.generatePocket(rect(0, 0, 40, 40), EM6, POCKET)
    expect(r.notes).toEqual([])
    expect(r.segments.length).toBeGreaterThan(0)
  })
})
