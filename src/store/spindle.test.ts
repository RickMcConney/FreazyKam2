import { describe, it, expect, beforeEach } from 'vitest'
import { spindleDialLabel, spindleDialSetting, spindleDialRange, spindleHasDial, normalizeCustomDial, clampToChartedRange, DEFAULT_CUSTOM_DIAL_RPM } from './spindle'
import { useWorkpieceStore, mergePersistedWorkpiece } from './workpieceStore'

const KOBALT_LIKE = [12000, 15000, 18000, 21000, 24000, 27000]

describe('a custom router dial', () => {
  it('reads the dial setting from the speeds the user typed, to the half detent', () => {
    expect(spindleDialSetting('custom', 18000, KOBALT_LIKE)).toBe(3)
    expect(spindleDialSetting('custom', 19500, KOBALT_LIKE)).toBe(3.5)
    expect(spindleDialLabel('custom', 24000, KOBALT_LIKE)).toBe('dial 5')
  })

  it('clamps a speed outside the chart to dial 1 or dial 6', () => {
    expect(spindleDialSetting('custom', 5000, KOBALT_LIKE)).toBe(1)
    expect(spindleDialSetting('custom', 40000, KOBALT_LIKE)).toBe(6)
  })

  it('shows no dial setting when the speeds do not rise with the dial, rather than a wrong one', () => {
    expect(spindleDialSetting('custom', 18000, [12000, 15000, 15000, 21000, 24000, 27000])).toBeNull()
    expect(spindleDialSetting('custom', 18000, [12000, 15000, 30000, 21000, 24000, 27000])).toBeNull()
    expect(spindleHasDial('custom')).toBe(true)
  })

  it('a stored dial that is not six numbers falls back to the default chart', () => {
    expect(normalizeCustomDial([1, 2, 3])).toEqual(DEFAULT_CUSTOM_DIAL_RPM)
    expect(normalizeCustomDial(['1', 2, 3, 4, 5, 6])).toEqual(DEFAULT_CUSTOM_DIAL_RPM)
    expect(normalizeCustomDial(KOBALT_LIKE)).toEqual(KOBALT_LIKE)
  })

  it('a VFD has no dial and no dial range', () => {
    expect(spindleDialSetting('vfd', 18000, KOBALT_LIKE)).toBeNull()
    expect(spindleDialRange('vfd', KOBALT_LIKE)).toBeNull()
  })
})

describe('choosing a dial router sets the spindle range auto feeds works in', () => {
  beforeEach(() => {
    useWorkpieceStore.setState({ spindleType: 'vfd', minSpindleRpm: 8000, maxSpindleRpm: 24000, customDialRpm: [...DEFAULT_CUSTOM_DIAL_RPM] })
  })

  it('a charted router takes its dial 1 and dial 6 speeds as min and max', () => {
    useWorkpieceStore.getState().setSpindleType('dewalt-compact')
    expect(useWorkpieceStore.getState()).toMatchObject({ minSpindleRpm: 16200, maxSpindleRpm: 26900 })
  })

  it('a custom router follows its own chart, and editing dial 1 or 6 moves the range with it', () => {
    const s = useWorkpieceStore.getState()
    s.setCustomDialRpm(KOBALT_LIKE)
    expect(useWorkpieceStore.getState()).toMatchObject({ minSpindleRpm: 8000, maxSpindleRpm: 24000 })
    s.setSpindleType('custom')
    expect(useWorkpieceStore.getState()).toMatchObject({ minSpindleRpm: 12000, maxSpindleRpm: 27000 })
    s.setCustomDialRpm([11000, 15000, 18000, 21000, 24000, 26000])
    expect(useWorkpieceStore.getState()).toMatchObject({ minSpindleRpm: 11000, maxSpindleRpm: 26000 })
  })

  it('a custom chart that does not rise leaves the range where it was', () => {
    const s = useWorkpieceStore.getState()
    s.setCustomDialRpm(KOBALT_LIKE)
    s.setSpindleType('custom')
    s.setCustomDialRpm([12000, 15000, 18000, 21000, 24000, 20000])
    expect(useWorkpieceStore.getState()).toMatchObject({ minSpindleRpm: 12000, maxSpindleRpm: 27000 })
  })

  it('switching to a VFD keeps the range the user had', () => {
    const s = useWorkpieceStore.getState()
    s.setSpindleType('makita-rt07')
    s.setMaxSpindleRpm(25000)
    s.setSpindleType('vfd')
    expect(useWorkpieceStore.getState()).toMatchObject({ minSpindleRpm: 10000, maxSpindleRpm: 25000 })
  })
})

describe('the charted routers', () => {
  it('a DeWalt DWP611 tops out at its rated 27,000 rpm, not a Makita\'s 30,000', () => {
    // The old table ran to 30,000, so a planned 24,000 rpm read as dial 4 — which turns 21,100.
    expect(spindleDialRange('dewalt-compact')).toEqual({ min: 16200, max: 26900 })
    expect(spindleDialSetting('dewalt-compact', 21100)).toBe(4)
    expect(spindleDialSetting('dewalt-compact', 24000)).toBe(5)
  })

  it('a Makita RT0701C runs 10,000 to 30,000 rpm', () => {
    expect(spindleDialRange('makita-rt07')).toEqual({ min: 10000, max: 30000 })
  })
})

describe('a saved spindle range is held inside a charted router\'s chart on load', () => {
  it('brings a DeWalt setup saved against the old chart down to the router\'s real top speed', () => {
    expect(clampToChartedRange('dewalt-compact', 16000, 30000)).toEqual({ minSpindleRpm: 16200, maxSpindleRpm: 26900 })
  })

  it('keeps a range the user narrowed inside the chart', () => {
    expect(clampToChartedRange('dewalt-compact', 17000, 20000)).toEqual({ minSpindleRpm: 17000, maxSpindleRpm: 20000 })
  })

  it('leaves a VFD\'s and a custom router\'s range alone', () => {
    expect(clampToChartedRange('vfd', 8000, 24000)).toEqual({ minSpindleRpm: 8000, maxSpindleRpm: 24000 })
    expect(clampToChartedRange('custom', 5000, 40000)).toEqual({ minSpindleRpm: 5000, maxSpindleRpm: 40000 })
  })

  it('is applied when the persisted settings are read back', () => {
    const out = mergePersistedWorkpiece({ spindleType: 'dewalt-compact', minSpindleRpm: 16000, maxSpindleRpm: 30000 }, useWorkpieceStore.getState())
    expect(out).toMatchObject({ minSpindleRpm: 16200, maxSpindleRpm: 26900 })
  })
})
