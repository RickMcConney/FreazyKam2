// The CAM job table the worker dispatches on.
//
// Split out of worker.ts so it can be imported under node: worker.ts wires itself to
// `self.onmessage` at module scope, which does not exist there, and the audit harness
// (sim/projectAudit.ts) needs to run these same jobs in-process. It kept its own copy of
// this table for that reason, and the copy immediately went stale — generatePocket grew a
// return value the duplicate did not have, so every audited pocket failed with
// "pocket.notes is not iterable". One table, two consumers.
import { generateProfile } from '../cam/profile'
import { generatePocket, takePocketNotes } from '../cam/pocket'
import { generateVCarve } from '../cam/vcarve'
import { generatePhotoVCarve } from '../cam/photoVcarve'
import { generateProfile3d } from '../cam/profile3d'
import { generateInlayFemale, generateInlayMale } from '../cam/inlay'
import { generateTrochoidal } from '../cam/trochoidal'
import { generateSurface } from '../cam/surfacing'
import { nest } from '../tools/nestOp'

export const handlers = {
  generateProfile,
  // Pocket rides its notes back with the motion — a strategy that declined the shape and
  // fell back, today (see pocket.ts). They cannot travel any other way: the worker has no
  // UI, and the progress channel is transient by design. `notes` is drained AFTER the call,
  // so the property order here matters.
  generatePocket: (...args: Parameters<typeof generatePocket>) => ({
    segments: generatePocket(...args),
    notes: takePocketNotes(),
  }),
  generateVCarve,
  generatePhotoVCarve,
  generateProfile3d,
  generateInlayFemale,
  generateInlayMale,
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
