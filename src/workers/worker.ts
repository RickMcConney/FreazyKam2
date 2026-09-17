import { setProgressReporter } from '../cam/progress'
import { handlers, type WorkerHandlers } from './handlers'

export type { WorkerHandlers }

self.onmessage = async (e: MessageEvent<{ id: number; fn: keyof WorkerHandlers; args: unknown[] }>) => {
  const { id, fn, args } = e.data
  try {
    // One job runs per worker at a time, so an ambient reporter is unambiguous.
    setProgressReporter((progress, label) => self.postMessage({ id, progress, label }))
    const handler = handlers[fn] as (...a: unknown[]) => unknown
    const result = await handler(...args)
    self.postMessage({ id, result })
  } catch (err) {
    self.postMessage({ id, error: String(err) })
  } finally {
    setProgressReporter(null)
  }
}
