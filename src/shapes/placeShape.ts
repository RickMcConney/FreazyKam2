// Put a shape on the canvas from its parameters — what releasing the shape tool does,
// as a plain module so the canvas and the MCP bridge (mcp/commands.ts) place shapes the
// SAME way: one path, or one path per part sharing a groupId, selected, and patched up
// once a font it needed arrives.

import { usePathsStore } from '../store/pathsStore'
import { nextPathColor, type ImportedPath } from '../importers/svgImporter'
import { uid } from '../uid'
import { generateShapeD, generateShapeParts, shapeDisplayName, type ShapeParams } from './shapeGenerators'

/** Add a shape drawn from `params` and select it. Returns the ids of the paths it became. */
export function placeShape(params: ShapeParams, opts: { fromCenter?: boolean } = {}): string[] {
  const id = uid('shape')
  const { addPaths: add, selectPath: sel, setSelectedIds } = usePathsStore.getState()
  const d = generateShapeD(params)
  // A multi-part shape lands as one path per part (a gear's teeth, bore and
  // spokes each want their own operation — see generateShapeParts). They
  // share a groupId so the paths list keeps them together, and each carries
  // the same shapeParams so the set stays editable as one shape.
  const parts = generateShapeParts(params)
  // The id to regenerate this shape through if a font has to arrive first —
  // any member of a group works, since updateShapeParams regenerates all of
  // it.
  let regenId = id
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
    ids = made.map((p) => p.id)
  } else {
    add([{
      id, name: shapeDisplayName(params.type), d, visible: true, color: nextPathColor(), shapeParams: params,
      ...(opts.fromCenter ? { fromCenter: true } : {}),
    }], { source: params.type === 'text' ? 'text' : 'shape' })
    sel(id)
    ids = [id]
  }

  // If text font wasn't loaded yet, update d once it loads — via
  // updateShapeParams so the fix amends the Text chip in place rather
  // than recording a separate edit event.
  if (params.type === 'text' && !d) {
    import('./textGenerator').then(({ loadFont }) => {
      loadFont(params.fontFamily).then(() => {
        const newD = generateShapeD(params)
        if (newD) usePathsStore.getState().updateShapeParams(id, params)
      })
    })
  }

  // Same story for a gear's tooth-count number: the single-stroke font is
  // fetched on demand, so a gear drawn before it lands has every part but
  // that one. Regenerating the group once it is here adds the part.
  if (params.type === 'gear' && params.toothLabel && !parts?.some((pt) => pt.part === 'label')) {
    import('./textGenerator').then(({ loadFont, SINGLE_LINE_FONT_FAMILY }) => {
      loadFont(SINGLE_LINE_FONT_FAMILY).then(() => {
        usePathsStore.getState().updateShapeParams(regenId, params)
      })
    })
  }
  return ids
}
