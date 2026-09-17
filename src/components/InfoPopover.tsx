import { useRef, useState } from 'react'
import { Info } from 'lucide-react'
import { ICON } from '../theme'

const POPOVER_WIDTH = 400

// A clickable “i” icon that opens a small panel with the given text in larger,
// easy-to-read type. Closes via the X button or by clicking anywhere outside.
// Positioned at click time (fixed coords) so it isn't clipped by the scrolling
// sidebar it usually lives in.
export default function InfoPopover({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  function toggle() {
    if (open) { setOpen(false); return }
    const el = btnRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const left = Math.max(12, Math.min(r.left, window.innerWidth - POPOVER_WIDTH - 12))
    const top = r.bottom + 6
    const maxHeight = window.innerHeight - top - 12
    setPos({ top, left, maxHeight })
    setOpen(true)
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label="More info"
        onClick={toggle}
        className="inline-flex text-gray-600 dark:text-neutral-400 hover:text-blue-500 dark:hover:text-blue-400 transition-colors cursor-pointer"
      >
        <Info size={ICON.xs} />
      </button>

      {open && pos && (
        <>
          {/* Transparent backdrop — click anywhere outside to dismiss */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            role="dialog"
            onClick={() => setOpen(false)}
            className="fixed z-50 bg-white dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 rounded-lg shadow-2xl p-4 overflow-y-auto cursor-pointer"
            style={{ top: pos.top, left: pos.left, width: POPOVER_WIDTH, maxHeight: pos.maxHeight }}
          >
            <p className="text-base leading-relaxed text-gray-700 dark:text-neutral-200">
              {text}
            </p>
          </div>
        </>
      )}
    </>
  )
}
