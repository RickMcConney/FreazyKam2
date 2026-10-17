// The tools this tab offers an AI assistant, as MCP tool definitions (JSON Schema). Sent to the
// freazykam-mcp server in the hello (bridgeClient.ts), which lists exactly these — so a
// tool added here reaches the assistant the next time a tab connects, with no new version of the
// server. Each tool runs the command of the same name in commands.ts; `tools.test.ts`
// holds the two lists to each other.
//
// The toolpath tools are BUILT from the registry (panels/machine/toolpathKinds.ts): its
// types, settings, limits and descriptions. Add a type there and these follow.
//
// get_status is the server's own (it must answer while no tab is connected); it runs
// the `status` command here.

import { TOOLPATH_KINDS, type SettingSpec } from '../panels/machine/toolpathKinds'
import type { ToolDef } from './protocol'

// ─── Schema shorthand ──────────────────────────────────────────────────────────

type Schema = Record<string, unknown>
const num = (description?: string, extra: Schema = {}): Schema => ({ type: 'number', ...(description ? { description } : {}), ...extra })
const int = (description?: string, extra: Schema = {}): Schema => ({ type: 'integer', ...(description ? { description } : {}), ...extra })
const str = (description?: string, extra: Schema = {}): Schema => ({ type: 'string', ...(description ? { description } : {}), ...extra })
const bool = (description?: string): Schema => ({ type: 'boolean', ...(description ? { description } : {}) })
const oneOf = (values: readonly string[], description?: string): Schema => ({ type: 'string', enum: values, ...(description ? { description } : {}) })
const ids = (description?: string, min = 1): Schema => ({ type: 'array', items: { type: 'string' }, minItems: min, ...(description ? { description } : {}) })
const anyObject = (description?: string): Schema => ({ type: 'object', additionalProperties: true, ...(description ? { description } : {}) })
const input = (properties: Record<string, Schema> = {}, required: string[] = []) =>
  ({ type: 'object' as const, properties, ...(required.length ? { required } : {}) })

const READ = { readOnlyHint: true }
const EDIT = { readOnlyHint: false, destructiveHint: false }
const DESTROY = { readOnlyHint: false, destructiveHint: true }

/** Generation can take minutes on a big job; the tab stops waiting a little sooner and says so. */
const GENERATION_MS = 300_000

const MATERIALS = ['pine', 'cedar', 'oak', 'maple', 'walnut', 'cherry', 'mdf', 'plywood', 'hdpe', 'delrin', 'acrylic', 'aluminum', 'brass', 'other']

// ─── Toolpath tools, from the registry ───────────────────────────────────────────

function settingLine(name: string, spec: SettingSpec): string {
  const kind = spec.enum ? spec.enum.join('|') : spec.type
  const range = [
    spec.exclusiveMinimum !== undefined ? `> ${spec.exclusiveMinimum}` : '',
    spec.minimum !== undefined ? `>= ${spec.minimum}` : '',
    spec.maximum !== undefined ? `<= ${spec.maximum}` : '',
  ].filter(Boolean).join(', ')
  const step = spec.multipleOf !== undefined ? `, a multiple of ${spec.multipleOf}` : ''
  const id = spec.toolsFor ? ', a tool id' : ''
  return `    ${name} (${kind}${id}${range ? `, ${range}` : ''}${step}): ${spec.description}` +
    `${spec.onlyWith ? ` (only with ${spec.onlyWith})` : ''}${spec.createOnly ? ' (set when created only)' : ''}`
}

const kinds = Object.values(TOOLPATH_KINDS)
const kindNames = kinds.map((k) => k.type)
const kindDocs = kinds.map((k) =>
  `${k.type} — ${k.summary} ${k.paths}${k.points ? ` points: ${k.points}.` : ''}\n` +
  Object.entries(k.settings).map(([n, s]) => settingLine(n, s)).join('\n')).join('\n')

// ─── The tools ─────────────────────────────────────────────────────────────────

export const TOOLS: ToolDef[] = [
  // Reading
  {
    name: 'list_paths', title: 'List paths', annotations: READ,
    description:
      'The drawn and imported paths (vectors) in the project: id, name, the shape that made it ' +
      '(rectangle, circle, gear, ... or null for an import), whether it is closed, its bounding ' +
      'box in mm from the stock\'s bottom-left corner, and how many tabs it has. Set ' +
      'includeGeometry to also get each path\'s SVG d string (CNC mm, Y up) — large on imported ' +
      'drawings, so ask for specific ids when you can.',
    inputSchema: input({ ids: ids('Only these paths', 0), includeGeometry: bool() }),
  },
  {
    name: 'list_toolpaths', title: 'List toolpaths', annotations: READ,
    description:
      'Every toolpath (operation) in program order: type, tool, status (done, needs-update, ' +
      'generating, error with its message), depth, the paths it cuts and, once generated, its ' +
      'deepest Z and cut extents (XY from the stock\'s bottom-left corner, like list_paths).',
    inputSchema: input(),
  },
  {
    name: 'get_toolpath', title: 'Get toolpath settings', annotations: READ,
    description: 'All settings of one toolpath — what its form would show — plus its summary.',
    inputSchema: input({ id: str() }, ['id']),
  },
  {
    name: 'list_tools', title: 'List tools', annotations: READ,
    description:
      'The tool library: id, type, diameter, angle (a V-bit\'s is included, a taper\'s is per ' +
      'side), flutes, rpm and feeds. Lists the user\'s own "My Tools" unless `folder` names an ' +
      'imported catalogue (the answer lists every folder and its size) or is "all".',
    inputSchema: input({
      folder: str('"My Tools" (default), a catalogue folder name, or "all"'),
      type: oneOf(['endmill', 'ballnose', 'bullnose', 'vbit', 'taper', 'drill'], 'Only this tool type'),
      search: str('Only tools whose name contains this'),
    }),
  },  {
    name: 'add_tool', title: 'Add a tool to the library', annotations: EDIT,
    description:
      'Add a cutter to the user\'s tool library (My Tools) — for a bit they own that list_tools ' +
      'does not have. This changes the library, which outlives the project and is not undone by ' +
      'undo; tell the user what you added. Unset numbers start where the library\'s New tool ' +
      'does (2 flutes, 18000 rpm, feed 2000, plunge 500, max depth 20 mm); the rated chip load ' +
      'defaults to what those feeds give. A vbit needs angleDeg (INCLUDED angle, e.g. 60); a ' +
      'taper needs angleDeg PER SIDE and its diameterMM is the TIP; a bullnose needs ' +
      'cornerRadiusMM. Refuses a name My Tools already has.',
    inputSchema: input({
      name: str(), type: oneOf(['endmill', 'ballnose', 'bullnose', 'vbit', 'taper', 'drill']),
      diameterMM: num(undefined, { exclusiveMinimum: 0 }), flutes: int(undefined, { minimum: 1, maximum: 12 }),
      angleDeg: num(), cornerRadiusMM: num(undefined, { exclusiveMinimum: 0 }),
      rpm: num(undefined, { exclusiveMinimum: 0 }), feedMmMin: num(undefined, { exclusiveMinimum: 0 }),
      plungeMmMin: num(undefined, { exclusiveMinimum: 0 }), maxDepthMM: num(undefined, { exclusiveMinimum: 0 }),
      chipLoadMM: num('rated chip load, mm per tooth', { exclusiveMinimum: 0 }),
    }, ['name', 'type', 'diameterMM']),
  },
  {
    name: 'update_tool', title: 'Change a tool in the library', annotations: EDIT, timeoutMs: GENERATION_MS,
    description:
      'Change a tool in My Tools (a catalogue tool cannot be changed: add_tool a copy). Fields ' +
      'as add_tool; omitted ones stay. Like add_tool it changes the library, not the project, ' +
      'and undo does not reverse it — say what you changed. Every toolpath cutting with the ' +
      'tool is regenerated and returned.',
    inputSchema: input({
      id: str(), name: str(), type: oneOf(['endmill', 'ballnose', 'bullnose', 'vbit', 'taper', 'drill']),
      diameterMM: num(undefined, { exclusiveMinimum: 0 }), flutes: int(undefined, { minimum: 1, maximum: 12 }),
      angleDeg: num(), cornerRadiusMM: num(undefined, { exclusiveMinimum: 0 }),
      rpm: num(undefined, { exclusiveMinimum: 0 }), feedMmMin: num(undefined, { exclusiveMinimum: 0 }),
      plungeMmMin: num(undefined, { exclusiveMinimum: 0 }), maxDepthMM: num(undefined, { exclusiveMinimum: 0 }),
      chipLoadMM: num('rated chip load, mm per tooth', { exclusiveMinimum: 0 }),
    }, ['id']),
  },

  {
    name: 'regenerate', title: 'Regenerate toolpaths', annotations: { ...EDIT, idempotentHint: true }, timeoutMs: GENERATION_MS,
    description:
      'Regenerate toolpaths (all, or the given ids) exactly as an edit would, wait for them to ' +
      'finish, and report each one\'s status and any error. Changes no settings.',
    inputSchema: input({ ids: ids('Only these toolpaths', 0) }),
  },
  {
    name: 'get_gcode', title: 'Get G-code', annotations: READ, timeoutMs: 120_000,
    description:
      'The G-code the Export button would write, using the active post-processor, a page of ' +
      'lines at a time (default 300 from line 1; totalLines says how many there are). With ' +
      'several sheets of stock, `sheet` picks one (0-based).',
    inputSchema: input({ sheet: int(undefined, { minimum: 0 }), startLine: int(undefined, { minimum: 1 }), maxLines: int(undefined, { minimum: 1, maximum: 5000 }) }),
  },
  {
    name: 'export_check', title: 'Export check', annotations: READ, timeoutMs: 120_000,
    description:
      'The review the Export dialog shows before writing G-code: machine and stock settings, ' +
      'tools used, spindle speeds, cut extents, deepest cut, estimated run time, and every ' +
      'safety warning. The best single check that a job is ready to cut.',
    inputSchema: input(),
  },

  // Project files — the server reads and writes them; a page cannot.
  {
    name: 'open_project', title: 'Open project', annotations: DESTROY, timeoutMs: GENERATION_MS,
    file: { param: 'path', mode: 'read', ext: '.fkam' },
    description:
      'Open a .fkam project file from this computer in the FreazyKam tab, replacing what is ' +
      'open, and wait for its toolpaths to generate. Refuses when the open project has unsaved ' +
      'changes: ask the user, and pass discardUnsaved only if they agree.',
    inputSchema: input({ path: str('Absolute path to a .fkam file'), discardUnsaved: bool() }, ['path']),
  },
  {
    name: 'save_project', title: 'Save project copy', annotations: EDIT,
    file: { param: 'path', mode: 'write', ext: '.fkam' },
    description:
      'Write the open project to a .fkam file on this computer — the same file Save would ' +
      'download. Does not change the project\'s saved state in the app. Refuses to replace an ' +
      'existing file unless overwrite is true.',
    inputSchema: input({ path: str('Absolute path ending in .fkam'), overwrite: bool() }, ['path']),
  },
  {
    name: 'import_file', title: 'Import SVG or DXF', annotations: EDIT,
    file: { param: 'path', mode: 'read', ext: ['.svg', '.dxf'] },
    description:
      'Import a drawing from this computer into the open project, as the toolbar\'s Import does: ' +
      'centred on the stock, as one group, selected. A DXF that does not state its units is ' +
      'refused until `units` is given — ask the user rather than guessing. Text in a DXF is not ' +
      'imported (it has to be exploded to outlines first); the answer says so.',
    inputSchema: input({
      path: str('Absolute path to a .svg or .dxf file'),
      units: oneOf(['mm', 'cm', 'in', 'ft', 'm'], 'DXF only: the units its numbers are in, when the file does not say'),
    }, ['path']),
  },
  {
    name: 'import_image', title: 'Import a picture', annotations: EDIT,
    file: { param: 'path', mode: 'read', ext: ['.png', '.jpg', '.jpeg', '.webp'], binary: true },
    description:
      'Import a picture (PNG, JPEG or WebP) from this computer, as the toolbar\'s Import does: ' +
      'sized at 96 DPI, scaled down to fit 80% of the stock, centred on it. Then trace it ' +
      '(trace_image), photo-carve it (create_toolpath photovcarve) or carve it as a depth map ' +
      '(create_toolpath profile3d).',
    inputSchema: input({ path: str('Absolute path to a .png, .jpg, .jpeg or .webp file') }, ['path']),
  },
  {
    name: 'export_gcode', title: 'Export G-code', annotations: EDIT, timeoutMs: 120_000,
    file: { param: 'path', mode: 'write', ext: ['.gcode', '.nc', '.ngc', '.tap'] },
    description:
      'Write the job\'s G-code to a file on this computer — what the Export button writes, with ' +
      'the active post-processor. Hidden toolpaths are left out. A job on several sheets of ' +
      'stock is one program per sheet: give `sheet` and export each. Run export_check first. ' +
      'Refuses to replace an existing file unless overwrite is true.',
    inputSchema: input({
      path: str('Absolute path ending in .gcode, .nc, .ngc or .tap'),
      sheet: int('0-based, when the job has several sheets', { minimum: 0 }),
      overwrite: bool(),
    }, ['path']),
  },
  {
    name: 'new_project', title: 'New project', annotations: DESTROY,
    description:
      'Start a new, empty project (as the New Project button does), optionally named. Stock ' +
      'size and material carry over, as they do in the app. Refuses when the open project has ' +
      'unsaved changes: ask the user, and pass discardUnsaved only if they agree. New Project ' +
      'cannot be undone.',
    inputSchema: input({ name: str(), discardUnsaved: bool() }),
  },

  // Drawing
  {
    name: 'list_shape_types', title: 'List shape types', annotations: READ,
    description:
      'The shapes add_shape can draw and each one\'s settings, with the values the shape tool ' +
      'would use now. Call this before add_shape to learn a type\'s setting names.',
    inputSchema: input(),
  },
  {
    name: 'add_shape', title: 'Add shape', annotations: EDIT,
    description:
      'Draw a shape on the canvas, centred on (x, y) in mm from the stock\'s bottom-left corner ' +
      '(for text, (x, y) is where the text starts). `settings` overrides any of the type\'s ' +
      'settings from list_shape_types; the rest keep the tool\'s defaults. Multi-part shapes ' +
      '(gear, box, ...) come back as several paths. Returns the new paths; change one later with ' +
      'update_shape rather than deleting and re-adding it.',
    inputSchema: input({
      type: str('rectangle, circle, polygon, star, text, gear, ... (see list_shape_types)'),
      x: num(), y: num(),
      settings: anyObject('e.g. {"w": 80, "h": 40} for a rectangle, {"radius": 25} for a circle'),
    }, ['type', 'x', 'y']),
  },
  {
    name: 'get_shape', title: 'Get shape settings', annotations: READ,
    description:
      'The settings of a shape drawn with a shape tool (or add_shape): its type, every setting ' +
      'update_shape can change with its current value, and the ids of all its paths — a ' +
      'multi-part shape (gear, box, clock wheel, ...) is several paths and any one of them names ' +
      'it. Fails for a path with no shape settings (imported, pen-drawn, or made by a path tool).',
    inputSchema: input({ id: str('any path of the shape') }, ['id']),
  },
  {
    name: 'update_shape', title: 'Change shape settings', annotations: EDIT, timeoutMs: GENERATION_MS,
    description:
      'Change a shape\'s settings as the Properties panel does — a gear\'s teeth, a rectangle\'s ' +
      'w, a text\'s text — redrawing every part of it (parts appear or vanish as the settings ' +
      'say) as one undo step, then regenerating every toolpath that cuts it. `settings` names ' +
      'only what changes; names and types come from get_shape. Position is not a setting: move ' +
      'with transform_paths. A box-shaped shape (rectangle, maze, board, ...) keeps its bottom-left ' +
      'corner as it grows, or its centre if get_shape says growsFromCentre. Refuses settings ' +
      'that would draw nothing. Returns the new settings, the paths and the regenerated toolpaths.',
    inputSchema: input({
      id: str('any path of the shape'),
      settings: anyObject('e.g. {"teeth": 40} for a gear, {"w": 120} for a rectangle, {"text": "Hi"} for text'),
    }, ['id', 'settings']),
  },
  {
    name: 'transform_paths', title: 'Move, rotate, scale or mirror paths', annotations: EDIT,
    description:
      'One transform of the given paths, as one undo step. kind "move": dx/dy, or toX/toY to ' +
      'put the paths\' combined centre there. "rotate": angleDeg (counter-clockwise). "scale": ' +
      'factor, or sx and sy. "mirror": axis "x" flips left-right, "y" flips top-bottom. ' +
      'Rotate, scale and mirror turn about the paths\' combined centre unless cx/cy is given.',
    inputSchema: input({
      ids: ids(), kind: oneOf(['move', 'rotate', 'scale', 'mirror']),
      dx: num(), dy: num(), toX: num(), toY: num(), angleDeg: num(),
      factor: num(), sx: num(), sy: num(), axis: oneOf(['x', 'y']), cx: num(), cy: num(),
    }, ['ids', 'kind']),
  },
  {
    name: 'delete_paths', title: 'Delete paths', annotations: DESTROY,
    description:
      'Delete paths, and with them any toolpath that cut only those paths. One undo step — ' +
      'undo brings everything back.',
    inputSchema: input({ ids: ids() }, ['ids']),
  },
  {
    name: 'group_paths', title: 'Group paths', annotations: EDIT,
    description:
      'Group paths (as Ctrl+G does) so they select and move as one. Groups nest: grouping a ' +
      'group with another path makes a group holding both. One undo step.',
    inputSchema: input({ ids: ids('at least two paths; a path in a group brings its whole group', 2) }, ['ids']),
  },
  {
    name: 'ungroup_paths', title: 'Ungroup paths', annotations: EDIT,
    description:
      'Take one level of grouping off every group the given paths are in (as Ctrl+Shift+G ' +
      'does): what was inside those groups is loose again, or back in the group it was in before. One undo step.',
    inputSchema: input({ ids: ids('any path of each group to ungroup') }, ['ids']),
  },
  {
    name: 'set_stock', title: 'Set stock', annotations: EDIT,
    description: 'Change the stock size (mm) and/or material. Omitted fields stay as they are.',
    inputSchema: input({
      widthMM: num(undefined, { exclusiveMinimum: 0 }), heightMM: num(undefined, { exclusiveMinimum: 0 }),
      thicknessMM: num(undefined, { exclusiveMinimum: 0 }), material: oneOf(MATERIALS),
    }),
  },
  {
    name: 'undo', title: 'Undo', annotations: EDIT,
    description: 'Undo the last change in FreazyKam — yours or the user\'s; it is one shared history.',
    inputSchema: input(),
  },
  {
    name: 'redo', title: 'Redo', annotations: EDIT,
    description: 'Redo the last undone change.',
    inputSchema: input(),
  },

  // Path tools — each what its form's Apply makes; settings left out are the form's
  {
    name: 'offset_paths', title: 'Offset paths', annotations: EDIT,
    description:
      'Make a new path offset from each given path, as the Offset tool does (the sources stay). ' +
      'distanceMM positive grows it, negative shrinks it. keepGenerated: a generated shape ' +
      '(rectangle, circle, gear...) stays that shape with new parameters. keepShape: scale to ' +
      'an average gap instead of offsetting exactly.',
    inputSchema: input({
      ids: ids(), distanceMM: num('Positive = outset, negative = inset'),
      cornerStyle: oneOf(['miter', 'round', 'square'], 'Corners of an outset'),
      keepShape: bool(), keepGenerated: bool(),
    }, ['ids', 'distanceMM']),
  },
  {
    name: 'boolean_paths', title: 'Combine paths (boolean)', annotations: EDIT,
    description:
      'Combine 2 or more closed paths into one result path; the sources are hidden, not deleted. ' +
      'Order matters for subtract: the first path is kept and the rest are cut away from it.',
    inputSchema: input({ ids: ids(undefined, 2), op: oneOf(['union', 'intersect', 'subtract']) }, ['ids', 'op']),
  },
  {
    name: 'pattern_paths', title: 'Pattern paths', annotations: EDIT,
    description:
      'Copy the given paths in a grid or round a circle, as the Pattern tool does; the originals ' +
      'count as the first instance. Linear: rows × cols with xGapMM/yGapMM between the copies\' ' +
      'bounding boxes. Circular: count instances on a circle of radiusMM from startAngleDeg to ' +
      'endAngleDeg, each turned to follow the circle if rotateItems. Copies keep their shape ' +
      'parameters and groups.',
    inputSchema: input({
      ids: ids(), mode: oneOf(['linear', 'circular']),
      rows: int(undefined, { minimum: 1 }), cols: int(undefined, { minimum: 1 }), xGapMM: num(), yGapMM: num(),
      count: int(undefined, { minimum: 2 }), radiusMM: num(), startAngleDeg: num(), endAngleDeg: num(), rotateItems: bool(),
    }, ['ids']),
  },
  {
    name: 'text_along_path', title: 'Text along a path', annotations: EDIT,
    description:
      'Lay a Text object (made with add_shape type "text") along another path, as the Along Path ' +
      'tool does; the text is hidden and the laid-out letters become a new path. side: out/on/in ' +
      '(above/on/below a line; outside/on/inside a closed shape). at: where along the guide, 0–1 ' +
      '(a closed guide counts clockwise from the bottom).',
    inputSchema: input({
      textId: str(), guideId: str(), side: oneOf(['out', 'on', 'in']),
      at: num(undefined, { minimum: 0, maximum: 1 }), spacingMM: num('Extra space between letters'),
      gapMM: num('Space between the line and the letters'), rotate: bool('Turn each letter to the guide'),
    }, ['textId', 'guideId']),
  },
  {
    name: 'list_corners', title: 'List corners', annotations: READ,
    description: 'The sharp corners of a path that corner_treatment can work on: index, position, and any treatment already on it.',
    inputSchema: input({ pathId: str() }, ['pathId']),
  },
  {
    name: 'corner_treatment', title: 'Treat corners', annotations: EDIT,
    description:
      'Round, chamfer or dogbone corners of a path, as the Corners tool does — on top of any ' +
      'treatments already there, and re-cut from the original corner, so changing a radius ' +
      'later is exact. "none" restores corners sharp. `corners` are indexes from list_corners; ' +
      'left out, every corner. dogbone: a notch so a round cutter fits a square inside corner.',
    inputSchema: input({
      pathId: str(), type: oneOf(['outerRound', 'innerRound', 'chamfer', 'dogbone', 'none']),
      radiusMM: num(undefined, { exclusiveMinimum: 0 }),
      corners: { type: 'array', items: { type: 'integer' }, description: 'Corner indexes from list_corners' },
    }, ['pathId', 'type']),
  },
  {
    name: 'nest_paths', title: 'Nest parts on the stock', annotations: EDIT, timeoutMs: GENERATION_MS,
    description:
      'Arrange parts on the stock to use as little of it as possible, as the Nest tool does — ' +
      'paths that belong together (a part and the holes in it, a group, a gear\'s parts) move ' +
      'as one. One undo step. multiSheet carries what will not fit onto more sheets. fillStock ' +
      'repeats ONE part until the stock is full (fillCount limits it), copying its toolpaths ' +
      'if copyToolpaths. sharedLines places parts one cutter apart so outside profiles can share ' +
      'cuts. avoidOthers keeps clear of paths not being nested.',
    inputSchema: input({
      ids: ids(), spacingMM: num(undefined, { minimum: 0 }), marginMM: num(undefined, { minimum: 0 }),
      rotation: oneOf(['none', '90', '45', '15'], 'How finely parts may be turned; none keeps the grain'),
      packFrom: oneOf(['left', 'bottom']), useHoles: bool('Put small parts inside the holes of big ones'),
      avoidOthers: bool(), multiSheet: bool(), fillStock: bool(), fillCount: int(undefined, { minimum: 0 }),
      copyToolpaths: bool(), sharedLines: bool(), sharedToolId: str('The end mill whose diameter is the gap, with sharedLines'),
    }, ['ids']),
  },
  {
    name: 'trace_image', title: 'Trace an image', annotations: EDIT, timeoutMs: GENERATION_MS,
    description:
      'Trace an imported picture into paths, as the Trace tool does; the picture is hidden under ' +
      'the result. trace: dark traces ink on a light ground. threshold (0–255) turns ' +
      'autoThreshold off. tones > 2 makes one layer per tone. mode centerline makes single ' +
      'lines down each stroke (for a V-bit), two tones only. Import the picture ' +
      'first (import_image).',
    inputSchema: input({
      imageId: str('An imported picture (list_paths)'),
      threshold: int(undefined, { minimum: 0, maximum: 255 }), autoThreshold: bool(), trace: oneOf(['dark', 'light']),
      minSpeckMM: num(undefined, { minimum: 0 }), smoothing: int(undefined, { minimum: 0, maximum: 100 }),
      tones: int(undefined, { minimum: 2, maximum: 8 }), thickenMM: num(undefined, { minimum: 0 }),
      mode: oneOf(['outline', 'centerline']),
    }, ['imageId']),
  },

  // Toolpaths — from the registry
  {
    name: 'toolpath_defaults', title: 'Toolpath defaults', annotations: READ,
    description:
      'What create_toolpath would use for a toolpath type if given no settings — the values its ' +
      'form would open with, including the user\'s last-used settings — and which tools it may use.',
    inputSchema: input({ type: oneOf(kindNames) }, ['type']),
  },
  {
    name: 'create_toolpath', title: 'Create toolpath', annotations: EDIT, timeoutMs: GENERATION_MS,
    description:
      'Create and generate a toolpath, exactly as its form\'s Generate button would — one undo ' +
      'step; cut in the order the path ids are given. Settings left out keep the form\'s ' +
      'defaults (see toolpath_defaults). A toolpath that fails is not kept, and its error is ' +
      'returned. Types and their settings:\n' + kindDocs,
    inputSchema: input({
      type: oneOf(kindNames),
      pathIds: ids('The paths to cut (see the type for what they mean)', 0),
      settings: anyObject('Settings of the chosen type, listed above'),
      points: { type: 'array', items: { type: 'object', properties: { x: num(), y: num() }, required: ['x', 'y'] }, description: 'For types that take bare points (mm)' },
    }, ['type']),
  },
  {
    name: 'update_toolpath', title: 'Update toolpath', annotations: EDIT, timeoutMs: GENERATION_MS,
    description:
      'Change settings of a toolpath and regenerate it. Like editing it in its form, this ' +
      'changes every toolpath made by the same Generate (its batch). Takes the settings ' +
      'create_toolpath lists for its type, except those marked "set when created only".',
    inputSchema: input({ id: str(), settings: anyObject() }, ['id', 'settings']),
  },
  {
    name: 'reorder_toolpaths', title: 'Reorder toolpaths', annotations: EDIT,
    description:
      'Change the program order, which is the cut order — e.g. drill holes and cut inside ' +
      'features before the profile that cuts the part free. Moves `ids` (keeping their own ' +
      'order) to just before `beforeId`, or to the end without it. Or groupByTool: true puts ' +
      'each tool\'s toolpaths together, for the fewest tool changes. One undo step.',
    inputSchema: input({ ids: ids(undefined, 0), beforeId: str('Toolpath to move them in front of'), groupByTool: bool() }),
  },
  {
    name: 'set_toolpath_visible', title: 'Show or hide toolpaths', annotations: EDIT,
    description: 'Hide toolpaths (left out of the exported G-code and the simulation) or show them again.',
    inputSchema: input({ ids: ids(), visible: bool() }, ['ids', 'visible']),
  },
  {
    name: 'delete_toolpaths', title: 'Delete toolpaths', annotations: DESTROY,
    description: 'Delete toolpaths (the paths stay). One undo step.',
    inputSchema: input({ ids: ids() }, ['ids']),
  },

  // Tabs
  {
    name: 'add_tabs', title: 'Add tabs', annotations: EDIT, timeoutMs: GENERATION_MS,
    description:
      'Put holding tabs on paths, spaced evenly round each one (replacing any it had), and ' +
      'regenerate the profiles that cut them so the tabs are left standing. Tabs belong to the ' +
      'path, so a profile made later uses them too. Defaults are the Tabs form\'s last-used ' +
      'values (4 tabs, 5 mm long, 2 mm high when never used). heightMM is measured up from ' +
      'the bottom of the cut.',
    inputSchema: input({
      pathIds: ids(), count: int(undefined, { minimum: 1, maximum: 20 }),
      lengthMM: num(undefined, { minimum: 0.5 }), heightMM: num(undefined, { minimum: 0.1 }),
    }, ['pathIds']),
  },
  {
    name: 'delete_tabs', title: 'Delete tabs', annotations: DESTROY, timeoutMs: GENERATION_MS,
    description: 'Remove every tab from the given paths and regenerate the profiles that cut them.',
    inputSchema: input({ pathIds: ids() }, ['pathIds']),
  },
]
