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
    // Name and message apart, so the client can rebuild the error's TYPE (workerClient's
    // errorFromWorker). String(err) shipped "Error: <message>", typeless, and that prefix
    // reached every failure message the forms show.
    const error = err instanceof Error ? { name: err.name, message: err.message } : { name: 'Error', message: String(err) }
    self.postMessage({ id, error })
  } finally {
    setProgressReporter(null)
  }
}
