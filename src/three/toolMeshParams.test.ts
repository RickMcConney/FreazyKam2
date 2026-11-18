import { describe, it, expect } from 'vitest'
import { toolMeshParams } from './toolMeshParams'
import type { ToolState } from '../sim/gcodeParser'

const base: ToolState = { toolDiameterMM: 6, spindleRpm: 18000, fluteCount: 2 }
const tan = (deg: number) => Math.tan((deg / 2) * Math.PI / 180)

describe('toolMeshParams — the 3D tool mesh read off a sim tool state', () => {
  it('a plain tool is a flat end mill', () => {
    expect(toolMeshParams(base)).toMatchObject({ type: 'flat', diamMM: 6, angleDeg: 60, tipDiaMM: 0, cornerMM: 0, helix: 'up' })
  })
  it('a V-bit carries its INCLUDED angle and no tip', () => {
    const p = toolMeshParams({ ...base, toolVbitHalfAngleTan: tan(90) })
    expect(p.type).toBe('vbit')
    expect(p.angleDeg).toBeCloseTo(90, 9)
    expect(p.tipDiaMM).toBe(0)
  })
  it('a cone with a tip ball is a taper, its tip a diameter', () => {
    const p = toolMeshParams({ ...base, toolVbitHalfAngleTan: tan(10), toolTipRadiusMM: 0.25 })
    expect(p.type).toBe('taper')
    expect(p.tipDiaMM).toBe(0.5)
  })
  it('ball, bull and drill are told apart, and only the bull keeps a corner', () => {
    expect(toolMeshParams({ ...base, toolBallNose: true, toolCornerRadiusMM: 3 })).toMatchObject({ type: 'ball', cornerMM: 0 })
    expect(toolMeshParams({ ...base, toolCornerRadiusMM: 1.5 })).toMatchObject({ type: 'bull', cornerMM: 1.5 })
    expect(toolMeshParams({ ...base, toolDrill: true })).toMatchObject({ type: 'drill', cornerMM: 0 })
  })
  it('a taper and a V-bit of the same diameter and angle do not share a mesh key', () => {
    const v = toolMeshParams({ ...base, toolVbitHalfAngleTan: tan(30) })
    const t = toolMeshParams({ ...base, toolVbitHalfAngleTan: tan(30), toolTipRadiusMM: 0.25 })
    expect(v.key).not.toBe(t.key)
  })
  it('the flute twist is part of the key', () => {
    expect(toolMeshParams(base).key).not.toBe(toolMeshParams({ ...base, toolHelix: 'down' }).key)
  })
})
