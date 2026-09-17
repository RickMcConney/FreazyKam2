import { describe, it, expect } from 'vitest'
import { clockReadout, fmtPeriod } from './clockReadout'
import { DEFAULT_CLOCK_SPEC } from '../shapes/clockTrain'
import { DEFAULT_SHAPE_CONFIG } from '../shapes/shapeGenerators'

const base = {
  gear: DEFAULT_SHAPE_CONFIG.gear,
  escapement: DEFAULT_SHAPE_CONFIG.escapement,
  pendulum: DEFAULT_SHAPE_CONFIG.pendulum,
}
const stock = { widthMM: 300, heightMM: 300 }
const len = (mm: number) => `${mm.toFixed(2)}mm`
const read = (spec = DEFAULT_CLOCK_SPEC) => clockReadout(spec, base, stock, len)

describe('the clock readout', () => {
  it('reports every section and one row per part', () => {
    const r = read()
    expect(r.sections.map((s) => s.title)).toEqual(['Pendulum', 'Going train', 'Weight drive', 'Tooth size', 'Parts'])
    expect(r.rows.length).toBeGreaterThan(0)
    expect(r.rows.every((row) => row.name.length > 0)).toBe(true)
  })

  // The default train is exact, which is the whole point of solveTrain — so the
  // button standing for this readout must not be shouting about it.
  it('is quiet about a default clock', () => {
    const r = read()
    expect(r.sections.flatMap((s) => s.lines).some((l) => l.tone === 'error')).toBe(false)
    expect(r.tone).not.toBe('error')
  })

  // The tone is what makes hiding the text behind a button safe: a train that
  // cannot keep time has to colour that button red.
  it('raises an error tone when no exact train exists', () => {
    // A prime escape count with few pins leaves solveTrain nothing to factorise.
    const r = read({ ...DEFAULT_CLOCK_SPEC, escapeTeeth: 37, minPins: 11 })
    const bad = r.sections.flatMap((s) => s.lines).filter((l) => l.tone === 'error')
    if (bad.length > 0) {
      expect(r.tone).toBe('error')
      expect(bad.some((l) => /s a day/.test(l.text))).toBe(true)
    } else {
      // If that combination happens to solve exactly, the readout must say so.
      expect(r.sections[1].lines.some((l) => /exact/.test(l.text))).toBe(true)
    }
  })

  it('says a too-big clock will overhang the stock', () => {
    const r = clockReadout(DEFAULT_CLOCK_SPEC, base, { widthMM: 60, heightMM: 60 }, len)
    expect(r.sections.flatMap((s) => s.lines).some((l) => l.tone === 'warn' && /overhang/.test(l.text))).toBe(true)
  })

  it('speaks intervals the way a clockmaker would', () => {
    expect(fmtPeriod(12)).toBe('12 s')
    expect(fmtPeriod(600)).toBe('10 min')
    expect(fmtPeriod(7200)).toBe('2 h')
  })
})
