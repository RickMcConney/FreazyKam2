import { useEffect, useRef, useState, type RefObject } from 'react'
import type { Viewport } from './viewport'

/** Held this long without travelling, a touch press becomes a SHIFT press. */
export const LONG_PRESS_MS = 450
/** Travel (screen px) under which a held finger still counts as "not moving". */
export const TOUCH_SLOP_PX = 10

/**
 * TOUCH ON THE CANVAS: long press is Shift, two fingers pan and pinch.
 *
 * A tablet has no modifier keys and no wheel. Rather than teach every handler about touch,
 * this sits IN FRONT of Konva (capture-phase listeners on the canvas container) and turns
 * finger input into the pointer events the handlers already understand:
 *
 * - A touch press is HELD BACK until it means something. It travels past TOUCH_SLOP_PX → the
 *   press is replayed as it was (at its original spot, so nothing jumps) and the gesture is a
 *   plain drag. It lifts first → replayed, then the lift: a plain tap. It is held for
 *   LONG_PRESS_MS → replayed with `shiftKey: true`, and EVERY later event of that finger is
 *   re-sent with Shift set too — so Shift-click, Shift-drag, Shift-tab-delete and the rest
 *   work unchanged, down to the handlers that read Shift mid-drag.
 * - With a tool that PLACES something where its hover preview stands (a shape, the stamp —
 *   `hoverTracks`), a finger has no hover to aim with, so one finger IS the hover: the
 *   preview appears under it on touch and follows it, snapped, and the lift places it there
 *   (a press and release where the finger last was). A long press still starts a real
 *   press, so long press + drag sizes a shape as a mouse drag does.
 * - A second finger is a pinch: whatever the first was doing is abandoned (a held-back press
 *   was never replayed, so usually nothing had started), and the two fingers pan and zoom
 *   about their midpoint. Nothing reaches Konva until every finger is up.
 *
 * Mouse and pen events are never touched.
 */
export function useTouchInput(opts: {
  containerRef: RefObject<HTMLDivElement | null>
  viewportRef: { current: Viewport }
  setViewport: (v: Viewport) => void
  clampScale: (s: number) => number
  /** A second finger arrived while a one-finger gesture was live: drop it. */
  abortGesture: () => void
  /** True while a one-finger touch should move the hover preview rather than press. */
  hoverTracks: () => boolean
}) {
  const optsRef = useRef(opts)
  optsRef.current = opts
  /** Where a long press engaged Shift, in container px — drawn as a ring until the lift. */
  const [shiftRing, setShiftRing] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const el = opts.containerRef.current
    if (!el) return
    const forged = new WeakSet<Event>()
    const touches = new Map<number, { x: number; y: number }>()
    // `last`: the latest position of a pending press — where a TRACKING press lands.
    let pending: { id: number; down: PointerEvent; last: PointerEvent; target: EventTarget; timer: number; track: boolean } | null = null
    const shifted = new Set<number>()
    /** Fingers moving the hover preview (hoverTracks) — never pressed until they lift. */
    const hovering = new Set<number>()
    const swallow = new Set<number>()
    let pinch: { a: number; b: number; d0: number; m0: { x: number; y: number }; vp0: Viewport } | null = null

    const local = (x: number, y: number) => {
      const r = el.getBoundingClientRect()
      return { x: x - r.left, y: y - r.top }
    }
    const resend = (target: EventTarget, src: PointerEvent, type: string, shift: boolean, buttons = src.buttons) => {
      const ev = new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        clientX: src.clientX, clientY: src.clientY, screenX: src.screenX, screenY: src.screenY,
        pointerId: src.pointerId, pointerType: src.pointerType, isPrimary: src.isPrimary,
        button: type === 'pointermove' ? -1 : src.button, buttons, width: src.width, height: src.height,
        pressure: src.pressure, shiftKey: shift || src.shiftKey, altKey: src.altKey,
        ctrlKey: src.ctrlKey, metaKey: src.metaKey,
      })
      forged.add(ev)
      target.dispatchEvent(ev)
    }
    const release = (shift: boolean) => {
      if (!pending) return
      const p = pending
      pending = null
      clearTimeout(p.timer)
      resend(p.target, p.track ? p.last : p.down, 'pointerdown', shift, 1)
    }
    /** The hover a mouse would have given: a move with no button held. */
    const hover = (target: EventTarget, src: PointerEvent) => resend(target, src, 'pointermove', false, 0)
    const startPinch = () => {
      const [a, b] = [...touches.keys()]
      const pa = touches.get(a)!, pb = touches.get(b)!
      pinch = {
        a, b,
        d0: Math.max(1, Math.hypot(pb.x - pa.x, pb.y - pa.y)),
        m0: local((pa.x + pb.x) / 2, (pa.y + pb.y) / 2),
        vp0: optsRef.current.viewportRef.current,
      }
    }
    const movePinch = () => {
      if (!pinch) return
      const pa = touches.get(pinch.a), pb = touches.get(pinch.b)
      if (!pa || !pb) return
      const { vp0, m0, d0 } = pinch
      const m = local((pa.x + pb.x) / 2, (pa.y + pb.y) / 2)
      const s = optsRef.current.clampScale(vp0.scale * Math.hypot(pb.x - pa.x, pb.y - pa.y) / d0)
      // The CNC point that was under the fingers' midpoint stays under it.
      const cx = (m0.x - vp0.x) / vp0.scale
      const cy = (vp0.y - m0.y) / vp0.scale
      optsRef.current.setViewport({ scale: s, x: m.x - cx * s, y: m.y + cy * s })
    }

    const onDown = (e: PointerEvent) => {
      if (forged.has(e) || e.pointerType !== 'touch') return
      // Only presses on the drawing itself — the zoom buttons and overlays inside the
      // container are ordinary HTML and keep their own taps.
      if (!(e.target instanceof HTMLCanvasElement)) return
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
      e.stopPropagation()
      if (touches.size === 1) {
        const id = e.pointerId
        const track = optsRef.current.hoverTracks()
        if (track) hover(e.target, e)
        pending = {
          id, down: e, last: e, target: e.target, track,
          timer: window.setTimeout(() => {
            if (pending?.id !== id) return
            release(true)
            shifted.add(id)
            setShiftRing(local(e.clientX, e.clientY))
            navigator.vibrate?.(15)
          }, LONG_PRESS_MS),
        }
        return
      }
      // A second finger: the first one's gesture, if it got going, is dropped.
      if (pending) { clearTimeout(pending.timer); pending = null }
      else if (hovering.size === 0) optsRef.current.abortGesture()
      shifted.clear()
      hovering.clear()
      setShiftRing(null)
      if (touches.size === 2) startPinch()
      for (const id of touches.keys()) swallow.add(id)
    }

    const onMove = (e: PointerEvent) => {
      if (forged.has(e) || !touches.has(e.pointerId)) return
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (swallow.has(e.pointerId)) { e.stopPropagation(); movePinch(); return }
      if (hovering.has(e.pointerId)) { e.stopPropagation(); hover(e.target!, e); return }
      if (pending?.id === e.pointerId) {
        const d = pending.down
        pending.last = e
        const still = Math.hypot(e.clientX - d.clientX, e.clientY - d.clientY) < TOUCH_SLOP_PX
        if (pending.track) {
          // Travel ends the chance of a long press; the finger goes on aiming the preview.
          e.stopPropagation()
          hover(e.target!, e)
          if (!still) { clearTimeout(pending.timer); pending = null; hovering.add(e.pointerId) }
          return
        }
        if (still) { e.stopPropagation(); return }
        release(false) // and this move goes on through
        return
      }
      if (shifted.has(e.pointerId)) { e.stopPropagation(); resend(e.target!, e, e.type, true) }
    }

    const onUp = (e: PointerEvent) => {
      if (forged.has(e) || !touches.has(e.pointerId)) return
      touches.delete(e.pointerId)
      if (swallow.has(e.pointerId)) {
        e.stopPropagation()
        swallow.delete(e.pointerId)
        if (pinch && (pinch.a === e.pointerId || pinch.b === e.pointerId)) pinch = null
        return
      }
      if (hovering.delete(e.pointerId)) {
        // The lift places what the preview shows: a press and release where the finger is.
        if (e.type === 'pointercancel') { e.stopPropagation(); return }
        resend(e.target!, e, 'pointerdown', false, 1)
        return
      }
      if (pending?.id === e.pointerId) {
        // A tap. A cancelled one never happened.
        if (e.type === 'pointercancel') { clearTimeout(pending.timer); pending = null; return }
        pending.last = e
        release(false)
        return
      }
      if (shifted.delete(e.pointerId)) {
        e.stopPropagation()
        setShiftRing(null)
        resend(e.target!, e, e.type, true)
      }
    }

    // Android raises a context menu on a long press; it would land on top of the Shift press.
    const onContext = (e: Event) => { if (touches.size > 0) e.preventDefault() }

    const cap = { capture: true }
    el.addEventListener('pointerdown', onDown, cap)
    el.addEventListener('pointermove', onMove, cap)
    el.addEventListener('pointerup', onUp, cap)
    el.addEventListener('pointercancel', onUp, cap)
    el.addEventListener('contextmenu', onContext, cap)
    return () => {
      if (pending) clearTimeout(pending.timer)
      el.removeEventListener('pointerdown', onDown, cap)
      el.removeEventListener('pointermove', onMove, cap)
      el.removeEventListener('pointerup', onUp, cap)
      el.removeEventListener('pointercancel', onUp, cap)
      el.removeEventListener('contextmenu', onContext, cap)
    }
  }, [opts.containerRef])

  return { shiftRing }
}
