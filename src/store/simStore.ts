import { create } from 'zustand'
import { parseGcode, getCurrentSegIdx, lineStartsOf, type SimSegment, type ToolState } from '../sim/gcodeParser'
import { useWorkpieceStore, zDatumOffsetMM } from './workpieceStore'
import { useUIStore } from './uiStore'

export type SimSpeed = 1 | 5 | 20 | 100

interface SimState {
  gcode: string
  // Where each line of `gcode` starts (read a line with `lineAt`) — an index into the one
  // text rather than a second copy of the program as an array of line strings.
  lineStarts: Uint32Array
  // TOP-REFERENCED — Z = 0 at the stock top, negative in material — whatever datum the
  // program was generated for. `loadGcode` takes `genZOff` off ONCE, so the 2D layer, the
  // 3D carve and the player all read this one array; each of them used to map its own
  // copy, which on a bottom-datum program was three copies of every segment.
  segments: SimSegment[]
  toolStates: ToolState[]
  totalTimeS: number
  playing: boolean
  speed: SimSpeed
  elapsedTimeS: number
  gcodeViewerOpen: boolean
  // Units the loaded PROGRAM is written in (its own G20/G21). Everything in this store is
  // mm; this is what the player formats its read-outs with, so they match the G-code lines
  // rather than the design-side mm/in toggle.
  programUnits: 'mm' | 'in'
  // Z datum offset that was in effect when this G-code was generated — already taken off
  // `segments`, and kept so a readout can put the machine's own Z back. Captured at load
  // so it stays right even if the user later changes zOrigin without regenerating.
  genZOff: number
  // The simulator is on screen (or was, and is only waiting for a rebuild), so a change
  // to the program should be re-simulated without the user pressing Simulate again.
  // See sim/simAutoReload.ts — this flag is the "controls are showing" test, kept in the
  // store because `invalidateSim` blanks `gcode` while the toolpaths regenerate.
  autoReload: boolean

  // `autoReload: false` marks a program the app did not generate (an imported .gcode
  // file) — regenerating operations can't rebuild it, so it must not arm the auto-reload.
  loadGcode: (text: string, opts?: { autoReload?: boolean }) => void
  play: () => void
  pause: () => void
  stop: () => void
  seekToTime: (t: number) => void
  setSpeed: (s: SimSpeed) => void
  advanceTime: (dtS: number) => void
  toggleGcodeViewer: () => void
  clearSim: () => void
  // Drop the loaded program because the toolpaths it was built from are being
  // regenerated — but stay armed, so simAutoReload rebuilds and reloads it once the
  // regenerations settle. `clearSim` is the opposite: it puts the simulator away
  // (the player's X, New/Open Project) and disarms the reload.
  invalidateSim: () => void
  currentLineIdx: () => number
}

// Fresh arrays per call — the cleared state is handed to consumers, not shared.
const emptyProgram = (): Partial<SimState> => ({
  gcode: '', lineStarts: new Uint32Array(0), segments: [], toolStates: [],
  totalTimeS: 0, elapsedTimeS: 0, playing: false, genZOff: 0, programUnits: 'mm',
})

export const useSimStore = create<SimState>()((set, get) => ({
  gcode: '',
  lineStarts: new Uint32Array(0),
  segments: [],
  toolStates: [],
  totalTimeS: 0,
  playing: false,
  speed: 20,
  elapsedTimeS: 0,
  gcodeViewerOpen: false,
  programUnits: 'mm',
  genZOff: 0,
  autoReload: false,

  loadGcode: (text, opts) => {
    const { zOrigin, thicknessMM, safeHeightMM } = useWorkpieceStore.getState()
    const genZOff = zDatumOffsetMM(zOrigin, thicknessMM)
    // Parser's initial cz must match the machine-coord safe height so the tool
    // starts at the right position when elapsedTimeS = 0 (reset to start).
    const parsed = parseGcode(text, safeHeightMM + genZOff)
    // App-generated G-code never triggers these; imported external files can.
    if (parsed.warnings.length > 0)
      useUIStore.getState().showStatus(`G-code simulation: ${parsed.warnings.join('; ')}`, 'warn')
    // To top-referenced, once and in place: these are this parse's own objects, so
    // nothing else holds them, and every consumer reads this one array.
    if (genZOff) for (const s of parsed.segments) { s.z -= genZOff; s.prevZ -= genZOff }
    set({
      gcode: text,
      lineStarts: lineStartsOf(text),
      segments: parsed.segments,
      toolStates: parsed.toolStates,
      programUnits: parsed.units,
      totalTimeS: parsed.totalTimeS,
      // A loaded program shows its RESULT: the finished part, every cut made. That is
      // what the user opened the simulator to see, and watching it happen is the second
      // question, not the first — so playback starts from the answer and Play rewinds to
      // the start (see `play`). Both views derive the material state from elapsedTimeS
      // alone, so parking it at the end is the whole of "render the final result"; the
      // 3D carve that backs it is spread over frames (HeightfieldMaterial.applyUpTo).
      elapsedTimeS: parsed.totalTimeS,
      playing: false,
      genZOff,
      autoReload: opts?.autoReload !== false,
    })
  },

  // Play from the start when the run is sitting at its end — which is where a freshly
  // loaded program sits, and where a finished one is left. Pressing Play on a finished
  // run is only ever a request to watch it happen. A paused run mid-way resumes.
  play: () =>
    set((s) => (s.totalTimeS > 0 && s.elapsedTimeS >= s.totalTimeS
      ? { playing: true, elapsedTimeS: 0 }
      : { playing: true })),
  pause: () => set({ playing: false }),
  stop: () => set({ playing: false, elapsedTimeS: 0 }),

  seekToTime: (t) =>
    set((s) => ({ elapsedTimeS: Math.max(0, Math.min(t, s.totalTimeS)) })),

  setSpeed: (speed) => set({ speed }),

  advanceTime: (dtS) =>
    set((s) => {
      if (!s.playing) return s
      const newTime = s.elapsedTimeS + dtS
      if (newTime >= s.totalTimeS) return { elapsedTimeS: s.totalTimeS, playing: false }
      return { elapsedTimeS: newTime }
    }),

  toggleGcodeViewer: () => set((s) => ({ gcodeViewerOpen: !s.gcodeViewerOpen })),

  clearSim: () => set({ ...emptyProgram(), autoReload: false }),

  invalidateSim: () => set((s) => (s.gcode ? { ...emptyProgram(), autoReload: s.autoReload } : s)),

  currentLineIdx: () => {
    const { segments, elapsedTimeS } = get()
    const idx = getCurrentSegIdx(segments, elapsedTimeS)
    return idx >= 0 ? (segments[idx]?.lineIdx ?? -1) : -1
  },
}))
