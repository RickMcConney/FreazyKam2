import { useEffect, useState, useMemo, useCallback, useRef, memo } from 'react'
import type Konva from 'konva'
import { Group, Path, Shape, Image as KonvaImage, Text as KonvaText } from 'react-konva'
import type { Viewport } from '../viewport'
import { usePathsStore } from '../../store/pathsStore'
import { patternOriginalsInSelection } from '../../store/patternBodies'
import { linkHighlights } from '../../tools/duplicateFollow'
import { ORIGINAL_COLOR } from '../../colors'
import { useUIStore } from '../../store/uiStore'
import { canvasTheme } from '../../theme'
import type { LiveTransform } from '../types'
import type { ImportedPath } from '../../store/pathsStore'
import { getBBox, extractRectInfo, translateD } from '../selectionUtils'
import { decodeStlMesh } from '../../importers/stlImporter'
import { placeStlModel } from '../../cam/stlPlacement'
import { buildHeightMap } from '../../cam/profile3d'
import { makeBatch, groupInto, strokeBatches, type BatchItem, type StrokeBatch } from '../batchDraw'

interface Props {
  viewport: Viewport
  liveTransform: LiveTransform | null
  /** What the CONSTRAINTS are carrying along with the drag — one transform per
   *  body, each with its own delta, so they cannot ride on `liveTransform`
   *  (which is one transform for the whole dragged selection). Consulted FIRST:
   *  a dragged part that is pinned to a stock edge appears in both, and the
   *  constraint's answer is the one that will actually land. */
  followTransforms?: LiveTransform[] | null
  excludePathId?: string | null
  /** Hide a whole shape group — the escapement animation draws its own copy at
   *  the real centre distance, and a static wheel under the turning one is
   *  unreadable. */
  excludeGroupId?: string | null
  /** Every path of this clock stands aside — ClockAnimLayer is drawing all five
   *  of its wheels itself, assembled and turning. */
  excludeClockId?: string | null
}

// ── Live-transform → Konva node attrs ─────────────────────────────────────────
// Maps an unbaked LiveTransform (drag/resize/rotate/skew in progress) onto the
// Konva node attributes that preview it. Identity attrs when lt is null.

interface LiveNodeAttrs {
  x: number; y: number
  scaleX: number; scaleY: number
  offsetX: number; offsetY: number
  rotation: number
  skewX: number; skewY: number
}

/** The transform previewing this path, constraints taking precedence. */
function transformFor(
  id: string,
  liveTransform: LiveTransform | null,
  followTransforms: LiveTransform[] | null | undefined,
): LiveTransform | null {
  if (followTransforms) {
    for (const ft of followTransforms) if (ft.pathIds.has(id)) return ft
  }
  return liveTransform?.pathIds.has(id) ? liveTransform : null
}

function liveTransformToNodeAttrs(lt: LiveTransform | null): LiveNodeAttrs {
  const a: LiveNodeAttrs = {
    x: 0, y: 0, scaleX: 1, scaleY: 1,
    offsetX: 0, offsetY: 0, rotation: 0, skewX: 0, skewY: 0,
  }
  if (!lt) return a
  if (lt.kind === 'translate') {
    a.x = lt.dx; a.y = lt.dy
  } else if (lt.kind === 'scale') {
    a.offsetX = lt.ax; a.offsetY = lt.ay
    a.x = lt.ax; a.y = lt.ay
    a.scaleX = lt.sx; a.scaleY = lt.sy
  } else if (lt.kind === 'rotate') {
    a.offsetX = lt.cx; a.offsetY = lt.cy
    a.x = lt.cx; a.y = lt.cy
    a.rotation = lt.angle
  } else if (lt.kind === 'skew') {
    a.offsetX = lt.ax; a.offsetY = lt.ay
    a.x = lt.ax; a.y = lt.ay
    a.skewX = lt.kx; a.skewY = lt.ky
  }
  return a
}

// Screen-constant stroke width, compensated during a live scale so the outline
// doesn't fatten/thin with the preview scale.
function liveStrokeWidth(lt: LiveTransform | null, attrs: LiveNodeAttrs, isSelected: boolean, scale: number): number {
  const base = (isSelected ? 2 : 1.5) / scale
  return lt?.kind === 'scale'
    ? base / Math.sqrt(Math.abs(attrs.scaleX * attrs.scaleY))
    : base
}

// ── Single image-backed path ──────────────────────────────────────────────────
// Renders the raster image inside the bounding-box rectangle path.
// Placement proof:
//   - Layer applies scaleY = -viewport.scale (Y-flip)
//   - ImgGroup sits at p0 (the first corner) with the baked rotation applied
//   - FlipGroup (scaleY=-1) cancels the layer's Y-flip so pixels are right-side-up
//   - Image at y = -heightMM means Konva's top-left corner is at y=-h; after
//     FlipGroup that becomes y=+h in outer-local-space → maps to p3 (top-left corner) ✓
//   - Image at y = 0 maps to p0 (bottom-left corner) ✓

interface ImagePathProps {
  p: ImportedPath
  isSelected: boolean
  liveTransform: LiveTransform | null
  followTransforms?: LiveTransform[] | null
  scale: number
  darkMode: boolean
}

const ImagePath = memo(function ImagePath({
  p, isSelected, liveTransform, followTransforms, scale, darkMode,
}: ImagePathProps) {
  const [imgEl, setImgEl] = useState<HTMLImageElement | null>(null)
  const C = canvasTheme(darkMode)

  useEffect(() => {
    const img = new window.Image()
    img.onload = () => setImgEl(img)
    img.src = p.imageSrc!
    return () => { img.onload = null }
  }, [p.imageSrc])

  const lt = transformFor(p.id, liveTransform, followTransforms)
  const attrs = liveTransformToNodeAttrs(lt)
  const strokeWidth = liveStrokeWidth(lt, attrs, isSelected, scale)

  const rect = extractRectInfo(p.d)

  return (
    <Group {...attrs} listening={false}>
      {/* Image: sits at p0, rotated along the first edge, Y-un-flipped */}
      {imgEl && rect && (
        <Group x={rect.p0.x} y={rect.p0.y} rotation={rect.rotationDeg} listening={false}>
          <Group scaleY={-1}>
            <KonvaImage
              image={imgEl}
              x={0}
              y={-rect.heightMM}
              width={rect.widthMM}
              height={rect.heightMM}
              opacity={0.75}
            />
          </Group>
        </Group>
      )}
      {/* Dashed bounding-box outline */}
      <Path
        data={p.d}
        stroke={isSelected ? C.path.selected : p.color}
        strokeWidth={strokeWidth}
        dash={[6 / scale, 4 / scale]}
        listening={false}
      />
    </Group>
  )
})

// ── STL bounding-box path ─────────────────────────────────────────────────────

interface StlPathProps {
  p: ImportedPath
  isSelected: boolean
  liveTransform: LiveTransform | null
  followTransforms?: LiveTransform[] | null
  scale: number
  darkMode: boolean
}

const HM_SIZE = 256

function buildHeightMapCanvas(p: ImportedPath): HTMLCanvasElement | null {
  if (!p.stlSrc || !p.stlModelBounds) return null
  const bbox = getBBox(p.d)
  if (!bbox) return null

  // Shared with the Profile 3D generate and the 3D view — decoded once per model.
  const { positions, indices } = decodeStlMesh(p.stlSrc)
  // Turned to stand as the outline does, as it is cut (cam/stlPlacement.ts). The picture is
  // the height map over the outline's axis-aligned box, so the turn is in its pixels.
  const placed = placeStlModel(positions, p.stlModelBounds, p.d)

  const grid = buildHeightMap(placed.positions, indices, placed.bounds, bbox, HM_SIZE, HM_SIZE)

  let minZ = 0
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] !== -Infinity && grid[i] < minZ) minZ = grid[i]
  }
  const range = Math.abs(minZ) || 1

  const canvas = document.createElement('canvas')
  canvas.width = HM_SIZE
  canvas.height = HM_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const imgData = ctx.createImageData(HM_SIZE, HM_SIZE)

  for (let iy = 0; iy < HM_SIZE; iy++) {
    const gridIy = HM_SIZE - 1 - iy  // flip Y: canvas top = CNC maxY
    for (let ix = 0; ix < HM_SIZE; ix++) {
      const h = grid[gridIy * HM_SIZE + ix]
      const pi = (iy * HM_SIZE + ix) * 4
      if (h === -Infinity) {
        imgData.data[pi + 3] = 0  // transparent outside model footprint
      } else {
        const t = (h - minZ) / range  // 0 = deepest, 1 = surface
        imgData.data[pi]     = Math.round(30  + t * 190)  // R 30→220
        imgData.data[pi + 1] = Math.round(20  + t * 140)  // G 20→160
        imgData.data[pi + 2] = Math.round(10  + t * 70)   // B 10→80
        imgData.data[pi + 3] = 230
      }
    }
  }
  ctx.putImageData(imgData, 0, 0)
  return canvas
}

const StlPath = memo(function StlPath({ p, isSelected, liveTransform, followTransforms, scale, darkMode }: StlPathProps) {
  const C = canvasTheme(darkMode)
  const lt = transformFor(p.id, liveTransform, followTransforms)
  const [hmCanvas, setHmCanvas] = useState<HTMLCanvasElement | null>(null)

  // The picture depends on the model and the outline's SHAPE, not on where it stands: a
  // move (a new `d`, translated) draws the same pixels at a new place, so it is keyed on
  // the outline moved to the origin and rebuilt only for a turn, a resize or a new model.
  // Built on a deferred timer so the first render isn't blocked; the old picture stays up
  // until the new one is ready rather than blanking after every gesture.
  const bb0 = getBBox(p.d)
  const shapeKey = bb0 ? translateD(p.d, -bb0.minX, -bb0.minY) : p.d
  useEffect(() => {
    const timer = setTimeout(() => {
      setHmCanvas(buildHeightMapCanvas(p))
    }, 0)
    return () => clearTimeout(timer)
  }, [p.id, p.stlSrc, p.stlModelBounds, shapeKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const attrs = liveTransformToNodeAttrs(lt)
  const strokeWidth = liveStrokeWidth(lt, attrs, isSelected, scale)

  // PLACED BY THE PATH'S BOX, as the model is cut (cam/stlMapping) and drawn in 3D: the
  // corners' order says nothing about where the model is. Read through extractRectInfo,
  // a MIRRORED outline (Send to Other Side) runs its corners the other way round, and the
  // picture landed a whole model away from the outline that is cut.
  const bb = getBBox(p.d)
  const rect = bb ? { p0: { x: bb.minX, y: bb.minY }, widthMM: bb.width, heightMM: bb.height, rotationDeg: 0 } : null
  const labelSize = 10 / scale

  return (
    <Group {...attrs} listening={false}>
      {/* Height map image — same Y-flip placement as ImagePath */}
      {hmCanvas && rect && (
        <Group x={rect.p0.x} y={rect.p0.y} rotation={rect.rotationDeg} listening={false}>
          <Group scaleY={-1}>
            <KonvaImage
              image={hmCanvas}
              x={0}
              y={-rect.heightMM}
              width={rect.widthMM}
              height={rect.heightMM}
              listening={false}
            />
          </Group>
        </Group>
      )}
      {/* Dashed bounding-box outline */}
      <Path
        data={p.d}
        stroke={isSelected ? C.path.selected : p.color}
        strokeWidth={strokeWidth}
        dash={[6 / scale, 4 / scale]}
        listening={false}
      />
      {/* "STL" label in un-flipped space */}
      {rect && (
        <Group x={rect.p0.x} y={rect.p0.y} rotation={rect.rotationDeg} listening={false}>
          <Group scaleY={-1}>
            <KonvaText
              text="STL"
              x={4 / scale}
              y={4 / scale}
              fontSize={labelSize}
              fill={isSelected ? C.path.selected : p.color}
              opacity={0.8}
              listening={false}
            />
          </Group>
        </Group>
      )}
    </Group>
  )
})

// ── Batched vector paths ─────────────────────────────────────────────────────
// Every plain outline goes through canvas/batchDraw: one stroke per (colour, width), each
// outline's `Path2D` parsed once per path OBJECT (a path is replaced, never mutated, when it
// changes), and only what is in view stroked when zoomed in. Selected paths draw last, so
// on top. Each live transform's paths are a batch of their own, under a Group carrying the
// transform's attrs — the batch itself is built once per gesture, since what is moving does
// not change mid-drag.

const itemCache = new WeakMap<ImportedPath, BatchItem | null>()
function itemOf(p: ImportedPath): BatchItem | null {
  if (itemCache.has(p)) return itemCache.get(p)!
  const b = getBBox(p.d)
  const it = b ? { path: new Path2D(p.d), minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY } : null
  itemCache.set(p, it)
  return it
}

const PLAIN_PX = 1.5
const SELECTED_PX = 2
// An ORIGINAL is drawn in ORIGINAL_COLOR (colors.ts) — a selected pattern's
// (`patternOriginalsInSelection`), or the shape a selected linked copy follows
// (`linkHighlights`): the one whose edit reaches the rest, which otherwise looks
// exactly like them.

/** A linked copy a change to the selection would reshape (`linkHighlights`): the
 *  selection colour, dashed — "this moves with what you have picked". */
const FOLLOWER_DASH_PX = [6, 4]

/** What the selection is tied to, as two sets for `strokeSets` — see `linkHighlights`. */
interface Ties { originals: Set<string>; followers: Set<string> }

function strokeSets(ps: ImportedPath[], selected: Set<string>, selectedColor: string, ties: Ties): StrokeBatch[] {
  const entries: { key: string; item: BatchItem }[] = []
  // Plain first, then the tied, then the selected, so the selection lands on top.
  // An original is green whether or not it is itself selected — it is the shape the
  // selected copies follow, or the pattern's original among its copies.
  const rank = (p: ImportedPath) => (selected.has(p.id) ? 2 : ties.originals.has(p.id) || ties.followers.has(p.id) ? 1 : 0)
  for (const pass of [0, 1, 2]) {
    for (const p of ps) {
      if (rank(p) !== pass) continue
      const item = itemOf(p)
      if (!item) continue
      const key = ties.originals.has(p.id) ? `o|${ORIGINAL_COLOR}`
        : selected.has(p.id) ? `s|${selectedColor}`
        : ties.followers.has(p.id) ? `f|${selectedColor}`
        : `u|${p.color}`
      entries.push({ key, item })
    }
  }
  return [...groupInto(entries)].map(([key, items]) => ({
    color: key.slice(2),
    widthPx: key[0] === 'u' || key[0] === 'f' ? PLAIN_PX : SELECTED_PX,
    ...(key[0] === 'f' ? { dashPx: FOLLOWER_DASH_PX } : {}),
    batch: makeBatch(items),
  }))
}

const PathBatches = memo(function PathBatches({ sets }: { sets: StrokeBatch[] }) {
  const sceneFunc = useCallback((ctx: Konva.Context, shape: Konva.Shape) => strokeBatches(ctx, shape, sets), [sets])
  return (
    <Shape
      sceneFunc={sceneFunc}
      listening={false}
      perfectDrawEnabled={false}
    />
  )
})

// ── Main layer ────────────────────────────────────────────────────────────────
// MEMOISED BECAUSE THE STAGE RE-RENDERS ON EVERY MOUSE MOVE and this is the one
// layer whose size is the document's. Its own props hold still through a gesture
// that is not moving geometry (a point-edit connect preview, the cursor readout),
// and the store subscriptions inside re-render it regardless of memo, so nothing
// goes stale. A pan or zoom re-renders it (the viewport prop) but rebuilds nothing:
// the batches depend on the paths, the selection and what is moving, never the view.
export const DesignLayer = memo(function DesignLayer({ viewport, liveTransform, followTransforms, excludePathId, excludeGroupId, excludeClockId }: Props) {
  // Individual selectors — whole-store destructuring re-rendered this layer on
  // every store change, including pure undo-stack pushes (tofix.md H3).
  const paths = usePathsStore((s) => s.paths)
  const selectedIds = usePathsStore((s) => s.selectedIds)
  const darkMode = useUIStore((s) => s.darkMode)
  const C = canvasTheme(darkMode)
  const { scale } = viewport

  const shown = useMemo(() => paths.filter((p) => p.visible && !p.hidden && p.id !== excludePathId
    && !(excludeGroupId && p.groupId === excludeGroupId)
    && !(excludeClockId && p.clockId === excludeClockId)), [paths, excludePathId, excludeGroupId, excludeClockId])

  // Which transform each plain path is moving under: -1 for none, k for followTransforms[k],
  // followTransforms.length for liveTransform. A new LiveTransform (and Set) arrives every
  // frame of a drag, so this is reduced to a string key and the batches below are keyed on
  // that — rebuilt when a gesture starts or ends, not per frame.
  const transforms = useMemo(() => [...(followTransforms ?? []), ...(liveTransform ? [liveTransform] : [])],
    [followTransforms, liveTransform])
  // The gestures hand out the SAME Set for the same id list every frame (canvas/idSet), so
  // the key is worked out again only when what is moving, or what is shown, changes — not
  // on every mouse move of a select-all drag over a big nest.
  const keyCache = useRef<{ sets: Set<string>[]; shown: ImportedPath[]; key: string } | null>(null)
  let movingKey = ''
  if (transforms.length > 0) {
    const sets = transforms.map((t) => t.pathIds)
    const c = keyCache.current
    if (c && c.shown === shown && c.sets.length === sets.length && c.sets.every((s, i) => s === sets[i])) {
      movingKey = c.key
    } else {
      const parts: string[] = []
      for (const p of shown) {
        if (p.imageSrc || p.stlSrc) continue
        const k = transforms.findIndex((t) => t.pathIds.has(p.id))
        if (k >= 0) parts.push(`${k}:${p.id}`)
      }
      movingKey = parts.join(',')
      keyCache.current = { sets, shown, key: movingKey }
    }
  }

  const ties = useMemo((): Ties => {
    const linked = linkHighlights(paths, selectedIds)
    return {
      originals: new Set([...patternOriginalsInSelection(paths, selectedIds), ...linked.originals]),
      followers: new Set(linked.copies),
    }
  }, [paths, selectedIds])
  const batches = useMemo(() => {
    const selected = new Set(selectedIds)
    const owner = new Map<string, number>()
    for (const e of movingKey ? movingKey.split(',') : []) {
      const i = e.indexOf(':')
      owner.set(e.slice(i + 1), +e.slice(0, i))
    }
    const plain = shown.filter((p) => !p.imageSrc && !p.stlSrc)
    const still = strokeSets(plain.filter((p) => !owner.has(p.id)), selected, C.path.selected, ties)
    const moving = new Map<number, StrokeBatch[]>()
    const byOwner = new Map<number, ImportedPath[]>()
    for (const p of plain) {
      const k = owner.get(p.id)
      if (k === undefined) continue
      const list = byOwner.get(k)
      if (list) list.push(p)
      else byOwner.set(k, [p])
    }
    for (const [k, ps] of byOwner) moving.set(k, strokeSets(ps, selected, C.path.selected, ties))
    return { still, moving }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- movingKey stands for `transforms`' membership
  }, [shown, selectedIds, movingKey, C.path.selected, ties])

  return (
    <Group name="design" listening={false}>
      {shown.map((p) => {
        if (!p.imageSrc && !p.stlSrc) return null
        const isSelected = selectedIds.includes(p.id)
        const Comp = p.imageSrc ? ImagePath : StlPath
        return (
          <Comp
            key={p.id}
            p={p}
            isSelected={isSelected}
            liveTransform={liveTransform}
            followTransforms={followTransforms}
            scale={scale}
            darkMode={darkMode}
          />
        )
      })}
      <PathBatches sets={batches.still} />
      {[...batches.moving].map(([k, sets]) => (
        <Group key={k} {...liveTransformToNodeAttrs(transforms[k] ?? null)} listening={false}>
          <PathBatches sets={sets} />
        </Group>
      ))}
    </Group>
  )
})
