// ─── Icon sizes (px) ───────────────────────────────────────────────────────
// Used as <Icon size={ICON.sm} />. Change here to scale all icons.
export const ICON = {
  xs:  12,   // status indicators inline with text
  sm:  15,   // action buttons inside panels
  md:  32,   // toolbar / shape palette buttons
  lg:  22,   // empty-state illustrations
} as const

// Material fill colors now live in ./colors (MATERIAL_COLORS) as the single
// source of truth shared with the 3D view. Import them from there.

// ─── Canvas (Konva) colors ──────────────────────────────────────────────────
// Konva draws to a bitmap canvas — it can't use CSS variables.
// Call canvasTheme(darkMode) to get the correct set for the active theme.

const CANVAS_LIGHT = {
  ruler: {
    bg:     '#f3f4f6',
    border: '#d1d5db',
    corner: '#e5e7eb',
    tickMj: '#9ca3af',
    tickMn: '#d1d5db',
    label:  '#374151',
  },
  grid: {
    originLine: '#ef4444',
    axisMj:     '#9ca3af',
    axisNorm:   '#d1d5db',
    axisMn:     '#e5e7eb',
    mmLabel:    '#9ca3af',
  },
  workpiece: {},
  path: {
    selected: '#1e40af',
  },
}

const CANVAS_DARK = {
  ruler: {
    bg:     '#262626',
    border: '#404040',
    corner: '#404040',
    tickMj: '#737373',
    tickMn: '#404040',
    label:  '#d4d4d4',
  },
  grid: {
    originLine: '#ef4444',
    axisMj:     '#525252',
    axisNorm:   '#404040',
    axisMn:     '#333333',
    mmLabel:    '#737373',
  },
  workpiece: {},
  path: {
    selected: '#ffffff',
  },
}

export function canvasTheme(dark: boolean) {
  return dark ? CANVAS_DARK : CANVAS_LIGHT
}

