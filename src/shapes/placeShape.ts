// Put a shape on the canvas from its parameters — what releasing the shape tool does,
// as a plain module so the canvas and the MCP bridge (mcp/commands.ts) place shapes the
// SAME way: one path, or one path per part sharing a groupId, selected, and patched up
// once a font it needed arrives.

import { usePathsStore } from '../store/pathsStore'
import { nextPathColor, type ImportedPath } from '../importers/svgImporter'
import { uid } from '../uid'
import { generateShapeD, generateShapeParts, shapeDisplayName, type ShapeParams } from './shapeGenerators'
import { loadFont, isFontLoaded, SINGLE_LINE_FONT_FAMILY } from './textGenerator'

/** Once `family` has loaded, regenerate the shape from the params it has NOW — never the
 *  ones it was placed with: an edit made while the font was in flight (teeth 24 → 30,
 *  retyped text) would otherwise be put back. Through updateShapeParams, so the fix
 *  amends the shape's chip rather than recording an edit of its own. Skipped when the
 *  load failed, when the shape is gone, or when it no longer wants the font. */
function regenWhenFontLoads(family: string, pathId: string, groupId: string | undefined,
  stillWants: (p: ShapeParams) => boolean): void {
  loadFont(family).then(() => {
    if (!isFontLoaded(family)) return
    const { paths, updateShapeParams } = usePathsStore.getState()
    // Any member of a group regenerates all of it, so a deleted first part is no reason to stop.
    const live = paths.find((p) => p.id === pathId)
      ?? (groupId ? paths.find((p) => p.groupId === groupId && p.shapePart !== undefined) : undefined)
    if (!live?.shapeParams || !stillWants(live.shapeParams)) return
    updateShapeParams(live.id, live.shapeParams)
  })
}

/** Add a shape drawn from `params` and select it. Returns the ids of the paths it became. */
export function placeShape(params: ShapeParams, opts: { fromCenter?: boolean } = {}): string[] {
  const id = uid('shape')
  const { addPaths: add, selectPath: sel, setSelectedIds } = usePathsStore.getState()
  // A multi-part shape lands as one path per part (a gear's teeth, bore and
  // spokes each want their own operation — see generateShapeParts). They
  // share a groupId so the paths list keeps them together, and each carries
  // the same shapeParams so the set stays editable as one shape.
  const parts = generateShapeParts(params)
  // The id to regenerate this shape through if a font has to arrive first —
  // any member of a group works, since updateShapeParams regenerates all of
  // it.
  let regenId = id
  let regenGroup: string | undefined
  let ids: string[]
  // Even ONE part lands as a part: a shape whose part count changes with its
  // parameters (a V-bit bowtie is one outline, a straight-bit one a socket and
  // a key) can then grow its other parts later as parts, instead of being
  // regenerated as one compound path that has to be split by hand.
  if (parts && parts.length >= 1) {
    const groupId = uid('shape-group')
    const name = shapeDisplayName(params.type)
    const color = nextPathColor()
    const made: ImportedPath[] = parts.map((pt) => ({
      id: uid('shape'), name: `${name} ${pt.label}`, d: pt.d,
      visible: true, color, shapeParams: params, shapePart: pt.part,
      groupId, groupName: name,
      // The tool's setting is the DEFAULT for what is drawn from it; from
      // here on it is the object's own, changed from its panel.
      ...(opts.fromCenter ? { fromCenter: true } : {}),
    }))
    add(made, { source: 'shape' })
    setSelectedIds(made.map((p) => p.id))
    regenId = made[0].id
    regenGroup = groupId
    ids = made.map((p) => p.id)
  } else {
    // Only a single-path shape needs the whole outline: for a parts shape generateShapeD
    // is the parts joined, so computing it up front generated the shape twice.
    const d = generateShapeD(params)
    add([{
      id, name: shapeDisplayName(params.type), d, visible: true, color: nextPathColor(), shapeParams: params,
      ...(opts.fromCenter ? { fromCenter: true } : {}),
    }], { source: params.type === 'text' ? 'text' : 'shape' })
    sel(id)
    ids = [id]
  }

  // Text in a font that has not loaded yet: redraw it once the font is here. Asked of
  // the FONT, not of an empty `d` — when the default font is already in, the text is
  // drawn in THAT as a stand-in, and keying on `!d` left it stored in Roboto for good
  // while its params said Times.
  if (params.type === 'text' && !isFontLoaded(params.fontFamily)) {
    const family = params.fontFamily
    regenWhenFontLoads(family, id, undefined, (p) => p.type === 'text' && p.fontFamily === family)
  }

  // Same story for a gear's tooth-count number: the single-stroke font is
  // fetched on demand, so a gear drawn before it lands has every part but
  // that one. Regenerating the group once it is here adds the part.
  if (params.type === 'gear' && params.toothLabel && !parts?.some((pt) => pt.part === 'label')) {
    regenWhenFontLoads(SINGLE_LINE_FONT_FAMILY, regenId, regenGroup, (p) => p.type === 'gear' && !!p.toothLabel)
  }
  return ids
}
