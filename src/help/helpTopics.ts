// THE HELP LINKS (help mode — see HelpMode.tsx). Every control that can explain itself
// carries a TOPIC (`data-help`, set through `helpAttr` so the compiler checks the name),
// and this table says where each topic's explanation lives: a page of the help site
// (`help/`) or the user guide (`docs/`), as the REPO path of its markdown and the
// heading anchor it should land on. Repo paths rather than URLs so `helpTopics.test.ts`
// can check every one against the markdown the sites are built from — a renamed heading
// fails the test, not a reader's click.
//
// A topic names a CONTROL, and every topic lands somewhere of its own — a page, or a
// section of one (the test holds it to that). Pointing two controls at the same place
// sent each reader to the top of a page about something else as often as not; the fix is
// a page or a section for each, not a shared landing. Several BUTTONS may share a topic
// when they are one thing (New, Open and Save are the project file).

export const HELP_TOPICS = {
  // ── Toolbar ────────────────────────────────────────────────────────────────
  'project-file': 'help/how-to/save-a-project.md',
  'import': 'help/how-to/import-a-file.md',
  'export-gcode': 'help/how-to/export-g-code.md',
  'export-drawing': 'help/reference/file-formats.md#save-and-export',
  'undo-redo': 'help/reference/keyboard-and-mouse.md#editing',
  'simulate': 'help/how-to/simulate-a-job.md',
  'sheets': 'help/how-to/use-several-sheets.md',
  'units': 'help/how-to/switch-units.md',
  'feed-time': 'help/how-to/switch-units.md#feeds-per-minute-or-per-second',
  'snap': 'help/how-to/snap-to-grid.md',
  'lock-dragging': 'help/how-to/lock-dragging.md',
  'measure': 'help/how-to/measure-a-distance.md',
  'theme': 'help/reference/screen.md#light-or-dark-theme',
  'mcp': 'help/how-to/connect-an-ai-assistant.md#4-turn-it-on-in-freazykam',

  // ── View tabs ──────────────────────────────────────────────────────────────
  'view-2d': 'help/reference/screen.md#view-tabs',
  'view-3d': 'docs/10-export.md#2d-and-3d',
  'tool-library': 'help/reference/tools.md',
  'post-processor': 'help/reference/post-processor.md',
  'machine-tab': 'help/reference/machine-tab.md',

  // ── Sidebar ────────────────────────────────────────────────────────────────
  'draw-tab': 'help/reference/screen.md#draw-tab-groups',
  'paths-tab': 'help/reference/screen.md#sidebar-tabs',
  'paths-list': 'docs/02-canvas.md#the-paths-list',
  'toolpaths-list': 'help/how-to/change-the-cut-order.md',
  'setup': 'help/how-to/set-up-your-stock.md',
  'properties': 'docs/02-canvas.md#the-properties-panel',
  'objects-strip': 'help/reference/screen.md#objects-strip',
  'status-bar': 'help/reference/screen.md#status-bar',

  // ── Canvas zoom controls ───────────────────────────────────────────────────
  'zoom': 'help/how-to/zoom-and-pan.md#zoom-buttons',
  'actual-size': 'help/how-to/zoom-and-pan.md#see-parts-at-real-size',

  // ── Draw ───────────────────────────────────────────────────────────────────
  'pen': 'help/how-to/draw-with-the-pen.md',
  'text': 'help/how-to/add-text.md',
  'shape': 'help/how-to/draw-a-shape.md',

  // ── CAM operations (keys are MachinePanel's form types) ─────────────────────
  'profile': 'help/how-to/cut-out-a-part.md',
  'trochoidal': 'help/how-to/cut-with-loops.md',
  'pocket': 'help/how-to/clear-a-pocket.md',
  'drill': 'help/how-to/drill-holes.md',
  'surface': 'help/how-to/flatten-your-stock.md',
  'vcarve': 'help/how-to/v-carve-lettering.md',
  'photovcarve': 'help/how-to/carve-a-photo.md',
  'inlay': 'help/how-to/make-an-inlay.md',
  'profile3d': 'help/how-to/carve-a-3d-model.md',
  'fluting': 'help/how-to/carve-flutes.md',
  'doublesided': 'help/how-to/cut-both-sides.md',
  'tiling': 'help/how-to/cut-a-long-board-in-tiles.md',

  // ── Path tools (same) ──────────────────────────────────────────────────────
  'boolean': 'help/how-to/combine-shapes.md',
  'offset': 'help/how-to/offset-a-shape.md',
  'pattern': 'help/how-to/repeat-a-shape.md',
  'nest': 'help/how-to/nest-parts.md',
  'tabs': 'help/how-to/add-holding-tabs.md',
  'nodeedit': 'help/how-to/round-corners.md',
  'trace': 'help/how-to/trace-a-picture.md',
  'along': 'help/how-to/lay-text-along-a-path.md',
  'duplicate': 'help/how-to/duplicate-shapes.md',
} as const satisfies Record<string, string>

export type HelpTopic = keyof typeof HELP_TOPICS

/** Spread onto the element a topic explains: `<button {...helpAttr('pocket')}>`. */
export const helpAttr = (topic: HelpTopic) => ({ 'data-help': topic })

/** Where a topic's page is served: `help/how-to/x.md#a` → `/help/how-to/x.html#a`.
 *  Null for a name that is not a topic (an attribute set by hand, say). */
export function helpUrl(topic: string): string | null {
  const target = (HELP_TOPICS as Record<string, string>)[topic]
  if (!target) return null
  const [file, hash] = target.split('#')
  const page = file.replace(/(^|\/)README\.md$/, '$1index.html').replace(/\.md$/, '.html')
  return `/${page}${hash ? `#${hash}` : ''}`
}

/** The help site's home, for the banner's own link. */
export const HELP_HOME = '/help/'
