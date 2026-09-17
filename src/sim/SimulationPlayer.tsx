import { useEffect, type ReactNode } from 'react'
import { ICON } from '../theme'
import { Play, Pause, Rewind, FileText, X } from 'lucide-react'
import { useSimStore, type SimSpeed } from '../store/simStore'
import { useUIStore } from '../store/uiStore'
import { useWorkpieceStore, MATERIAL_INFO } from '../store/workpieceStore'
import { spindleDialLabel } from '../store/spindle'
import type { ToolType } from '../store/toolStore'
import { targetChipLoad, rigidityFeedFactor } from '../cam/feeds'
import { getCurrentSegIdx, interpolatePos, segTool, formatSimTime } from './gcodeParser'

const SPEEDS: SimSpeed[] = [1, 5, 20, 100]

// Chip-load bands: actual / target ratio → color + meaning.
const CHIP_STATUS = {
  rubbing: { color: '#ef4444', label: 'rubbing · too hot' },   // too low
  good:    { color: '#22c55e', label: 'sweet spot' },
  heavy:   { color: '#3b82f6', label: 'chips too large' },     // too high
  none:    { color: '#9ca3af', label: '' },
} as const

function chipStatus(actual: number | null, target: number): keyof typeof CHIP_STATUS {
  if (actual === null || target <= 0) return 'none'
  const r = actual / target
  if (r < 0.75) return 'rubbing'
  if (r > 1.4) return 'heavy'
  return 'good'
}

// Widest value each field ever holds, in monospace characters. The bars are centred
// overlays, so a field that grows by one character slides the whole row sideways — and a
// row of numbers that moves while it updates cannot be read at all.
const W_Z = 8            // -999.999 (mm) / -39.3701 (in)
const W_RPM = 5          // 99999
const W_DIAL = 11        // ' · dial 5.5' (dial tables top out at 6, rounded to half-detents)
const W_UNIT = 6         // 'mm/min' / 'in/min'
const W_CHIP_LABEL = 17  // 'rubbing · too hot'

// Read-outs are formatted in the units the PROGRAM declares, not the design-side mm/in
// toggle: this bar sits above the G-code viewer and highlights a line in it, so a Z of
// -0.1969 beside a line reading Z-5.000 would be its own kind of wrong. simStore holds
// everything in mm (the parser converts an inch program on the way in — the heightfield
// and cut trail depend on that), so the conversion belongs here, at the last step.
const MM_PER_IN = 25.4
const progLen = (mm: number, inch: boolean) => (inch ? (mm / MM_PER_IN).toFixed(4) : mm.toFixed(3))
const progFeed = (mmMin: number, inch: boolean) => (inch ? (mmMin / MM_PER_IN).toFixed(1) : String(Math.round(mmMin)))
const progFz = (mm: number, inch: boolean) => (inch ? (mm / MM_PER_IN).toFixed(4) : mm.toFixed(3))
// Surface speed is quoted in the idiom of the program's units: SFM for an inch program,
// m/min for a metric one. Same number, the name a machinist would reach for.
const FT_PER_M = 3.28084
const progSurf = (mMin: number, inch: boolean) =>
  inch ? `${Math.round(mMin * FT_PER_M)} ft/min` : `${Math.round(mMin)} m/min`

/**
 * A value in a status bar: fixed width, so the label beside it never moves.
 *
 * Every field is always rendered — a field that disappears when it has nothing to say
 * (chip load during a rapid, the status word between cuts) re-flows everything after it,
 * which is the same unreadable flicker by another route. Nothing-to-say prints as '—'.
 */
function Slot({ ch, children, align = 'right', color }: {
  ch: number
  children: ReactNode
  align?: 'left' | 'right'
  color?: string
}) {
  return (
    <span
      className="inline-block tabular-nums"
      style={{ width: `${ch}ch`, textAlign: align, color }}
    >
      {children}
    </span>
  )
}

export default function SimulationPlayer() {
  const playing = useSimStore((s) => s.playing)
  const speed = useSimStore((s) => s.speed)
  const elapsedTimeS = useSimStore((s) => s.elapsedTimeS)
  const totalTimeS = useSimStore((s) => s.totalTimeS)
  const segments = useSimStore((s) => s.segments)
  const genZOff = useSimStore((s) => s.genZOff)
  const toolStates = useSimStore((s) => s.toolStates)
  const gcode = useSimStore((s) => s.gcode)
  const gcodeViewerOpen = useSimStore((s) => s.gcodeViewerOpen)
  const programUnits = useSimStore((s) => s.programUnits)
  const material = useWorkpieceStore((s) => s.material)
  const machineRigidity = useWorkpieceStore((s) => s.machineRigidity)
  const minSpindleRpm = useWorkpieceStore((s) => s.minSpindleRpm)
  const spindleType = useWorkpieceStore((s) => s.spindleType)
  const { play, pause, stop, seekToTime, setSpeed, toggleGcodeViewer, clearSim } = useSimStore()

  // Animation loop — reads fresh store state each frame to avoid stale closures
  useEffect(() => {
    if (!playing) return
    let rafId = 0
    let lastTs: number | null = null

    function tick(ts: number) {
      if (lastTs !== null) {
        const dt = (ts - lastTs) / 1000
        const state = useSimStore.getState()
        if (!state.playing) return   // simulation ended or paused, stop loop
        state.advanceTime(dt * state.speed)
      }
      lastTs = ts
      rafId = requestAnimationFrame(tick)
    }

    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [playing])

  if (!gcode) return null

  const inch = programUnits === 'in'
  // Feed values are one char wider in inch (3937.0 vs 99999); 'rapid' fits either way.
  const wFeed = inch ? 6 : 5
  const wFz = inch ? 6 : 5

  const progress = totalTimeS > 0 ? elapsedTimeS / totalTimeS : 0
  const segIdx = getCurrentSegIdx(segments, elapsedTimeS)
  const curSeg = segIdx >= 0 ? segments[segIdx] : null
  const pos = interpolatePos(segments, elapsedTimeS)
  const currentLineNum = curSeg ? curSeg.lineIdx + 1 : 0

  // Spindle speed (read from the G-code) + chip-load feedback for the current move.
  const ts = curSeg ? segTool(curSeg, toolStates) : null
  const spindleRpm = ts?.spindleRpm ?? 0
  const toolType: ToolType = ts?.toolBallNose ? 'ballnose'
    : ts?.toolTipRadiusMM ? 'taper'
    : ts?.toolVbitHalfAngleTan !== undefined ? 'vbit' : 'endmill'
  // Judge a taper by its MEAN cutting diameter, the same figure feeds.feedDiameterMM
  // fed the feed calculation — its parsed `dia` is the widest it opens out to, and its
  // tip is far narrower, so either end alone would move the gauge off the aim.
  const feedDiaMM = ts ? (ts.toolTipRadiusMM ? ts.toolTipRadiusMM + ts.toolDiameterMM / 2 : ts.toolDiameterMM) : 0
  const targetFz = ts ? targetChipLoad(toolType, feedDiaMM, MATERIAL_INFO[material].hardness) : 0
  // Chip-load color applies only to steady side-cutting: the tip must be below the
  // material top (z < 0, not cutting air) AND not descending. Descending moves —
  // ramp-in, plunges, helical entries — run a deliberately reduced feed and have
  // light engagement, so judging them as steady-state would falsely read "rubbing".
  const descending = !!curSeg && curSeg.z < curSeg.prevZ - 1e-3
  // Segments are top-referenced (simStore.loadGcode), so below zero is in the material.
  const cutting = !!curSeg && !curSeg.rapid && !!pos && pos.z < -0.001 && !descending
  const actualFz = ts && cutting && spindleRpm > 0 && ts.fluteCount > 0
    ? curSeg!.feedRateMmMin / (spindleRpm * ts.fluteCount)
    : null
  // Display the intrinsic target, but judge the color against the rigidity-adjusted
  // aim — so a hobby machine running its lighter feed still reads "sweet spot".
  const aimFz = targetFz * rigidityFeedFactor(machineRigidity)
  const status = chipStatus(actualFz, aimFz)
  const chip = CHIP_STATUS[status]
  // For manual feeds, suggest the feed that puts chip load in the sweet spot at the
  // current spindle & flute count, with the RPM direction as an alternative lever.
  const sweetFeed = ts ? Math.round(aimFz * spindleRpm * ts.fluteCount) : 0
  const suggestion =
    status === 'rubbing' && sweetFeed > 0 ? `raise feed to ~${progFeed(sweetFeed, inch)} ${programUnits}/min (or lower RPM / fewer flutes)` :
    status === 'heavy'   && sweetFeed > 0 ? `lower feed to ~${progFeed(sweetFeed, inch)} ${programUnits}/min (or raise RPM / more flutes)` : ''

  // Surface-speed (Vc) check: metals carry a safe cutting-speed ceiling. If the
  // programmed spindle drives the edge past it — typically because the machine's
  // minimum RPM is still too fast for the bit diameter — the cut runs hot (built-up
  // edge on aluminum, edge wear on brass). Flag it so the spindle reads red.
  const vcCeilingMMin = MATERIAL_INFO[material].maxSurfaceSpeedMMin
  const dia = ts?.toolDiameterMM ?? 0
  const surfaceSpeedMMin = dia > 0 && spindleRpm > 0 ? (Math.PI * dia * spindleRpm) / 1000 : 0
  // Compare on whole m/min so a 1-rpm integer rounding in the G-code (≈0.01 m/min)
  // doesn't flag a spindle that's sitting right on the ceiling.
  const spindleTooFast = !!vcCeilingMMin && Math.round(surfaceSpeedMMin) > vcCeilingMMin

  // When the spindle reads red, explain *why* and whether the user can fix it:
  //  • safeRpm   — fastest spindle that keeps this bit under the material's Vc limit.
  //  • machine-constrained — even the machine's slowest spindle is over the limit,
  //    so no RPM helps; only a smaller bit (or a lower-min spindle) will.
  const safeRpm = vcCeilingMMin && dia > 0 ? Math.floor((vcCeilingMMin * 1000) / (Math.PI * dia)) : 0
  const maxBitMM = vcCeilingMMin && minSpindleRpm > 0 ? (vcCeilingMMin * 1000) / (Math.PI * minSpindleRpm) : 0
  const machineConstrained = spindleTooFast && safeRpm > 0 && safeRpm < minSpindleRpm
  const spindleHint = !spindleTooFast ? '' : machineConstrained
    ? `${MATERIAL_INFO[material].label} should stay under ${progSurf(vcCeilingMMin!, inch)}, but a Ø${progLen(dia, inch)} ${programUnits} tool reaches that at ${safeRpm} RPM — below your machine's ${minSpindleRpm} RPM minimum. The spindle can't slow down enough, so lowering RPM won't help: use a tool ≤ ${progLen(maxBitMM, inch)} ${programUnits}, or fit a spindle that runs slower.`
    : `${MATERIAL_INFO[material].label} should stay under ${progSurf(vcCeilingMMin!, inch)}. Lower the spindle to ≤ ${safeRpm} RPM for this Ø${progLen(dia, inch)} ${programUnits} tool (or turn on auto feeds & speeds to set it automatically).`

  // The elapsed clock never runs longer than the total, so the total's width sizes both.
  const totalTimeStr = formatSimTime(totalTimeS)
  const lastLineNum = segments.length > 0 ? segments[segments.length - 1].lineIdx + 1 : 0
  const wLine = Math.max(4, String(lastLineNum).length)
  const dialLabel = spindleDialLabel(spindleType, spindleRpm)

  return (
    // Bottom-pinned column: the last child holds its place and the stack grows UPWARD, so
    // the rows that come and go (the two hint banners) live at the TOP. Below the bars they
    // shunted the whole player up and down every time the chip load crossed a band.
    <div className="absolute bottom-12 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-1.5 select-none">
      {/* Surface-speed warning — explains the red spindle and how (or whether) to fix it */}
      {spindleTooFast && spindleHint && (
        <div className="max-w-md bg-red-50/95 dark:bg-red-950/90 border border-red-300 dark:border-red-800 rounded-md px-3 py-1.5 text-body text-red-700 dark:text-red-300 text-center whitespace-normal pointer-events-none">
          ⚠ Spindle too fast ({progSurf(surfaceSpeedMMin, inch)}) — {spindleHint}
        </div>
      )}

      {/* How to get the chip load back into the sweet spot */}
      {suggestion && (
        <div className="max-w-md bg-gray-50/95 dark:bg-neutral-900/95 border border-gray-300 dark:border-neutral-700 rounded-md px-3 py-1 text-body text-gray-600 dark:text-neutral-400 text-center whitespace-normal pointer-events-none">
          {suggestion}
        </div>
      )}

      {/* Stats bar */}
      <div className="bg-gray-50/95 dark:bg-neutral-900/95 border border-gray-300 dark:border-neutral-700 rounded-md px-3 py-1 text-body font-mono text-gray-700 dark:text-neutral-300 flex gap-3 whitespace-nowrap pointer-events-none">
        <span>Line: <Slot ch={wLine}>{currentLineNum || '—'}</Slot></span>
        <span>Z: <Slot ch={W_Z}>{pos ? progLen(pos.z + genZOff, inch) : '—'}</Slot> {programUnits}</span>
        {/* 'rapid' is the feed's VALUE, not a replacement label — swapping the label out
            was half the flicker, and it moved the clock beside it. */}
        <span className={curSeg?.rapid ? 'text-gray-600 dark:text-neutral-400' : ''}>
          F: <Slot ch={wFeed}>
            {!curSeg ? '—' : curSeg.rapid ? 'rapid' : progFeed(curSeg.feedRateMmMin, inch)}
          </Slot>
          {/* Held in a fixed slot rather than dropped on a rapid — vanishing would move
              the clock beside it, which is the flicker this bar is built to avoid. */}
          <Slot ch={W_UNIT} align="left">{curSeg && !curSeg.rapid ? ` ${programUnits}/min` : ''}</Slot>
        </span>
        <span className="text-gray-500 dark:text-neutral-400">
          <Slot ch={totalTimeStr.length}>{formatSimTime(elapsedTimeS)}</Slot> / {totalTimeStr}
        </span>
      </div>

      {/* Controls */}
      <div className="bg-gray-50/95 dark:bg-neutral-900/95 border border-gray-300 dark:border-neutral-700 rounded-xl px-3 py-1.5 flex items-center gap-2 shadow-xl">
        {/* Reset to the start */}
        <button
          title="Reset"
          onClick={stop}
          className="text-gray-500 dark:text-neutral-400 hover:text-gray-900 dark:hover:text-neutral-100 transition-colors p-0.5"
        >
          <Rewind size={ICON.sm} />
        </button>

        {/* Play / Pause */}
        <button
          title={playing ? 'Pause (Space)' : 'Play (Space)'}
          onClick={() => (playing ? pause() : play())}
          className="w-7 h-7 rounded-full bg-blue-600 hover:bg-blue-500 text-white flex items-center justify-center transition-colors"
        >
          {playing ? <Pause size={ICON.sm} /> : <Play size={ICON.sm} className="ml-0.5" />}
        </button>

        {/* Seek slider */}
        <input
          type="range"
          min={0}
          max={1000}
          value={Math.round(progress * 1000)}
          onChange={(e) => seekToTime((parseInt(e.target.value) / 1000) * totalTimeS)}
          className="w-36 h-1 accent-blue-500 cursor-pointer"
        />

        {/* Speed */}
        <div className="flex items-center gap-0.5">
          {SPEEDS.map((s) => (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              className={[
                'text-body px-1.5 py-0.5 rounded transition-colors',
                speed === s ? 'bg-blue-600 text-white' : 'text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200',
              ].join(' ')}
            >
              {s}×
            </button>
          ))}
        </div>

        {/* G-code viewer toggle */}
        <button
          title="Toggle G-code viewer"
          onClick={toggleGcodeViewer}
          className={[
            'p-0.5 transition-colors',
            gcodeViewerOpen ? 'text-blue-400' : 'text-gray-500 dark:text-neutral-400 hover:text-gray-900 dark:hover:text-neutral-100',
          ].join(' ')}
        >
          <FileText size={ICON.md} />
        </button>

        <div className="w-px h-4 bg-gray-200 dark:bg-neutral-700 mx-0.5" />

        {/* Close simulation — from the 3D view this also returns to 2D */}
        <button
          title="Close simulation"
          onClick={() => {
            clearSim()
            const ui = useUIStore.getState()
            if (ui.workspaceTab === '3d') ui.setWorkspaceTab('2d')
          }}
          className="text-gray-600 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200 transition-colors p-0.5"
        >
          <X size={ICON.sm} />
        </button>
      </div>

      {/* Spindle + chip-load feedback. Always mounted: it used to unmount between moves,
          which made the bar blink in and out and shifted the controls above it. */}
      <div className="bg-gray-50/95 dark:bg-neutral-900/95 border border-gray-300 dark:border-neutral-700 rounded-md px-3 py-1 text-body font-mono text-gray-700 dark:text-neutral-300 flex items-center gap-3 whitespace-nowrap pointer-events-none">
        <span className={spindleTooFast ? 'text-red-600 dark:text-red-500 font-semibold' : ''}>
          {/* The surface speed moved to the warning banner rather than being appended
              here — it only ever appeared when something was wrong, so it dragged the
              whole row sideways exactly when the numbers mattered most. */}
          Spindle: <Slot ch={W_RPM}>{spindleRpm > 0 ? Math.round(spindleRpm) : '—'}</Slot>
          <Slot ch={W_DIAL} align="left">{dialLabel ? ` · ${dialLabel}` : ''}</Slot>
        </span>
        <span className="flex items-center gap-1.5">
          Chip
          <span style={{ color: chip.color }}>●</span>
          <Slot ch={wFz}>{actualFz !== null ? progFz(actualFz, inch) : '—'}</Slot>
          /
          <Slot ch={wFz}>{targetFz > 0 ? progFz(targetFz, inch) : '—'}</Slot>
          {programUnits}
        </span>
        {/* Holds its width whatever the band, and prints '—' rather than vanishing when
            the move isn't steady side-cutting and there is nothing to judge. */}
        <Slot ch={W_CHIP_LABEL} align="left" color={chip.color}>{chip.label || '—'}</Slot>
      </div>
    </div>
  )
}
