import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { uid } from '../uid'

export type CommentStyle = 'semicolon' | 'parenthesis' | 'none'

export interface PostProcessorProfile {
  id: string
  name: string
  unitMode: 'mm' | 'in'
  commentStyle: CommentStyle
  startGcode: string
  endGcode: string
  toolChangeGcode: string
  spindleOnTemplate: string
  spindleOffGcode: string
  rapidTemplate: string
  cutTemplate: string
  arcCWTemplate: string
  arcCCWTemplate: string
  outputArcs: boolean
  /** True for the factory controller presets shipped with the app. User-created
   *  and duplicated profiles omit this. Lets the UI offer "reset to default" and
   *  drives the persist merge that seeds newly-added presets for existing users. */
  builtin?: boolean
}

// The RS274 motion/arc grammar is shared by every controller we target; only the
// header/footer, comment style, tool-change, and spindle lines differ. So each
// preset overrides just those fields on top of this base. 
const RS274_MOTION = {
  spindleOnTemplate: 'M3 S{s}',
  spindleOffGcode: 'M5',
  rapidTemplate: 'G0 X{x} Y{y} Z{z}',
  cutTemplate: 'G1 X{x} Y{y} Z{z} F{f}',
  arcCWTemplate: 'G2 X{x} Y{y} Z{z} I{i} J{j} F{f}',
  arcCCWTemplate: 'G3 X{x} Y{y} Z{z} I{i} J{j} F{f}',
  outputArcs: true,
} as const

const GRBL_MM: PostProcessorProfile = {
  id: 'grbl-mm',
  name: 'Grbl (mm)',
  unitMode: 'mm',
  commentStyle: 'parenthesis',
  startGcode: 'G90 (absolute positioning)\nG17 (XY plane)',
  // Grbl ignores M6. Stop the spindle and M0-pause so the operator can swap the
  // tool by hand (resume on cycle-start); the next op re-issues M3 with its own
  // RPM. Without the pause a multi-tool file would plough on with the wrong bit.
  toolChangeGcode: 'M5\nM0',
  endGcode: 'M5 (spindle off)\nG0 Z10.000 (retract clear of the work)\nG0 X0 Y0 (return to origin)\nM30 (program end)',
  builtin: true,
  ...RS274_MOTION,
}

const GRBL_IN: PostProcessorProfile = {
  id: 'grbl-in',
  name: 'Grbl (inches)',
  unitMode: 'in',
  commentStyle: 'parenthesis',
  startGcode: 'G90 (absolute positioning)\nG17 (XY plane)',
  toolChangeGcode: 'M5\nM0',
  endGcode: 'M5 (spindle off)\nG0 Z0.400 (retract clear of the work)\nG0 X0 Y0 (return to origin)\nM30 (program end)',
  builtin: true,
  ...RS274_MOTION,
}

// grblHAL is Grbl-compatible but adds an explicit feed-rate mode (G94). For a
// manual tool change we stop the spindle and M0-pause (resume on operator button)
// rather than emit a bare M6 — we don't assign tool-table numbers, and M6 without a
// T word is unreliable across controllers. See follow-up: optional tool numbers +
// T{n} M6 for ATC / tool-table setups.
const GRBLHAL_MM: PostProcessorProfile = {
  id: 'grblhal-mm',
  name: 'grblHAL (mm)',
  unitMode: 'mm',
  commentStyle: 'parenthesis',
  startGcode: 'G90 (absolute positioning)\nG94 (feed in units per minute)\nG17 (XY plane)',
  toolChangeGcode: 'M5\nM0',
  endGcode: 'M5 (spindle off)\nG0 Z10.000 (retract clear of the work)\nG0 X0 Y0 (return to origin)\nM30 (program end)',
  builtin: true,
  ...RS274_MOTION,
}

// LinuxCNC (RS274NGC). Selects work coords + feed mode explicitly and enables path
// blending (G64) so the look-ahead doesn't decelerate to a stop at every segment.
const LINUXCNC_MM: PostProcessorProfile = {
  id: 'linuxcnc-mm',
  name: 'LinuxCNC (mm)',
  unitMode: 'mm',
  commentStyle: 'parenthesis',
  startGcode: 'G90 (absolute positioning)\nG94 (feed in units per minute)\nG17 (XY plane)\nG54 (work offset 1)\nG64 P0.01 (path blending, 0.01 tolerance)',
  toolChangeGcode: 'M5\nM0',
  endGcode: 'M5 (spindle off)\nM9 (coolant off)\nG0 Z10.000 (retract clear of the work)\nG0 X0 Y0 (return to origin)\nM30 (program end)',
  builtin: true,
  ...RS274_MOTION,
}

// Mach3 — parentheses-only comments; reset modal groups (G40/G49/G80) in the header
// so a stale offset/cycle from a prior program can't carry over.
const MACH3_MM: PostProcessorProfile = {
  id: 'mach3-mm',
  name: 'Mach3 (mm)',
  unitMode: 'mm',
  commentStyle: 'parenthesis',
  startGcode: 'G90 (absolute positioning)\nG17 (XY plane)\nG40 (cancel cutter compensation)\nG49 (cancel tool length offset)\nG80 (cancel canned cycle)',
  toolChangeGcode: 'M5\nM0',
  endGcode: 'M5 (spindle off)\nM9 (coolant off)\nG0 Z10.000 (retract clear of the work)\nG0 X0 Y0 (return to origin)\nM30 (program end)',
  builtin: true,
  ...RS274_MOTION,
}

// UCCNC — practically Mach3-compatible dialect.
const UCCNC_MM: PostProcessorProfile = {
  id: 'uccnc-mm',
  name: 'UCCNC (mm)',
  unitMode: 'mm',
  commentStyle: 'parenthesis',
  startGcode: 'G90 (absolute positioning)\nG17 (XY plane)\nG40 (cancel cutter compensation)\nG49 (cancel tool length offset)\nG80 (cancel canned cycle)',
  toolChangeGcode: 'M5\nM0',
  endGcode: 'M5 (spindle off)\nG0 Z10.000 (retract clear of the work)\nG0 X0 Y0 (return to origin)\nM30 (program end)',
  builtin: true,
  ...RS274_MOTION,
}

// Minimal safe baseline for an unknown controller: units + absolute mode only.
const GENERIC_MM: PostProcessorProfile = {
  id: 'generic-mm',
  name: 'Generic (mm)',
  unitMode: 'mm',
  commentStyle: 'semicolon',
  startGcode: 'G90 ; absolute positioning',
  toolChangeGcode: 'M5\nM0',
  endGcode: 'M5 ; spindle off\nM30 ; program end',
  builtin: true,
  ...RS274_MOTION,
}

// Order here is the order shown in the panel sidebar.
const BUILTIN_PROFILES: PostProcessorProfile[] = [
  GRBL_MM,
  GRBL_IN,
  GRBLHAL_MM,
  LINUXCNC_MM,
  MACH3_MM,
  UCCNC_MM,
  GENERIC_MM,
]


interface PostProcessorState {
  profiles: PostProcessorProfile[]
  activeId: string
  /** Ids of built-in presets that have ever been seeded into `profiles`. The merge
   *  consults this so a built-in the user deleted stays gone, while presets added
   *  in a later app version (ids not here yet) are still introduced. */
  seededBuiltinIds: string[]
  setActiveId: (id: string) => void
  addProfile: () => void
  duplicateProfile: (id: string) => void
  deleteProfile: (id: string) => void
  resetProfile: (id: string) => void
  updateProfile: (id: string, updates: Partial<Omit<PostProcessorProfile, 'id'>>) => void
  replaceState: (profiles: PostProcessorProfile[], activeId: string) => void
  getActiveProfile: () => PostProcessorProfile
}

export const usePostProcessorStore = create<PostProcessorState>()(
  persist(
    (set, get) => ({
      profiles: BUILTIN_PROFILES,
      activeId: 'grbl-mm',
      seededBuiltinIds: BUILTIN_PROFILES.map((p) => p.id),

      setActiveId: (id) => set({ activeId: id }),

      addProfile: () => {
        const id = uid('pp')
        const newProfile: PostProcessorProfile = { ...GRBL_MM, id, name: 'New Profile', builtin: false }
        set((s) => ({ profiles: [...s.profiles, newProfile], activeId: id }))
      },

      duplicateProfile: (id) => {
        const src = get().profiles.find((p) => p.id === id)
        if (!src) return
        const newId = uid('pp')
        const dup: PostProcessorProfile = { ...src, id: newId, name: `${src.name} copy`, builtin: false }
        set((s) => ({ profiles: [...s.profiles, dup], activeId: newId }))
      },

      deleteProfile: (id) =>
        set((s) => {
          if (s.profiles.length <= 1) return s
          const profiles = s.profiles.filter((p) => p.id !== id)
          return { profiles, activeId: s.activeId === id ? profiles[0].id : s.activeId }
        }),

      resetProfile: (id) => {
        const factory = BUILTIN_PROFILES.find((p) => p.id === id)
        if (!factory) return
        set((s) => ({ profiles: s.profiles.map((p) => (p.id === id ? { ...factory } : p)) }))
      },

      updateProfile: (id, updates) =>
        set((s) => ({
          profiles: s.profiles.map((p) => (p.id === id ? { ...p, ...updates } : p)),
        })),

      replaceState: (profiles, activeId) => set({ profiles, activeId }),

      getActiveProfile: () => {
        const { profiles, activeId } = get()
        return profiles.find((p) => p.id === activeId) ?? profiles[0]
      },
    }),
    {
      name: 'freazykam-postprocessors',
      // Keep every persisted profile (preserving the user's edits and any custom
      // profiles), then append built-in presets added in a newer app version so
      // existing users gain new controllers without losing their own. Functions
      // come from `current`; persisted JSON only carries `profiles` + `activeId`.
      merge: (persisted, current) => {
        const p = persisted as Partial<PostProcessorState> | undefined
        if (!p || !Array.isArray(p.profiles) || p.profiles.length === 0) return current
        // Pre-seededBuiltinIds saves treat every currently-present built-in as seeded
        // so the first load after upgrade doesn't reintroduce ones long deleted.
        const seeded = new Set(p.seededBuiltinIds ?? p.profiles.map((x) => x.id))
        const profiles = [...p.profiles]
        for (const b of BUILTIN_PROFILES) {
          if (!seeded.has(b.id)) profiles.push(b)
        }
        const seededBuiltinIds = [...new Set([...seeded, ...BUILTIN_PROFILES.map((b) => b.id)])]
        const activeId = profiles.some((x) => x.id === p.activeId) ? p.activeId! : profiles[0].id
        return { ...current, profiles, activeId, seededBuiltinIds }
      },
    }
  )
)
