import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { AVAILABLE_FONTS, loadFont, getFont, isSingleStrokeFont } from '../shapes/textGenerator'

function buildPreviewSVG(family: string, text: string): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const font: any = getFont(family)
  if (!font) return ''
  try {
    const size = 32
    const path = font.getPath(text, 0, size, size)
    const bb = path.getBoundingBox()
    if (!bb || bb.x2 <= bb.x1 || bb.y2 <= bb.y1) return ''
    const pad = 3
    const vw = bb.x2 - bb.x1 + pad * 2
    const vh = bb.y2 - bb.y1 + pad * 2
    const d: string = path.toPathData(1)
    // Single-stroke fonts are open polylines — stroke them; outline fonts fill.
    const paint = isSingleStrokeFont(family)
      ? `fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"`
      : `fill="currentColor"`
    return (
      `<svg xmlns="http://www.w3.org/2000/svg"` +
      ` viewBox="${bb.x1 - pad} ${bb.y1 - pad} ${vw} ${vh}"` +
      ` height="44" preserveAspectRatio="xMinYMid meet"` +
      ` style="display:block;max-width:100%"` +
      ` aria-hidden="true"><path d="${d}" ${paint}/></svg>`
    )
  } catch {
    return ''
  }
}

interface Props {
  value: string
  onChange: (family: string) => void
  previewText?: string
  className?: string
}

// Approximate height of the preview strip + the menu's borders, reserved when
// sizing the scrollable list against the available viewport space.
const PREVIEW_RESERVE = 64
// Matches the old `max-h-44` (11rem) — the list never grows taller than this.
const LIST_MAX = 176

export default function FontSelect({ value, onChange, previewText, className = '' }: Props) {
  const [open, setOpen] = useState(false)
  const [hoveredFamily, setHoveredFamily] = useState<string | null>(null)
  const [previewSVG, setPreviewSVG] = useState<string>('')
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Fixed-viewport placement so the menu escapes the sidebar's scroll clipping
  // and can flip above the field when there isn't room below.
  const [pos, setPos] = useState<{ left: number; width: number; top: number | null; bottom: number | null; listMaxH: number }>(
    { left: 0, width: 0, top: 0, bottom: null, listMaxH: LIST_MAX }
  )

  const recalc = useCallback(() => {
    const el = rootRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const margin = 8
    const spaceBelow = window.innerHeight - r.bottom - margin
    const spaceAbove = r.top - margin
    // Drop up only when below is too cramped for a usable list and above has more room.
    const dropUp = spaceBelow < LIST_MAX + PREVIEW_RESERVE && spaceAbove > spaceBelow
    const listMaxH = Math.max(80, Math.min(LIST_MAX, (dropUp ? spaceAbove : spaceBelow) - PREVIEW_RESERVE))
    setPos(dropUp
      ? { left: r.left, width: r.width, top: null, bottom: window.innerHeight - r.top + 2, listMaxH }
      : { left: r.left, width: r.width, top: r.bottom + 2, bottom: null, listMaxH })
  }, [])

  useEffect(() => {
    if (!open) return
    recalc()
    const onMouse = (e: MouseEvent) => {
      const t = e.target as Node
      if (rootRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const reposition = () => recalc()
    document.addEventListener('mousedown', onMouse)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', reposition)
    // Capture phase so the menu follows when any ancestor (the sidebar) scrolls.
    window.addEventListener('scroll', reposition, true)
    return () => {
      document.removeEventListener('mousedown', onMouse)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [open, recalc])

  const sampleText = previewText?.trim() || 'AaBbCc'

  const showPreview = useCallback((family: string) => {
    const font = getFont(family)
    if (font) {
      setPreviewSVG(buildPreviewSVG(family, sampleText))
    } else {
      setPreviewSVG('')
      loadFont(family).then(() => {
        setPreviewSVG(buildPreviewSVG(family, sampleText))
      })
    }
  }, [sampleText])

  const handleEnter = useCallback((family: string) => {
    setHoveredFamily(family)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => showPreview(family), 60)
  }, [showPreview])

  const handleLeave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  // Refresh preview if previewText changes while a font is hovered
  useEffect(() => {
    if (hoveredFamily && open) showPreview(hoveredFamily)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sampleText])

  const selectedLabel = AVAILABLE_FONTS.find(f => f.family === value)?.label ?? value

  const btnCls =
    'w-full flex items-center justify-between gap-1 bg-gray-50 dark:bg-neutral-900 ' +
    'border border-gray-300 dark:border-neutral-700 rounded px-1.5 py-0.5 text-body ' +
    'text-gray-800 dark:text-neutral-200 text-left hover:border-gray-400 ' +
    'dark:hover:border-neutral-500 focus:outline-none focus:border-blue-500'

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button type="button" onClick={() => setOpen(o => !o)} className={btnCls}>
        <span className="truncate">{selectedLabel}</span>
        <svg className="shrink-0 w-3 h-3 opacity-50" viewBox="0 0 12 12" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M2 4l4 4 4-4" />
        </svg>
      </button>

      {open && createPortal(
        <div
          ref={menuRef}
          className="fixed z-50 bg-white dark:bg-neutral-800 border border-gray-200 dark:border-neutral-600 rounded shadow-lg"
          style={{
            left: pos.left,
            width: pos.width,
            ...(pos.top != null ? { top: pos.top } : { bottom: pos.bottom ?? 0 }),
          }}
        >
          {/* Font list */}
          <div className="overflow-y-auto" style={{ maxHeight: pos.listMaxH }}>
            {AVAILABLE_FONTS.map(f => {
              const active = f.family === value
              const hovered = f.family === hoveredFamily
              return (
                <button
                  key={f.family}
                  type="button"
                  onMouseEnter={() => handleEnter(f.family)}
                  onMouseLeave={handleLeave}
                  onClick={() => { onChange(f.family); setOpen(false) }}
                  className={[
                    'w-full px-2 py-1 text-body text-left',
                    active
                      ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                      : hovered
                        ? 'bg-gray-100 dark:bg-neutral-700 text-gray-800 dark:text-neutral-200'
                        : 'text-gray-800 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700',
                  ].join(' ')}
                >
                  {f.label}
                </button>
              )
            })}
          </div>

          {/* Preview zone */}
          <div className="border-t border-gray-200 dark:border-neutral-600 px-2 py-1.5 min-h-[52px] flex items-center">
            {previewSVG
              ? <span className="text-gray-800 dark:text-neutral-200"
                  dangerouslySetInnerHTML={{ __html: previewSVG }} />
              : <span className="text-label text-gray-600 dark:text-neutral-400 italic">
                  {hoveredFamily ? 'Loading…' : 'Hover a font to preview'}
                </span>
            }
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
