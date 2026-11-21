import { describe, it, expect } from 'vitest'
import type { ImportedPath } from '../importers/svgImporter'
import { selectedShapeOf } from './shapeDefaults'
import { DEFAULT_SHAPE_CONFIG, defaultsFromParams, shapeParamsFromConfig, type ShapeParams } from './shapeGenerators'

describe('defaultsFromParams — the last shape drawn is the default for the next of its type', () => {
  it('a drawn rectangle sets the default width and height but not its position', () => {
    const next = defaultsFromParams(DEFAULT_SHAPE_CONFIG, { type: 'rectangle', x: 12, y: 34, w: 80, h: 20 })
    expect(next.rectangle).toEqual({ w: 80, h: 20 })
  })

  it('leaves every other shape type\'s defaults alone', () => {
    const next = defaultsFromParams(DEFAULT_SHAPE_CONFIG, { type: 'circle', cx: 0, cy: 0, radius: 7 })
    expect(next.circle.radius).toBe(7)
    expect(next.rectangle).toBe(DEFAULT_SHAPE_CONFIG.rectangle)
    expect(next.gear).toBe(DEFAULT_SHAPE_CONFIG.gear)
  })

  it('a clock wheel\'s arbor pinion does not ride into the gear defaults', () => {
    const wheel = { ...shapeParamsFromConfig('gear', 5, 5, DEFAULT_SHAPE_CONFIG), teeth: 60, arborPins: 8, arborPinCircleDia: 20, arborPinDia: 2 } as ShapeParams
    const next = defaultsFromParams(DEFAULT_SHAPE_CONFIG, wheel)
    expect(next.gear.teeth).toBe(60)
    expect(next.gear).not.toHaveProperty('arborPins')
    expect(next.gear).not.toHaveProperty('cx')
  })

  it('round-trips: a shape placed from the new defaults has the drawn shape\'s parameters', () => {
    const star: ShapeParams = { type: 'star', cx: 3, cy: 4, outerRadius: 30, innerRadius: 11, points: 7 }
    const next = defaultsFromParams(DEFAULT_SHAPE_CONFIG, star)
    expect(shapeParamsFromConfig('star', 3, 4, next)).toEqual(star)
  })
})

describe('selectedShapeOf — only a selection that is ONE shape sets the defaults', () => {
  const rect = (id: string, extra: Partial<ImportedPath> = {}): ImportedPath =>
    ({ id, name: id, d: 'M0 0 L1 0 L1 1 Z', visible: true, color: '#000', shapeParams: { type: 'rectangle', x: 0, y: 0, w: 1, h: 1 }, ...extra }) as ImportedPath
  it('a lone selected shape is the one', () => {
    const paths = [rect('a'), rect('b')]
    expect(selectedShapeOf(paths, ['b'])?.id).toBe('b')
  })
  it('two separate shapes selected set nothing', () => {
    expect(selectedShapeOf([rect('a'), rect('b')], ['a', 'b'])).toBeNull()
  })
  it('every part of one multi-part shape selected is that shape', () => {
    const paths = [rect('a', { groupId: 'g', shapePart: 'teeth' }), rect('b', { groupId: 'g', shapePart: 'bore' })]
    expect(selectedShapeOf(paths, ['a', 'b'])?.id).toBe('a')
  })
  it('a path with no shape parameters sets nothing', () => {
    expect(selectedShapeOf([rect('a', { shapeParams: undefined })], ['a'])).toBeNull()
  })
})
