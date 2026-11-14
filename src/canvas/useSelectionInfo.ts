import { useMemo, useRef } from 'react'
import { useSelectedPaths } from '../store/pathsStore'
import { isScaleLocked } from '../shapes/shapeGenerators'
import { getMultiBBox, type BBox } from './selectionUtils'

/** What the gestures and the handles need to know about the selection as a whole. */
export function useSelectionInfo() {
  const selectedPaths = useSelectedPaths()
  // Selection bbox, computed once per store change instead of per mousemove —
  // SelectionLayer + SelectionHandleLayer used to each re-flatten every selected
  // path on every liveTransform frame to derive this themselves (tofix.md H1).
  const selectionBBox = useMemo(() => getMultiBBox(selectedPaths.map((p) => p.d)), [selectedPaths])
  const selectionBBoxRef = useRef<BBox | null>(null)
  selectionBBoxRef.current = selectionBBox
  // A selection holding any mechanism whose size is set by its own parameters
  // gets no resize handles — see SCALE_LOCKED_SHAPES. Any, not every: dragging
  // a corner scales the WHOLE selection, so one gear in it is enough to make
  // the gesture wrong.
  const selectionScaleLocked = useMemo(
    () => selectedPaths.some((p) => isScaleLocked(p.shapeParams)),
    [selectedPaths],
  )
  const selectionScaleLockedRef = useRef(false)
  selectionScaleLockedRef.current = selectionScaleLocked
  // A selection holding an IMAGE cannot be skewed — Shift + middle handle scales it instead. The
  // picture and the photo V-carve are both pinned to the path's rectangle
  // (extractRectInfo), so a skew turned the outline into a parallelogram while the picture
  // stayed a rectangle and the carve followed the picture: what was drawn and what was cut
  // disagreed. Any, not every, for the same reason as the scale lock above.
  const selectionSkewLocked = useMemo(
    () => selectedPaths.some((p) => !!p.imageSrc),
    [selectedPaths],
  )
  const selectionSkewLockedRef = useRef(false)
  selectionSkewLockedRef.current = selectionSkewLocked
  // ANY flagged path in the selection is enough: scaling the group about its
  // middle is the only reading of "centred" that a mixed selection has.
  const centreResize = useMemo(() => selectedPaths.some((p) => p.fromCenter), [selectedPaths])
  const centreResizeRef = useRef(false)
  centreResizeRef.current = centreResize

  return {
    selectedPaths, selectionBBox, selectionBBoxRef,
    selectionScaleLocked, selectionScaleLockedRef,
    selectionSkewLocked, selectionSkewLockedRef,
    centreResize, centreResizeRef,
  }
}
