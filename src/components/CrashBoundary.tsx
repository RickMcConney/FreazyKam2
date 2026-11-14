import { Component, type ErrorInfo, type ReactNode } from 'react'
import { RotateCcw, Play } from 'lucide-react'
import { recordCrash, type CrashEntry } from '../util/crashLog'

// Without this, an error thrown while rendering (or in an effect) unmounts the whole
// app and leaves a white page that only a reload gets out of — losing whatever the
// autosave had not caught. The document lives in the zustand stores, outside React,
// so it survives the unmount: CONTINUE mounts the app again over the same drawing.
// The error is shown, and kept (util/crashLog), so the cause can be found.

interface State { entry: CrashEntry | null }

export class CrashBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { entry: null }

  static getDerivedStateFromError(): Partial<State> {
    // The entry itself is written in componentDidCatch, which has the component stack.
    return {}
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    this.setState({ entry: recordCrash('render', error, info.componentStack ?? undefined) })
  }

  render() {
    const { entry } = this.state
    if (!entry) return this.props.children
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-gray-50 dark:bg-neutral-900 text-gray-900 dark:text-neutral-100 p-6">
        <div className="max-w-2xl w-full space-y-3">
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="text-body">
            The app hit an error it could not draw past. Your drawing is still in memory —
            Continue puts the app back over it. If that fails, Reload offers the last autosave.
          </p>
          <div className="flex gap-2">
            <button onClick={() => this.setState({ entry: null })}
              className="flex items-center gap-1.5 px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700">
              <Play size={14} /> Continue
            </button>
            <button onClick={() => location.reload()}
              className="flex items-center gap-1.5 px-3 py-1 rounded border border-gray-300 dark:border-neutral-600 hover:bg-gray-100 dark:hover:bg-neutral-800">
              <RotateCcw size={14} /> Reload
            </button>
          </div>
          <pre className="text-xs whitespace-pre-wrap break-words max-h-[50vh] overflow-auto rounded border border-gray-300 dark:border-neutral-700 p-2 bg-white dark:bg-neutral-950 select-text">
            {entry.message}
            {entry.hiddenForS !== null ? `\n\nPage had been hidden ${entry.hiddenForS} s, visible again ${entry.sinceVisibleS} s before this.` : ''}
            {entry.stack ? `\n\n${entry.stack}` : ''}
            {entry.componentStack ? `\n\nComponents:${entry.componentStack}` : ''}
          </pre>
        </div>
      </div>
    )
  }
}
