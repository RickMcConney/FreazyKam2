import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'

/**
 * A floating panel dragged by its header. Until the first drag it sits at `initial`;
 * after that it is pinned by its top-left corner in viewport px. Put `style` on the
 * panel and `onHeaderPointerDown` on a DIRECT child of it (the header), since the
 * panel's box is read from the header's parent. Pointer events, so a finger drags it
 * too — give the header `touch-none` or the browser takes the drag as a scroll.
 */
export function useDraggablePanel(initial: CSSProperties) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const drag = useRef<{ dx: number; dy: number } | null>(null)
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!drag.current) return
      setPos({ x: e.clientX - drag.current.dx, y: e.clientY - drag.current.dy })
    }
    const up = () => { drag.current = null }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [])

  const onHeaderPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect()
    drag.current = { dx: e.clientX - box.left, dy: e.clientY - box.top }
    setPos({ x: box.left, y: box.top })
  }
  const style: CSSProperties = pos ? { left: pos.x, top: pos.y } : initial
  return { style, onHeaderPointerDown }
}
