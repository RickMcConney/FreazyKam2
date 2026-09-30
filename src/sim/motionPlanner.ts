// ─── Motion planner: the speed the machine actually reaches ─────────────────────
//
// The programmed feed is a CEILING. A Grbl-family controller (Grbl, FluidNC, grblHAL)
// never reaches it on a move too short to accelerate over, and brakes nearly to a stop
// for a sharp corner — so on a small, corner-heavy part the machine spends most of the
// job well below the F word. Chip load is feed ÷ (rpm × flutes) at the speed the tool is
// REALLY moving, and a spindle does not slow down for corners: that is where a plastic
// part melts while every programmed number reads fine.
//
// This reproduces the controller's planner closely enough to time a job and to judge the
// chip it cuts. It is the standard Grbl scheme:
//   • each block's nominal speed is its feed, capped by every axis's max rate along it;
//   • its acceleration is the tightest axis limit along its direction;
//   • a JUNCTION between two blocks may be taken no faster than junction deviation
//     allows: v² = a·δ·sin(θ/2) / (1 − sin(θ/2)), θ the angle between them (a straight
//     run is unlimited, a reversal stops);
//   • a backward pass brakes in time for every junction and for the end of the look-ahead
//     buffer, a forward pass limits how fast each block can speed up, and each block then
//     runs a trapezoid: accelerate, cruise, decelerate.
//
// ARCS are the one place the simulator's own geometry would mislead. The controller cuts
// a G2/G3 as chords of `arc_tolerance` sagitta (0.002 mm by default), so the angle between
// two of its chords — which is what sets the speed round the arc — comes from THAT
// tolerance, not from however finely the simulator happened to chord the same arc for
// drawing. So a junction inside an arc is priced at the controller's chord angle. (It
// comes out far more generous than the √(a·r) centripetal limit one might expect: Grbl
// has no centripetal check, only the junction rule.)

export interface MotionLimits {
  accelXYMmS2: number      // X and Y acceleration, mm/s²
  accelZMmS2: number       // Z acceleration, mm/s²
  maxRateXYMmMin: number   // X/Y max rate — rapids run at it; 0 = unknown
  maxRateZMmMin: number    // Z max rate, mm/min; 0 = unknown
  junctionDeviationMM: number
}

// Controller defaults for the two settings a user almost never changes (FluidNC and Grbl
// both ship with these).
export const ARC_TOLERANCE_MM = 0.002
export const PLANNER_BLOCKS = 32

// Rapid rate when the machine's max rate is not known.
export const FALLBACK_RAPID_MM_MIN = 5000

/** Per-segment input the planner needs beyond the geometry. */
export interface PlanBlock {
  dx: number; dy: number; dz: number
  feedMmMin: number        // programmed feed; ignored for a rapid
  rapid: boolean
  arcRadiusMM: number      // > 0 when this segment is a chord of a G2/G3
  arcId: number            // chords of one G2/G3 share it; -1 for a straight move
  stopBefore: boolean      // the controller syncs to a stop before this move (M3/M5/S/M0/M6/G4…)
}

/** A block's speed profile: entry, cruise and exit speed (mm/s) at acceleration `acc`. */
export interface Trapezoid {
  v0: number
  vc: number
  v1: number
  acc: number
  durationS: number
}

const EPS = 1e-9

/** Lowest acceleration (or max rate) along unit direction `u` given per-axis limits. */
function alongDir(ux: number, uy: number, uz: number, xy: number, z: number): number {
  let lim = Infinity
  if (Math.abs(ux) > EPS) lim = Math.min(lim, xy / Math.abs(ux))
  if (Math.abs(uy) > EPS) lim = Math.min(lim, xy / Math.abs(uy))
  if (Math.abs(uz) > EPS) lim = Math.min(lim, z / Math.abs(uz))
  return lim
}

/**
 * Plan a program. Returns one trapezoid per block, in order. With acceleration switched
 * off (either accel ≤ 0) every block runs at its nominal speed throughout — exactly the
 * old constant-feed timing.
 */
export function planMotion(blocks: PlanBlock[], lim: MotionLimits): Trapezoid[] {
  const n = blocks.length
  const out: Trapezoid[] = new Array(n)
  const accelOn = lim.accelXYMmS2 > 0 && lim.accelZMmS2 > 0
  const rateXY = lim.maxRateXYMmMin > 0 ? lim.maxRateXYMmMin / 60 : Infinity
  const rateZ = lim.maxRateZMmMin > 0 ? lim.maxRateZMmMin / 60 : Infinity
  const rapidXY = lim.maxRateXYMmMin > 0 ? lim.maxRateXYMmMin / 60 : FALLBACK_RAPID_MM_MIN / 60

  const len = new Float64Array(n)
  const ux = new Float64Array(n), uy = new Float64Array(n), uz = new Float64Array(n)
  const vNom = new Float64Array(n)
  const acc = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const b = blocks[i]
    const L = Math.hypot(b.dx, b.dy, b.dz)
    len[i] = L
    const k = L > EPS ? 1 / L : 0
    ux[i] = b.dx * k; uy[i] = b.dy * k; uz[i] = b.dz * k
    // A rapid asks for everything; the axis limits below then decide.
    const asked = b.rapid ? Infinity : Math.max(b.feedMmMin, 1) / 60
    const cap = b.rapid
      ? alongDir(ux[i], uy[i], uz[i], rapidXY, rateZ === Infinity ? rapidXY : rateZ)
      : alongDir(ux[i], uy[i], uz[i], rateXY, rateZ)
    vNom[i] = Math.min(asked, cap)
    if (!Number.isFinite(vNom[i])) vNom[i] = FALLBACK_RAPID_MM_MIN / 60
    acc[i] = accelOn ? alongDir(ux[i], uy[i], uz[i], lim.accelXYMmS2, lim.accelZMmS2) : Infinity
  }

  if (!accelOn) {
    for (let i = 0; i < n; i++) {
      const v = vNom[i]
      out[i] = { v0: v, vc: v, v1: v, acc: Infinity, durationS: len[i] / v }
    }
    return out
  }

  // ── Junction limits: the fastest block i may be ENTERED, squared. ──
  const jd = Math.max(0, lim.junctionDeviationMM)
  const maxEntrySq = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const b = blocks[i]
    if (i === 0 || b.stopBefore) { maxEntrySq[i] = 0; continue }
    const nomSq = Math.min(vNom[i - 1], vNom[i]) ** 2
    const prev = blocks[i - 1]
    let vjSq: number
    if (b.arcId >= 0 && prev.arcId === b.arcId) {
      // Inside one arc: the controller's chord angle, not ours. Its junction vector points
      // at the centre, which lies in XY, so the XY acceleration applies.
      const r = b.arcRadiusMM
      const half = Math.sqrt(Math.max(0, ARC_TOLERANCE_MM * (2 * r - ARC_TOLERANCE_MM)))
      const segAngle = r > ARC_TOLERANCE_MM ? 2 * Math.asin(Math.min(1, half / r)) : Math.PI
      const c = Math.cos(segAngle / 2)   // sin(θ/2) with θ = π − segAngle
      vjSq = c >= 1 - EPS ? Infinity : (lim.accelXYMmS2 * jd * c) / (1 - c)
    } else {
      // Grbl's cos θ is taken against the REVERSED previous direction: −1 is straight on.
      const cosT = -(ux[i - 1] * ux[i] + uy[i - 1] * uy[i] + uz[i - 1] * uz[i])
      if (cosT > 0.999999) vjSq = 0                   // reversal: stop
      else if (cosT < -0.999999) vjSq = Infinity      // straight on: no limit
      else {
        let jx = ux[i] - ux[i - 1], jy = uy[i] - uy[i - 1], jz = uz[i] - uz[i - 1]
        const jl = Math.hypot(jx, jy, jz)
        jx /= jl; jy /= jl; jz /= jl
        const aj = alongDir(jx, jy, jz, lim.accelXYMmS2, lim.accelZMmS2)
        const s = Math.sqrt(0.5 * (1 - cosT))
        vjSq = (aj * jd * s) / (1 - s)
      }
    }
    maxEntrySq[i] = Math.min(vjSq, nomSq)
  }

  // ── Look-ahead: the controller only plans PLANNER_BLOCKS ahead and assumes the machine
  // stops at the end of what it can see. The simulator chords an arc far more coarsely
  // than the controller (which uses ARC_TOLERANCE_MM), so a chord here stands for several
  // controller blocks; weigh it by how many, or the window would reach too far. ──
  const weight = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const r = blocks[i].arcRadiusMM
    if (blocks[i].arcId >= 0 && r > ARC_TOLERANCE_MM) {
      const ctrlChord = 2 * Math.sqrt(ARC_TOLERANCE_MM * (2 * r - ARC_TOLERANCE_MM))
      weight[i] = Math.max(1, len[i] / ctrlChord)
    } else weight[i] = 1
  }
  // windowLen[i]: distance covered by the next PLANNER_BLOCKS controller blocks from i.
  const windowLen = new Float64Array(n)
  {
    let j = 0, wSum = 0, lSum = 0
    for (let i = 0; i < n; i++) {
      if (j < i) { j = i; wSum = 0; lSum = 0 }
      while (j < n && wSum + weight[j] <= PLANNER_BLOCKS) { wSum += weight[j]; lSum += len[j]; j++ }
      // A block alone heavier than the window still counts in part.
      windowLen[i] = j > i ? lSum : len[i] * (PLANNER_BLOCKS / weight[i])
      if (j > i) { wSum -= weight[i]; lSum -= len[i] }
    }
  }

  // ── Backward pass: brake in time for every junction ahead, and for the buffer's end. ──
  const entrySq = new Float64Array(n + 1)
  entrySq[n] = 0
  for (let i = n - 1; i >= 0; i--) {
    const fromExit = entrySq[i + 1] + 2 * acc[i] * len[i]
    const fromWindow = 2 * acc[i] * windowLen[i]
    entrySq[i] = Math.min(maxEntrySq[i], fromExit, fromWindow)
  }
  // ── Forward pass: no block can speed up faster than its acceleration allows. ──
  entrySq[0] = 0
  for (let i = 0; i < n; i++) {
    const reach = entrySq[i] + 2 * acc[i] * len[i]
    if (entrySq[i + 1] > reach) entrySq[i + 1] = reach
  }

  for (let i = 0; i < n; i++) {
    out[i] = trapezoid(len[i], Math.sqrt(entrySq[i]), Math.sqrt(entrySq[i + 1]), vNom[i], acc[i])
  }
  return out
}

/** The accelerate / cruise / decelerate profile of one block. */
export function trapezoid(L: number, v0: number, v1: number, vNom: number, a: number): Trapezoid {
  if (!(a > 0) || !Number.isFinite(a)) {
    return { v0: vNom, vc: vNom, v1: vNom, acc: Infinity, durationS: L / vNom }
  }
  const peakSq = (2 * a * L + v0 * v0 + v1 * v1) / 2
  const vc = Math.max(Math.min(vNom, Math.sqrt(Math.max(0, peakSq))), v0, v1, EPS)
  const dAcc = (vc * vc - v0 * v0) / (2 * a)
  const dDec = (vc * vc - v1 * v1) / (2 * a)
  const dCruise = Math.max(0, L - dAcc - dDec)
  const durationS = (vc - v0) / a + dCruise / vc + (vc - v1) / a
  return { v0, vc, v1, acc: a, durationS }
}

/** Distance along a block after `t` seconds of it, and the speed there. */
export function trapezoidAt(tr: Trapezoid, L: number, t: number): { dist: number; speed: number } {
  if (!Number.isFinite(tr.acc)) return { dist: Math.min(L, tr.vc * t), speed: tr.vc }
  const a = tr.acc
  const tAcc = (tr.vc - tr.v0) / a
  const dAcc = (tr.vc * tr.vc - tr.v0 * tr.v0) / (2 * a)
  const dDec = (tr.vc * tr.vc - tr.v1 * tr.v1) / (2 * a)
  const dCruise = Math.max(0, L - dAcc - dDec)
  const tCruise = dCruise / tr.vc
  if (t <= tAcc) return { dist: tr.v0 * t + 0.5 * a * t * t, speed: tr.v0 + a * t }
  if (t <= tAcc + tCruise) return { dist: dAcc + tr.vc * (t - tAcc), speed: tr.vc }
  const td = Math.min(t - tAcc - tCruise, (tr.vc - tr.v1) / a)
  return {
    dist: Math.min(L, dAcc + dCruise + tr.vc * td - 0.5 * a * td * td),
    speed: Math.max(tr.v1, tr.vc - a * td),
  }
}

/** How much of a block's length is travelled slower than `v` (mm/s). */
export function lengthBelowSpeed(tr: Trapezoid, L: number, v: number): number {
  if (!Number.isFinite(tr.acc)) return tr.vc < v ? L : 0
  if (tr.vc <= v) return L
  const a = tr.acc
  const accPart = tr.v0 < v ? (v * v - tr.v0 * tr.v0) / (2 * a) : 0
  const decPart = tr.v1 < v ? (v * v - tr.v1 * tr.v1) / (2 * a) : 0
  return Math.min(L, accPart + decPart)
}
