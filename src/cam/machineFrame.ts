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

/** The next setting a quarter turn ANTICLOCKWISE on — the Machine Axes Rotate button. */
export function nextMachineXDir(dir: MachineXDir): MachineXDir {
  return MACHINE_X_DIRS[(MACHINE_X_DIRS.indexOf(dir) + 1) % MACHINE_X_DIRS.length]
}

type OriginPos =
  | 'top-left' | 'top-center' | 'top-right'
  | 'mid-left' | 'center' | 'mid-right'
  | 'bottom-left' | 'bottom-center' | 'bottom-right'

const TURNED_ORIGIN: Record<OriginPos, OriginPos> = {
  'top-left': 'bottom-left', 'top-center': 'mid-left', 'top-right': 'top-left',
  'mid-left': 'bottom-center', 'center': 'center', 'mid-right': 'top-center',
  'bottom-left': 'bottom-right', 'bottom-center': 'mid-right', 'bottom-right': 'top-right',
}

/**
 * TURNING THE WHOLE SETUP, NOT JUST THE AXES. A long-Y machine drawn its own way stands
 * the sheet up on a wide monitor; turning the axes a quarter turn anticlockwise lets it lie
 * down. On an empty drawing the stock and the work origin turn WITH the axes (the stock's
 * width and height swap, the origin goes to the corner the turn carries it to), so the
 * machine sees exactly the same table: every stock corner has the same machine
 * coordinates before and after (pinned in machineFrame.test.ts). This is that corner.
 */
export function turnedOrigin<O extends OriginPos>(o: O): O {
  return TURNED_ORIGIN[o] as O
}

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
