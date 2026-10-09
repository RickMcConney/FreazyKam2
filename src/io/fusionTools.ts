// Reading a Fusion 360 tool library (the `.json` Fusion's Tool Library exports, and the
// format most bit vendors publish their catalogue in) into the app's own tools.
//
// Pure — no stores — so the conversion is testable against a real vendor file.
//
// What the format says, as far as this reads it (every length in `unit`, which is
// "inches" or "millimeters" for the whole record):
// - `geometry.DC` is the cutting diameter; `NOF` the flute count; `LCF` the flute length.
// - `geometry.TA` is the taper angle PER SIDE, for a chamfer mill (the V-bit: a 90° V-bit
//   is TA 45) and a tapered mill alike. Ours stores a V-bit's INCLUDED angle and a
//   taper's per side (`includedAngleDeg` in cam/geom.ts), so the V-bit doubles and the
//   taper is taken as it is.
// - `geometry.RE` is the corner radius: a tapered mill's tip ball radius, which is what our
//   taper's `diameterMM` holds (as a diameter) — DC on a tapered mill is the diameter at
//   the top of the flutes, not the tip.
// - `start-values.presets[0]` carries the feeds: `v_f` cutting, `v_f_plunge` plunge, `n` rpm.

import type { Tool, ToolType } from '../store/toolStore'

export interface FusionImport {
  tools: Tool[]
  // Tools the app cannot cut with, by name and why — reported, never dropped silently.
  skipped: { name: string; why: string }[]
  // Approximations made on the way in (a bull nose read as a flat end mill).
  notes: string[]
  // The vendor most of the tools come from, to name the folder they land in.
  vendor: string | null
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** True when parsed JSON looks like a Fusion 360 tool library: `{ data: [ {type, geometry}… ] }`. */
export function isFusionLibrary(data: unknown): boolean {
  return isObj(data) && Array.isArray(data.data) && data.data.some((t) => isObj(t) && typeof t.type === 'string' && isObj(t.geometry))
}

// Fusion's tool types, as far as they map onto ours. A slot mill is what the surfacing
// bits are filed under. A bull nose (a bowl bit) keeps its corner radius, RE.
const TYPE_MAP: Record<string, { type: ToolType; note?: string }> = {
  'flat end mill': { type: 'endmill' },
  'slot mill': { type: 'endmill' },
  'face mill': { type: 'endmill' },
  'bull nose end mill': { type: 'bullnose' },
  'ball end mill': { type: 'ballnose' },
  'chamfer mill': { type: 'vbit' },
  'tapered mill': { type: 'taper' },
  'drill': { type: 'drill' },
  'spot drill': { type: 'drill' },
}

/**
 * Convert a parsed Fusion library. `mintId` gives every tool a fresh id — a vendor
 * catalogue's guids mean nothing to a library, and an id is what operations hold on to.
 */
export function fromFusionLibrary(data: unknown, mintId: () => string): FusionImport {
  const out: FusionImport = { tools: [], skipped: [], notes: [], vendor: null }
  if (!isObj(data) || !Array.isArray(data.data)) return out
  const vendors = new Map<string, number>()

  for (const raw of data.data) {
    if (!isObj(raw)) continue
    const name = (typeof raw.description === 'string' && raw.description.trim()) || 'Unnamed tool'
    const kind = typeof raw.type === 'string' ? raw.type : ''
    if (kind === 'holder' || kind === 'probe') continue
    const map = TYPE_MAP[kind]
    if (!map) { out.skipped.push({ name, why: `a ${kind || 'tool of no type'}, which FreazyKam has no shape for` }); continue }
    const g = isObj(raw.geometry) ? raw.geometry : {}
    const k = raw.unit === 'millimeters' ? 1 : raw.unit === 'inches' ? 25.4 : undefined
    if (k === undefined) { out.skipped.push({ name, why: `its unit "${String(raw.unit)}" is not inches or millimeters` }); continue }

    const dc = num(g.DC)
    const re = num(g.RE)
    const ta = num(g.TA)
    const lcf = num(g.LCF)
    let diameterMM = dc !== undefined ? dc * k : undefined
    let vbitAngleDeg: number | undefined
    let cornerRadiusMM: number | undefined
    if (map.type === 'bullnose') {
      if (!re || dc === undefined || re * 2 > dc + 1e-9) { out.skipped.push({ name, why: 'its corner radius is missing or wider than the bit' }); continue }
      cornerRadiusMM = round(re * k)
    } else if (map.type === 'vbit') {
      if (ta === undefined || ta <= 0 || ta >= 90) { out.skipped.push({ name, why: 'it has no usable V angle' }); continue }
      vbitAngleDeg = 2 * ta
    } else if (map.type === 'taper') {
      if (ta === undefined || ta <= 0 || !re) { out.skipped.push({ name, why: 'it has no taper angle or tip radius' }); continue }
      vbitAngleDeg = ta
      diameterMM = 2 * re * k
    }
    if (!diameterMM || diameterMM <= 0) { out.skipped.push({ name, why: 'it has no diameter' }); continue }

    const preset = isObj(raw['start-values']) && Array.isArray(raw['start-values'].presets) && isObj(raw['start-values'].presets[0])
      ? raw['start-values'].presets[0] : {}
    const tool: Tool = {
      id: mintId(),
      name,
      type: map.type,
      diameterMM: round(diameterMM),
      fluteCount: Math.max(1, Math.round(num(g.NOF) ?? 2)),
      rpm: Math.round(num(preset.n) ?? 18000),
      // A drill has no side feed; ours stores 0 for it, as the default drill does.
      xyFeedMmMin: map.type === 'drill' ? 0 : round((num(preset.v_f) ?? 0) * k),
      zFeedMmMin: round((num(preset.v_f_plunge) ?? num(preset.v_f) ?? 0) * k) || 300,
      // The flute length: how deep the tool can cut, and for a taper the length of the
      // cone — which, with the tip and the angle, is how wide the taper opens out. A
      // V-bit's is the height of its cone, worked out from the geometry: catalogues fill
      // its LCF in carelessly (IDC's 90° ½" V-bit says 1.7 mm where its cone is 6.35).
      maxDepthMM: round(map.type === 'vbit' && dc !== undefined && ta !== undefined
        ? Math.max(0, dc - (num(g['tip-diameter']) ?? 0)) / 2 / Math.tan(ta * Math.PI / 180) * k
        : (lcf ?? dc ?? 0) * k) || 10,
      ...(vbitAngleDeg !== undefined ? { vbitAngleDeg } : {}),
      ...(cornerRadiusMM !== undefined ? { cornerRadiusMM } : {}),
    }
    if (map.type !== 'drill' && tool.xyFeedMmMin === 0) tool.xyFeedMmMin = 1000
    if (map.note) out.notes.push(`${name}: ${map.note}`)
    out.tools.push(tool)
    if (typeof raw.vendor === 'string' && raw.vendor.trim()) vendors.set(raw.vendor.trim(), (vendors.get(raw.vendor.trim()) ?? 0) + 1)
  }

  dedupeNames(out.tools)
  let best = 0
  for (const [v, n] of vendors) if (n > best) { best = n; out.vendor = v }
  return out
}

// A catalogue can list one name twice (the same engraver in two shank sizes). The import
// merges by name, so two tools under one name would read as a clash with itself; the
// second and later get their diameter added, which is what tells them apart.
function dedupeNames(tools: Tool[]) {
  const count = new Map<string, number>()
  for (const t of tools) count.set(t.name, (count.get(t.name) ?? 0) + 1)
  const seen = new Set<string>()
  for (const t of tools) {
    if ((count.get(t.name) ?? 0) < 2) continue
    let name = `${t.name} Ø${+t.diameterMM.toFixed(3)}mm`
    for (let n = 2; seen.has(name); n++) name = `${t.name} Ø${+t.diameterMM.toFixed(3)}mm (${n})`
    seen.add(name)
    t.name = name
  }
}

const round = (v: number) => Math.round(v * 1000) / 1000
