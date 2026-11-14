// The sheet's holding strips (cam/bridges, where they are called bridges): each a
// translucent band across the gap it joins, drawn in CNC space under the tab markers, so
// where the cuts will lift can be checked against the parts before anything is cut.
//
// While the Tabs form is open they can be DRAGGED: a strip slides along the outline it
// leaves from and stays a join between the same two parts (or the part and the frame),
// square off the outline and off both parts' corners (cam/bridgePick). Where no such join
// exists under the pointer it stays at the last place that had one. Shift-click (or Alt-click) deletes.
// One undo step and one regeneration per drag, on release — the moves in between are local.

import { memo, useMemo, useState } from 'react'
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

function band(l: BridgeLine, h: number): number[] | null {
  const len = Math.hypot(l.x2 - l.x1, l.y2 - l.y1)
  if (len < 1e-9) return null
  // The band's corners: the centreline pushed half a width to either side.
  const nx = -(l.y2 - l.y1) / len * h, ny = (l.x2 - l.x1) / len * h
  return [l.x1 + nx, l.y1 + ny, l.x2 + nx, l.y2 + ny, l.x2 - nx, l.y2 - ny, l.x1 - nx, l.y1 - ny]
}

export const BridgeLayer = memo(function BridgeLayer({ viewport }: { viewport: Viewport }) {
  const bridges = useWorkpieceStore((s) => s.bridges)
  const interactive = useUIStore((s) => s.tabsFormActive)
  const [drag, setDrag] = useState<{ i: number; line: BridgeLine } | null>(null)
  const [hover, setHover] = useState<number | null>(null)
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
      const cnc = screenToCNC(p.x, p.y, viewport)
      const pick = stripAt(ix, cnc.x, cnc.y, opts)
      if (pick) { line = pick.line; setDrag({ i, line }) }
    }
    let done = false
    const onUp = () => {
      if (done) return
      done = true
      stage.off('mousemove.bridgedrag')
      stage.off('mouseup.bridgedrag')
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      setDrag(null)
      if (line !== start) moveStrip(i, line)
    }
    stage.on('mousemove.bridgedrag', onMove)
    stage.on('mouseup.bridgedrag', onUp)
    // Released outside the canvas: still the end of the drag.
    window.addEventListener('mouseup', onUp, { once: true })
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
            <Line closed fill={OP_TYPE_COLORS.tabs} opacity={hot ? 0.75 : 0.45} perfectDrawEnabled={false} points={pts} listening={false} />
            {/* The grab area: the strip, or GRAB_PX across on screen when it is thinner than
                that. Invisible — opacity does not reach Konva's hit canvas. */}
            {interactive && (
              <Line points={[l.x1, l.y1, l.x2, l.y2]} stroke="#000" opacity={0}
                strokeWidth={Math.max(bridges.widthMM, GRAB_PX / viewport.scale)}
                onMouseDown={onDown(i)}
                onMouseEnter={() => { setHover(i); if (!drag) document.body.style.cursor = 'grab' }}
                onMouseLeave={() => { setHover(null); if (!drag) document.body.style.cursor = '' }} />
            )}
          </Group>
        )
      })}
    </Group>
  )
})
