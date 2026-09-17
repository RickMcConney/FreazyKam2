import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ICON } from '../theme'
import { X, Copy, Check } from 'lucide-react'
import { useSimStore } from '../store/simStore'
import { getCurrentSegIdx, lineAt } from '../sim/gcodeParser'

const ROW_H = 20  // px per line — matches text-body + leading-5 + py-px

export default function GcodeViewer({ fill = false }: { fill?: boolean }) {
  // The text and where its lines start: a line is sliced out only when it scrolls into view.
  const gcode = useSimStore((s) => s.gcode)
  const lineStarts = useSimStore((s) => s.lineStarts)
  const lineCount = lineStarts.length
  const toggleGcodeViewer = useSimStore((s) => s.toggleGcodeViewer)
  const playing = useSimStore((s) => s.playing)

  // Selector returns integer — only causes re-render when line number changes, not every frame
  const currentLineIdx = useSimStore((s) => {
    const idx = getCurrentSegIdx(s.segments, s.elapsedTimeS)
    return idx >= 0 ? (s.segments[idx]?.lineIdx ?? -1) : -1
  })

  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [visibleH, setVisibleH] = useState(132)

  const [copied, setCopied] = useState(false)

  const copyToClipboard = useCallback(() => {
    // The lines as the viewer shows them, so a CRLF program copies out with \n endings.
    const text = useSimStore.getState().gcode.replace(/\r\n/g, '\n')
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [])

  const seekToLine = useCallback((lineIdx: number) => {
    const { segments, seekToTime } = useSimStore.getState()
    // Find the first segment at or after this line index
    const seg = segments.find((s) => s.lineIdx >= lineIdx)
    if (seg) seekToTime(seg.startTimeS)
  }, [])

  // Measure actual scroll area height
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setVisibleH(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Auto-scroll to current line when simulation is playing
  useEffect(() => {
    if (!playing || !scrollRef.current || currentLineIdx < 0) return
    const target = Math.max(0, currentLineIdx * ROW_H - visibleH / 2)
    scrollRef.current.scrollTop = target
  }, [currentLineIdx, playing, visibleH])

  const lineNumCh = String(lineCount).length + 1

  const buffer = 6
  const visibleStart = Math.max(0, Math.floor(scrollTop / ROW_H) - buffer)
  const visibleEnd = Math.min(lineCount, Math.ceil((scrollTop + visibleH) / ROW_H) + buffer)
  const totalH = lineCount * ROW_H

  return (
    <div className={`${fill ? 'flex-1 min-h-0' : 'h-40 flex-shrink-0'} flex flex-col border-t border-gray-300 dark:border-neutral-700 bg-gray-50 dark:bg-neutral-900`}>
      {/* Header */}
      <div className="flex items-center px-3 py-1 border-b border-gray-300 dark:border-neutral-700 flex-shrink-0 bg-gray-50 dark:bg-neutral-900">
        <span className="text-body text-gray-500 dark:text-neutral-400 font-medium">G-code Viewer</span>
        <span className="ml-2 text-body text-gray-600 dark:text-neutral-400">{lineCount} lines</span>
        <button
          onClick={copyToClipboard}
          className="ml-auto text-gray-600 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-300 transition-colors"
          title="Copy to clipboard"
        >
          {copied ? <Check size={ICON.sm} className="text-green-500" /> : <Copy size={ICON.sm} />}
        </button>
        <button
          onClick={toggleGcodeViewer}
          className="ml-2 text-gray-600 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-300 transition-colors"
          title="Close"
        >
          <X size={ICON.sm} />
        </button>
      </div>

      {/* Virtual scroll area */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto selection:bg-sky-500/40 selection:text-inherit"
        onScroll={(e) => setScrollTop((e.currentTarget).scrollTop)}
        onCopy={(e) => {
          const sel = window.getSelection()
          if (!sel) return
          e.preventDefault()
          e.clipboardData.setData('text/plain', sel.toString())
        }}
      >
        {/* Full-height spacer so the scrollbar is correctly sized */}
        <div style={{ height: totalH, position: 'relative' }}>
          {/* Only the visible window is rendered */}
          <div style={{ position: 'absolute', top: visibleStart * ROW_H, width: '100%' }}>
            {Array.from({ length: Math.max(0, visibleEnd - visibleStart) }, (_, i) => {
              const lineIdx = visibleStart + i
              const line = lineAt(gcode, lineStarts, lineIdx)
              const isActive = lineIdx === currentLineIdx
              return (
                <div
                  key={lineIdx}
                  style={{ height: ROW_H }}
                  onClick={() => seekToLine(lineIdx)}
                  className={[
                    'flex items-center px-3 text-body font-mono cursor-pointer overflow-hidden whitespace-nowrap',
                    isActive ? 'bg-yellow-500/20' : 'hover:bg-gray-100 dark:hover:bg-neutral-800',
                  ].join(' ')}
                >
                  <span className="text-gray-600 dark:text-neutral-400 shrink-0 text-right select-none mr-3" style={{ minWidth: `${lineNumCh}ch` }}>
                    {lineIdx + 1}
                  </span>
                  <span className={isActive ? 'text-yellow-100' : 'text-gray-600 dark:text-neutral-400'}>
                    {line}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
