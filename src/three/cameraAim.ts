// The 3D view's camera, aimed from outside it — for a script that has to show the same view
// every time (scripts/screenshots). The camera lives inside ThreeView's mount effect, so the
// view registers a function here while it is on screen, as the 2D canvas does with
// registerViewFit (store/canvasStore.ts).

/** Look down on the CNC point (x, y), mm, far enough off to show `spanMM` top to bottom —
 *  straight down, or leaning back towards the viewer by `tiltDeg` from the vertical. */
export type CameraAim = (x: number, y: number, spanMM: number, tiltDeg?: number) => void

let aim: CameraAim | null = null
export function registerCameraAim(fn: CameraAim | null): void { aim = fn }
export function aimCameraFromAbove(x: number, y: number, spanMM: number, tiltDeg = 0): void { aim?.(x, y, spanMM, tiltDeg) }
