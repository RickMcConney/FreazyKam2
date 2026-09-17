import { useEffect, useState, memo } from 'react'
import { Group, Path, Image as KonvaImage, Text as KonvaText } from 'react-konva'
import type { Viewport } from '../CanvasStage'
import { usePathsStore } from '../../store/pathsStore'
import { useUIStore } from '../../store/uiStore'
import { canvasTheme } from '../../theme'
import type { LiveTransform } from '../types'
import type { ImportedPath } from '../../store/pathsStore'
import { getBBox, extractRectInfo } from '../selectionUtils'
import { decodeStlMesh } from '../../importers/stlImporter'
import { buildHeightMap } from '../../cam/profile3d'

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

  const grid = buildHeightMap(positions, indices, p.stlModelBounds, bbox, HM_SIZE, HM_SIZE)

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

  // Build height map on a deferred timer so the first render isn't blocked
  useEffect(() => {
    setHmCanvas(null)
    const timer = setTimeout(() => {
      setHmCanvas(buildHeightMapCanvas(p))
    }, 0)
    return () => clearTimeout(timer)
  }, [p.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const attrs = liveTransformToNodeAttrs(lt)
  const strokeWidth = liveStrokeWidth(lt, attrs, isSelected, scale)

  const rect = extractRectInfo(p.d)
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

// ── Main layer ────────────────────────────────────────────────────────────────
// MEMOISED BECAUSE THE STAGE RE-RENDERS ON EVERY MOUSE MOVE and this is the one
// layer whose size is the document's — a gear project reconciled a hundred-odd
// Path elements per move for nothing. Its own props hold still through a
// gesture that is not moving geometry (a point-edit connect preview, the cursor
// readout), and the store subscriptions inside re-render it regardless of memo,
// so nothing goes stale.
export const DesignLayer = memo(function DesignLayer({ viewport, liveTransform, followTransforms, excludePathId, excludeGroupId, excludeClockId }: Props) {
  // Individual selectors — whole-store destructuring re-rendered this layer on
  // every store change, including pure undo-stack pushes (tofix.md H3).
  const paths = usePathsStore((s) => s.paths)
  const selectedIds = usePathsStore((s) => s.selectedIds)
  const darkMode = useUIStore((s) => s.darkMode)
  const C = canvasTheme(darkMode)
  const { scale } = viewport

  return (
    <Group listening={false}>
      {paths.filter((p) => p.visible && !p.hidden && p.id !== excludePathId
        && !(excludeGroupId && p.groupId === excludeGroupId)
        && !(excludeClockId && p.clockId === excludeClockId)).map((p) => {
        const isSelected = selectedIds.includes(p.id)

        // Image-backed paths get special rendering
        if (p.imageSrc) {
          return (
            <ImagePath
              key={p.id}
              p={p}
              isSelected={isSelected}
              liveTransform={liveTransform}
              followTransforms={followTransforms}
              scale={scale}
              darkMode={darkMode}
            />
          )
        }

        // STL-backed paths: dashed bounding box + label
        if (p.stlSrc) {
          return (
            <StlPath
              key={p.id}
              p={p}
              isSelected={isSelected}
              liveTransform={liveTransform}
              followTransforms={followTransforms}
              scale={scale}
              darkMode={darkMode}
            />
          )
        }

        // Normal vector path
        const lt = transformFor(p.id, liveTransform, followTransforms)
        const attrs = liveTransformToNodeAttrs(lt)
        const strokeWidth = liveStrokeWidth(lt, attrs, isSelected, scale)

        return (
          <Path
            key={p.id}
            data={p.d}
            stroke={isSelected ? C.path.selected : p.color}
            strokeWidth={strokeWidth}
            listening={false}
            {...attrs}
          />
        )
      })}
    </Group>
  )
})
