import { describe, it, expect } from 'vitest'
import { planOffset, type OffsetFormState } from './offsetPlan'
import { applyOffset } from './offsetOp'
import { applyScaleOffset } from './scaleOffset'
import { generateShapeD, type ShapeParams } from '../shapes/shapeGenerators'
import type { ImportedPath } from '../importers/svgImporter'

const form = (over: Partial<OffsetFormState> = {}): OffsetFormState =>
  ({ distanceMM: 4, cornerStyle: 'miter', keepShape: false, keepGenerated: true, ...over })
const plain = (d: string): ImportedPath => ({ id: 'p', name: 'p', d, visible: true, color: '#888' })
const generated = (p: ShapeParams, extra: Partial<ImportedPath> = {}): ImportedPath =>
  ({ ...plain(generateShapeD(p)), shapeParams: p, ...extra })

const TRI = 'M0,0 L40,0 L0,30 Z'
const heart: ShapeParams = { type: 'heart', cx: 0, cy: 0, curveRadius: 20, angle: 90 }
const spiro: ShapeParams = { type: 'spirograph', cx: 0, cy: 0, radius: 20, ratio: 0.3, p: 0.5 }

describe('what an offset makes of each source', () => {
  // Keep shape scales an outline to an average gap — the way to keep the shape of a path
  // that has no parameters to keep it with.
  it('scales a plain path when Keep shape is on', () => {
    const plan = planOffset(plain(TRI), form({ keepShape: true }))!
    expect(plan.kind).toBe('outline')
    expect(plan.d).toBe(applyScaleOffset(TRI, 4)!.d)
  })

  // A shape that can stay itself does, with its parameters: Keep shape would only have
  // done the same scaling (heart) or worse (rectangle), without them.
  it('keeps a supported shape itself whatever Keep shape says', () => {
    const plan = planOffset(generated(heart), form({ keepShape: true }))!
    expect(plan.kind).toBe('scaled')
    expect(plan.shapeParams?.type).toBe('heart')
  })

  // Scaling a gear's teeth or a spirograph to an average gap is not an offset of anything,
  // so Keep shape is not offered for them and does not apply: they get the ordinary one.
  it('never scales a generator that cannot stay itself', () => {
    const plan = planOffset(generated(spiro), form({ keepShape: true }))!
    expect(plan.kind).toBe('outline')
    expect(plan.d).toBe(applyOffset(generateShapeD(spiro), { distanceMM: 4, cornerStyle: 'miter' }))
    expect(plan.shapeParams).toBeUndefined()
  })

  // Un-ticking Keep generated shapes asks for the plain offset — with the corner style,
  // never Keep shape's scaling.
  it('gives a supported shape the ordinary offset when Keep generated shapes is off', () => {
    const plan = planOffset(generated(heart), form({ keepGenerated: false, keepShape: true, cornerStyle: 'round' }))!
    expect(plan.kind).toBe('outline')
    expect(plan.d).toBe(applyOffset(generateShapeD(heart), { distanceMM: 4, cornerStyle: 'round' }))
  })
})
