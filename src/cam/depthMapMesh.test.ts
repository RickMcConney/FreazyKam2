import { describe, it, expect } from 'vitest'
import { depthMapMesh, depthMapFloorLevel } from './depthMapMesh'
import type { PhotoImage } from './photoVcarve'

// A picture of `w`×`h` pixels from a function of (column, row), row 0 the TOP.
function picture(w: number, h: number, f: (i: number, j: number) => number): PhotoImage {
  const lum = new Uint8Array(w * h)
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) lum[j * w + i] = f(i, j)
  return { lum, w, h }
}

/** Every node as [x, y, z]. */
function nodes(positions: Float32Array): [number, number, number][] {
  const out: [number, number, number][] = []
  for (let k = 0; k < positions.length; k += 3) out.push([positions[k], positions[k + 1], positions[k + 2]])
  return out
}

const RECT = { p0: { x: 10, y: 20 }, widthMM: 40, heightMM: 30, rotationDeg: 0 }

describe('a depth map as a mesh', () => {
  // A dark-grey background (40) with a white square in the middle: the background is the
  // picture's darkest, so it must come out ON the floor, not 40/255 of the relief above it.
  const greyBg = picture(40, 30, (i, j) => (i >= 15 && i < 25 && j >= 10 && j < 20 ? 255 : 40))

  it('puts a grey background on the floor, so it meets the floor cleared round the picture with no step', () => {
    const m = depthMapMesh(greyBg, RECT, 6)
    const zs = nodes(m.positions).map((p) => p[2])
    expect(Math.min(...zs)).toBe(0)
    // ... and the background is all of it: every node away from the square is at the floor.
    const corner = nodes(m.positions).filter(([x, y]) => x < 15 && y < 25)
    expect(corner.length).toBeGreaterThan(0)
    for (const p of corner) expect(p[2]).toBe(0)
  })

  it('keeps white at the model top, the full relief above the floor', () => {
    const m = depthMapMesh(greyBg, RECT, 6)
    expect(Math.max(...nodes(m.positions).map((p) => p[2]))).toBeCloseTo(6, 5)
    expect(m.bounds.maxZ).toBe(6)
    expect(m.bounds.minZ).toBe(0)
  })

  it('stretches the levels between the background and white, rather than shifting them', () => {
    // Three bands: 40 (the background), 148, 255. The middle one lands proportionally
    // between the floor level and white.
    const bands = picture(30, 10, (i) => (i < 10 ? 40 : i < 20 ? 148 : 255))
    const floor = depthMapFloorLevel(bands)
    expect(floor).toBeGreaterThanOrEqual(40)
    expect(floor).toBeLessThan(50)
    const m = depthMapMesh(bands, { p0: { x: 0, y: 0 }, widthMM: 30, heightMM: 10, rotationDeg: 0 }, 10)
    const mid = nodes(m.positions).find(([x, y]) => Math.abs(x - 15) < 0.6 && Math.abs(y - 5) < 0.6)!
    expect(mid[2]).toBeCloseTo(((148 - floor) / (255 - floor)) * 10, 4)
  })

  it('with dark high, puts a light background on the floor and black at the top', () => {
    const lightBg = picture(40, 30, (i, j) => (i >= 15 && i < 25 && j >= 10 && j < 20 ? 0 : 200))
    const m = depthMapMesh(lightBg, RECT, 6, { invert: true })
    const zs = nodes(m.positions).map((p) => p[2])
    expect(Math.min(...zs)).toBe(0)
    expect(Math.max(...zs)).toBeCloseTo(6, 5)
    const centre = nodes(m.positions).find(([x, y]) => Math.abs(x - 30) < 0.6 && Math.abs(y - 35) < 0.6)!
    expect(centre[2]).toBeCloseTo(6, 5)
  })

  it('carves the picture\'s TOP row at the high-Y edge (CNC is Y-up, pixel rows run down)', () => {
    // White top half, black bottom half.
    const topWhite = picture(20, 20, (_i, j) => (j < 10 ? 255 : 0))
    const m = depthMapMesh(topWhite, { p0: { x: 0, y: 0 }, widthMM: 20, heightMM: 20, rotationDeg: 0 }, 5)
    const top = nodes(m.positions).filter(([, y]) => y > 18)
    const bottom = nodes(m.positions).filter(([, y]) => y < 2)
    for (const p of top) expect(p[2]).toBeCloseTo(5, 5)
    for (const p of bottom) expect(p[2]).toBe(0)
  })

  it('maps onto its own bounds with scale 1, turned with the picture', () => {
    const m = depthMapMesh(greyBg, { ...RECT, rotationDeg: 30 }, 6)
    expect(m.bbox.minX).toBe(m.bounds.minX)
    expect(m.bbox.maxY).toBe(m.bounds.maxY)
    // The picture's bottom-right corner, turned 30° about p0.
    const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6)
    const bx = RECT.p0.x + RECT.widthMM * c, by = RECT.p0.y + RECT.widthMM * s
    expect(nodes(m.positions).some(([x, y]) => Math.hypot(x - bx, y - by) < 1e-4)).toBe(true)
  })

  it('reads a picture of one flat level as the model top, not as a division by zero', () => {
    const flat = picture(10, 10, () => 255)
    const zs = nodes(depthMapMesh(flat, RECT, 6).positions).map((p) => p[2])
    for (const z of zs) expect(z).toBe(6)
  })
})

describe('the floor of a depth map is its background, found in the histogram', () => {
  // A seeded speckle, so the pictures are the same every run.
  let seed = 7
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647

  it('takes in a JPEG background\'s whole speck tail, so the specks are cut flat, not carved as bumps', () => {
    // The dog's shape: a black background (0–1) with compression specks out to grey 20, and
    // the plaque's own greys from 60 up.
    const dog = picture(200, 150, (i, j) => {
      const inPlaque = Math.hypot((i - 100) / 70, (j - 75) / 50) < 1
      if (inPlaque) return 60 + Math.floor(rand() * 190)
      const r = rand()
      return r < 0.9 ? Math.floor(rand() * 2) : 2 + Math.floor(rand() * rand() * 19)
    })
    const floor = depthMapFloorLevel(dog)
    expect(floor).toBeGreaterThanOrEqual(20)   // past every speck
    expect(floor).toBeLessThan(60)             // short of the plaque
    // ... and on the mesh, the whole background is floor.
    const m = depthMapMesh(dog, { p0: { x: 0, y: 0 }, widthMM: 200, heightMM: 150, rotationDeg: 0 }, 12)
    const bg = nodes(m.positions).filter(([x, y]) => Math.hypot((x - 100) / 70, (y - 75) / 50) > 1.1)
    expect(bg.length).toBeGreaterThan(100)
    for (const p of bg) expect(p[2]).toBe(0)
  })

  it('puts a grey background on the floor and cuts specks DARKER than it flat with it', () => {
    const grey = picture(100, 100, (i, j) => {
      if (i > 30 && i < 70 && j > 30 && j < 70) return 120 + ((i + j) % 100)
      if ((i * 7 + j * 13) % 97 === 0) return 10           // dark specks
      return 39 + Math.floor(rand() * 3)                    // the background, 39–41
    })
    const floor = depthMapFloorLevel(grey)
    expect(floor).toBeGreaterThanOrEqual(41)
    expect(floor).toBeLessThan(120)
    const m = depthMapMesh(grey, { p0: { x: 0, y: 0 }, widthMM: 100, heightMM: 100, rotationDeg: 0 }, 6)
    const zs = nodes(m.positions).filter(([x, y]) => x < 25 || y < 25).map((p) => p[2])
    for (const z of zs) expect(z).toBe(0)
  })

  it('stops where the background\'s spike ends, keeping dark content that begins right after it', () => {
    // The elk's shape: a black spike, then dark scenery climbing at once from grey 6.
    const elk = picture(200, 100, (i) => (i < 40 ? Math.floor(rand() * 2) : 6 + Math.floor((i - 40) * 1.5)))
    expect(depthMapFloorLevel(elk)).toBeLessThanOrEqual(6)
  })

  it('floors a picture with no background spike at its darkest 0.1 %, so a few specks cannot set it', () => {
    // A smooth ramp from 30 to 230 with a handful of black specks.
    const ramp = picture(200, 100, (i, j) => ((i * 31 + j * 17) % 5000 === 0 ? 0 : 30 + i))
    const floor = depthMapFloorLevel(ramp)
    expect(floor).toBeGreaterThanOrEqual(30)
    expect(floor).toBeLessThan(33)
  })

  it('with dark high, does not take a picture\'s largest mid-grey for its background', () => {
    // The dog with Dark is high: no light background, a big flat mid-grey plaque (130), and
    // the dog lighter than it. Read upside down, the plaque is the tallest bin on the dark
    // side of the median — taken for the background, it cut the whole dog flat on the floor.
    const plaque = picture(200, 150, (i, j) => {
      if (Math.hypot((i - 100) / 40, (j - 75) / 30) < 1) return 160 + Math.floor(rand() * 95)   // the dog
      if (Math.hypot((i - 100) / 90, (j - 75) / 65) < 1) return 128 + Math.floor(rand() * 5)    // the plaque
      return Math.floor(rand() * 2)                                                              // black backdrop
    })
    const floor = 255 - depthMapFloorLevel(plaque, true)   // back to plain grey
    expect(floor).toBeGreaterThan(240)   // the floor is the dog's lightest, not the plaque
    const m = depthMapMesh(plaque, { p0: { x: 0, y: 0 }, widthMM: 200, heightMM: 150, rotationDeg: 0 }, 12, { invert: true })
    const dog = nodes(m.positions).filter(([x, y]) => Math.hypot((x - 100) / 40, (y - 75) / 30) < 0.8)
    expect(dog.filter((p) => p[2] > 0).length).toBeGreaterThan(dog.length * 0.9)
  })

  it('reads the histogram the other way up when dark is high: a WHITE background is the floor', () => {
    const white = picture(100, 100, (i, j) => (i > 30 && i < 70 && j > 30 && j < 70 ? 40 : 253 + Math.floor(rand() * 3)))
    expect(depthMapFloorLevel(white, true)).toBeGreaterThanOrEqual(2)
    expect(depthMapFloorLevel(white, true)).toBeLessThan(200)
  })
})
