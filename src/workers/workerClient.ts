import type { WorkerHandlers } from './worker'
import { perfLog } from '../debug'

// Pool of generation workers.
//
// Toolpath generation is pure CPU work with no shared state, so independent
// operations can run on separate threads: regenerating N operations after a
// scrub, or a "generate all", used to queue behind one worker while the rest of
// the machine idled.
//
// ORDERING: jobs that carry the same `key` are serialized in submission order,
// and only one runs at a time. The key is the operation id, so two generations
// of the SAME operation can never be in flight together — which is what stops a
// slow earlier run from resolving after a faster later one and writing stale
// segments over fresh ones via setSegments. Different keys (and keyless jobs)
// run concurrently. The old single-worker client got this property by accident,
// from strict FIFO across one thread; here it is explicit.
//
// Sized to leave a core for the UI thread, and capped — beyond a handful of
// threads the wins are small and each worker carries its own module graph.
// `navigator` is guarded: this module is evaluated under vitest's node
// environment (and the standalone script harnesses), where it doesn't exist.
const HW_THREADS = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency ?? 4) : 4
const POOL_SIZE = Math.max(1, Math.min(4, HW_THREADS - 1))

// Seam for tests: the scheduling policy (per-key serialization, FIFO within a
// key, parallelism across keys) is the part worth verifying, and it doesn't
// need real threads.
type WorkerLike = Pick<Worker, 'postMessage' | 'terminate'> & {
  onmessage: ((e: MessageEvent<never>) => void) | null
  onerror: ((e: { message?: string }) => void) | null
}

interface Job {
  id: number
  fn: string
  args: unknown[]
  key?: string
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

// Progress fan-out. Generators report through an ambient reporter inside the worker (see
// cam/progress.ts); the worker posts those as { id, progress } messages, which are matched
// back to the job's key (the operation id) and handed to whoever is listening. Kept as a
// listener registry rather than a parameter on runInWorkerFor so the ~20 call sites that
// only want a result don't have to thread anything through.
export type WorkerProgress = { opId?: string; fn: string; frac: number; label?: string; done: boolean }
const progressListeners = new Set<(p: WorkerProgress) => void>()

export function addWorkerProgressListener(fn: (p: WorkerProgress) => void): () => void {
  progressListeners.add(fn)
  return () => progressListeners.delete(fn)
}

function emitProgress(p: WorkerProgress): void {
  for (const l of progressListeners) l(p)
}

interface Slot {
  worker: WorkerLike
  job: Job | null
}

const slots: Slot[] = []
const queue: Job[] = []
// Keys with a job currently running — the serialization guarantee above.
const activeKeys = new Set<string>()
let _nextId = 0

// Production always uses the default factory.
let workerFactory: () => WorkerLike =
  () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike

export function __setWorkerFactoryForTests(f: (() => WorkerLike) | null): void {
  workerFactory = f ?? (() => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike)
  for (const s of slots) s.worker.terminate()
  slots.length = 0
  queue.length = 0
  activeKeys.clear()
}

function spawn(): Slot {
  const worker = workerFactory()
  const slot: Slot = { worker, job: null }

  worker.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string; progress?: number; label?: string }>) => {
    const { id, result, error, progress, label } = e.data
    const job = slot.job
    if (!job || job.id !== id) return
    if (progress !== undefined) {
      emitProgress({ opId: job.key, fn: job.fn, frac: progress, label, done: false })
      return   // a progress tick, not a completion — the slot stays busy
    }
    emitProgress({ opId: job.key, fn: job.fn, frac: 1, done: true })
    finish(slot)
    if (error !== undefined) job.reject(new Error(error))
    else job.resolve(result)
    pump()
  }

  worker.onerror = (ev) => {
    const job = slot.job
    if (job) emitProgress({ opId: job.key, fn: job.fn, frac: 1, done: true })
    finish(slot)
    // Replace the slot: a crashed worker still holds its thread and (after a big
    // adaptive/vcarve run) a large heap, and it can't be trusted for more work.
    worker.terminate()
    const idx = slots.indexOf(slot)
    if (idx !== -1) slots.splice(idx, 1)
    job?.reject(new Error(ev.message ?? 'Worker error'))
    pump()
  }

  slots.push(slot)
  return slot
}

// Release a slot and its key reservation.
function finish(slot: Slot): void {
  if (slot.job?.key !== undefined) activeKeys.delete(slot.job.key)
  slot.job = null
}

// Assign queued jobs to idle workers, skipping any whose key is still running.
// Per-key FIFO falls out of taking the FIRST eligible job each time: only one
// job per key can be active, so when it finishes the next one for that key is
// necessarily the earliest still queued.
function pump(): void {
  for (;;) {
    // Pick the job before the worker — checking eligibility first means a queue
    // that is entirely blocked on active keys doesn't spawn a worker to sit idle.
    const qi = queue.findIndex((j) => j.key === undefined || !activeKeys.has(j.key))
    if (qi === -1) return

    const idle = slots.find((s) => s.job === null)
      ?? (slots.length < POOL_SIZE ? spawn() : undefined)
    if (!idle) return

    const [job] = queue.splice(qi, 1)
    if (job.key !== undefined) activeKeys.add(job.key)
    idle.job = job
    idle.worker.postMessage({ id: job.id, fn: job.fn, args: job.args })
  }
}

// ─── Cancellation ──────────────────────────────────────────────────────────────
//
// A generation runs as one synchronous call inside a worker — an adaptive march or a
// V-carve solve never yields — so there is no checkpoint for a cancel flag to be polled
// at. terminate() is the only thing that actually stops one, and a terminated worker
// takes its thread and its (post-solve, often large) heap with it. Cancelled slots are
// therefore dropped rather than reused; pump() spawns replacements on the next job.
// Idle workers are left alone so an abort doesn't cost a module-graph reload.

export const WORK_CANCELLED = 'Generation cancelled'

/** True for the rejection cancelAllWork hands to in-flight jobs. */
export function isWorkCancelled(e: unknown): boolean {
  return e instanceof Error && e.message === WORK_CANCELLED
}

/**
 * Abandon every queued and in-flight generation. Each affected job's promise rejects
 * with WORK_CANCELLED — synchronously from here, so a caller can reconcile store state
 * immediately after and win the race against the awaiting `catch` blocks, which run a
 * microtask later. Returns how many jobs were stopped.
 */
export function cancelAllWork(): number {
  const cancelled: Job[] = queue.splice(0)
  for (let i = slots.length - 1; i >= 0; i--) {
    const slot = slots[i]
    if (!slot.job) continue
    cancelled.push(slot.job)
    slot.worker.terminate()
    slots.splice(i, 1)
  }
  activeKeys.clear()
  for (const job of cancelled) {
    emitProgress({ opId: job.key, fn: job.fn, frac: 1, done: true })
    job.reject(new Error(WORK_CANCELLED))
  }
  return cancelled.length
}

function submit(key: string | undefined, fn: string, args: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now()
    queue.push({
      id: _nextId++,
      fn,
      args,
      key,
      resolve: (v) => {
        perfLog(`[perf] worker ${fn}: ${(performance.now() - t0).toFixed(0)}ms`)
        resolve(v)
      },
      reject,
    })
    pump()
  })
}

// Run a generation for operation `opId`. Calls sharing an opId never overlap and
// resolve in submission order, so the last one submitted is the last to write
// its segments. Use this whenever the result lands in setSegments(opId, …).
//
// `opId` may be undefined for a not-yet-created operation — a fresh id can't
// collide with anything in flight, so those need no ordering constraint.
export function runInWorkerFor<K extends keyof WorkerHandlers>(
  opId: string | undefined,
  fn: K,
  ...args: Parameters<WorkerHandlers[K]>
): Promise<Awaited<ReturnType<WorkerHandlers[K]>>> {
  return submit(opId, fn, args) as Promise<Awaited<ReturnType<WorkerHandlers[K]>>>
}
