import { describe, it, expect, beforeEach } from 'vitest'
import { unzlibSync } from 'fflate'
import { generateGcode, MAX_GCODE_LINE } from './gcode'
import { thumbnailLines } from './thumbnail'
import { parseGcode } from '../sim/gcodeParser'
import { useWorkpieceStore } from '../store/workpieceStore'
import type { PostProcessorProfile } from '../store/postProcessorStore'
import type { Tool } from '../store/toolStore'
import type { AnyOperation, MotionSegment } from '../store/toolpathStore'

const POST: PostProcessorProfile = {
  id: 'test-post', name: 'Test Post', unitMode: 'mm', commentStyle: 'parenthesis',
  startGcode: 'G90', endGcode: 'M5\nM30', toolChangeGcode: 'M5\nM0',
  spindleOnTemplate: 'M3 S{s}', spindleOffGcode: 'M5',
  rapidTemplate: 'G0 X{x} Y{y} Z{z}', cutTemplate: 'G1 X{x} Y{y} Z{z} F{f}',
  arcCWTemplate: 'G2 X{x} Y{y} Z{z} I{i} J{j} F{f}', arcCCWTemplate: 'G3 X{x} Y{y} Z{z} I{i} J{j} F{f}',
  outputArcs: true, thumbnails: true,
}

const TOOL: Tool = {
  id: 't1', name: 'End Mill', type: 'endmill', diameterMM: 6, fluteCount: 2,
  rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 25,
}
const TOOLS = { t1: TOOL }

const cut = (x: number, y: number, z: number): MotionSegment => ({ x, y, z, rapid: false })
const rapid = (x: number, y: number, z: number): MotionSegment => ({ x, y, z, rapid: true })

// A 6 mm slot 3 mm deep along y = 60, from x = 20 to x = 80, on 100 × 80 stock.
const SLOT: AnyOperation = {
  id: 'op1', name: 'Profile 1', type: 'profile', toolId: 't1', pathId: 'p1',
  side: 'outside', depthMM: 3, stepDownMM: 3, direction: 'climb', rampIn: false,
  status: 'done', color: '#fff', visible: true,
  segments: [rapid(20, 60, 5), cut(20, 60, -3), cut(80, 60, -3), rapid(80, 60, 5)],
}
const STOCK = { widthMM: 100, heightMM: 80, thicknessMM: 12 }

beforeEach(() => {
  useWorkpieceStore.setState({
    ...STOCK, origin: 'bottom-left', zOrigin: 'top', spindleType: 'vfd',
    autoFeedEnabled: false, maxFeedMmMin: 0,
  })
})

/** Every thumbnail block in a program: size, declared length and the base64 it carries. */
function blocks(lines: string[]) {
  const out: { w: number; h: number; len: number; b64: string }[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^; thumbnail begin (\d+)x(\d+) (\d+)$/.exec(lines[i])
    if (!m) continue
    let b64 = ''
    while (lines[++i] !== '; thumbnail end') b64 += lines[i].slice(2)
    out.push({ w: +m[1], h: +m[2], len: +m[3], b64 })
  }
  return out
}

/** RGBA pixels of a PNG the encoder wrote (8-bit RGBA, None/Up filters only). */
function decodePng(b64: string) {
  const bytes = Uint8Array.from(Buffer.from(b64, 'base64'))
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  const dv = new DataView(bytes.buffer)
  let p = 8, w = 0, h = 0
  const idat: Uint8Array[] = []
  while (p < bytes.length) {
    const len = dv.getUint32(p), type = String.fromCharCode(...bytes.subarray(p + 4, p + 8))
    const data = bytes.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') { w = dv.getUint32(p + 8); h = dv.getUint32(p + 12) }
    if (type === 'IDAT') idat.push(data)
    p += 12 + len
  }
  const raw = unzlibSync(Uint8Array.from(idat.flatMap((d) => [...d])))
  const px = new Uint8Array(w * h * 4), stride = w * 4
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x]
      px[y * stride + x] = f === 2 && y > 0 ? (v + px[(y - 1) * stride + x]) & 0xff : v
    }
  }
  return { w, h, px }
}

describe('G-code thumbnails (Klipper / Moonraker)', () => {
  it('are written only into a file, and only when the profile asks for them', () => {
    const asFile = (post: PostProcessorProfile) => generateGcode([SLOT], TOOLS, 'p', post, { forFile: true })
    expect(asFile(POST)).toContain('; thumbnail begin 300x300 ')
    expect(asFile({ ...POST, thumbnails: false })).not.toContain('thumbnail')
    // The simulator, run time and export check build the program without forFile.
    expect(generateGcode([SLOT], TOOLS, 'p', POST)).not.toContain('thumbnail')
  })

  it('sit in the header, as ; comments however the profile comments, every line under the controller limit', () => {
    const lines = generateGcode([SLOT], TOOLS, 'p', POST, { forFile: true }).split('\n')
    const first = lines.findIndex((l) => l.startsWith('; thumbnail begin'))
    const units = lines.indexOf('G21')
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(units)
    expect(lines[0]).toBe('(p)')   // the program name still leads
    const last = lines.lastIndexOf('; thumbnail end')
    for (const l of lines.slice(first - 1, last + 2)) {
      expect(l.startsWith(';')).toBe(true)
      expect(l.length).toBeLessThanOrEqual(MAX_GCODE_LINE)
    }
  })

  // Moonraker extracts thumbnails only from a file whose slicer it can name — an "Unknown"
  // slicer gets none up to v0.9.3. These are its own identify patterns (metadata.py).
  it('come with a header Moonraker names the slicer from, in current releases and in old ones', () => {
    const g = generateGcode([SLOT], TOOLS, 'p', POST, { forFile: true })
    const head = g.slice(0, g.indexOf('; thumbnail begin'))
    // master: the generic PrusaSlicer-fork line → slicer "FreazyKam", version = the build
    const m = /; generated by (.+?) on \d{4}-\d{2}-\d{2} at \d{2}:\d{2}:\d{2}/.exec(head)
    expect(m?.[1].split(' ')[0]).toBe('FreazyKam')
    expect(m?.[1].split(' ')).toHaveLength(2)
    // v0.8 – v0.9.3: only the PrusaSlicer family's alias pattern
    expect(head).toMatch(/PrusaSlicer\s(.*)\son/)
    // and none of it unless thumbnails are written
    const plain = generateGcode([SLOT], TOOLS, 'p', { ...POST, thumbnails: false }, { forFile: true })
    expect(plain).not.toMatch(/generated by|PrusaSlicer/)
  })

  it('leave the moves the controller runs exactly as they were', () => {
    const withThumb = generateGcode([SLOT], TOOLS, 'p', POST, { forFile: true })
    const without = generateGcode([SLOT], TOOLS, 'p', { ...POST, thumbnails: false }, { forFile: true })
    const moves = (g: string) => parseGcode(g).segments.map((s) => [s.x, s.y, s.z, s.rapid])
    expect(moves(withThumb)).toEqual(moves(without))
  })

  it('declare the base64 length they carry, small size first, as Moonraker expects', () => {
    const bs = blocks(thumbnailLines([SLOT], TOOLS, STOCK, (op) => op.toolId))
    expect(bs.map((b) => `${b.w}x${b.h}`)).toEqual(['32x32', '300x300'])
    for (const b of bs) expect(b.b64.length).toBe(b.len)
  })

  it('frame the small icon on what is cut, not on the whole stock', () => {
    const { w, px } = decodePng(blocks(thumbnailLines([SLOT], TOOLS, STOCK, (op) => op.toolId))[0].b64)
    const lum = (i: number, j: number) => px[(j * w + i) * 4] + px[(j * w + i) * 4 + 1] + px[(j * w + i) * 4 + 2]
    const alpha = (i: number, j: number) => px[(j * w + i) * 4 + 3]
    // The slot runs across the middle of the icon — framed on the stock it would sit at
    // a quarter of the way down, a pixel or two of 32.
    expect(alpha(16, 16)).toBe(255)
    // Row 11 is y ≈ 70 mm, uncut stock inside the frame; above the stock's top edge (80 mm)
    // the frame runs on into nothing.
    expect(alpha(16, 11)).toBe(255)
    expect(lum(16, 16)).toBeLessThan(lum(16, 11) - 150)
    expect(lum(3, 16)).toBeLessThan(lum(16, 11) - 150)   // and nearly edge to edge
    expect(alpha(16, 2)).toBe(0)
  })

  // A 0.5 mm line 0.2 mm deep, 200 mm long: a fourteenth of an icon pixel wide. Alone it is
  // the deepest cut in the job; beside a 10 mm hole it is a fiftieth of it — the engraved
  // label on a cut-out part, and the case a colour read off depth alone would lose.
  it.each([
    ['alone', false],
    ['beside a cut fifty times deeper', true],
  ])('keep a line far thinner than an icon pixel visible in the icon — %s', (_, withHole) => {
    const fine: Tool = { ...TOOL, id: 'fine', diameterMM: 0.5 }
    const line: AnyOperation = { ...SLOT, toolId: 'fine', segments: [rapid(50, 150, 5), cut(50, 150, -0.2), cut(250, 150, -0.2), rapid(250, 150, 5)] }
    const hole: AnyOperation = { ...SLOT, id: 'op2', segments: [rapid(30, 150, 5), cut(30, 150, -10), rapid(30, 150, 5)] }
    const stock = { widthMM: 300, heightMM: 300, thicknessMM: 12 }
    const ops = withHole ? [line, hole] : [line]
    const { w, px } = decodePng(blocks(thumbnailLines(ops, { fine, t1: TOOL }, stock, (op) => op.toolId))[0].b64)
    const lum = (i: number, j: number) => px[(j * w + i) * 4] + px[(j * w + i) * 4 + 1] + px[(j * w + i) * 4 + 2]
    const row = [15, 16].map((j) => lum(16, j))
    expect(Math.min(...row)).toBeLessThan(lum(16, 4) - 150)
  })

  it('show a drilled hole — a plunge straight down, with no length to sweep', () => {
    const drill: AnyOperation = { ...SLOT, segments: [rapid(30, 40, 5), cut(30, 40, -10), rapid(30, 40, 5)] }
    const { w, px } = decodePng(blocks(thumbnailLines([drill], TOOLS, STOCK, (op) => op.toolId))[1].b64)
    // 3 px/mm, the stock's bottom edge on row 270 (as in the test below).
    const lum = (xMM: number, yMM: number) => {
      const k = (Math.floor(270 - yMM * 3) * w + Math.floor(xMM * 3)) * 4
      return px[k] + px[k + 1] + px[k + 2]
    }
    expect(lum(30, 40)).toBeLessThan(lum(70, 40) - 60)
  })

  it('picture the stock top-down with Y up: the cut is darker than the stock, off the stock is clear', () => {
    const big = blocks(thumbnailLines([SLOT], TOOLS, STOCK, (op) => op.toolId))[1]
    const { w, h, px } = decodePng(big.b64)
    expect([w, h]).toEqual([300, 300])
    // 100 × 80 mm fills the width at 3 px/mm; the stock runs rows 30 … 270.
    const at = (xMM: number, yMM: number) => {
      const k = (Math.floor(270 - yMM * 3) * w + Math.floor(xMM * 3)) * 4
      return { lum: px[k] + px[k + 1] + px[k + 2], a: px[k + 3] }
    }
    const slot = at(50, 60), stock = at(50, 20), mirrored = at(50, 80 - 60)
    expect(slot.a).toBe(255)
    expect(slot.lum).toBeLessThan(stock.lum - 60)
    expect(mirrored.lum).toBe(stock.lum)   // a Y-down picture would put the slot here
    expect(px[(10 * w + 150) * 4 + 3]).toBe(0)   // above the stock: transparent
  })
})
