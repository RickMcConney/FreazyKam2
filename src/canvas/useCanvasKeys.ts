import { useEffect, useRef } from 'react'
import { useSimStore } from '../store/simStore'
import { useUIStore } from '../store/uiStore'
import type { Gesture } from './useGesture'

interface KeyActions {
  /** Delete/Backspace while in point edit. */
  onDeleteKey: (e: KeyboardEvent) => void
  /** Escape in point edit: leaves connect mode if in it, else leaves point edit. */
  escapeNodeEdit: () => void
  /** Escape with the pen: commits what has been drawn as an open path. */
  finishPenOnEscape: () => void
  /** Escape with Measure: drops the line. False when there is none, and the tool goes. */
  clearMeasure: () => boolean
  /** Escape with Constrain: drops a half-made constraint. False when there is none. */
  escapeConstrain: () => boolean
  /** The tool is going: anything it had in progress goes with it. */
  cancelTool: () => void
}

/**
 * The canvas's keyboard: modifiers and space, Delete in point edit, and the Escape ladder.
 *
 * Registered ONCE and reading `actions` through a ref. App has a window keydown listener
 * too, and Delete in point edit stops it with stopImmediatePropagation — which only works
 * from a listener registered first, so this one must not come and go with a re-render.
 */
export function useCanvasKeys({ spaceHeldRef, setAltDown, setShiftDown }: Gesture, actions: KeyActions) {
  const latest = useRef(actions)
  latest.current = actions

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return
      if (e.code === 'Space' && !useSimStore.getState().gcode) { e.preventDefault(); spaceHeldRef.current = true }
      if (e.shiftKey) setShiftDown(true)
      if (e.key === 'Alt') {
        if (useUIStore.getState().activeTool === 'pen') e.preventDefault()
        setAltDown(true)
      }
      if (e.key === 'Delete' || e.key === 'Backspace') latest.current.onDeleteKey(e)

      if (e.code === 'Escape') {
        // Arranging is committed on every mouseup, so Escape just leaves — it is
        // "done", not "cancel", and there is nothing uncommitted to throw away.
        if (useUIStore.getState().clockLinkPathId) {
          useUIStore.getState().setClockLink(null)
          return
        }
        if (useUIStore.getState().nodeEditPathId) {
          latest.current.escapeNodeEdit()
          return
        }
        const { activeTool, setActiveTool, clearDrillPoints } = useUIStore.getState()
        if (activeTool === 'pen') {
          latest.current.finishPenOnEscape()
        } else if (activeTool === 'measure' && latest.current.clearMeasure()) {
          // A measurement goes first; Escape again leaves the tool.
        } else if (activeTool === 'constrain' && latest.current.escapeConstrain()) {
          // A half-made constraint goes first; the tool stays on.
        } else if (activeTool !== 'select' && activeTool !== 'region') {
          if (activeTool === 'drill') clearDrillPoints()
          setActiveTool('select')
          latest.current.cancelTool()
        }
      }
    }
    const onUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceHeldRef.current = false
      if (!e.shiftKey) setShiftDown(false)
      if (e.key === 'Alt') setAltDown(false)
    }
    // Alt+Tab / Cmd+Tab / dialogs swallow the keyup, so a held modifier would
    // stick until tapped again — clear them all when the window loses focus.
    const onBlur = () => {
      spaceHeldRef.current = false
      setShiftDown(false)
      setAltDown(false)
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [spaceHeldRef, setAltDown, setShiftDown])
}
