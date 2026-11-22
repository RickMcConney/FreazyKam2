// The sheet's holding strips (cam/bridges, where they are called bridges): each a
// translucent band across the gap it joins, drawn in CNC space under the tab markers, so
// where the cuts will lift can be checked against the parts before anything is cut.
//
// While the Tabs form is open they can be DRAGGED: a strip slides along the outline it
// leaves from and stays a join between the same two parts (or the part and the frame),
// square off the outline and off both parts' corners (cam/bridgePick). Where no such join
// exists under the pointer it stays at the last place that had one. Shift-click (or Alt-click) deletes.
// One undo step and one regeneration per drag, on release — the moves in between are local.

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { usePathsStore } from '../../store/pathsStore'
import { useCutHiddenKey, partsOut, stripsShown } from '../holdVisibility'
import { Group, Line } from 'react-konva'
import type Konva from 'konva'
import type { Viewport } from '../viewport'
import { useWorkpieceStore } from '../../store/workpieceStore'
import { useUIStore } from '../../store/uiStore'
import { OP_TYPE_COLORS } from '../../colors'
import type { BridgeLine } from '../../cam/bridges'
import { stripAt, stripEnds } from '../../cam/bridgePick'
import { cornerClearMM } from '../../cam/bridges'
import { holdIndexNow, cutterRadiusFor, moveStrip, removeStrip } from '../../tools/bridgesRun'
import { screenToCNC } from '../viewport'

const GRAB_PX = 12

// The strip's centreline pulled in by half its width at each end, for a ROUND-CAPPED stroke
// of that width: the caps put the ends back, so it covers exactly the strip's length. A strip
// shorter than it is wide draws as a disc at its middle.
function band(l: BridgeLine, h: number): number[] | null {
  const len = Math.hypot(l.x2 - l.x1, l.y2 - l.y1)
  if (len < 1e-9) return null
  const pull = Math.min(h, len / 2) / len
  const dx = (l.x2 - l.x1) * pull, dy = (l.y2 - l.y1) * pull
  return [l.x1 + dx, l.y1 + dy, l.x2 - dx, l.y2 - dy]
}

export const BridgeLayer = memo(function BridgeLayer({ viewport }: { viewport: Viewport }) {
  const bridges = useWorkpieceStore((s) => s.bridges)
  const interactive = useUIStore((s) => s.tabsFormActive)
  const [drag, setDrag] = useState<{ i: number; line: BridgeLine } | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  // The viewport as it is NOW: the wheel zooms mid-drag (see TabLayer).
  const viewportRef = useRef(viewport)
  viewportRef.current = viewport
  // Ends a drag in progress when the form closes or the layer goes (see TabLayer).
  const endDragRef = useRef<(() => void) | null>(null)
  useEffect(() => { if (!interactive) endDragRef.current?.() }, [interactive])
  useEffect(() => () => endDragRef.current?.(), [])
  // A strip touching only parts that are hidden — or whose every profile is — is not drawn
  // (canvas/holdVisibility). With nothing hidden nothing is asked: the index is a whole nest.
  const paths = usePathsStore((s) => s.paths)
  const cutHiddenKey = useCutHiddenKey()
  const shown = useMemo(() => {
    if (!bridges) return null
    const out = partsOut(paths, cutHiddenKey)
    return out.size === 0 ? null : stripsShown(bridges.lines, holdIndexNow(true), out)
  }, [bridges, paths, cutHiddenKey])
  if (!bridges) return null
  const h = bridges.widthMM / 2

  const onDown = (i: number) => (e: Konva.KonvaEventObject<MouseEvent>) => {
    if (e.evt.button !== 0) return
    e.cancelBubble = true
    // No mouseleave comes from a node that has just gone: clear what it set.
    if (e.evt.shiftKey || e.evt.altKey) { setHover(null); document.body.style.cursor = ''; removeStrip(i); return }
    const stage = e.target.getStage()
    const start = bridges.lines[i]
    if (!stage || !start) return
    const ix = holdIndexNow()
    const ends = stripEnds(ix, start)
    // A strip whose part is gone (or not cut through any more) has nothing to slide along.
    if (!ends) return
    const toolRadiusMM = cutterRadiusFor([ends.a, ...(ends.b === 'frame' ? [] : [ends.b])])
    // Anywhere on the sheet: the drag is held to the two parts it joins, not to a distance.
    const far = Math.hypot(ix.stock.widthMM, ix.stock.heightMM)
    const opts = {
      widthMM: bridges.widthMM, toolRadiusMM, reachMM: far, pickMM: far,
      searchMM: cornerClearMM(bridges.widthMM, toolRadiusMM), fromPart: ends.a, toPart: ends.b,
    }
    let line = start
    setDrag({ i, line })
    document.body.style.cursor = 'grabbing'
    const onMove = () => {
      const p = stage.getPointerPosition()
      if (!p) return
      const cnc = screenToCNC(p.x, p.y, viewportRef.current)
      const pick = stripAt(ix, cnc.x, cnc.y, opts)
      if (pick) { line = pick.line; setDrag({ i, line }) }
    }
    let done = false
    const onUp = () => {
      if (done) return
      done = true
      endDragRef.current = null
      stage.off('pointermove.bridgedrag')
      stage.off('pointerup.bridgedrag')
      window.removeEventListener('pointerup', onUp)
      document.body.style.cursor = ''
      setDrag(null)
      if (line !== start) moveStrip(i, line)
    }
    endDragRef.current = onUp
    stage.on('pointermove.bridgedrag', onMove)
    stage.on('pointerup.bridgedrag', onUp)
    // Released outside the canvas: still the end of the drag.
    window.addEventListener('pointerup', onUp, { once: true })
  }

  return (
    <Group listening={interactive}>
      {bridges.lines.map((l0, i) => {
        if (shown && !shown[i]) return null
        const l = drag?.i === i ? drag.line : l0
        const pts = band(l, h)
        if (!pts) return null
        const hot = interactive && (hover === i || drag?.i === i)
        return (
          <Group key={i}>
            <Line stroke={OP_TYPE_COLORS.tabs} strokeWidth={2 * h} lineCap="round" opacity={hot ? 0.75 : 0.45} perfectDrawEnabled={false} points={pts} listening={false} />
            {/* The grab area: the strip, or GRAB_PX across on screen when it is thinner than
                that. Invisible — opacity does not reach Konva's hit canvas. */}
            {interactive && (
              <Line points={[l.x1, l.y1, l.x2, l.y2]} stroke="#000" opacity={0} lineCap="round"
                strokeWidth={Math.max(bridges.widthMM, GRAB_PX / viewport.scale)}
                onPointerDown={onDown(i)}
                onPointerEnter={() => { setHover(i); if (!drag) document.body.style.cursor = 'grab' }}
                onPointerLeave={() => { setHover(null); if (!drag) document.body.style.cursor = '' }} />
            )}
          </Group>
        )
      })}
    </Group>
  )
})
