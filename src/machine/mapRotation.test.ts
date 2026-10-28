import { describe, it, expect } from 'vitest'
import { workToMap, screenDirToWork, mapRotationFor, type MapRotation } from './mapRotation'
import { fromMachine, MACHINE_X_DIRS } from '../cam/machineFrame'

const ROTS: MapRotation[] = [0, 90, 180, 270]
// Screen up, as an SVG (y-down) vector, is (0, −1).
const up = (v: [number, number]) => v[0] === 0 && v[1] < 0
const right = (v: [number, number]) => v[0] > 0 && v[1] === 0

describe('turning the go-to map', () => {
  it('unturned, draws work +X to the right and +Y up — the machine seen from the front', () => {
    expect(right(workToMap(1, 0, 0))).toBe(true)
    expect(up(workToMap(0, 1, 0))).toBe(true)
  })

  it('a quarter-turn clockwise puts work +X pointing DOWN the screen and +Y to the right', () => {
    expect(workToMap(1, 0, 90)).toEqual([0, 1])
    expect(right(workToMap(0, 1, 90))).toBe(true)
  })

  it('a jog arrow moves the tool the way it points on the map, at every turn', () => {
    for (const rot of ROTS) {
      for (const [r, u] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) {
        const w = screenDirToWork(r, u, rot)
        const [sx, sy] = workToMap(w.x, w.y, rot)
        // Back on screen it points where the arrow does: right = +sx, up = −sy.
        expect([sx, -sy + 0]).toEqual([r, u])
      }
    }
  })

  it('beside the machine (a quarter-turn), the up arrow jogs X−', () => {
    expect(screenDirToWork(0, 1, 90)).toEqual({ x: -1, y: 0 })
    expect(screenDirToWork(1, 0, 90)).toEqual({ x: 0, y: 1 })
  })
})

describe('mapRotationFor — the map lies like the drawing', () => {
  it('points each machine axis on the map where the canvas draws it', () => {
    for (const d of MACHINE_X_DIRS) {
      for (const [mx, my] of [[1, 0], [0, 1]]) {
        const [dx, dy] = fromMachine(mx, my, d)   // on the drawing, Y up
        expect(workToMap(mx, my, mapRotationFor(d)), d).toEqual([dx, -dy + 0])
      }
    }
  })
})
