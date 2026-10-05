// The CAM job table the worker dispatches on.
//
// Split out of worker.ts so it can be imported under node: worker.ts wires itself to
// `self.onmessage` at module scope, which does not exist there, and the audit harness
// (sim/projectAudit.ts) needs to run these same jobs in-process. It kept its own copy of
// this table for that reason, and the copy immediately went stale — generatePocket grew a
// return value the duplicate did not have, so every audited pocket failed with
// "pocket.notes is not iterable". One table, two consumers.
import { generateProfile } from '../cam/profile'
import { generateSharedLineProfile } from '../cam/sharedLineProfile'
import { generatePocket } from '../cam/pocket'
import { takeNotes, type GenNote } from '../cam/notes'
import { generateVCarve } from '../cam/vcarve'
import { generatePhotoVCarve } from '../cam/photoVcarve'
import { generateProfile3d } from '../cam/profile3d'
import { depthMapMesh } from '../cam/depthMapMesh'
import type { PhotoImage, PhotoRect } from '../cam/photoVcarve'
import type { Tool } from '../store/toolStore'
import { generateInlayFemale, generateInlayMale } from '../cam/inlay'
import { generateTrochoidal } from '../cam/trochoidal'
import { generateSurface } from '../cam/surfacing'
import { nest } from '../tools/nestOp'

// Clear, run, drain: a note left over from a job that threw must not be reported against
// the next one. Pocket, v-carve and inlay are the generators that can skip part of what
// they were asked for (see cam/notes.ts); their results carry `notes` alongside the
// motion, since the worker has no UI and the progress channel is transient by design.
async function withNotes<R extends object>(run: () => R | Promise<R>): Promise<R & { notes: GenNote[] }> {
  takeNotes()
  const result = await run()
  return { ...result, notes: takeNotes() }
}

export const handlers = {
  generateProfile,
  // A sheet of parts profiled as one network of shared lines (cam/sharedLineProfile).
  generateSharedLineProfile: (...args: Parameters<typeof generateSharedLineProfile>) =>
    withNotes(() => generateSharedLineProfile(...args)),
  generatePocket: (...args: Parameters<typeof generatePocket>) =>
    withNotes(() => ({ segments: generatePocket(...args) })),
  generateVCarve: (...args: Parameters<typeof generateVCarve>) =>
    withNotes(async () => ({ segments: await generateVCarve(...args) })),
  generatePhotoVCarve,
  generateProfile3d,
  // A depth-map picture carved as a 3D Profile: built into a mesh HERE, in the worker,
  // so the main thread only decodes the pixels and clones a byte per pixel across.
  generateProfile3dImage: (image: PhotoImage, rect: PhotoRect, reliefMM: number, invert: boolean,
    tool: Tool, params: Parameters<typeof generateProfile3d>[5]) => {
    const m = depthMapMesh(image, rect, reliefMM, { invert })
    return generateProfile3d(m.positions, m.indices, m.bounds, m.bbox, tool, params)
  },
  generateInlayFemale: (...args: Parameters<typeof generateInlayFemale>) =>
    withNotes(() => generateInlayFemale(...args)),
  generateInlayMale: (...args: Parameters<typeof generateInlayMale>) =>
    withNotes(() => generateInlayMale(...args)),
  generateTrochoidal,
  generateSurface,
  // Not a toolpath, but the same shape of job: one long synchronous solve over
  // plain geometry. A sheet of parts rasterizes the whole stock once per part
  // per orientation, which on nineteen tracks at 15° is seconds — long enough
  // that running it on the UI thread put up the browser's "page unresponsive"
  // dialog mid-nest.
  nest,
} as const

export type WorkerHandlers = typeof handlers
