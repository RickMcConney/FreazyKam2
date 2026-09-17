export type PathNode = {
  x: number
  y: number
  handleIn?: { x: number; y: number }
  handleOut?: { x: number; y: number }
}

function lerp(a: { x: number; y: number }, b: { x: number; y: number }, t: number) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

function evalCubic(
  p0: { x: number; y: number },
  c1: { x: number; y: number },
  c2: { x: number; y: number },
  p3: { x: number; y: number },
  t: number
) {
  const q0 = lerp(p0, c1, t)
  const q1 = lerp(c1, c2, t)
  const q2 = lerp(c2, p3, t)
  const r0 = lerp(q0, q1, t)
  const r1 = lerp(q1, q2, t)
  return lerp(r0, r1, t)
}

// Convert an SVG arc to one or more cubic bezier segments (SVG spec appendix F)
function arcToCubics(
  x1: number, y1: number,
  rx: number, ry: number,
  phiDeg: number,
  largeArc: boolean,
  sweep: boolean,
  x2: number, y2: number,
): Array<[number, number, number, number, number, number]> {
  if (x1 === x2 && y1 === y2) return []
  if (rx === 0 || ry === 0) return [[x2, y2, x2, y2, x2, y2]]

  const phi = (phiDeg * Math.PI) / 180
  const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi)
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2
  const x1p = cosPhi * dx + sinPhi * dy
  const y1p = -sinPhi * dx + cosPhi * dy

  rx = Math.abs(rx); ry = Math.abs(ry)
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s }

  const rx2 = rx * rx, ry2 = ry * ry, x1p2 = x1p * x1p, y1p2 = y1p * y1p
  const num = Math.max(0, rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2)
  const den = rx2 * y1p2 + ry2 * x1p2
  const k = (largeArc !== sweep ? 1 : -1) * Math.sqrt(den === 0 ? 0 : num / den)
  const cxp = (k * rx * y1p) / ry
  const cyp = (-k * ry * x1p) / rx
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2

  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy
    const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy))
    const a = Math.acos(Math.max(-1, Math.min(1, dot / len)))
    return ux * vy - uy * vx < 0 ? -a : a
  }
  const ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry
  const vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry
  let theta1 = ang(1, 0, ux, uy)
  let dTheta = ang(ux, uy, vx, vy)
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI

  const segs = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI / 2)))
  const result: Array<[number, number, number, number, number, number]> = []
  for (let i = 0; i < segs; i++) {
    const a1 = theta1 + (i * dTheta) / segs
    const a2 = theta1 + ((i + 1) * dTheta) / segs
    const alpha = (4 / 3) * Math.tan((a2 - a1) / 4)
    const cos1 = Math.cos(a1), sin1 = Math.sin(a1)
    const cos2 = Math.cos(a2), sin2 = Math.sin(a2)
    const toW = (ex: number, ey: number) => ({
      x: cosPhi * ex - sinPhi * ey + cx,
      y: sinPhi * ex + cosPhi * ey + cy,
    })
    const c1 = toW(rx * cos1 - alpha * rx * sin1, ry * sin1 + alpha * ry * cos1)
    const c2 = toW(rx * cos2 + alpha * rx * sin2, ry * sin2 - alpha * ry * cos2)
    const ep = toW(rx * cos2, ry * sin2)
    result.push([c1.x, c1.y, c2.x, c2.y, ep.x, ep.y])
  }
  return result
}

export function splitCompoundPath(d: string): string[] {
  // Uppercase commands only — the whole pipeline emits absolute uppercase d
  // strings (see CLAUDE.md Path Data Format). Matching lowercase here would
  // half-parse malformed input instead of failing visibly (bugs.md R5).
  const tokens = d.match(/[MLCSQTAZ]|[-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?/g) ?? []
  const subpaths: string[] = []
  let current: string[] = []
  for (const tok of tokens) {
    if (tok === 'M' && current.length > 0) {
      subpaths.push(current.join(' '))
      current = []
    }
    current.push(tok)
  }
  if (current.length > 0) subpaths.push(current.join(' '))
  return subpaths.filter((s) => s.trim().length > 1)
}

export function parseDToNodes(d: string): { nodes: PathNode[]; closed: boolean } {
  // Tokenize properly: split command letters from numbers (handles compact "M10,20" format).
  // Uppercase commands only — see splitCompoundPath.
  const tokens = d.match(/[MLCSQTAZ]|[-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?/g) ?? []
  const nodes: PathNode[] = []
  let closed = false
  let i = 0
  // Track last control point for S/T smooth continuation
  let lastCmd = ''
  let lastC2x = 0, lastC2y = 0  // for S: reflection of previous C's c2
  let lastQ1x = 0, lastQ1y = 0  // for T: reflection of previous Q's control point

  while (i < tokens.length) {
    const cmd = tokens[i++]
    if (cmd === 'M') {
      nodes.push({ x: parseFloat(tokens[i++]), y: parseFloat(tokens[i++]) })
    } else if (cmd === 'L') {
      nodes.push({ x: parseFloat(tokens[i++]), y: parseFloat(tokens[i++]) })
    } else if (cmd === 'C') {
      const c1x = parseFloat(tokens[i++]), c1y = parseFloat(tokens[i++])
      const c2x = parseFloat(tokens[i++]), c2y = parseFloat(tokens[i++])
      const ex = parseFloat(tokens[i++]), ey = parseFloat(tokens[i++])
      if (nodes.length > 0) nodes[nodes.length - 1].handleOut = { x: c1x, y: c1y }
      nodes.push({ x: ex, y: ey, handleIn: { x: c2x, y: c2y } })
      lastC2x = c2x; lastC2y = c2y
    } else if (cmd === 'S') {
      // Smooth cubic: c1 is reflection of previous c2 (or current point if prev wasn't C/S)
      const c2x = parseFloat(tokens[i++]), c2y = parseFloat(tokens[i++])
      const ex = parseFloat(tokens[i++]), ey = parseFloat(tokens[i++])
      const prev = nodes.length > 0 ? nodes[nodes.length - 1] : { x: 0, y: 0 }
      const c1x = (lastCmd === 'C' || lastCmd === 'S') ? 2 * prev.x - lastC2x : prev.x
      const c1y = (lastCmd === 'C' || lastCmd === 'S') ? 2 * prev.y - lastC2y : prev.y
      if (nodes.length > 0) nodes[nodes.length - 1].handleOut = { x: c1x, y: c1y }
      nodes.push({ x: ex, y: ey, handleIn: { x: c2x, y: c2y } })
      lastC2x = c2x; lastC2y = c2y
    } else if (cmd === 'Q') {
      // Quadratic bezier → cubic: c1 = p0 + 2/3*(q-p0), c2 = p + 2/3*(q-p)
      const qx = parseFloat(tokens[i++]), qy = parseFloat(tokens[i++])
      const ex = parseFloat(tokens[i++]), ey = parseFloat(tokens[i++])
      const prev = nodes.length > 0 ? nodes[nodes.length - 1] : { x: 0, y: 0 }
      const c1x = prev.x + (2 / 3) * (qx - prev.x)
      const c1y = prev.y + (2 / 3) * (qy - prev.y)
      const c2x = ex + (2 / 3) * (qx - ex)
      const c2y = ey + (2 / 3) * (qy - ey)
      if (nodes.length > 0) nodes[nodes.length - 1].handleOut = { x: c1x, y: c1y }
      nodes.push({ x: ex, y: ey, handleIn: { x: c2x, y: c2y } })
      lastQ1x = qx; lastQ1y = qy
    } else if (cmd === 'T') {
      // Smooth quadratic: control point is reflection of previous Q's control point
      const ex = parseFloat(tokens[i++]), ey = parseFloat(tokens[i++])
      const prev = nodes.length > 0 ? nodes[nodes.length - 1] : { x: 0, y: 0 }
      const qx = (lastCmd === 'Q' || lastCmd === 'T') ? 2 * prev.x - lastQ1x : prev.x
      const qy = (lastCmd === 'Q' || lastCmd === 'T') ? 2 * prev.y - lastQ1y : prev.y
      const c1x = prev.x + (2 / 3) * (qx - prev.x)
      const c1y = prev.y + (2 / 3) * (qy - prev.y)
      const c2x = ex + (2 / 3) * (qx - ex)
      const c2y = ey + (2 / 3) * (qy - ey)
      if (nodes.length > 0) nodes[nodes.length - 1].handleOut = { x: c1x, y: c1y }
      nodes.push({ x: ex, y: ey, handleIn: { x: c2x, y: c2y } })
      lastQ1x = qx; lastQ1y = qy
    } else if (cmd === 'A') {
      const rx = parseFloat(tokens[i++]), ry = parseFloat(tokens[i++])
      const xRot = parseFloat(tokens[i++])
      const largeArc = tokens[i++] === '1'
      const sweep = tokens[i++] === '1'
      const ex = parseFloat(tokens[i++]), ey = parseFloat(tokens[i++])
      if (nodes.length > 0) {
        const prev = nodes[nodes.length - 1]
        const cubics = arcToCubics(prev.x, prev.y, rx, ry, xRot, largeArc, sweep, ex, ey)
        for (const [c1x, c1y, c2x, c2y, epx, epy] of cubics) {
          nodes[nodes.length - 1].handleOut = { x: c1x, y: c1y }
          nodes.push({ x: epx, y: epy, handleIn: { x: c2x, y: c2y } })
        }
      } else {
        nodes.push({ x: ex, y: ey })
      }
    } else if (cmd === 'Z' || cmd === 'z') {
      closed = true
    }
    lastCmd = cmd
  }

  // Detect implicit close: last node coincident with first (with or without Z).
  // Font paths often return explicitly to the start instead of using Z.
  if (nodes.length >= 2) {
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    if (Math.abs(last.x - first.x) < 0.001 && Math.abs(last.y - first.y) < 0.001) {
      if (last.handleIn) first.handleIn = last.handleIn
      nodes.pop()
      closed = true
    }
  }

  return { nodes, closed }
}

// 4-decimal rounding, matching every other d producer (stringifyD, shape
// generators, importFile) — unrounded drag deltas otherwise write
// full-precision floats into d strings, history snapshots, and .fkam files.
const fmt = (n: number) => +n.toFixed(4)

export function nodesToD(nodes: PathNode[], closed: boolean): string {
  if (nodes.length === 0) return ''
  let d = `M ${fmt(nodes[0].x)} ${fmt(nodes[0].y)}`

  for (let i = 1; i < nodes.length; i++) {
    const prev = nodes[i - 1]
    const curr = nodes[i]
    if (!prev.handleOut && !curr.handleIn) {
      d += ` L ${fmt(curr.x)} ${fmt(curr.y)}`
    } else {
      d += ` C ${fmt(prev.handleOut?.x ?? prev.x)} ${fmt(prev.handleOut?.y ?? prev.y)} ${fmt(curr.handleIn?.x ?? curr.x)} ${fmt(curr.handleIn?.y ?? curr.y)} ${fmt(curr.x)} ${fmt(curr.y)}`
    }
  }

  if (closed && nodes.length >= 2) {
    const prev = nodes[nodes.length - 1]
    const curr = nodes[0]
    if (!prev.handleOut && !curr.handleIn) {
      d += ' Z'
    } else {
      d += ` C ${fmt(prev.handleOut?.x ?? prev.x)} ${fmt(prev.handleOut?.y ?? prev.y)} ${fmt(curr.handleIn?.x ?? curr.x)} ${fmt(curr.handleIn?.y ?? curr.y)} ${fmt(curr.x)} ${fmt(curr.y)} Z`
    }
  }

  return d
}

export function removeNode(nodes: PathNode[], idx: number): PathNode[] {
  return nodes.filter((_, i) => i !== idx)
}

export function toggleNodeCurvature(nodes: PathNode[], idx: number, closed: boolean): PathNode[] {
  const n = nodes.length
  if (idx < 0 || idx >= n) return nodes

  const node = nodes[idx]
  const result = [...nodes]

  if (node.handleIn || node.handleOut) {
    result[idx] = { x: node.x, y: node.y }
    return result
  }

  const prev = idx > 0 ? nodes[idx - 1] : closed ? nodes[n - 1] : null
  const next = idx < n - 1 ? nodes[idx + 1] : closed ? nodes[0] : null

  let handleIn: PathNode['handleIn']
  let handleOut: PathNode['handleOut']

  if (prev && next) {
    const dx = (next.x - prev.x) / 6
    const dy = (next.y - prev.y) / 6
    handleIn = { x: node.x - dx, y: node.y - dy }
    handleOut = { x: node.x + dx, y: node.y + dy }
  } else if (next) {
    handleOut = {
      x: node.x + (next.x - node.x) / 3,
      y: node.y + (next.y - node.y) / 3,
    }
  } else if (prev) {
    handleIn = {
      x: node.x + (prev.x - node.x) / 3,
      y: node.y + (prev.y - node.y) / 3,
    }
  }

  result[idx] = { ...node, handleIn, handleOut }
  return result
}

function splitCubicAt(
  p0: { x: number; y: number },
  c1: { x: number; y: number },
  c2: { x: number; y: number },
  p3: { x: number; y: number },
  t: number
) {
  const q0 = lerp(p0, c1, t)
  const q1 = lerp(c1, c2, t)
  const q2 = lerp(c2, p3, t)
  const r0 = lerp(q0, q1, t)
  const r1 = lerp(q1, q2, t)
  const s = lerp(r0, r1, t)
  return { mid: s, leftOut: q0, leftIn: r0, rightOut: r1, rightIn: q2 }
}

export function insertNodeOnSegment(
  nodes: PathNode[],
  segIdx: number,
  cncX: number,
  cncY: number,
  closed: boolean
): PathNode[] {
  const n = nodes.length
  const toIdx = (segIdx + 1) % n
  if (!closed && toIdx === 0) return nodes

  const from = nodes[segIdx]
  const to = nodes[toIdx]
  const p0 = { x: from.x, y: from.y }
  const p3 = { x: to.x, y: to.y }
  const c1 = from.handleOut ?? p0
  const c2 = to.handleIn ?? p3
  const hasCurve = !!(from.handleOut || to.handleIn)

  let bestT = 0.5
  let bestDistSq = Infinity
  const SAMPLES = 30
  for (let j = 0; j <= SAMPLES; j++) {
    const t = j / SAMPLES
    const pt = evalCubic(p0, c1, c2, p3, t)
    const dx = pt.x - cncX, dy = pt.y - cncY
    const dsq = dx * dx + dy * dy
    if (dsq < bestDistSq) { bestDistSq = dsq; bestT = t }
  }

  const split = splitCubicAt(p0, c1, c2, p3, bestT)
  const result = [...nodes]
  const newNode: PathNode = {
    x: split.mid.x,
    y: split.mid.y,
    handleIn: hasCurve ? split.leftIn : undefined,
    handleOut: hasCurve ? split.rightOut : undefined,
  }
  result[segIdx] = { ...from, handleOut: hasCurve ? split.leftOut : undefined }
  result[toIdx] = { ...to, handleIn: hasCurve ? split.rightIn : undefined }
  result.splice(segIdx + 1, 0, newNode)
  return result
}

function reverseNodes(nodes: PathNode[]): PathNode[] {
  return nodes.slice().reverse().map(n => ({
    x: n.x,
    y: n.y,
    handleIn: n.handleOut ? { ...n.handleOut } : undefined,
    handleOut: n.handleIn ? { ...n.handleIn } : undefined,
  }))
}

// Connect an open path's endpoint to one of its own interior nodes without merging.
// Slices into a closed loop (src→…→tgt) and an open remainder (tgt→…→other_end).
// The target node is duplicated so both pieces are valid; no nodes are deleted.
export function connectEndpointToInterior(
  nodes: PathNode[],
  srcIdx: number,  // must be 0 or nodes.length-1
  tgtIdx: number,  // must be interior (not 0 or last)
): { loopNodes: PathNode[]; remainNodes: PathNode[] } | null {
  const n = nodes.length
  if (srcIdx !== 0 && srcIdx !== n - 1) return null
  if (tgtIdx <= 0 || tgtIdx >= n - 1) return null

  if (srcIdx === 0) {
    // Loop: [src, …, tgt] closed.  Clear tgt.handleOut — it pointed to B0 (remain side).
    const loop = nodes.slice(0, tgtIdx + 1).map((nd, i, arr) =>
      i === arr.length - 1 ? { ...nd, handleOut: undefined } : nd
    )
    // Remain: [tgt_dup, …, last].  Clear tgt.handleIn — it pointed inward from A side.
    const remain = [{ ...nodes[tgtIdx], handleIn: undefined }, ...nodes.slice(tgtIdx + 1)]
    return { loopNodes: loop, remainNodes: remain }
  } else {
    // Loop: [tgt, …, src] closed.  Clear tgt.handleIn — it pointed to A2 (remain side).
    const loop = nodes.slice(tgtIdx).map((nd, i) =>
      i === 0 ? { ...nd, handleIn: undefined } : nd
    )
    // Remain: [first, …, tgt_dup].  Clear tgt.handleOut — it pointed inward to B side.
    const remain = [...nodes.slice(0, tgtIdx), { ...nodes[tgtIdx], handleOut: undefined }]
    return { loopNodes: loop, remainNodes: remain }
  }
}

// Join paths by concatenation — both junction nodes keep their original positions.
// Use this for connect-click mode where nodes are at different positions.
// (joinPaths merges the two junction nodes into one; use that for drag-weld instead.)
export function joinPathsConnect(
  nodesA: PathNode[], srcIdx: number,
  nodesB: PathNode[], tgtIdx: number, closedB: boolean,
): PathNode[] | null {
  if (nodesA.length < 2 || nodesB.length < 2) return null
  if (srcIdx !== 0 && srcIdx !== nodesA.length - 1) return null
  if (!closedB && tgtIdx !== 0 && tgtIdx !== nodesB.length - 1) return null

  const A = srcIdx === 0 ? reverseNodes(nodesA) : nodesA

  let B: PathNode[]
  if (closedB) {
    const reordered = [...nodesB.slice(tgtIdx), ...nodesB.slice(0, tgtIdx)]
    const tail: PathNode = { x: reordered[0].x, y: reordered[0].y, handleIn: reordered[0].handleIn, handleOut: undefined }
    B = [...reordered, tail]
  } else {
    B = tgtIdx === nodesB.length - 1 ? reverseNodes(nodesB) : nodesB
  }

  // Simple concatenation — no merging, A's endpoint and B's target both stay at their positions
  return [...A, ...B]
}

// Join an open path A (at endpoint srcIdx) to path B (at any node tgtIdx).
// For open B, tgtIdx must be 0 or B.length-1.
// For closed B, tgtIdx may be any index — the closed path is opened at that node.
export function joinPaths(
  nodesA: PathNode[], srcIdx: number, closedA: boolean,
  nodesB: PathNode[], tgtIdx: number, closedB: boolean,
): PathNode[] | null {
  if (closedA) return null
  if (nodesA.length < 2 || nodesB.length < 2) return null
  if (srcIdx !== 0 && srcIdx !== nodesA.length - 1) return null
  if (!closedB && tgtIdx !== 0 && tgtIdx !== nodesB.length - 1) return null

  // Normalize A: src should be the last node
  const A = srcIdx === 0 ? reverseNodes(nodesA) : nodesA

  let B: PathNode[]
  if (closedB) {
    // Reorder B so the target node is first, then append a copy of it at the end.
    // This preserves every segment of the closed path — the closing segment (last→first)
    // becomes the last segment of the combined open path. The user can then trim whichever
    // seam segment they don't want rather than having one silently deleted here.
    const reordered = [...nodesB.slice(tgtIdx), ...nodesB.slice(0, tgtIdx)]
    const tail: PathNode = { x: reordered[0].x, y: reordered[0].y, handleIn: reordered[0].handleIn, handleOut: undefined }
    B = [...reordered, tail]
  } else {
    B = tgtIdx === nodesB.length - 1 ? reverseNodes(nodesB) : nodesB
  }

  const aLast = A[A.length - 1]
  const bFirst = B[0]
  const merged: PathNode = {
    x: bFirst.x,
    y: bFirst.y,
    handleIn: aLast.handleIn,
    handleOut: bFirst.handleOut,
  }
  return [...A.slice(0, -1), merged, ...B.slice(1)]
}

// Weld an open path's endpoint to one of its own interior (non-endpoint) nodes.
// Creates a closed loop from the endpoint through the midpoint, and leaves the
// remainder as a separate open path. Returns null for degenerate cases.
export function endpointToMidpointWeld(
  nodes: PathNode[],
  srcIdx: number, // must be 0 or nodes.length-1
  tgtIdx: number, // must not be 0 or nodes.length-1
): { loopNodes: PathNode[]; remainNodes: PathNode[] } | null {
  const n = nodes.length
  if (srcIdx !== 0 && srcIdx !== n - 1) return null
  if (tgtIdx === 0 || tgtIdx === n - 1) return null

  const src = nodes[srcIdx]
  const tgt = nodes[tgtIdx]

  if (srcIdx === 0) {
    // Front loop: [merged, n1 .. n[tgtIdx-1]] closed
    // The loop covers the n0→…→n[tgtIdx] round-trip
    if (tgtIdx < 2) return null // loop would have < 2 nodes
    const loopFirst: PathNode = {
      x: tgt.x, y: tgt.y,
      handleIn: tgt.handleIn,  // controls the closing segment (n[tgtIdx-1]→merged) end
      handleOut: src.handleOut, // controls the first segment (merged→n1) start
    }
    const loopNodes = [loopFirst, ...nodes.slice(1, tgtIdx)]
    // Remainder: n[tgtIdx] onward, tgt.handleIn cleared (now a new open start)
    const remainNodes = [{ ...tgt, handleIn: undefined }, ...nodes.slice(tgtIdx + 1)]
    return { loopNodes, remainNodes }
  } else {
    // Back loop: [merged, n[tgtIdx+1] .. n[n-2]] closed
    if (n - 1 - tgtIdx < 2) return null // loop would have < 2 nodes
    const loopFirst: PathNode = {
      x: tgt.x, y: tgt.y,
      handleIn: src.handleIn,   // controls the closing segment (n[n-2]→merged) end
      handleOut: tgt.handleOut, // controls the first segment (merged→n[tgtIdx+1]) start
    }
    const loopNodes = [loopFirst, ...nodes.slice(tgtIdx + 1, n - 1)]
    // Remainder: up to n[tgtIdx], tgt.handleOut cleared (now a new open end)
    const remainNodes = [...nodes.slice(0, tgtIdx), { ...tgt, handleOut: undefined }]
    return { loopNodes, remainNodes }
  }
}

export function weldNodes(
  nodes: PathNode[],
  srcIdx: number,
  tgtIdx: number,
  closed: boolean,
): { nodes: PathNode[]; closed: boolean } {
  const src = nodes[srcIdx]
  const tgt = nodes[tgtIdx]
  const n = nodes.length

  // Merged node at tgt's position; src's handleIn becomes the incoming handle,
  // tgt's handleOut becomes the outgoing handle (handles for the deleted segment are dropped).
  const merged: PathNode = {
    x: tgt.x,
    y: tgt.y,
    handleIn: src.handleIn ?? tgt.handleIn,
    handleOut: tgt.handleOut ?? src.handleOut,
  }

  let newNodes = nodes.map((node, i) => {
    if (i === tgtIdx) return merged
    return node
  }).filter((_, i) => i !== srcIdx)

  // Close the path when welding the two endpoints of an open path
  const isEndpointWeld =
    !closed &&
    ((srcIdx === 0 && tgtIdx === n - 1) || (srcIdx === n - 1 && tgtIdx === 0))
  const resultClosed = isEndpointWeld || closed

  // When an endpoint is removed and the result is still open, the node that becomes
  // the new first/last endpoint inherits a phantom handle from the deleted segment.
  // Clear it so it doesn't render a dangling handle arm.
  if (!resultClosed && !closed) {
    if (srcIdx === 0 && newNodes.length > 0) {
      newNodes[0] = { ...newNodes[0], handleIn: undefined }
    } else if (srcIdx === n - 1 && newNodes.length > 0) {
      newNodes[newNodes.length - 1] = { ...newNodes[newNodes.length - 1], handleOut: undefined }
    }
  }

  return { nodes: newNodes, closed: resultClosed }
}

export function deleteSegment(
  nodes: PathNode[],
  segIdx: number,
  closed: boolean,
): { nodes: PathNode[]; closed: boolean; secondPath: PathNode[] | null } {
  const n = nodes.length
  const toIdx = (segIdx + 1) % n

  // Clear the handles that were part of the deleted segment
  const updated = nodes.map((node, i) => {
    if (i === segIdx) return { ...node, handleOut: undefined }
    if (i === toIdx) return { ...node, handleIn: undefined }
    return node
  })

  if (closed) {
    // Open the path: reorder so the new start is nodes[toIdx]
    const reordered = [...updated.slice(toIdx), ...updated.slice(0, toIdx)]
    return { nodes: reordered, closed: false, secondPath: null }
  }

  // Open path: split into two subpaths at the deleted segment
  const first = updated.slice(0, segIdx + 1)
  const second = updated.slice(toIdx)
  const firstValid = first.length >= 2
  const secondValid = second.length >= 2
  if (!firstValid && secondValid) {
    return { nodes: second, closed: false, secondPath: null }
  }
  return {
    nodes: firstValid ? first : [],
    closed: false,
    secondPath: secondValid ? second : null,
  }
}

export function segmentMidpoint(
  nodes: PathNode[],
  segIdx: number,
): { x: number; y: number } {
  const toIdx = (segIdx + 1) % nodes.length
  const from = nodes[segIdx]
  const to = nodes[toIdx]
  return evalCubic(
    { x: from.x, y: from.y },
    from.handleOut ?? { x: from.x, y: from.y },
    to.handleIn ?? { x: to.x, y: to.y },
    { x: to.x, y: to.y },
    0.5,
  )
}

export function nearestPointOnSegment(
  nodes: PathNode[],
  segIdx: number,
  cx: number,
  cy: number,
): { x: number; y: number; distSq: number } {
  const toIdx = (segIdx + 1) % nodes.length
  const from = nodes[segIdx]
  const to = nodes[toIdx]
  const p0 = { x: from.x, y: from.y }
  const p3 = { x: to.x, y: to.y }
  const c1 = from.handleOut ?? p0
  const c2 = to.handleIn ?? p3

  let best = p0
  let bestDistSq = Infinity
  const SAMPLES = 40
  for (let j = 0; j <= SAMPLES; j++) {
    const pt = evalCubic(p0, c1, c2, p3, j / SAMPLES)
    const dx = pt.x - cx, dy = pt.y - cy
    const dsq = dx * dx + dy * dy
    if (dsq < bestDistSq) { bestDistSq = dsq; best = pt }
  }
  return { x: best.x, y: best.y, distSq: bestDistSq }
}

export function nearestSegmentOnPath(
  nodes: PathNode[],
  closed: boolean,
  cx: number,
  cy: number
): { segIdx: number; distSq: number } | null {
  const segCount = closed ? nodes.length : nodes.length - 1
  if (segCount <= 0) return null

  let bestSeg = 0, bestDistSq = Infinity
  const SAMPLES = 20

  for (let i = 0; i < segCount; i++) {
    const from = nodes[i]
    const to = nodes[(i + 1) % nodes.length]
    const p0 = { x: from.x, y: from.y }
    const p3 = { x: to.x, y: to.y }
    const c1 = from.handleOut ?? p0
    const c2 = to.handleIn ?? p3

    for (let j = 0; j <= SAMPLES; j++) {
      const t = j / SAMPLES
      const pt = evalCubic(p0, c1, c2, p3, t)
      const dx = pt.x - cx, dy = pt.y - cy
      const dsq = dx * dx + dy * dy
      if (dsq < bestDistSq) { bestDistSq = dsq; bestSeg = i }
    }
  }

  return { segIdx: bestSeg, distSq: bestDistSq }
}
