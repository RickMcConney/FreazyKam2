import { memo, useMemo, useRef } from 'react'
import { SIM_CUT_COLOR, SIM_TOOL_CUTTING_COLOR, SIM_TOOL_RAPID_COLOR } from '../../colors'
import { Group, Shape, Image as KonvaImage } from 'react-konva'
import type { Viewport } from '../CanvasStage'
import { useSimStore } from '../../store/simStore'
import { useWorkpieceStore } from '../../store/workpieceStore'
import { getCurrentSegIdx, interpolatePos, segTool, type SimSegment, type ToolState } from '../../sim/gcodeParser'
import { CutTrail, effectiveCutWidthAt, type FrustumSeg } from '../../sim/cutTrail'
import { TrailRaster, cutBBox, type TrailBBox } from '../../sim/trailRaster'
import { SPINDLE_VIS_RPS } from '../../sim/spindleVis'
import { originWorldXY } from '../layers/WorkpieceLayer'

interface Props {
  viewport: Viewport
}

// Top-down cross-section of an N-flute cutter: body circle with one gullet
// notch per flute (outer arc, then a shallower arc at the gullet radius; the
// radial jumps between them read as the flute faces). Built at the origin in
// CNC mm — position and spin are applied via the Shape's x/y/rotation props.
function makeToolSectionFunc(r: number, flutes: number) {
  const n = Math.max(1, Math.min(flutes, 8))
  const span = (2 * Math.PI) / n
  const gulletR = r * 0.55
  return (ctx: any, shape: any) => {
    ctx.beginPath()
    ctx.moveTo(r, 0)
    for (let i = 0; i < n; i++) {
      const a0 = i * span
      ctx.arc(0, 0, r, a0, a0 + span * 0.65, false)
      ctx.arc(0, 0, gulletR, a0 + span * 0.65, a0 + span, false)
    }
    ctx.closePath()
    ctx.fillStrokeShape(shape)
  }
}

// Backward-facing semicircle cap at the start of a frustum segment.
// Arc goes from θ+π/2 counterclockwise (in CNC Y-up) to θ-π/2, covering the backward half.
// anticlockwise=false in canvas Y-down-ctx = CCW in the Y-flipped CNC layer space.
function makeStartCapSceneFunc(af: FrustumSeg) {
  const dx = af.x1 - af.x0, dy = af.y1 - af.y0
  const len = Math.hypot(dx, dy)
  if (len < 0.0001) return null
  const θ = Math.atan2(dy, dx)
  const r = af.w0 / 2
  return (ctx: any, shape: any) => {
    ctx.beginPath()
    ctx.arc(af.x0, af.y0, r, θ + Math.PI / 2, θ - Math.PI / 2, false)
    ctx.closePath()
    ctx.fillStrokeShape(shape)
  }
}

// Builds a Konva sceneFunc that fills all frustum segments as closed quad subpaths.
// Each quad: left-start → left-end → right-end → right-start.
// Coordinates are in CNC mm (the layer's Y-flipped transform handles screen mapping).
function makeFrustumSceneFunc(segs: FrustumSeg[]) {
  return (ctx: any, shape: any) => {
    ctx.beginPath()
    for (const { x0, y0, w0, x1, y1, w1 } of segs) {
      const dx = x1 - x0, dy = y1 - y0
      const len = Math.hypot(dx, dy)
      if (len < 0.0001) continue
      const nx = -dy / len, ny = dx / len   // left-hand normal in CNC Y-up space
      const r0 = w0 / 2, r1 = w1 / 2
      ctx.moveTo(x0 + nx * r0, y0 + ny * r0)
      ctx.lineTo(x1 + nx * r1, y1 + ny * r1)
      ctx.lineTo(x1 - nx * r1, y1 - ny * r1)
      ctx.lineTo(x0 - nx * r0, y0 - ny * r0)
      ctx.closePath()
    }
    ctx.fillStrokeShape(shape)
  }
}

// Completed trail: ONE Konva node — an image of everything cut so far — however long
// the program. What each frame does is paint the segments cut during it into that
// image (see trailRaster.ts); what each REDRAW does, whether from playback, a pan or
// a zoom, is blit it. Re-stroking the vector geometry instead cost tens of ms per
// redraw on a photo v-carve, which is a slow pan long after the program had finished.
interface CompletedTrailProps {
  segments: SimSegment[]
  upToIdx: number
  ox: number
  oy: number
  toolStates: ToolState[]
  bbox: TrailBBox | null
  scale: number
}
const CompletedTrail = memo(function CompletedTrail({ segments, upToIdx, ox, oy, toolStates, bbox, scale }: CompletedTrailProps) {
  const trailRef = useRef<CutTrail | null>(null)
  const rasterRef = useRef<TrailRaster | null>(null)
  const drawnGenRef = useRef(-1)
  const trail = trailRef.current ?? (trailRef.current = new CutTrail())
  const raster = rasterRef.current ?? (rasterRef.current = new TrailRaster())

  trail.sync(segments, upToIdx, ox, oy, toolStates)

  // Reallocated (first frame, or the user zoomed in past what the image holds) or
  // restarted (rewind, new program) — either way what is on the image is not what the
  // trail says, so paint all of it. Otherwise paint only the difference.
  const resized = bbox ? raster.ensure(bbox, scale) : false
  if (bbox) {
    if (resized || trail.generation !== drawnGenRef.current) {
      if (!resized) raster.clear()
      raster.strokePolys(trail.byWidth, SIM_CUT_COLOR)
      raster.fillFrustums(trail.frustums, SIM_CUT_COLOR)
      drawnGenRef.current = trail.generation
    } else {
      raster.strokePolys(trail.pendingByWidth, SIM_CUT_COLOR)
      raster.fillFrustums(trail.pendingFrustums, SIM_CUT_COLOR)
    }
  }
  trail.drainPending()

  const img = raster.canvas
  if (!img || !bbox) return null

  // The image is painted rows-down; this layer is Y-flipped, so un-flip it the same
  // way DesignLayer draws an imported picture.
  return (
    <Group x={bbox.x0} y={bbox.y0} listening={false}>
      <Group scaleY={-1}>
        <KonvaImage
          image={img}
          x={0}
          y={-raster.heightMM}
          width={raster.widthMM}
          height={raster.heightMM}
          opacity={0.55}
          listening={false}
        />
      </Group>
    </Group>
  )
})

export const SimulationLayer = memo(function SimulationLayer({ viewport }: Props) {
  // Already top-referenced — simStore.loadGcode takes the datum offset off once.
  const segments = useSimStore((s) => s.segments)
  const toolStates = useSimStore((s) => s.toolStates)
  const elapsedTimeS = useSimStore((s) => s.elapsedTimeS)
  const simSpeed = useSimStore((s) => s.speed)
  const gcode = useSimStore((s) => s.gcode)
  const { scale } = viewport

  const { widthMM, heightMM, origin } = useWorkpieceStore()
  const org = originWorldXY(origin, widthMM, heightMM)
  const ox = org.x
  const oy = org.y

  // Where the trail image has to reach. Grown by the widest cut in the program so a
  // stroke at the edge isn't clipped in half.
  const trailBBox = useMemo(() => {
    let widest = 0
    for (const ts of toolStates) if (ts.toolDiameterMM > widest) widest = ts.toolDiameterMM
    return cutBBox(segments, ox, oy, widest / 2 + 1)
  }, [segments, toolStates, ox, oy])

  if (!gcode || segments.length === 0) return null

  const curSegIdx = getCurrentSegIdx(segments, elapsedTimeS)
  const pos = interpolatePos(segments, elapsedTimeS)
  if (!pos) return null

  const curSeg = curSegIdx >= 0 ? segments[curSegIdx] : null
  const isCutting = !!curSeg && !curSeg.rapid && (curSeg.prevZ < -0.001 || pos.z < -0.001)
  const tx = pos.x + ox
  const ty = pos.y + oy

  // Active partial segment: frustum when widths differ, plain line otherwise.
  // Always a Shape so the element type stays stable across frames (no React remounting).
  const activeFrustum: FrustumSeg | null = curSeg && isCutting ? {
    x0: curSeg.prevX + ox, y0: curSeg.prevY + oy,
    w0: effectiveCutWidthAt(curSeg, curSeg.prevZ, toolStates),
    x1: tx, y1: ty,
    w1: effectiveCutWidthAt(curSeg, pos.z, toolStates),
  } : null

  const activeCutWidth = activeFrustum ? activeFrustum.w1 : (curSeg ? segTool(curSeg, toolStates).toolDiameterMM : 0)
  const toolRadius = Math.max(activeCutWidth / 2, 1.5 / scale)

  return (
    <Group listening={false}>
      <CompletedTrail
        segments={segments} upToIdx={curSegIdx - 1}
        ox={ox} oy={oy} toolStates={toolStates}
        bbox={trailBBox} scale={scale}
      />

      {/* Active partial segment — 60fps updates */}
      {activeFrustum && (() => {
        const capFn = makeStartCapSceneFunc(activeFrustum)
        return (
          <>
            {capFn && (
              <Shape
                sceneFunc={capFn}
                fill={SIM_CUT_COLOR}
                strokeWidth={0}
                opacity={0.55}
                listening={false}
              />
            )}
            <Shape
              sceneFunc={makeFrustumSceneFunc([activeFrustum])}
              fill={SIM_CUT_COLOR}
              strokeWidth={0}
              opacity={0.55}
              listening={false}
            />
          </>
        )
      })()}

      {/* Tool indicator: rotating cutter cross-section.
          Konva rotation inside the Y-flipped layer appears CCW on screen, so
          the negative angle spins M3-clockwise as seen from above. Angle is
          sim time normalized by playback speed — wall-clock rate during
          playback (matching the 3D view), but frozen on zoom/pan redraws and
          while paused, since it only advances when elapsedTimeS advances. */}
      <Shape
        x={tx} y={ty}
        rotation={-((elapsedTimeS / simSpeed) * SPINDLE_VIS_RPS * 360) % 360}
        sceneFunc={makeToolSectionFunc(toolRadius, curSeg ? segTool(curSeg, toolStates).fluteCount : 2)}
        fill={isCutting ? SIM_TOOL_CUTTING_COLOR : SIM_TOOL_RAPID_COLOR}
        opacity={0.95}
        listening={false}
      />
    </Group>
  )
})
