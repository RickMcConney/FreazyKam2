import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react'

/**
 * A floating panel dragged by its header. Until the first drag it sits at `initial`;
 * after that it is pinned by its top-left corner in viewport px. Put `style` on the
 * panel and `onHeaderMouseDown` on a DIRECT child of it (the header), since the
 * panel's box is read from the header's parent.
 */
export function useDraggablePanel(initial: CSSProperties) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const drag = useRef<{ dx: number; dy: number } | null>(null)
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!drag.current) return
      setPos({ x: e.clientX - drag.current.dx, y: e.clientY - drag.current.dy })
    }
    const up = () => { drag.current = null }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [])

  const onHeaderMouseDown = (e: ReactMouseEvent<HTMLElement>) => {
    const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect()
    drag.current = { dx: e.clientX - box.left, dy: e.clientY - box.top }
    setPos({ x: box.left, y: box.top })
  }
  const style: CSSProperties = pos ? { left: pos.x, top: pos.y } : initial
  return { style, onHeaderMouseDown }
}
