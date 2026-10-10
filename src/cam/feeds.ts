import type { Tool, ToolType } from '../store/toolStore'
import { maxCutRadiusMM, feedDiameterMM } from './geom'
import { useWorkpieceStore, MATERIAL_INFO, type Material, type MaterialKind } from '../store/workpieceStore'
import { clamp } from '../util/num'

// ─── Centralized feed, spindle & step-down calculation ─────────────────────────
//
// Derives a cutting feed, plunge feed, spindle speed, and step-down from the
// material, the tool geometry, the machine rigidity, and a hard max-feed ceiling.
//
// Chip load (feed per tooth) = feed / (rpm * flutes) and does NOT depend on the
// axial depth of cut. It is the number that decides whether the edge CUTS or RUBS:
// too thin a chip and the edge skates, the heat stays in the cut, wood burns and
// plastic melts. So the chip is chosen first, from the material, and everything
// else bends around it:
//   • a light machine is protected by a lower FEED — reached by slowing the
//     spindle, which keeps the chip — and by a shallower step-down;
//   • the chip itself is trimmed for rigidity only as far as the material allows
//     (MIN_CHIP_FRACTION), which for a plastic is hardly at all.
// Step-down is chosen from machine rigidity + material hardness (bounded by tool
// diameter) and snapped to a whole division of the operation's intended total
// depth.
//
// All heuristic constants live here so they're easy to tune. The model produces
// sane starting numbers, not shop-certified values.

// The chip a tool type takes relative to a square end mill of the same diameter.
const REFERENCE_DIAMETER_MM = 6
const CHIP_LOAD_FACTOR: Record<ToolType, number> = {
  endmill: 1,
  ballnose: 0.8,
  // Between the two it generalises: a flat-bottomed cutter whose corners are rounded.
  bullnose: 0.9,
  // The knife edge of a V-bit is the most fragile cutter here.
  vbit: 0.6,
  // A taper is a small, well-supported cutter whose flute is backed by the cone — it
  // takes a lighter chip than a straight end mill of its mean diameter but is not as
  // fragile as the knife edge of a V-bit.
  taper: 0.7,
  drill: 1,
}

// Bits at or above this diameter may step down a full diameter; smaller bits are
// limited to half their diameter (they're far more fragile).
const SMALL_BIT_THRESHOLD_MM = 3.175 // 1/8"

// How far below the intrinsic chip each machine rigidity would like to run — a
// lighter chip is a lighter cutting force on a flexible gantry. Indexed by
// rigidity 1..5. Never applied past the material's floor (MIN_CHIP_FRACTION).
const RIGIDITY_CHIP_FACTOR = [0.6, 0.7, 0.8, 0.95, 1.05]
export function rigidityChipFactor(rigidity: number): number {
  return RIGIDITY_CHIP_FACTOR[clamp(Math.round(rigidity), 1, 5) - 1]
}

// The thinnest chip, as a fraction of the intrinsic one, a material tolerates
// before the edge rubs. Plastics melt and weld back into the slot, so they barely
// give any of their chip up; a metal work-hardens and builds up an edge; a wood
// just burns a little. This floor — not the rigidity factor — is what the old
// hardness-only model lacked: it thinned a 3 mm single-flute bit in Delrin to
// 0.01 mm/tooth at 19,000 rpm, and the Delrin melted.
const MIN_CHIP_FRACTION: Record<MaterialKind, number> = {
  wood: 0.5,
  plastic: 0.85,
  metal: 0.7,
}

// The fastest a machine of each rigidity should cut at, mm/min — a soft ceiling on
// the feed, below the machine's own hard `maxFeedMmMin`. When it binds, the SPINDLE
// slows so the chip is kept. Indexed by rigidity 1..5.
const RIGIDITY_FEED_CEILING_MM_MIN = [1200, 1800, 3000, 5000, 8000]
export function rigidityFeedCeilingMmMin(rigidity: number): number {
  return RIGIDITY_FEED_CEILING_MM_MIN[clamp(Math.round(rigidity), 1, 5) - 1]
}

// Axial depth-of-cut aggressiveness by machine rigidity (before the material and
// diameter caps). R1–R3 take shallower passes than the old linear ramp so light
// machines aren't handed near-full-diameter step-downs. Indexed by rigidity 1..5.
const RIGIDITY_DEPTH_FACTOR = [0.3, 0.45, 0.6, 0.85, 1.0]

// How a bit's chip scales with its size, relative to REFERENCE_DIAMETER_MM. In proportion
// to the diameter from 1/8" up (capped at 2×), and FASTER than that below it: a small bit
// is weaker for its size, so its chip falls as Ø^1.5. Maker charts show it — IDC's 1/16"
// takes a third of their 1/8"'s chip, not half. This used to be floored at 0.3× instead,
// so every bit under 1.8 mm was fed as a 1.8 mm bit: a 1/32" downcut in maple at 1159
// mm/min where its maker says 254 — a broken bit.
const SMALL_BIT_KNEE_MM = 3.175
const SMALL_BIT_EXPONENT = 1.5
export function chipDiameterScale(diameterMM: number): number {
  if (diameterMM >= SMALL_BIT_KNEE_MM) return Math.min(diameterMM / REFERENCE_DIAMETER_MM, 2)
  const d = Math.max(0, diameterMM)
  return (SMALL_BIT_KNEE_MM / REFERENCE_DIAMETER_MM) * Math.pow(d / SMALL_BIT_KNEE_MM, SMALL_BIT_EXPONENT)
}

// THE CHIP-LOAD CEILING is the tool's RATED chip load (`Tool.chipLoadMM`) — the maker's
// recommendation, fixed, never derived from the feed and rpm it is there to judge. The
// reference everything judges by is the LOWER of it and the material-and-size model:
// Auto Feeds aims there, and with Auto Feeds off the chip gauge and the export check
// warn when the user's own feed and rpm run the bit too hot or too cold against it.
// A published chip load is a recommendation rather than a hard limit, but a bit fed too
// slowly shows as rubbing on the gauge while one fed too hard breaks — so it is read as a
// ceiling. None for a drill (its chip is not a side-cutting one) or an unrated tool.
export function toolChipCeilingMM(tool: Tool): number | undefined {
  if (tool.type === 'drill') return undefined
  return tool.chipLoadMM !== undefined && tool.chipLoadMM > 0 ? tool.chipLoadMM : undefined
}

// Intrinsic recommended chip load (mm per tooth) for a tool in a given material —
// a property of the tool type + diameter + material only (this is what manufacturer
// chip-load charts give). Machine rigidity does NOT enter here. `ceilingMM` is the
// tool's own chip-load ceiling (`toolChipCeilingMM`): the chip never goes above it,
// whatever the material would take. Everything else — the rigidity-trimmed aim, the
// rubbing floor — is derived from this, so the ceiling reaches all of them.
export function targetChipLoad(toolType: ToolType, diameterMM: number, material: Material, ceilingMM?: number): number {
  const fz = MATERIAL_INFO[material].chipLoadMM * (CHIP_LOAD_FACTOR[toolType] ?? 1) * chipDiameterScale(diameterMM)
  return ceilingMM !== undefined && ceilingMM > 0 ? Math.min(fz, ceilingMM) : fz
}

// The chip auto feeds actually aims for on this machine: the intrinsic chip trimmed
// for rigidity, but never below the material's floor. Shared by the feed calc, the
// simulator's gauge and the export preflight, so all three judge against one aim.
export function aimChipLoad(toolType: ToolType, diameterMM: number, material: Material, rigidity: number, ceilingMM?: number): number {
  const aim = Math.max(
    targetChipLoad(toolType, diameterMM, material, ceilingMM) * rigidityChipFactor(rigidity),
    minChipLoad(toolType, diameterMM, material, ceilingMM),
  )
  // A stiff machine's rigidity factor runs ABOVE 1; it still may not take the bit past
  // the tool's own ceiling.
  return ceilingMM !== undefined && ceilingMM > 0 ? Math.min(aim, ceilingMM) : aim
}

// The thinnest chip this tool should ever run in this material before it rubs.
export function minChipLoad(toolType: ToolType, diameterMM: number, material: Material, ceilingMM?: number): number {
  return targetChipLoad(toolType, diameterMM, material, ceilingMM) * MIN_CHIP_FRACTION[MATERIAL_INFO[material].kind]
}

// The simulator and the export preflight call a chip under 0.75× the aim "rubbing".
// Auto feeds never thins below 0.8× the aim, so its own output never trips them.
const RUBBING_MARGIN = 0.8

interface FeedCalcInput {
  tool: Tool
  material: Material
  rigidity: number       // 1..5
  maxFeedMmMin: number
  minSpindleRpm: number  // machine's lowest usable spindle speed (clamp floor)
  maxSpindleRpm: number  // machine's top spindle speed — auto may raise rpm up to this
  userStepDownMM: number
  totalDepthMM: number   // operation's intended total depth — for whole-division of step-down
  enabled: boolean
  // Radial engagement as a fraction of tool diameter (WOC / D). 1 = full-width slotting
  // (a plain profile/contour cut), low values = HSM/trochoidal. Low engagement lets the
  // axial step-down go much deeper (toward the flute length) for the same tool load.
  // Omitted/undefined ⇒ treated as 1, so non-trochoidal operations are unaffected.
  radialEngagementFraction?: number
}

interface FeedCalcResult {
  xyFeedMmMin: number
  plungeMmMin: number
  stepDownMM: number
  rpm: number
  rpmAdjusted: boolean   // true when auto chose an rpm different from the tool's stored setting
  spindleTooFast: boolean // true when the machine's min rpm exceeds the material's safe Vc ceiling
}

// Same floor `geom.zPasses` applies to its own step.
const MIN_STEP_DOWN_MM = 0.01

function computeFeeds(input: FeedCalcInput): FeedCalcResult {
  const { tool, material, rigidity, maxFeedMmMin, minSpindleRpm, maxSpindleRpm, userStepDownMM, totalDepthMM, enabled, radialEngagementFraction } = input
  const maxFeed = maxFeedMmMin > 0 ? maxFeedMmMin : Infinity

  // When auto-feed is off we keep the tool's own feeds/speed and the user's
  // step-down, but the machine's max feed is a hard limit that is always honored.
  if (!enabled) {
    return {
      xyFeedMmMin: Math.min(tool.xyFeedMmMin, maxFeed),
      plungeMmMin: Math.min(tool.zFeedMmMin, maxFeed),
      // The user's value, but never one no pass can take. `geom.zPasses` has always
      // floored its step, but inlay and profile3d step themselves, and a 0 (a hand-edited
      // file, stale form defaults) looped them forever — a worker growing an array of
      // -0 passes until it ran out of memory. Every generator's step-down comes through
      // here, so the floor goes here once.
      stepDownMM: Number.isFinite(userStepDownMM) ? Math.max(MIN_STEP_DOWN_MM, Math.abs(userStepDownMM)) : MIN_STEP_DOWN_MM,
      rpm: tool.rpm,
      rpmAdjusted: false,
      spindleTooFast: false,
    }
  }

  const R = clamp(rigidity, 1, 5)
  const info = MATERIAL_INFO[material]
  const hardness = info.hardness > 0 ? info.hardness : 1
  const flutes = tool.fluteCount > 0 ? tool.fluteCount : 1

  // The chip comes first: the material's own, trimmed for rigidity no further than
  // the material tolerates.
  const ceiling = toolChipCeilingMM(tool)
  const fzAim = aimChipLoad(tool.type, feedDiameterMM(tool), material, R, ceiling)

  // Spindle speed is a computed output, not taken from the tool: pick the rpm that
  // lets the feed reach the target feed at the aimed chip, bounded by the machine's
  // spindle range. The target is the machine's hard max feed, lowered to what this
  // rigidity should cut at — so a light machine gets a slower SPINDLE and the same
  // chip, not a thinner chip at full rpm.
  const denom = fzAim * flutes
  const loRpm = minSpindleRpm > 0 ? minSpindleRpm : 1
  let hiRpm = Math.max(maxSpindleRpm, loRpm)
  const targetFeed = Math.min(maxFeed, rigidityFeedCeilingMmMin(R))

  // A surface-speed (Vc) ceiling keeps the edge from overheating at the high RPMs
  // wood prefers: rpm = Vc / (π·d). This tightens the top of the rpm range (never
  // below the machine's own floor). If even the machine's minimum rpm spins faster
  // than the safe Vc — common on trim routers that idle high — we can't honor it,
  // so flag it so the UI can warn (use a smaller bit / VFD).
  let spindleTooFast = false
  // Surface speed peaks at the WIDEST diameter that cuts — a taper's, not its tip's.
  const vcDiaMM = 2 * maxCutRadiusMM(tool)
  const vcMax = info.maxSurfaceSpeedMMin
  if (vcMax && vcMax > 0 && vcDiaMM > 0) {
    // Floor so the whole-rpm result never rounds *above* the surface-speed ceiling
    // (Math.round on a fractional ceiling rpm would nudge Vc a hair over the limit).
    const vcRpm = Math.floor((vcMax * 1000) / (Math.PI * vcDiaMM))
    if (vcRpm < loRpm) spindleTooFast = true
    hiRpm = clamp(vcRpm, loRpm, hiRpm)
  }

  const idealRpm = denom > 0 ? targetFeed / denom : hiRpm
  const rpm = Math.round(clamp(idealRpm, loRpm, hiRpm))
  // When the spindle cannot go slow enough to meet the rigidity target, the chip may
  // thin toward the material's floor (never past the gauge's "rubbing" band), and
  // beyond that the feed runs over the target to keep it — the rigidity figure is
  // soft, a thin chip melts plastic. Only the machine's own max feed is hard, and
  // only it may thin the chip further.
  const fzFloor = Math.max(minChipLoad(tool.type, feedDiameterMM(tool), material, ceiling), RUBBING_MARGIN * fzAim)
  const fzRun = clamp(targetFeed / (flutes * rpm), fzFloor, fzAim)
  const xyFeed = Math.min(fzRun * flutes * rpm, maxFeed)
  const rpmAdjusted = rpm !== tool.rpm
  const plunge = clamp(0.4 * xyFeed, 50, maxFeed)

  // Step-down comes from machine rigidity + material hardness, capped by the tool
  // diameter — it can be shallower OR deeper than the user's guess.
  const capDiaMM = feedDiameterMM(tool)
  const diaCap = capDiaMM >= SMALL_BIT_THRESHOLD_MM ? capDiaMM : 0.5 * capDiaMM
  const rigidDepthFactor = RIGIDITY_DEPTH_FACTOR[clamp(Math.round(R), 1, 5) - 1]
  const matDepthFactor = clamp(1 / Math.sqrt(hardness), 0.4, 1.5)

  // Light radial engagement (HSM / trochoidal) permits a much deeper axial pass: the
  // cut is intermittent and the unengaged flute sheds heat, so depth of cut can climb
  // well past a diameter. Scale both the target DOC and its ceiling by an engagement
  // boost; full-slot cuts (engagement ≥ 1, e.g. a plain profile) get boost = 1 and the
  // original diameter-bounded behavior. The ceiling rises only toward the tool's usable
  // flute length (`maxDepthMM`), never beyond it.
  const engagement = clamp(radialEngagementFraction ?? 1, 0.05, 1)
  const depthBoost = clamp(Math.sqrt(1 / engagement), 1, 4)
  const fluteCap = tool.maxDepthMM > 0 ? Math.max(diaCap, tool.maxDepthMM) : diaCap
  const depthCap = clamp(diaCap * depthBoost, diaCap, fluteCap)
  const idealDoc = clamp(diaCap * rigidDepthFactor * matDepthFactor * depthBoost, 0.1, depthCap)

  // Favor a whole-number division of the intended total depth so passes come out
  // even (e.g. 10 mm @ ~2.7 ideal → 4 passes of 2.5 mm). Rounding to the nearest
  // pass count can overshoot idealDoc by up to ~50% (e.g. 4 mm @ 2.7 ideal rounds
  // to a single 4 mm pass), so cap the result: idealDoc is the rigidity/material
  // ceiling and may be exceeded only slightly for evenness before forcing another,
  // shallower pass. The engagement-aware depth cap is the hard upper bound.
  let stepDown = idealDoc
  if (totalDepthMM > 0) {
    const stepCap = Math.min(idealDoc * 1.1, depthCap)
    let passes = Math.max(1, Math.round(totalDepthMM / idealDoc))
    stepDown = totalDepthMM / passes
    while (stepDown > stepCap && passes < 1000) { passes += 1; stepDown = totalDepthMM / passes }
  }

  return { xyFeedMmMin: xyFeed, plungeMmMin: plunge, stepDownMM: stepDown, rpm, rpmAdjusted, spindleTooFast }
}

// ─── Store-reading convenience wrappers ────────────────────────────────────────

function calcForTool(tool: Tool, userStepDownMM: number, totalDepthMM: number, radialEngagementFraction?: number): FeedCalcResult {
  const { material, machineRigidity, maxFeedMmMin, minSpindleRpm, maxSpindleRpm, autoFeedEnabled } = useWorkpieceStore.getState()
  return computeFeeds({
    tool,
    material,
    rigidity: machineRigidity,
    maxFeedMmMin,
    minSpindleRpm,
    maxSpindleRpm,
    userStepDownMM,
    totalDepthMM,
    enabled: autoFeedEnabled,
    radialEngagementFraction,
  })
}

export interface ToolFeeds {
  xyFeedMmMin: number
  plungeMmMin: number
  rpm: number
  rpmAdjusted: boolean
  spindleTooFast: boolean
}

// Cutting/plunge feed + spindle speed for the current machine/material — used by
// gcode.ts. Step-down inputs are irrelevant to these outputs.
export function feedsForTool(tool: Tool): ToolFeeds {
  const { xyFeedMmMin, plungeMmMin, rpm, rpmAdjusted, spindleTooFast } = calcForTool(tool, 0, 0)
  return { xyFeedMmMin, plungeMmMin, rpm, rpmAdjusted, spindleTooFast }
}

// Effective step-down for a generator call — used at every toolpath call site.
// `totalDepthMM` is the operation's intended cut depth (for whole-division).
// `radialEngagementFraction` (WOC / D) lets low-engagement ops (trochoidal) step deeper;
// omit it for full-slot operations (profile, etc.) to keep the diameter-bounded depth.
export function effectiveStepDownMM(tool: Tool, userStepDownMM: number, totalDepthMM: number, radialEngagementFraction?: number): number {
  return calcForTool(tool, userStepDownMM, totalDepthMM, radialEngagementFraction).stepDownMM
}

// Starting step-down for a form that has just been opened (or had its tool
// changed) — it seeds the manual field, and only survives when auto feeds are
// off, since `effectiveStepDownMM` recomputes it otherwise. Derived from the
// cutter rather than stored per tool: half a diameter is a conservative
// full-slot pass for a mill, and a drill pecks a full diameter at a time.
// Bounded by the usable flute length so the seed is never an impossible depth.
export function seedStepDownMM(tool?: Tool | null): number {
  if (!tool || !(tool.diameterMM > 0)) return 3
  const seed = tool.type === 'drill' ? tool.diameterMM : tool.diameterMM * 0.5
  return tool.maxDepthMM > 0 ? Math.min(seed, tool.maxDepthMM) : seed
}

// Radial engagement (WOC / D) of a trochoidal pass: the forward advance per loop
// (`trochStepMM`) is the material the tool bites into each revolution of the pattern.
export function trochoidalEngagementFraction(tool: Tool, trochStepMM: number): number {
  return tool.diameterMM > 0 ? trochStepMM / tool.diameterMM : 1
}
