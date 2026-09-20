import { X, BookOpen } from 'lucide-react'
import { useUIStore } from '../store/uiStore'

type Section = {
  title: string
  rows: { keys: string[]; desc: string }[]
}

const SHORTCUTS: Section[] = [
  {
    title: 'File',
    rows: [
      { keys: ['Ctrl+N'], desc: 'New project' },
      { keys: ['Ctrl+O'], desc: 'Open project' },
      { keys: ['Ctrl+S'], desc: 'Save project' },
    ],
  },
  {
    title: 'Edit',
    rows: [
      { keys: ['Ctrl+Z'], desc: 'Undo' },
      { keys: ['Ctrl+Y'], desc: 'Redo' },
      { keys: ['Ctrl+C'], desc: 'Copy selected paths (paste into any project)' },
      { keys: ['Ctrl+V'], desc: 'Paste paths' },
      { keys: ['Ctrl+X'], desc: 'Cut selected paths' },
      { keys: ['Ctrl+D'], desc: 'Duplicate selected' },
      { keys: ['Ctrl+G'], desc: 'Group selected paths' },
      { keys: ['Ctrl+Shift+G'], desc: 'Ungroup' },
      { keys: ['Delete', 'Backspace'], desc: 'Delete selected' },
      { keys: ['Arrow keys'], desc: 'Nudge selected 1 mm (0.1") — Shift ×10, Alt ÷10' },
      { keys: ['Escape'], desc: 'Deselect / cancel operation' },
    ],
  },
  {
    title: 'Canvas',
    rows: [
      { keys: ['Scroll'], desc: 'Zoom in / out' },
      { keys: ['Middle mouse', 'Space+drag'], desc: 'Pan' },
      { keys: ['S'], desc: 'Toggle snap to grid' },
      { keys: ['C'], desc: 'Constrain tool — hold one part relative to another' },
    ],
  },
  {
    title: 'Point Edit',
    rows: [
      { keys: ['Double-click path'], desc: 'Enter point edit mode' },
      { keys: ['Click segment'], desc: 'Insert point' },
      { keys: ['Hover point + Delete'], desc: 'Remove point' },
      { keys: ['Escape'], desc: 'Commit and exit point edit' },
    ],
  },
]

const FEATURES = [
  {
    title: 'Select tool',
    desc: 'Click to select, drag empty area to box-select — drag RIGHT and the box takes everything it touches (dashed), drag back LEFT and it takes only what lies wholly inside (solid). Shift-click to toggle membership in a multi-selection. Drag handles to move, scale, or rotate. Hold Alt while dragging a corner handle to skew (shear) instead of scale.',
  },
  {
    title: 'Export SVG',
    desc: 'The toolbar Export SVG button writes the selected paths — or every visible path when nothing is selected — as an SVG in millimetres, with the stock as the page, so a path lands back where it was drawn when the file is imported into a project with the same stock. Path names ride along and come back as names. It carries OUTLINES only: a gear arrives as a shape with no module or tooth count, and images and STL bounding boxes are left out. To move work between two projects of this app, use Ctrl+C / Ctrl+V instead, which keeps the objects.',
  },
  {
    title: 'Copying between projects',
    desc: 'Ctrl+C copies the selected paths and Ctrl+V pastes them — into the same project, or into another one open in a second tab or window. The copy carries the OBJECTS, not just their outlines: a gear arrives with its module and tooth count still editable, a clock as one clock, a group as one group, and holding tabs come with the path. Provenance (an offset, a pattern, a boolean) survives only when the paths it was generated from are copied too, since a form has nothing to re-run without them. Pasting back into the project it came from nudges the copy 5 mm clear; into another project it lands where it was drawn. Operations are not copied — they name a tool and a floor the other project need not have.',
  },
  {
    title: 'Groups',
    desc: 'Select several paths and press Ctrl+G (or Group in the Properties panel) to tie them together: clicking any member then selects the whole group, so they move, scale, rotate and delete as one thing, and the Objects strip shows them as one chip. Ctrl+Shift+G ungroups. To get at a single path inside a group, Alt-click it on the canvas or click it in the Paths list. Groups nest: group a group with a shape and ungrouping gives back that group and that shape, one level at a time.',
  },
  {
    title: 'Constraints',
    desc: 'Hold one part a stated distance from another and keep it there as either is edited — four holes 10 mm in from the corners of a plate stay 10 mm in from the corners when the plate is resized. Press C (or Constrain in the Properties panel), then click a point on one part and a point on another: corners, edge midpoints, centres and the centres of round features all offer themselves as you move over a part. It is created holding the distance the parts ALREADY stand at, so nothing moves, and the keyboard goes straight to its first number. Instead of clicking the second point you can DRAG that part into place, with the dimension reading out live, and let go where you want it. Each constraint is one row: the two numbers, a click on a label to stop holding that one, a ↻ to hold the angle between the parts as well (so a slot turns with the plate it sits in), and ✕ to delete. Numbers are measured along the FIRST part’s own axes, so rotating it carries everything held to it round with it. A part can also be held off an edge of the stock, which is ground and wins over a drag. There is no root: drag any part of a chain and the rest follow. Dimensions are drawn on the canvas while the tool is on.',
  },
  {
    title: 'Shape tools',
    desc: 'Pick a shape from the Draw tab. Click the canvas to place it at the default size, or drag to size it interactively. Tick From centre and a drag grows outward from where it started instead of running corner to corner — drag repeatedly from one point for concentric shapes. A gear, escapement, pendulum or train track ignores the drag and places at the size its own parameters give it — those are set by module and tooth count, by the beat, or by the piece it has to connect to, not by how far you drag. Edit parameters in the Properties panel.',
  },
  {
    title: 'Pen tool',
    desc: 'Click to place points. In Bezier mode, drag to pull out curve handles. In all other modes curves are computed automatically from point positions. Hold Alt while clicking to make the incoming segment a straight line. Click near the first point to close the path, or press Escape to finish an open path (2+ points required). Ctrl+Z to undo the last placed point.',
  },
  {
    title: 'Pocket regions',
    desc: 'Pocketing needs a closed path, but a drawing often encloses an area that no single path closes around — slots cut into the edge of a part, bounded by the outline on three sides and a separate line across the mouth. While the Pocket form is open, move over the canvas: the area under the cursor is highlighted, built from every visible line that bounds it, split wherever lines meet or cross. Click inside it to make it a new closed path and select it for the pocket (shapes inside it come along as holes); Shift-click to add more areas. Clicking on a line still selects that path as usual, and an area one closed path already bounds just selects that path. The original lines are left alone. An area that is not fully enclosed highlights nothing, since closing a gap would mean guessing at a line nobody drew.',
  },
  {
    title: 'Point edit',
    desc: 'Double-click any path to edit its points directly. Drag points or handles to reshape. Click on a segment to insert a new point. Hover a point and press Delete to remove it.',
  },
  {
    title: 'Import',
    desc: 'Supported formats: SVG, DXF, STL (projected outline), PNG/JPG/WebP (placed as a boundary rectangle), and G-code (for simulation replay).',
  },
  {
    title: 'Toolpaths',
    desc: 'Select paths, then pick from CAM Operations in the Draw tab: Profile, Trochoidal, Pocket, Drill, Surface, V-Carve, Photo V-Carve, Inlay or 3D Profile. Simulate G-code previews the motion; Export G-code downloads Grbl-compatible output.',
  },
  {
    title: 'Path tools',
    desc: 'Under CAM Operations, the Path Tools row reshapes geometry rather than cutting it: Boolean (union, intersect, subtract), Offset, Pattern (linear or circular array), Tabs (holding tabs) and Corners (round, chamfer, dogbone).',
  },
  {
    title: 'Objects strip',
    desc: 'The strip under the canvas holds one chip per thing in the document — every path, every clock, every operation. Click a chip to select what it stands for and reopen the editor that made it: a gear chip its module and tooth count, a boolean chip its union or subtract, a pocket chip its depth. Editing a thing changes its chip instead of adding another, and hovering a chip and clicking its ✕ deletes the thing itself. A group, a multi-part shape or a whole Generate is one chip; tabs and corner treatments get their own, attached to the path they belong to.',
  },
  {
    title: 'Ops strip',
    desc: 'The Ops tab of the same strip is the program rather than the document: one chip per toolpath, in the order the machine will run them, which is the order G-code is written in. Operations sharing a tool are drawn as one coloured band with a marker at every tool change; drag a chip or a whole band to reorder. When the program visits a tool more than once a −N TC button appears and gathers that tool\'s operations into one step so you load it once. Hover a chip to hide an operation (hidden operations are left out of exported G-code) or to delete it.',
  },
]

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-block px-1.5 py-0.5 rounded text-xs font-mono bg-gray-100 dark:bg-neutral-700 border border-gray-300 dark:border-neutral-600 text-gray-800 dark:text-neutral-200">
      {children}
    </kbd>
  )
}

export default function HelpPanel() {
  const { helpOpen, setHelpOpen } = useUIStore()
  if (!helpOpen) return null

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={() => setHelpOpen(false)}
    >
      <div
        className="bg-white dark:bg-neutral-800 rounded-lg shadow-2xl border border-gray-200 dark:border-neutral-700 w-[680px] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-neutral-700 flex-shrink-0">
          <h2 className="text-base font-semibold text-gray-900 dark:text-neutral-100">FreazyKam Help</h2>
          <div className="flex items-center gap-4">
            {/* This panel is the quick reference; the full task-by-task guide is the
                site's documentation, which is the same markdown that lives in docs/. */}
            <a
              href="/docs/"
              target="_blank"
              rel="noopener"
              className="flex items-center gap-1.5 text-sm text-blue-600 dark:text-blue-400 hover:underline"
            >
              <BookOpen size={15} />
              User guide
            </a>
            <button
              onClick={() => setHelpOpen(false)}
              className="text-gray-600 hover:text-gray-800 dark:hover:text-neutral-200 transition-colors"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Scrollable body */}
        <div className="overflow-y-auto px-6 py-5 flex flex-col gap-6">

          {/* Keyboard shortcuts */}
          <section>
            <h3 className="text-sm font-semibold text-gray-700 dark:text-neutral-300 mb-3 uppercase tracking-wide">
              Keyboard Shortcuts
            </h3>
            <div className="grid grid-cols-2 gap-x-8 gap-y-5">
              {SHORTCUTS.map((section) => (
                <div key={section.title}>
                  <div className="text-xs font-medium text-gray-600 dark:text-neutral-400 mb-1.5">{section.title}</div>
                  <table className="w-full text-sm">
                    <tbody>
                      {section.rows.map((row) => (
                        <tr key={row.desc} className="align-top">
                          <td className="pr-3 pb-1 whitespace-nowrap">
                            <span className="flex gap-1 flex-wrap">
                              {row.keys.map((k) => <Kbd key={k}>{k}</Kbd>)}
                            </span>
                          </td>
                          <td className="pb-1 text-gray-600 dark:text-neutral-400">{row.desc}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          </section>

          {/* Feature overview */}
          <section>
            <h3 className="text-sm font-semibold text-gray-700 dark:text-neutral-300 mb-3 uppercase tracking-wide">
              Features
            </h3>
            <div className="grid grid-cols-2 gap-x-8 gap-y-3">
              {FEATURES.map((f) => (
                <div key={f.title}>
                  <div className="text-sm font-medium text-gray-800 dark:text-neutral-200 mb-0.5">{f.title}</div>
                  <div className="text-xs text-gray-500 dark:text-neutral-400 leading-relaxed">{f.desc}</div>
                </div>
              ))}
            </div>
          </section>

          {/* Coordinate system note */}
          <section className="bg-gray-50 dark:bg-neutral-700/40 rounded-md px-4 py-3">
            <div className="text-xs font-medium text-gray-600 dark:text-neutral-300 mb-1">Coordinate system</div>
            <p className="text-xs text-gray-500 dark:text-neutral-400 leading-relaxed">
              All dimensions are in CNC space (mm, Y-up, origin at stock bottom-left by default).
              The canvas applies a Y-flip so positive Y appears upward on screen, matching conventional
              CAD orientation.
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
