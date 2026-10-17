import { cellOffset, opCell, sameCell, type Cell } from '../cam/sheets'
import { currentSheet, pathCell, simProgramIsStaleNow } from '../canvas/useSheets'
import { useUIStore } from '../store/uiStore'
import { useEffect, useRef, useState } from 'react'
import { perfLog } from '../debug'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { useSimStore } from '../store/simStore'
import { useToolpathStore, type MotionSegment } from '../store/toolpathStore'
import { useWorkpieceStore, zDatumOffsetMM } from '../store/workpieceStore'
import { useToolStore } from '../store/toolStore'
import { usePathsStore } from '../store/pathsStore'
import { getCurrentSegIdx, interpolatePos, segFraction, segTool, type SimSegment } from '../sim/gcodeParser'
import { flattenPath } from '../cam/pathFlattener'
import { cornerRadiusMM, fluteHelixFromName, includedAngleDeg, isVCutter, maxCutRadiusMM, type FluteHelix } from '../cam/geom'
import { getBBox } from '../canvas/selectionUtils'
import { THREE_BG_COLOR_THREE, MATERIAL_COLORS } from '../colors'
import { HeightfieldMaterial } from './HeightfieldMaterial'
import { buildToolMesh } from './toolMesh'
import { getWoodTexture, setWoodTextureListener, woodTileMM } from './woodTexture'
import SimulationPlayer from '../sim/SimulationPlayer'
// M3 (clockwise viewed from above) is negative rotation about three's +Y.
import { SPINDLE_VIS_RPS } from '../sim/spindleVis'
import { originWorldXY } from '../canvas/layers/WorkpieceLayer'
import { decodeStlMesh, type StlMesh } from '../importers/stlImporter'
import type { StlModelBounds } from '../importers/stlImporter'

// Time constant of the Follow Tool camera low-pass, in ms — the time the target
// takes to close ~63% of its distance to the tool. Larger is calmer and laggier.
const FOLLOW_TAU_MS = 450

// ─── coordinate mapping ──────────────────────────────────────────────────────
//
// CNC space: X right, Y away-from-viewer (up in 2D canvas), Z up (into material = negative)
// Three.js:  X right, Y up, Z toward viewer
//
// Mapping: threeX = cncX,  threeY = thicknessMM + cncZ,  threeZ = -cncY

function cncToThree(x: number, y: number, z: number, T: number): [number, number, number] {
  return [x, T + z, -y]
}


// ─── helpers ────────────────────────────────────────────────────────────────

function buildCNCAxes(size: number): THREE.LineSegments {
  const pos = new Float32Array([
    0, 0, 0,   size, 0,    0,
    0, 0, 0,   0,    0,   -size,
    0, 0, 0,   0,    size,  0,
  ])
  const col = new Float32Array([
    1, 0, 0,   1, 0, 0,
    0, 1, 0,   0, 1, 0,
    0, 0, 1,   0, 0, 1,
  ])
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('color',    new THREE.BufferAttribute(col, 3))
  return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true }))
}

function disposeObject3D(obj: THREE.Object3D) {
  obj.traverse(child => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose()
      const disposeMat = (m: THREE.Material) => {
        ;(m as THREE.MeshPhongMaterial).map?.dispose()
        m.dispose()
      }
      if (Array.isArray(child.material)) child.material.forEach(disposeMat)
      else disposeMat(child.material as THREE.Material)
    }
  })
}

// ─── scene refs ──────────────────────────────────────────────────────────────

interface StlGeoCacheEntry {
  mesh: StlMesh                          // the shared decoded model (decodeStlMesh) — read only
  stlSrc: string                         // the model it was decoded from, compared by identity
  bakedGeo: THREE.BufferGeometry | null  // vertex-transformed geometry, keyed by bakedKey
  bakedKey: string                       // `${path.d}|${T}` — invalidate on placement or thickness change
}

// A toolpath line built for exactly this segments array at this stock thickness — see
// rebuildToolpaths.
interface ToolpathLineEntry {
  segments: MotionSegment[]
  T: number
  color: string
  line: THREE.LineSegments
}

interface SceneRefs {
  toolpathLines: Map<string, ToolpathLineEntry>  // op.id → its cached line
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  workpieceGroup: THREE.Group
  toolpathGroup: THREE.Group
  shapesGroup: THREE.Group
  toolMesh: THREE.Object3D | null
  axesHelper: THREE.Object3D
  gridHelper: THREE.LineSegments
  heightfield: HeightfieldMaterial | null    // alternate GPU heightfield strategy
  simSegments: SimSegment[]                  // the store's (top-referenced) segments the carve was built from
  // The loaded program belongs to another sheet than the one on show (simProgramIsStale):
  // the loop then draws neither carve nor tool until the active sheet's program arrives.
  // Kept here, refreshed by the subscriptions that can change it, so the frame loop does
  // not re-derive the sheet layout sixty times a second.
  simStale: boolean
  stlGeoCache: Map<string, StlGeoCacheEntry>  // path.id → parsed raw geometry
  rafId: number
  running: boolean            // is the rAF loop currently scheduled?
  fpsSamples: number[]
  lastFrameTs: number
  renderNeeded: boolean
  activeToolKey: string  // encodes type+diam+angle; rebuild mesh when it changes
}

// ─── component ───────────────────────────────────────────────────────────────

export default function ThreeView() {
  const containerRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<SceneRefs | null>(null)
  const fpsRef = useRef<HTMLSpanElement>(null)

  const [showAxes, setShowAxes] = useState(false)
  const [showToolpaths, setShowToolpaths] = useState(false)
  const [showWorkpiece, setShowWorkpiece] = useState(true)
  const [showTool, setShowTool] = useState(true)
  const [showShapes, setShowShapes] = useState(true)
  const [followTool, setFollowTool] = useState(false)
  // The simulator's readout and controls, hidden for a clean screenshot of the carve.
  const [showReadout, setShowReadout] = useState(true)

  const showAxesRef      = useRef(showAxes)
  const showToolpathsRef = useRef(showToolpaths)
  const showWorkpieceRef = useRef(showWorkpiece)
  const showToolRef      = useRef(showTool)
  const showShapesRef    = useRef(showShapes)
  const followToolRef    = useRef(followTool)
  showAxesRef.current      = showAxes
  showToolpathsRef.current = showToolpaths
  showWorkpieceRef.current = showWorkpiece
  showToolRef.current      = showTool
  showShapesRef.current    = showShapes
  followToolRef.current    = followTool

  // Restarts the suspended rAF loop; assigned once the scene is built. The
  // visibility toggles above are plain refs the loop polls, so flipping one
  // while the loop is parked has to wake it explicitly — nothing else would.
  const wakeRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    wakeRef.current?.()
  }, [showAxes, showToolpaths, showWorkpiece, showTool, showShapes, followTool])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    renderer.setSize(container.clientWidth, container.clientHeight)
    renderer.setClearColor(THREE_BG_COLOR_THREE)
    container.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(THREE_BG_COLOR_THREE)

    scene.add(new THREE.AmbientLight(0xffffff, 0.6))
    const sun = new THREE.DirectionalLight(0xffffff, 1.0)
    sun.position.set(1, 2, 1)
    scene.add(sun)

    const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 5000)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.1
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    }

    const workpieceGroup = new THREE.Group()
    const toolpathGroup  = new THREE.Group()
    const shapesGroup    = new THREE.Group()
    scene.add(workpieceGroup)
    scene.add(toolpathGroup)
    scene.add(shapesGroup)

    const axesHelper = buildCNCAxes(40)
    scene.add(axesHelper)

    const gridHelper = buildRectGrid(200, 200, 20)
    gridHelper.position.y = -0.5
    scene.add(gridHelper)

    const refs: SceneRefs = {
      renderer, scene, camera, controls,
      workpieceGroup, toolpathGroup, shapesGroup,
      toolMesh: null,
      axesHelper,
      gridHelper,
      heightfield: null,
      simSegments: [],
      simStale: simProgramIsStaleNow(),
      stlGeoCache: new Map(),
      toolpathLines: new Map(),
      rafId: 0,
      running: false,
      fpsSamples: [],
      lastFrameTs: 0,
      renderNeeded: true,
      activeToolKey: '',
    }
    sceneRef.current = refs

    // Render-on-demand AND loop-on-demand: the rAF loop suspends itself once
    // there is nothing left to animate, so an idle 3D tab costs nothing at all
    // (it previously kept ticking — sampling FPS, polling four stores, running
    // controls damping — just to decide not to draw). Anything that changes the
    // scene from OUTSIDE a frame must call wake() rather than setting
    // renderNeeded directly, or the change would sit unpainted until something
    // else happened to restart the loop.
    const wake = () => {
      refs.renderNeeded = true
      if (refs.running) return
      refs.running = true
      // Reset the frame clock so the first frame back doesn't see a dt covering
      // the whole idle period (which would spin the tool by that entire span).
      refs.lastFrameTs = performance.now()
      refs.rafId = requestAnimationFrame(animate)
    }
    wakeRef.current = wake

    controls.addEventListener('change', wake)

    // ─── Coming back from sleep ──────────────────────────────────────────────
    //
    // This view renders ON DEMAND, so anything that blanks it without changing
    // the scene leaves it blank for good: nothing asks for the frame that would
    // put it back. Two such things, and both happen when the machine sleeps.
    //
    // The GPU context can be TAKEN AWAY (`webglcontextlost`), and the browser
    // will only try to give it back if the default is prevented — otherwise the
    // loss is permanent and the view is black until the tab is reloaded. three
    // re-uploads its buffers and textures on the next render after a restore, so
    // asking for that frame is the whole of the recovery.
    //
    // And the canvas's pixels can simply be dropped while the page is hidden,
    // context intact, which shows as the same black rectangle. A frame on
    // becoming visible again covers that one, and costs a single render.
    const canvas = renderer.domElement
    const onContextLost = (e: Event) => {
      e.preventDefault()
      console.warn('[3d] WebGL context lost — waiting for the browser to restore it')
    }
    const onContextRestored = () => { wake() }
    const onVisible = () => { if (document.visibilityState === 'visible') wake() }
    canvas.addEventListener('webglcontextlost', onContextLost)
    canvas.addEventListener('webglcontextrestored', onContextRestored)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)

    rebuildWorkpiece(refs)
    rebuildToolpaths(refs)
    rebuildShapes(refs)
    fitCamera(refs)

    const ro = new ResizeObserver(() => {
      const w = container.clientWidth, h = container.clientHeight
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      wake()
    })
    ro.observe(container)

    function animate(now: number) {
      const dt = now - refs.lastFrameTs
      refs.lastFrameTs = now
      if (dt > 0 && dt < 500) {
        refs.fpsSamples.push(1000 / dt)
        if (refs.fpsSamples.length > 30) refs.fpsSamples.shift()
        if (refs.fpsSamples.length === 30 && fpsRef.current) {
          const avg = refs.fpsSamples.reduce((a, b) => a + b, 0) / 30
          fpsRef.current.textContent = `${Math.round(avg)} fps`
        }
      }

      const axVis = showAxesRef.current
      const tpVis = showToolpathsRef.current
      const wpVis = showWorkpieceRef.current
      const shVis = showShapesRef.current
      if (refs.axesHelper.visible     !== axVis) { refs.axesHelper.visible     = axVis; refs.renderNeeded = true }
      if (refs.toolpathGroup.visible  !== tpVis) { refs.toolpathGroup.visible  = tpVis; refs.renderNeeded = true }
      if (refs.workpieceGroup.visible !== wpVis) { refs.workpieceGroup.visible = wpVis; refs.renderNeeded = true }
      if (refs.heightfield   && refs.heightfield.group.visible !== wpVis) { refs.heightfield.group.visible = wpVis; refs.renderNeeded = true }
      if (refs.shapesGroup.visible    !== shVis) { refs.shapesGroup.visible    = shVis; refs.renderNeeded = true }

      const sim = useSimStore.getState()

      if (sim.gcode && sim.segments.length > 0 && !refs.simStale) {
        const segIdx = getCurrentSegIdx(sim.segments, sim.elapsedTimeS)
        const pos    = interpolatePos(sim.segments, sim.elapsedTimeS)
        const wp     = useWorkpieceStore.getState()
        const T      = wp.thicknessMM
        const org    = originWorldXY(wp.origin, wp.widthMM, wp.heightMM)
        // sim.segments are already top-referenced (simStore.loadGcode), so pos.z is too.

        // Rebuild tool mesh if the current segment uses a different tool type/size
        const activeSeg = sim.segments[segIdx]
        if (activeSeg) {
          const ts = segTool(activeSeg, sim.toolStates)
          let tType = 'flat', tDiam = ts.toolDiameterMM, tAngle = 60
          const tTip = ts.toolTipRadiusMM ? ts.toolTipRadiusMM * 2 : 0
          if (ts.toolVbitHalfAngleTan) {
            tType  = tTip > 0 ? 'taper' : 'vbit'
            tAngle = Math.atan(ts.toolVbitHalfAngleTan) * (180 / Math.PI) * 2
          } else if (ts.toolBallNose) {
            tType = 'ball'
          } else if (ts.toolCornerRadiusMM) {
            tType = 'bull'
          } else if (ts.toolDrill) {
            tType = 'drill'
          }
          // The tip is part of the shape, so it belongs in the key — without it a
          // taper and a V-bit of the same diameter and angle share a mesh.
          const key = `${tType}|${tDiam}|${tAngle}|${ts.fluteCount}|${tTip}|${ts.toolCornerRadiusMM ?? 0}|${ts.toolHelix ?? 'up'}`
          if (key !== refs.activeToolKey) {
            buildToolIndicatorForParams(refs, tType, tDiam, tAngle, ts.fluteCount, tTip, ts.toolCornerRadiusMM ?? 0, ts.toolHelix)
            refs.activeToolKey = key
          }
        }

        if (refs.toolMesh) {
          const toolVis = showToolRef.current
          if (refs.toolMesh.visible !== toolVis) { refs.toolMesh.visible = toolVis; refs.renderNeeded = true }
          if (pos && toolVis) {
            const [tx, ty, tz] = cncToThree(pos.x + org.x, pos.y + org.y, pos.z, T)
            refs.toolMesh.position.set(tx, ty, tz)
            refs.renderNeeded = true
          }
          if (toolVis && sim.playing && dt > 0 && dt < 500) {
            refs.toolMesh.rotation.y -= 2 * Math.PI * SPINDLE_VIS_RPS * (dt / 1000)
            refs.renderNeeded = true
          }
        }

        if (followToolRef.current && pos) {
          // Follow the tool in the XY plane ONLY. Three's Y is the vertical
          // (T + cncZ), and Z is the axis that moves fastest and least usefully:
          // a v-carve rides the Z up and down within a single stroke, and a
          // target that tracked it would swing the camera on every plunge. The
          // tool travels across the work slowly enough to watch; it plunges too
          // fast. So the target keeps whatever height it already has — the one
          // the user framed — and only slides along with the cut.
          const [tx, , tz] = cncToThree(pos.x + org.x, pos.y + org.y, pos.z, T)

          // …and it lags the tool through a first-order low-pass rather than
          // sitting on it. Lettering and detail work dart back and forth over a
          // few mm many times a second; a target pinned to the tip hands all of
          // that straight to the camera, which is what makes it sickening to
          // watch. The filter's gain falls off as 1/(2π·f·τ), so a 5 Hz, 2 mm
          // wiggle reaches the camera as ~0.15 mm — still — while a traverse,
          // which is a step and not an oscillation, is tracked with a steady
          // lag of feed·τ (~20 mm at 50 mm/s) that costs nothing to look at.
          // dt is clamped so a long frame (a carve catching up, a backgrounded
          // tab) can't overshoot, and skipped when the clock hasn't advanced.
          const step = dt > 0 ? Math.min(dt, 100) : 0
          const k    = 1 - Math.exp(-step / FOLLOW_TAU_MS)
          const tgt  = refs.controls.target
          tgt.x += (tx - tgt.x) * k
          tgt.z += (tz - tgt.z) * k
          // The glide outlives whatever woke the frame — a paused sim, the last
          // segment of a program — so it has to keep the loop alive itself
          // until it has actually arrived.
          if (Math.abs(tx - tgt.x) + Math.abs(tz - tgt.z) > 1e-3) refs.renderNeeded = true
        }

        if (refs.heightfield) {
          const seg = sim.segments[segIdx]
          // Along the move by DISTANCE, not time: with acceleration the two differ, and the
          // carve must end where the tool is drawn.
          const t = seg && seg.durationS > 1e-9 ? segFraction(seg, sim.elapsedTimeS) : 1
          refs.heightfield.applyUpTo(refs.simSegments, segIdx, t)
        }
      } else {
        if (refs.toolMesh && refs.toolMesh.visible) { refs.toolMesh.visible = false; refs.renderNeeded = true }

        if (refs.heightfield && refs.heightfield.anyCarved) refs.heightfield.reset()
      }

      if (refs.heightfield) {
        if (refs.heightfield.flushToGPU()) refs.renderNeeded = true
      }

      // Returns true while the camera is still moving (damping easing out).
      // That's the one continuous animation with no event to wake us — the
      // 'change' listener fires during it, but it can't distinguish "still
      // settling" from "settled", so the return value drives the loop instead.
      const controlsMoving = controls.update()

      if (refs.renderNeeded) {
        renderer.render(scene, camera)
        refs.renderNeeded = false
      }

      // Keep going only while something is actually animating. renderNeeded can
      // have been set again during this frame (a store subscription firing
      // mid-frame, or heightfield work that outlived the render).
      // …including a carve that ran out of its frame budget: a jump (a program opening on
      // its finished state, a rewind, a scrubber drag) is carved over several frames, and
      // a chunk that lowered nothing has no dirty texture to keep the loop awake for it.
      if (sim.playing || controlsMoving || refs.renderNeeded || refs.heightfield?.catchingUp) {
        refs.rafId = requestAnimationFrame(animate)
      } else {
        refs.running = false
        // Don't leave the readout showing the last live number — nothing is
        // being drawn, and the samples either side of the gap aren't a rate.
        refs.fpsSamples = []
        if (fpsRef.current) fpsRef.current.textContent = 'idle'
      }
    }
    wake()

    // EACH SUBSCRIPTION COMPARES THE SLICE IT DRAWS. Unconditional, they rebuilt on every
    // write to their store: toggling mm/in, or nudging rigidity, max feed or safe height,
    // rebuilt the whole simulation heightfield (up to 4M samples, re-carved) and re-framed
    // the camera over the user's own orbit; every status or segments write during a Generate
    // rebuilt every op's toolpath; every selection click re-flattened every shape.
    const unsubWP = useWorkpieceStore.subscribe((s, p) => {
      const sized = s.widthMM !== p.widthMM || s.heightMM !== p.heightMM || s.thicknessMM !== p.thicknessMM
      if (!sized && s.origin === p.origin && s.zOrigin === p.zOrigin && s.material === p.material) return
      rebuildWorkpiece(refs)
      // Toolpaths and shape outlines are drawn on the stock top, so a new thickness moves
      // them too — they used to stay floating at the old height.
      // A new stock size moves every sheet after the first (cam/sheets) too.
      if (s.thicknessMM !== p.thicknessMM || s.heightMM !== p.heightMM || s.widthMM !== p.widthMM) { rebuildToolpaths(refs); rebuildShapes(refs) }
      // Only a new stock SIZE re-frames the view.
      if (sized) fitCamera(refs)
      wake()
    })
    const unsubTP = useToolpathStore.subscribe((s, p) => {
      if (s.operations === p.operations) return
      rebuildToolpaths(refs)   // cached per op: only ops whose segments changed are rebuilt
      refs.simStale = simProgramIsStaleNow()
      wake()
    })
    // Wakes on ANY sim change, not just a new program: dragging the scrubber
    // moves elapsedTimeS with no other signal, and the loop is what advances the
    // tool position and heightfield carving to match.
    const unsubSim = useSimStore.subscribe((state, prev) => {
      if (state.gcode !== prev.gcode) {
        refs.fpsSamples = []
        rebuildSim(refs)
        buildToolIndicator(refs)
      }
      if (state.sheet !== prev.sheet || state.autoReload !== prev.autoReload || state.gcode !== prev.gcode) {
        refs.simStale = simProgramIsStaleNow()
      }
      wake()
    })
    const unsubPaths = usePathsStore.subscribe((s, p) => {
      if (s.paths === p.paths) return   // a selection change draws nothing here
      rebuildShapes(refs)
      // A part dragged onto another sheet takes its toolpath with it.
      rebuildToolpaths(refs)
      // …and can make or empty a sheet, which can move the one on show.
      refs.simStale = simProgramIsStaleNow()
      wake()
    })
    const unsubSheet = useUIStore.subscribe((s, p) => {
      if (sameCell(s.activeSheet, p.activeSheet)) return
      rebuildShapes(refs)
      rebuildToolpaths(refs)
      refs.simStale = simProgramIsStaleNow()
      wake()
    })

    // Repaint when an async wood photo texture finishes loading (render-on-demand).
    setWoodTextureListener(wake)

    return () => {
      cancelAnimationFrame(refs.rafId)
      refs.running = false
      wakeRef.current = null
      canvas.removeEventListener('webglcontextlost', onContextLost)
      canvas.removeEventListener('webglcontextrestored', onContextRestored)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
      ro.disconnect()
      setWoodTextureListener(null)
      unsubWP(); unsubTP(); unsubSim(); unsubPaths(); unsubSheet()
      if (refs.heightfield) refs.heightfield.dispose()
      if (refs.toolMesh) disposeObject3D(refs.toolMesh)
      // The decoded model is shared (decodeStlMesh) and plain arrays; only the baked geometry is ours.
      for (const entry of refs.stlGeoCache.values()) entry.bakedGeo?.dispose()
      refs.stlGeoCache.clear()
      for (const entry of refs.toolpathLines.values()) disposeToolpathLine(entry.line)
      refs.toolpathLines.clear()
      renderer.dispose()
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement)
    }
  }, [])

  return (
    <div ref={containerRef} className="w-full h-full relative overflow-hidden">
      {/* Hidden, not unmounted: the player owns the playback loop, so a carve keeps
          running (and Space still plays and pauses) while its readout is out of the shot. */}
      <div className={showReadout ? undefined : 'hidden'}>
        <SimulationPlayer />
        <span ref={fpsRef} className="absolute top-2 left-2 text-xs text-neutral-500 pointer-events-none select-none" />
      </div>

      <div className="absolute top-2 right-2 z-10 flex flex-col gap-1">
        {([
          ['Axes',        showAxes,      setShowAxes],
          ['Toolpaths',   showToolpaths, setShowToolpaths],
          ['Stock',       showWorkpiece, setShowWorkpiece],
          ['Tool',        showTool,      setShowTool],
          ['Shapes',      showShapes,    setShowShapes],
          ['Follow Tool', followTool,    setFollowTool],
          ['Readout',     showReadout,   setShowReadout],
        ] as [string, boolean, (v: boolean) => void][]).map(([label, val, set]) => (
          <button
            key={label}
            onClick={() => set(!val)}
            className={[
              'px-2 py-0.5 text-xs rounded border transition-colors',
              val
                ? 'bg-blue-600 border-blue-500 text-white'
                : 'bg-neutral-800/80 border-neutral-600 text-neutral-400',
            ].join(' ')}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── scene builder helpers ───────────────────────────────────────────────────

// Rounds a raw step to the nearest human-readable value (1, 2, 5, 10, 20, 50…)
function niceStep(raw: number): number {
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const n = raw / mag
  if (n < 1.5) return mag
  if (n < 3.5) return 2 * mag
  if (n < 7.5) return 5 * mag
  return 10 * mag
}

// Builds a rectangular grid (W×H workpiece, 1 step margin each side) as LineSegments.
// Unlike GridHelper, this is not square so it fits non-square workpieces without
// over-extending in the shorter dimension.
function buildRectGrid(W: number, H: number, step: number): THREE.LineSegments {
  const pts: number[] = []
  const x0 = -step,    x1 = W + step
  const z0 = -(H + step), z1 = step
  for (let z = z0; z <= z1 + step * 1e-6; z += step) {
    pts.push(x0, 0, z,  x1, 0, z)
  }
  for (let x = x0; x <= x1 + step * 1e-6; x += step) {
    pts.push(x, 0, z0,  x, 0, z1)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3))
  return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x2a2a2a }))
}

function clearGroup(group: THREE.Group) {
  while (group.children.length) {
    const child = group.children[0] as THREE.Mesh
    if (!child.userData.cachedGeo) child.geometry?.dispose()
    if (Array.isArray(child.material)) child.material.forEach(m => m.dispose())
    else (child.material as THREE.Material)?.dispose()
    group.remove(child)
  }
}

function rebuildWorkpiece(refs: SceneRefs) {
  clearGroup(refs.workpieceGroup)

  const wp  = useWorkpieceStore.getState()
  const { widthMM: W, heightMM: H, thicknessMM: T, origin } = wp
  const org = originWorldXY(origin, W, H)

  // Pin the origin gizmo at the chosen Z datum: top surface (Y=T) for top-of-stock,
  // stock bottom (Y=0) for bottom-of-stock.
  refs.axesHelper.position.set(org.x, T - zDatumOffsetMM(wp.zOrigin, T), -org.y)

  refs.scene.remove(refs.gridHelper)
  refs.gridHelper.geometry.dispose()
  ;(refs.gridHelper.material as THREE.Material).dispose()
  const step = niceStep(Math.max(W, H) / 10)
  refs.gridHelper = buildRectGrid(W, H, step)
  refs.gridHelper.position.y = -0.5
  refs.scene.add(refs.gridHelper)

  rebuildSim(refs)
  buildToolIndicator(refs)
}

// Build the simulation material (GPU displaced-plane heightfield).
function rebuildSim(refs: SceneRefs) {
  rebuildHeightfield(refs)
}

function disposeHeightfield(refs: SceneRefs) {
  if (refs.heightfield) {
    refs.scene.remove(refs.heightfield.group)
    refs.heightfield.dispose()
    refs.heightfield = null
  }
}

function rebuildHeightfield(refs: SceneRefs) {
  disposeHeightfield(refs)

  const wp  = useWorkpieceStore.getState()
  const { widthMM: W, heightMM: H, thicknessMM: T, material, origin, zOrigin } = wp
  const org = originWorldXY(origin, W, H)
  const { segments, toolStates } = useSimStore.getState()
  refs.simSegments = segments

  // A photo v-carve is finished by painting the board and sanding the face back, so
  // the cuts end up DARK against bare wood — the opposite of the fresh-cut look, and
  // the only way to judge whether the carve reads as a picture. When the program
  // contains one, show the whole board that way: the paint doesn't stop at the photo's
  // edge, it fills every cut that was made before it.
  const paintedCuts = useToolpathStore.getState().operations
    .some((o) => o.type === 'photovcarve' && o.visible)
  const hf = new HeightfieldMaterial(W, H, T, segments, toolStates, org.x, org.y, getWoodTexture(material), woodTileMM(material), zOrigin, paintedCuts, MATERIAL_COLORS[material].opacity ?? 1)
  refs.heightfield = hf
  refs.scene.add(hf.group)
  perfLog(`[heightfield] built ${hf.topZ.length.toLocaleString()} samples @ ${hf.cellMM.toFixed(3)}mm cell`)
}

function buildToolIndicatorForParams(refs: SceneRefs, toolType: string, diamMM: number, vbitAngleDeg: number, fluteCount = 2, tipDiaMM = 0, cornerMM = 0, helix: FluteHelix = 'up') {
  if (refs.toolMesh) {
    refs.scene.remove(refs.toolMesh)
    disposeObject3D(refs.toolMesh)
    refs.toolMesh = null
  }
  const mesh = buildToolMesh(toolType, diamMM, vbitAngleDeg, fluteCount, tipDiaMM, cornerMM, helix)
  mesh.visible = false
  refs.scene.add(mesh)
  refs.toolMesh = mesh
}

// Build the tool indicator from the first non-rapid sim segment, or fall back
// to the first tool in the library.
function buildToolIndicator(refs: SceneRefs) {
  refs.activeToolKey = ''

  const { segments, toolStates } = useSimStore.getState()
  let toolType = 'flat', diamMM = 3, vbitAngleDeg = 60, fluteCount = 2, tipDiaMM = 0, cornerMM = 0
  let helix: FluteHelix = 'up'

  for (const seg of segments) {
    if (!seg.rapid) {
      const ts = segTool(seg, toolStates)
      diamMM = ts.toolDiameterMM
      fluteCount = ts.fluteCount
      helix = ts.toolHelix ?? 'up'
      tipDiaMM = ts.toolTipRadiusMM ? ts.toolTipRadiusMM * 2 : 0
      if (ts.toolVbitHalfAngleTan) {
        toolType = tipDiaMM > 0 ? 'taper' : 'vbit'
        vbitAngleDeg = Math.atan(ts.toolVbitHalfAngleTan) * (180 / Math.PI) * 2
      } else if (ts.toolBallNose) {
        toolType = 'ball'
      } else if (ts.toolCornerRadiusMM) {
        toolType = 'bull'
        cornerMM = ts.toolCornerRadiusMM
      } else if (ts.toolDrill) {
        toolType = 'drill'
      }
      break
    }
  }

  if (!segments.length) {
    const t = useToolStore.getState().tools[0]
    if (!t) return
    toolType   = t.type
    diamMM     = t.diameterMM
    fluteCount = t.fluteCount
    if (isVCutter(t)) vbitAngleDeg = includedAngleDeg(t)
    // A library taper stores its TIP as its diameter; the mesh wants the widest.
    if (t.type === 'taper') { tipDiaMM = t.diameterMM; diamMM = 2 * maxCutRadiusMM(t) }
    cornerMM = cornerRadiusMM(t)
    helix = fluteHelixFromName(t.name)
  }

  buildToolIndicatorForParams(refs, toolType, diamMM, vbitAngleDeg, fluteCount, tipDiaMM, cornerMM, helix)
}

// The active sheet and how far it is from the stock. CNC (x, y) → three (x, −y), so moving
// the sheet's corner onto the stock's is a position of (−at.x, 0, at.y).
function activeSheetPlacement(): { stock: { widthMM: number; heightMM: number }; cell: Cell; at: { x: number; y: number } } {
  const stock = useWorkpieceStore.getState()
  const { cell } = currentSheet()
  return { stock, cell, at: cellOffset(cell, stock) }
}

function rebuildShapes(refs: SceneRefs) {
  clearGroup(refs.shapesGroup)

  const paths = usePathsStore.getState().paths
  const T = useWorkpieceStore.getState().thicknessMM
  const surfaceY = T + 0.15
  // ONE SHEET ON THE STOCK, like the program the simulator plays (cam/sheets): the active
  // sheet's shapes moved up onto it, every other sheet's left out. Drawn where they lie,
  // sheet 1's outlines stayed on the stock whichever sheet was being simulated.
  const { stock, cell, at } = activeSheetPlacement()

  // Prune deleted STL paths from the geometry cache
  const stlPathIds = new Set(paths.filter(p => p.stlSrc).map(p => p.id))
  for (const [id, entry] of refs.stlGeoCache) {
    if (!stlPathIds.has(id)) {
      entry.bakedGeo?.dispose()
      refs.stlGeoCache.delete(id)
    }
  }

  for (const path of paths) {
    if (!path.visible || path.hidden) continue
    if (!sameCell(pathCell(path, stock), cell)) continue

    if (path.stlSrc && path.stlModelBounds) {
      let cached = refs.stlGeoCache.get(path.id)
      if (!cached || cached.stlSrc !== path.stlSrc) {
        cached?.bakedGeo?.dispose()
        try {
          cached = { mesh: decodeStlMesh(path.stlSrc), stlSrc: path.stlSrc, bakedGeo: null, bakedKey: '' }
          refs.stlGeoCache.set(path.id, cached)
        } catch {
          continue
        }
      }
      const bakedKey = `${path.d}|${T}`
      if (!cached.bakedGeo || cached.bakedKey !== bakedKey) {
        cached.bakedGeo?.dispose()
        cached.bakedGeo = buildStlGeo(cached.mesh, path.stlModelBounds, path.d, T)
        cached.bakedKey = bakedKey
      }
      if (!cached.bakedGeo) continue
      const mesh = new THREE.Mesh(cached.bakedGeo, new THREE.MeshLambertMaterial({
        color: new THREE.Color(path.color),
        side: THREE.DoubleSide,
      }))
      mesh.userData.cachedGeo = true
      mesh.position.set(-at.x, 0, at.y)
      refs.shapesGroup.add(mesh)
      continue
    }

    const polylines = flattenPath(path.d, 0.3)
    const lineMat = new THREE.LineBasicMaterial({ color: new THREE.Color(path.color) })
    for (const pts of polylines) {
      if (pts.length < 2) continue
      const positions = new Float32Array(pts.length * 3)
      for (let i = 0; i < pts.length; i++) {
        positions[i * 3]     = pts[i][0] - at.x
        positions[i * 3 + 1] = surfaceY
        positions[i * 3 + 2] = -(pts[i][1] - at.y)
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      refs.shapesGroup.add(new THREE.Line(geo, lineMat))
    }
  }

  refs.renderNeeded = true
}

// Bake an STL's raw geometry into Three.js coordinates, scaled to match the
// 2D bounding rect (d string) in CNC space.  Result is cached; only rebuilt
// when path.d or workpiece thickness changes.
// Coordinate mapping: threeX = cncX, threeY = T + cncZ, threeZ = -cncY
function buildStlGeo(
  mesh: StlMesh,
  bounds: StlModelBounds,
  d: string,
  T: number,
): THREE.BufferGeometry | null {
  const bbox = getBBox(d)
  if (!bbox) return null

  const modelW = bounds.maxX - bounds.minX
  const modelH = bounds.maxY - bounds.minY
  if (modelW < 0.001 || modelH < 0.001) return null

  const scaleX = bbox.width / modelW
  const scaleY = bbox.height / modelH
  const scaleZ = (scaleX + scaleY) / 2

  const modelCX = (bounds.minX + bounds.maxX) / 2
  const modelCY = (bounds.minY + bounds.maxY) / 2

  const positions = mesh.positions
  const count = positions.length / 3
  const newPos = new Float32Array(count * 3)

  for (let i = 0; i < count; i++) {
    const stlX = positions[i * 3]
    const stlY = positions[i * 3 + 1]
    const stlZ = positions[i * 3 + 2]
    const cncX = (stlX - modelCX) * scaleX + bbox.cx
    const cncY = (stlY - modelCY) * scaleY + bbox.cy
    const cncZ = (stlZ - bounds.maxZ) * scaleZ
    newPos[i * 3]     = cncX
    newPos[i * 3 + 1] = T + cncZ
    newPos[i * 3 + 2] = -cncY
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(newPos, 3))
  // A copy, as index.clone() was: the cached index is shared and three owns this one.
  if (mesh.indices) geo.setIndex(new THREE.BufferAttribute(mesh.indices.slice(), 1))
  geo.computeVertexNormals()
  return geo
}

// The sweep of an arc segment for display: 5° steps, at least 8. Null when the radius is
// degenerate, which draws as a straight chord to the end point.
function arcSweep3D(
  px: number, py: number, ex: number, ey: number,
  arcCx: number, arcCy: number, cw: boolean,
): { r: number; a0: number; a1: number; steps: number } | null {
  const r = Math.hypot(px - arcCx, py - arcCy)
  if (r < 0.001) return null
  const a0 = Math.atan2(py - arcCy, px - arcCx)
  let a1 = Math.atan2(ey - arcCy, ex - arcCx)
  const isFullCircle = Math.abs(px - ex) < 0.001 && Math.abs(py - ey) < 0.001
  if (isFullCircle) a1 = a0 + (cw ? -2 * Math.PI : 2 * Math.PI)
  else if (cw) { if (a1 >= a0) a1 -= 2 * Math.PI }
  else { if (a1 <= a0) a1 += 2 * Math.PI }
  const steps = Math.max(8, Math.ceil(Math.abs(a1 - a0) / (5 * Math.PI / 180)))
  return { r, a0, a1, steps }
}

// One op's toolpath as line segments in Three space (x, T + z, −y — see cncToThree). The
// vertex count is taken first so the positions go straight into one Float32Array: the old
// build pushed through a tuple per vertex into a number[] and then copied it, about four
// times the final size, per op, on every rebuild. Z interpolates along an arc so helical
// descents show as helices.
function buildToolpathLine(segs: MotionSegment[], T: number, color: string): THREE.LineSegments | null {
  let pairs = 0
  for (let i = 1; i < segs.length; i++) {
    const p = segs[i - 1], c = segs[i]
    if (c.arc) {
      const sw = arcSweep3D(p.x, p.y, c.x, c.y, c.arc.cx, c.arc.cy, c.arc.cw)
      pairs += sw ? sw.steps : 1
    } else {
      pairs++
    }
  }
  if (pairs === 0) return null

  const pos = new Float32Array(pairs * 6)
  let o = 0
  const put = (x: number, y: number, z: number) => { pos[o++] = x; pos[o++] = T + z; pos[o++] = -y }
  for (let i = 1; i < segs.length; i++) {
    const p = segs[i - 1], c = segs[i]
    const sw = c.arc ? arcSweep3D(p.x, p.y, c.x, c.y, c.arc.cx, c.arc.cy, c.arc.cw) : null
    if (!c.arc || !sw) {
      put(p.x, p.y, p.z); put(c.x, c.y, c.z)
      continue
    }
    const { r, a0, a1, steps } = sw
    let lx = p.x, ly = p.y, lz = p.z
    for (let k = 1; k <= steps; k++) {
      const t = k / steps
      const a = a0 + (a1 - a0) * t
      const ax = c.arc.cx + r * Math.cos(a), ay = c.arc.cy + r * Math.sin(a), az = p.z + (c.z - p.z) * t
      put(lx, ly, lz); put(ax, ay, az)
      lx = ax; ly = ay; lz = az
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: new THREE.Color(color) }))
}

function disposeToolpathLine(line: THREE.LineSegments) {
  line.geometry.dispose()
  ;(line.material as THREE.Material).dispose()
}

// ONE CACHED LINE PER OPERATION. This used to throw every op's geometry away and rebuild all
// of it on every toolpath-store write — and a Generate writes the store constantly (each
// op's `generating`, its segments, its entry hint, a start-height revalidation), so a run
// over N ops rebuilt everything N times over. Segments arrays are replaced, never mutated,
// so an unchanged array IS an unchanged toolpath: only an op whose array (or the stock
// thickness it is drawn on) changed is rebuilt, a colour change is applied in place, and a
// hidden op keeps its line for when it is shown again. Keyed by op id rather than a WeakMap
// so a replaced line's GPU buffers are actually disposed.
function rebuildToolpaths(refs: SceneRefs) {
  const ops = useToolpathStore.getState().operations
  const T = useWorkpieceStore.getState().thicknessMM
  // The active sheet's toolpaths only, lifted onto the stock (see rebuildShapes). The cached
  // line keeps its geometry where the op lies; only its POSITION moves it.
  const { stock, cell, at } = activeSheetPlacement()
  const cache = refs.toolpathLines
  const keep = new Set<string>()
  const shown: THREE.LineSegments[] = []

  for (const op of ops) {
    if (op.segments.length < 2) continue
    let entry = cache.get(op.id)
    const valid = !!entry && entry.segments === op.segments && entry.T === T
    if (valid) keep.add(op.id)
    if (!op.visible || !sameCell(opCell(op, stock), cell)) continue
    if (!valid) {
      if (entry) disposeToolpathLine(entry.line)
      const line = buildToolpathLine(op.segments, T, op.color)
      if (!line) { cache.delete(op.id); continue }
      entry = { segments: op.segments, T, color: op.color, line }
      cache.set(op.id, entry)
      keep.add(op.id)
    } else if (entry!.color !== op.color) {
      ;(entry!.line.material as THREE.LineBasicMaterial).color.set(op.color)
      entry!.color = op.color
    }
    entry!.line.position.set(-at.x, 0, at.y)
    shown.push(entry!.line)
  }

  for (const [id, entry] of cache) {
    if (!keep.has(id)) { disposeToolpathLine(entry.line); cache.delete(id) }
  }

  // Re-parented in program order WITHOUT disposing — the cache owns these lines.
  if (refs.toolpathGroup.children.length) refs.toolpathGroup.remove(...refs.toolpathGroup.children)
  if (shown.length) refs.toolpathGroup.add(...shown)
}

function fitCamera(refs: SceneRefs) {
  const wp = useWorkpieceStore.getState()
  const { widthMM: W, heightMM: H, thicknessMM: T } = wp
  const cx   = W / 2
  const cz   = -H / 2
  const dist = Math.hypot(W, H) * 1.4
  refs.camera.near = dist * 0.001
  refs.camera.far  = dist * 10
  refs.camera.updateProjectionMatrix()
  refs.camera.position.set(cx, dist * 0.55, dist * 0.85)
  refs.camera.lookAt(cx, T / 2, cz)
  refs.controls.target.set(cx, T / 2, cz)
  refs.controls.update()
}
