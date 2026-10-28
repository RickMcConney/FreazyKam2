// WHICH WAY THE MACHINE'S AXES POINT ON THE DRAWING. Everything in the app — paths,
// toolpaths, the stock, the canvas — is drawn as the user sees the table, +X right and +Y
// up. Most machines agree; some have their X axis running away from the operator, which on
// the drawing is UP. The coordinates turn only where they cross to the machine: the G-code
// writer turns them on the way out, and anything that parses a program back to lay it over
// the drawing (the simulator, the export check) turns them back.
//
// A TURN, never a swap. A machine is right-handed (X × Y = Z up), so with +X up the
// drawing, +Y points LEFT. Swapping X and Y instead is a mirror: the part comes out
// reflected, every G2 should have been a G3, and climb milling becomes conventional.
// A quarter turn is exact (swap and negate), so no rounding is added.

export type MachineXDir = 'right' | 'up' | 'left' | 'down'

export const MACHINE_X_DIRS: readonly MachineXDir[] = ['right', 'up', 'left', 'down']

/** A point on the drawing, relative to the work origin → the same point in machine axes. */
export function toMachine(x: number, y: number, dir: MachineXDir): [number, number] {
  switch (dir) {
    case 'right': return [x, y]
    case 'up': return [y + 0, -x + 0]      // + 0: no −0 in the output
    case 'left': return [-x + 0, -y + 0]
    case 'down': return [-y + 0, x + 0]
  }
}

/** A point in machine axes → the same point on the drawing. Inverse of `toMachine`. */
export function fromMachine(x: number, y: number, dir: MachineXDir): [number, number] {
  switch (dir) {
    case 'right': return [x, y]
    case 'up': return [-y + 0, x + 0]
    case 'left': return [-x + 0, -y + 0]
    case 'down': return [y + 0, -x + 0]
  }
}

/** Turn parsed moves (machine axes) back onto the drawing, in place. */
export function movesToDrawing(segs: { x: number; y: number; prevX: number; prevY: number }[], dir: MachineXDir): void {
  if (dir === 'right') return
  for (const s of segs) {
    [s.x, s.y] = fromMachine(s.x, s.y, dir);
    [s.prevX, s.prevY] = fromMachine(s.prevX, s.prevY, dir)
  }
}
