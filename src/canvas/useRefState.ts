import { useCallback, useRef, useState, type MutableRefObject } from 'react'

// State + ref twin: `set` updates both synchronously, so event handlers can
// read `ref.current` mid-gesture (before React re-renders) while JSX renders
// from `value`. Replaces the hand-maintained pairs in CanvasStage where every
// write had to remember to update both (tofix.md R3).
export function useRefState<T>(initial: T): [T, MutableRefObject<T>, (v: T) => void] {
  const [value, setValue] = useState<T>(initial)
  const ref = useRef<T>(initial)
  const set = useCallback((v: T) => {
    ref.current = v
    setValue(v)
  }, [])
  return [value, ref, set]
}
