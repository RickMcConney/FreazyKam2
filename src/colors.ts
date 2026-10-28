// Central color palette — edit here to retheme the whole app.

import type { Material } from './store/workpieceStore'

// All imported paths and created shapes share one color.
export const PATH_COLOR = '#60a5fa'  // blue-400

// One per layer of an import that has several (importers/layers.ts), in order of first
// appearance. The first is PATH_COLOR so a layer reads as "the usual" path; the rest are
// mid-tone hues that hold up on both the light and the dark canvas.
export const LAYER_COLORS = ['#60a5fa', '#f87171', '#fbbf24', '#34d399', '#c084fc', '#f472b6', '#22d3ee', '#a3e635']

// ─── Material colors (single source of truth) ───────────────────────────────
// One entry per material, used by both renderers:
//   light / dark — 2D canvas fill (Konva), picked per active theme
//   three        — 3D workpiece color (Three.js integer 0xRRGGBB), tuned for
//                  lit rendering so it differs slightly from the flat 2D fills
//   opacity      — optional 3D stock opacity (1 when absent); only clear stock sets it
export const MATERIAL_COLORS: Record<Material, { light: string; dark: string; three: number; opacity?: number }> = {
  pine:      { light: '#e8c98a', dark: '#7a5828', three: 0xd4a86a },
  cedar:     { light: '#d9a878', dark: '#6a4326', three: 0xc88a5a },
  basswood:  { light: '#f2e4c4', dark: '#8a7650', three: 0xeedcb4 },
  oak:       { light: '#c8a060', dark: '#6a4820', three: 0xb5803d },
  maple:     { light: '#f0d9a8', dark: '#8a6e3a', three: 0xe8c98d },
  walnut:    { light: '#7a4a28', dark: '#3a2010', three: 0x6b3d1e },
  cherry:    { light: '#c47a45', dark: '#6a3a1a', three: 0x9c4a2e },
  mdf:       { light: '#c8b89a', dark: '#5a4a38', three: 0xc8b89a },
  plywood:   { light: '#d4b07a', dark: '#6a5030', three: 0xc9a96a },
  hdpe:      { light: '#d8ecd8', dark: '#3a5a3a', three: 0xe0e0e0 },
  delrin:    { light: '#f2f0ea', dark: '#4a4844', three: 0xf0eee6 },
  acrylic:   { light: '#dcebf2', dark: '#34505c', three: 0xcfe4ee, opacity: 0.6 },
  aluminum:  { light: '#c8ccd0', dark: '#4a5058', three: 0xa8b4b8 },
  brass:     { light: '#d4b94a', dark: '#8a7320', three: 0xc9a83a },
  other:     { light: '#e0e0e0', dark: '#404040', three: 0xc8c8c8 },
}

// Toolpath operation colors — fixed per type, stable across sessions.
export const OP_TYPE_COLORS: Record<string, string> = {
  profile:  '#f97316',  // orange-500
  pocket:   '#06b6d4',  // cyan-500
  drill:    '#10b981',  // emerald-500
  surface:  '#8b5cf6',  // violet-500
  vcarve:   '#ec4899',  // pink-500
  photovcarve: '#f472b6', // pink-400 — a v-carve variant, so a lighter shade of the same
  inlay:    '#eab308',  // yellow-500
  profile3d:  '#34d399', // emerald-400
  trochoidal: '#fb923c', // orange-400
  fluting:  '#f43f5e',  // rose-500 — a centreline carve, a neighbour of v-carve's pink
  boolean:  '#38bdf8',  // sky-400
  offset:   '#4ade80',  // green-400
  pattern:  '#c084fc',  // purple-400
  trace:    '#2dd4bf',  // teal-400
  nest:     '#a78bfa',  // violet-400 — an arranging tool, so a neighbour of pattern's hue
  tabs:     '#f59e0b',  // amber-400
  doublesided: '#d97706', // amber-600 — the flip axis and pins draw in it on the canvas
  tiling:   '#0ea5e9',  // sky-500 — the seams draw in it on the canvas
  gcode:    '#6366f1',  // indigo-500
}

// Tool bands in the Toolpaths list: one hue per tool, so a run of operations reads as a
// block and the SAME tool appearing twice reads as the same colour twice — which is the
// point, since two same-coloured bands with a tool change between them are a redundant
// change. Hues only (not finished colours): the strip mixes them per theme, tinting the
// band background and its border from the same value.
export const TOOL_BAND_HUES = [205, 145, 35, 280, 0, 175, 55, 310, 95, 240]

// Simulation cut trail — matches the 3D carved-surface color.
export const SIM_CUT_COLOR       = '#ffcc00'

// The 2D cut trail's chip-load heat map (sim/cutTrail.ts `heatBand`), indexed by band.
// Band 0 is a cut the chip gauge does not judge — a plunge, a ramp, a drill — in
// neutral grey; 1–3 are the rubbing side, darkest where the chip is thinnest; 4 is the
// gauge's sweet spot; 5 is a chip too heavy. No yellow, so nothing reads as halfway.
export const SIM_HEAT_COLORS = ['#9ca3af', '#7f1d1d', '#dc2626', '#f97316', '#22c55e', '#3b82f6'] as const

// 2D simulation tool indicator states.
export const SIM_TOOL_CUTTING_COLOR = '#ef4444'  // red   — actively cutting
export const SIM_TOOL_RAPID_COLOR   = '#9ca3af'  // gray  — rapid move

// 3D view background.
export const THREE_BG_COLOR_THREE = 0xbfdbfe   // Three.js integer format

// Z-datum highlight — gradient on the stock sides (3D) and the Z origin label
// (2D) that marks which face Z0 sits on (top surface vs. stock bottom).
export const Z_DATUM_COLOR       = '#38bdf8'   // sky-400
export const Z_DATUM_COLOR_THREE = 0x38bdf8    // Three.js integer format

// The machine's axes wherever they are drawn or named: the canvas origin arrows, the Setup
// axis picture, and the X/Y/Z words in the G-code viewer. Z is the datum colour.
export const AXIS_COLORS = { x: '#ef4444', y: '#22c55e', z: Z_DATUM_COLOR } as const
