import { parseNums } from '../cam/pathFlattener'
import type { ShapeParams } from '../shapes/shapeGenerators'
import type { TransformStep } from '../canvas/selectionUtils'
import type { OffsetCornerStyle } from '../tools/offsetOp'
import type { PatternParams } from '../tools/patternOp'
import type { BooleanOpType } from '../tools/booleanOps'
import type { CornerTreatmentType } from '../tools/cornerTreatment'
import type { ClockSpec } from '../shapes/clockTrain'
import { PATH_COLOR } from '../colors'
import { splitCompoundPath } from '../canvas/nodeUtils'
import { uid } from '../uid'

export interface StlModelBounds {
  minX: number; maxX: number
  minY: number; maxY: number
  minZ: number; maxZ: number
}

export interface ImportedPath {
  id: string
  name: string
  d: string        // SVG d string in CNC mm coordinates (Y-up)
  visible: boolean
  hidden?: boolean // soft-hidden by boolean ops; shows in panel but not on canvas
  color: string
  shapeParams?: ShapeParams
  // Which piece of a multi-part shape this is (see generateShapeParts). All the
  // pieces carry the SAME shapeParams and share a groupId, so editing any one of
  // them regenerates the whole set.
  shapePart?: string
  // Where this part sits RELATIVE to where its shapeParams nominally put it —
  // the consolidated recipe (see consolidateSteps) for every repositioning
  // gesture applied to this part alone. A multi-part shape regenerates all of
  // its parts from one shared set of params, so without this a gear's pinion
  // snapped back to its designed spot the moment any parameter was stepped,
  // taking the user's arrangement with it. `d` stays the baked result of
  // definition-then-placement, so nothing downstream reads this.
  //
  // Only repositioning lives here (move/rotate/mirror/skew). A SCALE is a
  // definition edit — scaling a gear scales its module — so it still rewrites
  // shapeParams the way it always has.
  placement?: TransformStep[]
  groupId?: string   // shared across all paths from the same SVG import
  groupName?: string // display name for the group (SVG filename without extension)
  // The groups the USER tied this path into (Group / Ungroup), so several paths
  // select and move as one thing. A SECOND, orthogonal axis to `groupId`,
  // deliberately not the same field: `groupId` says what MADE these paths — a
  // gear's parts regenerate through it, an import is named by it — and a gear's
  // parts must stay individually selectable and draggable (see `placement`).
  //
  // OUTERMOST FIRST, and it is a chain because groups NEST: grouping a group
  // with a shape has to give back that group and that shape when it is
  // ungrouped, not three loose paths. So Group PREPENDS an id and Ungroup drops
  // the first one, revealing whatever was inside. `userGroups[0]` is the only
  // one selection ever asks about — it is the outermost thing the path belongs
  // to, which is what a click on the canvas selects.
  userGroups?: string[]
  // Which clock this shape was emitted as part of, and which wheel of it (see
  // shapes/clockTrain.ts). Purely a LINK: the shapes are ordinary, independent
  // and separately editable, and nothing regenerates through this. It exists so
  // the five groups can be found again and stood up in mesh — the one question a
  // drawing of loose wheels laid out flat cannot answer.
  clockId?: string
  clockPart?: string
  // The SPEC the whole clock was worked out from, carried by every one of its
  // parts — the same shape as `shapeParams` on a multi-part shape, and read back
  // by ClockPanel to reopen the designer on it. On the parts rather than in a
  // store of its own because a clock is only ever found THROUGH its parts: it
  // has no object of its own in the document.
  clockSpec?: ClockSpec
  // What GENERATED this path, and from what — the parameters its form reopens
  // on. Provenance belongs on the object rather than in the history: it is a
  // property of the thing, not of the moment it was made, and looking it up in
  // an event log meant a search with a failure mode (no chip found → fall back)
  // and a chip that had to be kept in step with the geometry it described.
  //
  // `definition.id` is shared by every path ONE generator call produced, which
  // is what a form's edit mode re-runs over: a pattern's copies, an offset's
  // results. It plays the part `groupId` plays for a multi-part shape.
  // How this object GROWS when its resize handles are dragged: outward from its
  // middle, or holding the opposite corner still. On the PATH rather than in
  // `shapeParams`, because it has to outlive them — a rotate, skew or mirror
  // drops shapeParams entirely (a rotated rectangle is no longer `{x,y,w,h}`),
  // and losing the preference with them means it can never be set on anything
  // that has been turned. It also lets an IMPORTED outline carry it, which has
  // no params at all.
  fromCenter?: boolean
  definition?: PathDefinition
  // Corner treatments as a RECIPE over the untreated outline, not as baked
  // geometry: `d` is `applyCornerTreatments(baseD, treatments)`, so re-editing a
  // radius re-cuts the ORIGINAL corner instead of rounding an already-rounded
  // one. That is what makes a corner chip honest — a chip that reopens a form is
  // a lie unless the form can reproduce what it did.
  //
  // NodeEditForm has always kept this pair in a module-level session cache;
  // holding it here is what lets it survive a reload, a save and a project load,
  // and lets the strip find it. `treatments` is keyed by corner index into
  // `baseD`, which is why any edit that changes the outline drops the whole
  // thing (see applyPathEdit) — those indices would point at different corners.
  corners?: { baseD: string; treatments: [number, { type: CornerTreatmentType; radiusMM: number }][] }
  imageSrc?: string  // base64 data URL — path acts as bounding box for this image
  stlSrc?: string            // base64-encoded STL file — path acts as 2D bounding box
  stlModelBounds?: StlModelBounds  // original STL bounding box in model space (mm)
}

// A generated path's provenance. A parametric SHAPE carries `shapeParams`
// instead — same idea, older field.
export type PathDefinition = { id: string } & (
  | { kind: 'offset'; sourceId: string; distanceMM: number; cornerStyle: OffsetCornerStyle }
  | { kind: 'pattern'; sourceIds: string[]; params: PatternParams }
  | { kind: 'duplicate'; sourceId: string; offsetMM: number }
  | { kind: 'boolean'; op: BooleanOpType; sourceIds: string[] }
)

export interface SvgImportResult {
  paths: ImportedPath[]
  needsPpiPrompt: boolean
  svgWidthMM: number
  svgHeightMM: number
  groupId: string
}

// Session-local numbering for display NAMES only ("Path 7") — ids come from
// uid() so they can never collide with ids loaded from a saved project.
let pathCounter = 0

export function nextPathColor(): string {
  return PATH_COLOR
}

// ── Path command types (absolute only) ───────────────────────────────────────
export type AbsCmd =
  | { t: 'M'; x: number; y: number }
  | { t: 'L'; x: number; y: number }
  | { t: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { t: 'S'; x2: number; y2: number; x: number; y: number }
  | { t: 'Q'; x1: number; y1: number; x: number; y: number }
  | { t: 'T'; x: number; y: number }
  | { t: 'A'; rx: number; ry: number; ang: number; lg: number; sw: number; x: number; y: number }
  | { t: 'Z' }

// Parse SVG d string → absolute commands (H/V expanded to L)
export function parseD(d: string): AbsCmd[] {
  const result: AbsCmd[] = []
  const tokens = d.match(/[a-zA-Z][^a-zA-Z]*/g) ?? []
  let cx = 0, cy = 0, mx = 0, my = 0

  for (const tok of tokens) {
    const letter = tok[0]
    const upper = letter.toUpperCase()
    const rel = letter !== upper
    const n = parseNums(tok.slice(1))

    switch (upper) {
      case 'M':
        for (let i = 0; i < n.length; i += 2) {
          const x = rel ? cx + n[i] : n[i]
          const y = rel ? cy + n[i + 1] : n[i + 1]
          result.push({ t: i === 0 ? 'M' : 'L', x, y })
          if (i === 0) { mx = x; my = y }
          cx = x; cy = y
        }
        break
      case 'L':
        for (let i = 0; i < n.length; i += 2) {
          const x = rel ? cx + n[i] : n[i]
          const y = rel ? cy + n[i + 1] : n[i + 1]
          result.push({ t: 'L', x, y })
          cx = x; cy = y
        }
        break
      case 'H':
        for (const v of n) {
          const x = rel ? cx + v : v
          result.push({ t: 'L', x, y: cy })  // expand H → L
          cx = x
        }
        break
      case 'V':
        for (const v of n) {
          const y = rel ? cy + v : v
          result.push({ t: 'L', x: cx, y })  // expand V → L
          cy = y
        }
        break
      case 'C':
        for (let i = 0; i < n.length; i += 6) {
          const x1 = rel ? cx + n[i] : n[i], y1 = rel ? cy + n[i+1] : n[i+1]
          const x2 = rel ? cx + n[i+2] : n[i+2], y2 = rel ? cy + n[i+3] : n[i+3]
          const x  = rel ? cx + n[i+4] : n[i+4], y  = rel ? cy + n[i+5] : n[i+5]
          result.push({ t: 'C', x1, y1, x2, y2, x, y })
          cx = x; cy = y
        }
        break
      case 'S':
        for (let i = 0; i < n.length; i += 4) {
          const x2 = rel ? cx + n[i] : n[i], y2 = rel ? cy + n[i+1] : n[i+1]
          const x  = rel ? cx + n[i+2] : n[i+2], y  = rel ? cy + n[i+3] : n[i+3]
          result.push({ t: 'S', x2, y2, x, y })
          cx = x; cy = y
        }
        break
      case 'Q':
        for (let i = 0; i < n.length; i += 4) {
          const x1 = rel ? cx + n[i] : n[i], y1 = rel ? cy + n[i+1] : n[i+1]
          const x  = rel ? cx + n[i+2] : n[i+2], y  = rel ? cy + n[i+3] : n[i+3]
          result.push({ t: 'Q', x1, y1, x, y })
          cx = x; cy = y
        }
        break
      case 'T':
        for (let i = 0; i < n.length; i += 2) {
          const x = rel ? cx + n[i] : n[i], y = rel ? cy + n[i+1] : n[i+1]
          result.push({ t: 'T', x, y })
          cx = x; cy = y
        }
        break
      case 'A':
        for (let i = 0; i < n.length; i += 7) {
          const x = rel ? cx + n[i+5] : n[i+5], y = rel ? cy + n[i+6] : n[i+6]
          result.push({ t: 'A', rx: n[i], ry: n[i+1], ang: n[i+2], lg: n[i+3], sw: n[i+4], x, y })
          cx = x; cy = y
        }
        break
      case 'Z':
        result.push({ t: 'Z' })
        cx = mx; cy = my
        break
    }
  }
  return result
}

function fmt(n: number) { return +n.toFixed(4) }

export function stringifyD(cmds: AbsCmd[]): string {
  return cmds.map(c => {
    switch (c.t) {
      case 'M': return `M${fmt(c.x)},${fmt(c.y)}`
      case 'L': return `L${fmt(c.x)},${fmt(c.y)}`
      case 'C': return `C${fmt(c.x1)},${fmt(c.y1)},${fmt(c.x2)},${fmt(c.y2)},${fmt(c.x)},${fmt(c.y)}`
      case 'S': return `S${fmt(c.x2)},${fmt(c.y2)},${fmt(c.x)},${fmt(c.y)}`
      case 'Q': return `Q${fmt(c.x1)},${fmt(c.y1)},${fmt(c.x)},${fmt(c.y)}`
      case 'T': return `T${fmt(c.x)},${fmt(c.y)}`
      case 'A': return `A${fmt(c.rx)},${fmt(c.ry)},${c.ang},${c.lg},${c.sw},${fmt(c.x)},${fmt(c.y)}`
      case 'Z': return 'Z'
    }
  }).join(' ')
}

// ── 2D affine matrix [a,b,c,d,e,f]: x'=ax+cy+e, y'=bx+dy+f ─────────────────
export type Mat6 = [number, number, number, number, number, number]
const IDENTITY: Mat6 = [1, 0, 0, 1, 0, 0]

// Compose M1(M2(p)) — M2 is applied first, M1 second
function matMul(M1: Mat6, M2: Mat6): Mat6 {
  const [a1,b1,c1,d1,e1,f1] = M1
  const [a2,b2,c2,d2,e2,f2] = M2
  return [
    a1*a2 + c1*b2,
    b1*a2 + d1*b2,
    a1*c2 + c1*d2,
    b1*c2 + d1*d2,
    a1*e2 + c1*f2 + e1,
    b1*e2 + d1*f2 + f1,
  ]
}

function parseSvgTransform(attr: string | null): Mat6 {
  if (!attr) return IDENTITY
  let result: Mat6 = [...IDENTITY] as Mat6
  const re = /(\w+)\(([^)]*)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(attr)) !== null) {
    const name = m[1]; const args = parseNums(m[2])
    let mat: Mat6 = [...IDENTITY] as Mat6
    switch (name) {
      case 'translate': mat = [1,0,0,1, args[0]??0, args[1]??0]; break
      case 'scale': { const sx = args[0]??1, sy = args[1]??sx; mat = [sx,0,0,sy,0,0]; break }
      case 'matrix': if (args.length===6) mat = args as Mat6; break
      case 'rotate': {
        const a = ((args[0]??0)*Math.PI)/180, cos=Math.cos(a), sin=Math.sin(a)
        const px=args[1]??0, py=args[2]??0
        mat = [cos,sin,-sin,cos, px-cos*px+sin*py, py-sin*px-cos*py]
        break
      }
      case 'skewX': mat = [1, 0, Math.tan(((args[0]??0)*Math.PI)/180), 1, 0, 0]; break
      case 'skewY': mat = [1, Math.tan(((args[0]??0)*Math.PI)/180), 0, 1, 0, 0]; break
    }
    // SVG CTM: T1 T2 → combined = T1 * T2 (T2 applied first to points)
    result = matMul(result, mat)
  }
  return result
}

// Transform an arc's radii + x-axis-rotation under the linear part of a Mat6.
// An affine map takes an ellipse to an ellipse. The ellipse is the image of the
// unit circle under R(ang)·diag(rx,ry), so the transformed ellipse is the image
// under N = L·R(ang)·diag(rx,ry). The SVD N = R(u)·diag(σ1,σ2)·R(v)ᵀ gives the
// new axes directly (R(v)ᵀ maps the circle to itself): radii = |σ1|,|σ2| and
// axis angle = u. The old code scaled rx/ry by the matrix row norms and left
// ang untouched — correct only for translate/axis-aligned scale/mirror, which
// is why rotating or skewing an ellipse distorted it (tofix.md B3).
function xformArcAxes(
  rx: number, ry: number, angDeg: number,
  a: number, b: number, c: number, d: number,
): { rx: number; ry: number; ang: number } {
  const phi = angDeg * Math.PI / 180
  const cosP = Math.cos(phi), sinP = Math.sin(phi)
  // N = L·R(phi)·diag(rx,ry), with L = [[a,c],[b,d]] (x' = ax+cy, y' = bx+dy)
  const n11 = (a * cosP + c * sinP) * rx
  const n21 = (b * cosP + d * sinP) * rx
  const n12 = (c * cosP - a * sinP) * ry
  const n22 = (d * cosP - b * sinP) * ry
  // Closed-form 2×2 SVD via rotation sum/difference identities
  const E = (n11 + n22) / 2, F = (n11 - n22) / 2
  const G = (n21 + n12) / 2, H = (n21 - n12) / 2
  const Q = Math.hypot(E, H), R = Math.hypot(F, G)
  // Left-rotation angle = new ellipse axis angle. For a circle (F=G=0) a1 is
  // arbitrary — harmless, any angle describes the same circle.
  const a1 = Math.atan2(G, F), a2 = Math.atan2(H, E)
  return {
    rx: Q + R,
    ry: Math.abs(Q - R),
    ang: +(((a2 + a1) / 2) * 180 / Math.PI).toFixed(4),
  }
}

export function applyMat(cmds: AbsCmd[], m: Mat6): AbsCmd[] {
  const [a,b,c,d,e,f] = m
  const px = (x: number, y: number) => a*x + c*y + e
  const py = (x: number, y: number) => b*x + d*y + f
  const det = a*d - b*c
  const flipSweep = det < 0
  return cmds.map((cmd): AbsCmd => {
    switch (cmd.t) {
      case 'M': return { t:'M', x:px(cmd.x,cmd.y), y:py(cmd.x,cmd.y) }
      case 'L': return { t:'L', x:px(cmd.x,cmd.y), y:py(cmd.x,cmd.y) }
      case 'C': return { t:'C', x1:px(cmd.x1,cmd.y1), y1:py(cmd.x1,cmd.y1), x2:px(cmd.x2,cmd.y2), y2:py(cmd.x2,cmd.y2), x:px(cmd.x,cmd.y), y:py(cmd.x,cmd.y) }
      case 'S': return { t:'S', x2:px(cmd.x2,cmd.y2), y2:py(cmd.x2,cmd.y2), x:px(cmd.x,cmd.y), y:py(cmd.x,cmd.y) }
      case 'Q': return { t:'Q', x1:px(cmd.x1,cmd.y1), y1:py(cmd.x1,cmd.y1), x:px(cmd.x,cmd.y), y:py(cmd.x,cmd.y) }
      case 'T': return { t:'T', x:px(cmd.x,cmd.y), y:py(cmd.x,cmd.y) }
      case 'A': {
        const ax = xformArcAxes(cmd.rx, cmd.ry, cmd.ang, a, b, c, d)
        return { t:'A', rx:ax.rx, ry:ax.ry, ang:ax.ang, lg:cmd.lg, sw:flipSweep?1-cmd.sw:cmd.sw, x:px(cmd.x,cmd.y), y:py(cmd.x,cmd.y) }
      }
      case 'Z': return { t:'Z' }
    }
  })
}

// Apply simple scale+translate (SVG px → CNC mm with Y-flip). Just a special
// case of applyMat — delegating keeps arc axis handling (incl. rotated arcs
// under non-uniform viewBox scaling) in one place.
function applyGlobalTransform(cmds: AbsCmd[], sx: number, sy: number, tx: number, ty: number): AbsCmd[] {
  return applyMat(cmds, [sx, 0, 0, sy, tx, ty])
}

// ── Shape element → d string (SVG coordinate space) ──────────────────────────
function getRectD(el: Element): string {
  const a = (n: string) => parseFloat(el.getAttribute(n) ?? '0')
  const x=a('x'), y=a('y'), w=a('width'), h=a('height')
  let rx=a('rx')||a('ry'), ry=a('ry')||a('rx')
  rx=Math.min(rx,w/2); ry=Math.min(ry,h/2)
  if (rx===0) return `M${x},${y} L${x+w},${y} L${x+w},${y+h} L${x},${y+h} Z`
  return `M${x+rx},${y} L${x+w-rx},${y} A${rx},${ry},0,0,1,${x+w},${y+ry} L${x+w},${y+h-ry} A${rx},${ry},0,0,1,${x+w-rx},${y+h} L${x+rx},${y+h} A${rx},${ry},0,0,1,${x},${y+h-ry} L${x},${y+ry} A${rx},${ry},0,0,1,${x+rx},${y} Z`
}

function getCircleD(el: Element): string {
  const a=(n:string)=>parseFloat(el.getAttribute(n)?? '0')
  const cx=a('cx'), cy=a('cy'), r=a('r')
  return `M${cx-r},${cy} A${r},${r},0,0,1,${cx+r},${cy} A${r},${r},0,0,1,${cx-r},${cy} Z`
}

function getEllipseD(el: Element): string {
  const a=(n:string)=>parseFloat(el.getAttribute(n)?? '0')
  const cx=a('cx'), cy=a('cy'), rx=a('rx'), ry=a('ry')
  return `M${cx-rx},${cy} A${rx},${ry},0,0,1,${cx+rx},${cy} A${rx},${ry},0,0,1,${cx-rx},${cy} Z`
}

function getLineD(el: Element): string {
  const a=(n:string)=>parseFloat(el.getAttribute(n)?? '0')
  return `M${a('x1')},${a('y1')} L${a('x2')},${a('y2')}`
}

function getPolyD(el: Element, close: boolean): string {
  const pts = el.getAttribute('points') ?? ''
  const n = pts.trim().split(/[\s,]+/).map(Number)
  const cmds: string[] = []
  for (let i=0; i+1<n.length; i+=2) cmds.push(`${i===0?'M':'L'}${n[i]},${n[i+1]}`)
  return cmds.join(' ') + (close ? ' Z' : '')
}

// ── Unit helpers ─────────────────────────────────────────────────────────────
const UNIT_PX: Record<string,number> = { px:1, pt:96/72, pc:16, mm:96/25.4, cm:96/2.54, in:96 }
const REAL_WORLD = new Set(['mm','cm','in','pt','pc'])

function parseSvgLength(attr: string|null): {px:number; unit:string}|null {
  if (!attr) return null
  const m = attr.trim().match(/^([\d.eE+\-]+)(mm|cm|in|pt|pc|px)?$/)
  if (!m) return null
  const unit = m[2]??'px', factor=UNIT_PX[unit]
  if (!factor) return null
  return { px: parseFloat(m[1])*factor, unit }
}

// ── Main export ───────────────────────────────────────────────────────────────
export interface ImportOptions {
  ppi?: number
}

/**
 * SVG user units → CNC mm, Y-up: the one transform an SVG import hangs on.
 *
 *   x_mm = (x − vbX)·(widthMM/vbW)
 *   y_mm = heightMM − (y − vbY)·(heightMM/vbH)
 *
 * Exported because `io/svgExport.ts` has to be its exact inverse — a file this
 * app writes and reads back must land where it started, and two copies of this
 * arithmetic in two files is how that quietly stops being true.
 */
export function svgToCncMat(
  widthMM: number, heightMM: number,
  vbX: number, vbY: number, vbW: number, vbH: number,
): Mat6 {
  const sx = widthMM / vbW
  const sy = -(heightMM / vbH)
  return [sx, 0, 0, sy, -vbX * sx, heightMM + vbY * (heightMM / vbH)]
}

export function importSvg(svgText: string, options?: ImportOptions | number, groupName?: string): SvgImportResult {
  const groupId = uid('svg-group')
  const opts: ImportOptions = typeof options === 'number' ? { ppi: options } : (options ?? {})
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
  if (doc.querySelector('parsererror')) throw new Error('Invalid SVG file')
  const svg = doc.querySelector('svg')
  if (!svg) throw new Error('No <svg> element found')

  let vbX=0, vbY=0, vbW=0, vbH=0
  const vbAttr = svg.getAttribute('viewBox')
  if (vbAttr) { const [a,b,c,d]=parseNums(vbAttr); vbX=a; vbY=b; vbW=c; vbH=d }

  const wParsed = parseSvgLength(svg.getAttribute('width'))
  const hParsed = parseSvgLength(svg.getAttribute('height'))
  const ppiOverride = opts.ppi

  let needsPpiPrompt = false
  let widthMM = 0, heightMM = 0

  if (wParsed && hParsed) {
    if (REAL_WORLD.has(wParsed.unit) || REAL_WORLD.has(hParsed.unit)) {
      widthMM  = wParsed.px  / (96/25.4)
      heightMM = hParsed.px / (96/25.4)
    } else {
      const ppi = ppiOverride ?? 96
      needsPpiPrompt = !ppiOverride
      widthMM  = wParsed.px  / (ppi/25.4)
      heightMM = hParsed.px / (ppi/25.4)
    }
    if (!vbAttr) { vbW=wParsed.px; vbH=hParsed.px }
  } else if (vbW && vbH) {
    const ppi = ppiOverride ?? 96
    needsPpiPrompt = !ppiOverride
    widthMM  = vbW / (ppi/25.4)
    heightMM = vbH / (ppi/25.4)
  } else {
    widthMM=100; heightMM=100; vbW=100; vbH=100; needsPpiPrompt=true
  }

  // Global transform: SVG px → CNC mm (Y-up). See `svgToCncMat` — the exporter
  // has to invert exactly this, so it is stated once.
  const [gsx, , , gsy, gtx, gty] = svgToCncMat(widthMM, heightMM, vbX, vbY, vbW, vbH)

  const paths: ImportedPath[] = []

  function processElement(el: Element, parentMat: Mat6) {
    const tag = el.tagName.toLowerCase().replace(/^.*:/, '')
    const elMat = matMul(parentMat, parseSvgTransform(el.getAttribute('transform')))

    if (tag === 'g' || tag === 'svg') {
      for (const child of el.children) processElement(child, elMat)
      return
    }

    let rawD: string|null = null
    switch (tag) {
      case 'path':     rawD = el.getAttribute('d'); break
      case 'rect':     rawD = getRectD(el); break
      case 'circle':   rawD = getCircleD(el); break
      case 'ellipse':  rawD = getEllipseD(el); break
      case 'line':     rawD = getLineD(el); break
      case 'polyline': rawD = getPolyD(el, false); break
      case 'polygon':  rawD = getPolyD(el, true); break
    }
    if (!rawD?.trim()) return

    try {
      const cmds = parseD(rawD)
      const withElMat = applyMat(cmds, elMat)
      const withGlobal = applyGlobalTransform(withElMat, gsx, gsy, gtx, gty)

      // M-only paths are drill-point markers — render each M as a crosshair
      const hasDrawable = withGlobal.some(c => c.t !== 'M' && c.t !== 'Z')
      if (!hasDrawable) {
        const baseName = el.getAttribute('id') || el.getAttribute('inkscape:label') || null
        const ARM = 1 // crosshair arm length in CNC mm
        for (const cmd of withGlobal) {
          if (cmd.t !== 'M') continue
          const cx = cmd.x, cy = cmd.y
          const crossD = `M${fmt(cx - ARM)},${fmt(cy)} L${fmt(cx + ARM)},${fmt(cy)} M${fmt(cx)},${fmt(cy - ARM)} L${fmt(cx)},${fmt(cy + ARM)}`
          const id = uid('path')
          const name = baseName || `Marker ${++pathCounter}`
          paths.push({ id, name, d: crossD, visible: true, color: PATH_COLOR, groupId, groupName })
        }
        return
      }

      const d = stringifyD(withGlobal)
      const baseName = el.getAttribute('id') || el.getAttribute('inkscape:label') || null
      const subDs = splitCompoundPath(d)
      if (subDs.length > 1) {
        subDs.forEach((subD, i) => {
          const id = uid('path')
          const name = baseName ? `${baseName} ${i + 1}` : `Path ${++pathCounter}`
          paths.push({ id, name, d: subD, visible: true, color: PATH_COLOR, groupId, groupName })
        })
      } else {
        const id = uid('path')
        const name = baseName || `Path ${++pathCounter}`
        paths.push({ id, name, d, visible: true, color: PATH_COLOR, groupId, groupName })
      }
    } catch {
      // skip malformed elements
    }
  }

  const svgMat = parseSvgTransform(svg.getAttribute('transform'))
  for (const child of svg.children) processElement(child, svgMat)

  return { paths, needsPpiPrompt, svgWidthMM: widthMM, svgHeightMM: heightMM, groupId }
}
