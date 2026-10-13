import { describe, it, expect, vi } from 'vitest'

vi.mock('../cam/regenerate')

import { copyOperationsForParts, type PartCopy } from './copyOperations'
import type { AnyOperation } from '../store/toolpathStore'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const base = { name: 'op', toolId: 't1', status: 'done' as const, segments: [], color: '#000', visible: true }

const pocket = (id: string, pathId: string, islandIds: string[] = [], extra: Partial<AnyOperation> = {}): AnyOperation => ({
  ...base, id, type: 'pocket', pathId, islandIds, depthMM: 3, stepDownMM: 1, stepoverPercent: 40,
  passAngleDeg: 0, direction: 'climb', strategy: 'hybrid', rampIn: false, ...extra,
} as AnyOperation)

const profile = (id: string, pathId: string, extra: Partial<AnyOperation> = {}): AnyOperation => ({
  ...base, id, type: 'profile', pathId, side: 'outside', depthMM: 6, stepDownMM: 2, direction: 'climb',
  rampIn: false, ...extra,
} as AnyOperation)

/** Copy n of a part made of `ids`, moved right by 100·n. */
const copyOf = (ids: string[], n: number): PartCopy => ({
  pathIds: new Map(ids.map((id) => [id, `${id}-c${n}`])),
  steps: [{ kind: 'translate', dx: 100 * n, dy: 0 }],
})

let seq = 0
const newId = (prefix: string) => `${prefix}-${++seq}`

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('copyOperationsForParts', () => {
  it('gives every copy its own copy of each operation, pointed at the copy\'s paths', () => {
    const ops = [pocket('p', 'plate', ['hole']), profile('o', 'plate')]
    const r = copyOperationsForParts(ops, ['plate', 'hole'], [copyOf(['plate', 'hole'], 1), copyOf(['plate', 'hole'], 2)], newId)
    expect(r.created).toHaveLength(4)
    const made = r.operations.filter((op) => r.created.includes(op.id))
    expect(made.map((op) => op.type === 'pocket' ? [op.pathId, op.islandIds] : [op.type === 'profile' && op.pathId]))
      .toEqual([['plate-c1', ['hole-c1']], ['plate-c2', ['hole-c2']], ['plate-c1'], ['plate-c2']])
    for (const op of made) {
      expect(op.status).toBe('pending')
      expect(op.segments).toEqual([])
    }
  })

  it('keeps program order: each operation\'s copies follow it, so the job still runs pocket-all then profile-all', () => {
    const ops = [pocket('p', 'plate'), profile('o', 'plate')]
    const r = copyOperationsForParts(ops, ['plate'], [copyOf(['plate'], 1), copyOf(['plate'], 2)], newId)
    expect(r.operations.map((op) => op.type)).toEqual(['pocket', 'pocket', 'pocket', 'profile', 'profile', 'profile'])
  })

  it('puts the copies in the source\'s batch, minting one for a source that was alone', () => {
    const ops = [pocket('p', 'plate', [], { batchId: 'b1' }), profile('o', 'plate')]
    const r = copyOperationsForParts(ops, ['plate'], [copyOf(['plate'], 1)], newId)
    const pockets = r.operations.filter((op) => op.type === 'pocket')
    expect(pockets.map((op) => op.batchId)).toEqual(['b1', 'b1'])
    const profiles = r.operations.filter((op) => op.type === 'profile')
    expect(profiles[0].batchId).toBeDefined()
    expect(profiles[1].batchId).toBe(profiles[0].batchId)
  })

  it('leaves alone an operation that also names a path outside the part', () => {
    const ops = [pocket('p', 'plate', ['someone-else']), profile('o', 'plate')]
    const r = copyOperationsForParts(ops, ['plate'], [copyOf(['plate'], 1)], newId)
    expect(r.operations.filter((op) => op.type === 'pocket')).toHaveLength(1)
    expect(r.operations.filter((op) => op.type === 'profile')).toHaveLength(2)
  })

  it('points a start-from-op reference at the same copy\'s operation, not the original\'s', () => {
    const ops = [pocket('p', 'plate'), profile('o', 'plate', { startFrom: { mode: 'op', opId: 'p' } })]
    const r = copyOperationsForParts(ops, ['plate'], [copyOf(['plate'], 1)], newId)
    const [, pocketCopy, , profileCopy] = r.operations
    expect(profileCopy.startFrom).toEqual({ mode: 'op', opId: pocketCopy.id })
  })

  it('moves a drill op\'s points with the copy', () => {
    const drill = { ...base, id: 'd', type: 'drill', drillMode: 'peck', pathId: 'hole', points: [{ x: 5, y: 7 }], depthMM: 3, stepDownMM: 1 } as AnyOperation
    const r = copyOperationsForParts([drill], ['hole'], [copyOf(['hole'], 1)], newId)
    const made = r.operations[1]
    expect(made.type === 'drill' && made.points).toEqual([{ x: 105, y: 7 }])
  })

  it('takes the copies INTO an optimize-path profile rather than cloning it', () => {
    const ops = [profile('o', 'plate', { sharedLines: true, pathIds: [] })]
    const r = copyOperationsForParts(ops, ['plate'], [copyOf(['plate'], 1), copyOf(['plate'], 2)], newId)
    expect(r.operations).toHaveLength(1)
    expect(r.extended).toEqual(['o'])
    const op = r.operations[0]
    expect(op.type === 'profile' && op.pathIds).toEqual(['plate-c1', 'plate-c2'])
  })

  it('skips an inlay, which is cut as a pair, and says so', () => {
    const inlay = { ...base, id: 'i', type: 'inlay', role: 'female', phase: 'vbit', pathId: 'plate', islandIds: [] } as unknown as AnyOperation
    const r = copyOperationsForParts([inlay], ['plate'], [copyOf(['plate'], 1)], newId)
    expect(r.operations).toEqual([inlay])
    expect(r.skipped.map((op) => op.id)).toEqual(['i'])
  })
})
