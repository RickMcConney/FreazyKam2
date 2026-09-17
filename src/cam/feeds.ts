import type { Tool, ToolType } from '../store/toolStore'
import { maxCutRadiusMM, tipBallRadiusMM } from './geom'
import { useWorkpieceStore, MATERIAL_INFO } from '../store/workpieceStore'

// ─── Centralized feed, spindle & step-down calculation ─────────────────────────
//
// Derives a cutting feed, plunge feed, spindle speed, and step-down from the
// material hardness, the tool geometry, the machine rigidity, and a hard
// max-feed ceiling.
//
// Chip load (feed per tooth) = feed / (rpm * flutes) and does NOT depend on the
// axial depth of cut. So when the machine can't feed fast enough to hold the
// target chip load, the correct fix is to *slow the spindle* — not to change the
// step-down. Step-down is instead chosen from machine rigidity + material
// hardness (bounded by tool diameter) and snapped to a whole division of the
// operation's intended total depth.
//
// All heuristic constants live here so they're easy to tune. The model produces
// sane starting numbers, not shop-certified values.

// Base chip load (mm per tooth) at the reference diameter, per tool type.
const REFERENCE_DIAMETER_MM = 6
const CHIP_LOAD_TABLE: Record<ToolType, number> = {
  endmill: 0.05,
  ballnose: 0.04,
  vbit: 0.03,
  // A taper is a small, well-supported cutter whose flute is backed by the cone — it
  // takes a lighter chip than a straight end mill of its mean diameter but is not as
  // fragile as the knife edge of a V-bit.
  taper: 0.035,
  drill: 0.05,
}

// Bits at or above this diameter may step down a full diameter; smaller bits are
// limited to half their diameter (they're far more fragile).
const SMALL_BIT_THRESHOLD_MM = 3.175 // 1/8"

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

// How hard we drive the chip relative to the intrinsic ideal, by machine rigidity.
// Softer machines aim for a lighter chip (gentler), stiffer ones a bit heavier.
// Used to scale the feed in computeFeeds and to set the chip-load gauge's color
// band (so a hobby machine running its lighter feed still reads "in the sweet
// spot" against this adjusted aim, while the displayed target stays intrinsic).
// Tuned per level (R1–R3 softened so hobby machines don't slam the feed cap);
// indexed by rigidity 1..5.
const RIGIDITY_FEED_FACTOR = [0.35, 0.5, 0.65, 0.95, 1.1]
export function rigidityFeedFactor(rigidity: number): number {
  return RIGIDITY_FEED_FACTOR[clamp(Math.round(rigidity), 1, 5) - 1]
}

// Axial depth-of-cut aggressiveness by machine rigidity (before the material and
// diameter caps). R1–R3 take shallower passes than the old linear ramp so light
// machines aren't handed near-full-diameter step-downs. Indexed by rigidity 1..5.
const RIGIDITY_DEPTH_FACTOR = [0.3, 0.45, 0.6, 0.85, 1.0]

// Intrinsic recommended chip load (mm per tooth) for a tool in a given material —
// a property of the tool type + diameter + material only (this is what manufacturer
// chip-load charts give). Machine rigidity does NOT enter here; it instead scales
// the feed in computeFeeds. Shared by the feed calc and the simulator's gauge.
export function targetChipLoad(toolType: ToolType, diameterMM: number, hardness: number): number {
  const h = hardness > 0 ? hardness : 1
  const diaScale = clamp(diameterMM / REFERENCE_DIAMETER_MM, 0.3, 2)
  return (CHIP_LOAD_TABLE[toolType] ?? 0.05) * diaScale / h
}

// The diameter to judge a tool's CUTTING duty by. Every type stores the diameter it
// cuts at — except a taper, whose stored diameter is the ball on its TIP. Feeding a
// 1 mm tip into targetChipLoad would ask a bit that is 5 mm wide halfway down its
// taper to take a 1 mm bit's chip, so a taper reports the mean of its tip and its
// widest cutting diameter instead.
export function feedDiameterMM(tool: Tool): number {
  if (tool.type !== 'taper') return tool.diameterMM
  return tipBallRadiusMM(tool) + maxCutRadiusMM(tool)
}

interface FeedCalcInput {
  tool: Tool
  materialHardness: number
  rigidity: number       // 1..5
  maxFeedMmMin: number
  minSpindleRpm: number  // machine's lowest usable spindle speed (clamp floor)
  maxSpindleRpm: number  // machine's top spindle speed — auto may raise rpm up to this
  maxSurfaceSpeedMMin?: number  // material Vc ceiling (m/min) — caps rpm for metals; omit for wood
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

function computeFeeds(input: FeedCalcInput): FeedCalcResult {
  const { tool, materialHardness, rigidity, maxFeedMmMin, minSpindleRpm, maxSpindleRpm, maxSurfaceSpeedMMin, userStepDownMM, totalDepthMM, enabled, radialEngagementFraction } = input
  const maxFeed = maxFeedMmMin > 0 ? maxFeedMmMin : Infinity

  // When auto-feed is off we keep the tool's own feeds/speed and the user's
  // step-down, but the machine's max feed is a hard limit that is always honored.
  if (!enabled) {
    return {
      xyFeedMmMin: Math.min(tool.xyFeedMmMin, maxFeed),
      plungeMmMin: Math.min(tool.zFeedMmMin, maxFeed),
      stepDownMM: userStepDownMM,
      rpm: tool.rpm,
      rpmAdjusted: false,
      spindleTooFast: false,
    }
  }

  const R = clamp(rigidity, 1, 5)
  const hardness = materialHardness > 0 ? materialHardness : 1
  const flutes = tool.fluteCount > 0 ? tool.fluteCount : 1

  // Intrinsic chip load for this tool + material (independent of the machine).
  const fz = targetChipLoad(tool.type, feedDiameterMM(tool), hardness)

  // On softer machines we deliberately aim for a lighter chip so the gantry isn't
  // overloaded. This scales the *feed*, not the displayed target.
  const fzAim = fz * rigidityFeedFactor(R)

  // Spindle speed is a computed output, not taken from the tool: pick the rpm that
  // lets the feed reach the machine's max (shortest job), bounded by the machine's
  // spindle range. Feed then follows from holding the aimed chip load. If the user
  // set the tool rpm too low, this raises it; if too high for the chip load at max
  // feed, it lowers it.
  const denom = fzAim * flutes
  const loRpm = minSpindleRpm > 0 ? minSpindleRpm : 1
  let hiRpm = Math.max(maxSpindleRpm, loRpm)

  // Metals get a surface-speed (Vc) ceiling so the edge doesn't overheat at the
  // high RPMs wood prefers: rpm = Vc / (π·d). This tightens the top of the rpm
  // range (never below the machine's own floor). If even the machine's minimum
  // rpm spins faster than the safe Vc — common on trim routers that idle high —
  // we can't honor it, so flag it so the UI can warn (use a smaller bit / VFD).
  let spindleTooFast = false
  if (maxSurfaceSpeedMMin && maxSurfaceSpeedMMin > 0 && tool.diameterMM > 0) {
    // Floor so the whole-rpm result never rounds *above* the surface-speed ceiling
    // (Math.round on a fractional ceiling rpm would nudge Vc a hair over the limit).
    const vcRpm = Math.floor((maxSurfaceSpeedMMin * 1000) / (Math.PI * tool.diameterMM))
    if (vcRpm < loRpm) spindleTooFast = true
    hiRpm = clamp(vcRpm, loRpm, hiRpm)
  }

  const idealRpm = denom > 0 ? maxFeed / denom : hiRpm
  const rpm = Math.round(clamp(idealRpm, loRpm, hiRpm))
  const xyFeed = Math.min(fzAim * flutes * rpm, maxFeed)
  const rpmAdjusted = rpm !== tool.rpm
  const plunge = clamp(0.4 * xyFeed, 50, maxFeed)

  // Step-down comes from machine rigidity + material hardness, capped by the tool
  // diameter — it can be shallower OR deeper than the user's guess.
  const diaCap = tool.diameterMM >= SMALL_BIT_THRESHOLD_MM ? tool.diameterMM : 0.5 * tool.diameterMM
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
    materialHardness: MATERIAL_INFO[material].hardness,
    rigidity: machineRigidity,
    maxFeedMmMin,
    minSpindleRpm,
    maxSpindleRpm,
    maxSurfaceSpeedMMin: MATERIAL_INFO[material].maxSurfaceSpeedMMin,
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
