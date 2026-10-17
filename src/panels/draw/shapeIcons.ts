// Shape-palette icons drawn to the Lucide spec (24 grid, 2 px round strokes, ≥ 2 px between
// elements), for the shapes Lucide has nothing that looks like. Built with createLucideIcon so
// they take the same props and classes as the stock icons beside them.
import { createLucideIcon } from 'lucide-react'

// A rectangle with concave (inverted) corners, and a line of lettering.
export const SignIcon = createLucideIcon('fk-sign', [
  ['path', { d: 'M6 5h12a3 3 0 0 0 3 3v8a3 3 0 0 0-3 3H6a3 3 0 0 0-3-3V8a3 3 0 0 0 3-3Z', key: 'outline' }],
  ['path', { d: 'M8 12h8', key: 'text' }],
])

// A stadium, with the centreline the cutter runs along.
export const SlotIcon = createLucideIcon('fk-slot', [
  ['rect', { x: '2', y: '7', width: '20', height: '10', rx: '5', key: 'outline' }],
  ['path', { d: 'M7 12h10', key: 'centre' }],
])

// The default board: rounded corners, a paddle handle and a juice groove.
export const BoardIcon = createLucideIcon('fk-board', [
  ['path', { d: 'M4 4h10a2 2 0 0 1 2 2v2a1 1 0 0 0 1 1h2a3 3 0 0 1 0 6h-2a1 1 0 0 0-1 1v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z', key: 'outline' }],
  ['rect', { x: '6', y: '8', width: '6', height: '8', rx: '1', key: 'groove' }],
])

// The anchor on its arbor, its two pallets standing over the escape wheel's sawteeth.
export const EscapementIcon = createLucideIcon('fk-escapement', [
  ['path', { d: 'M12 2v3', key: 'arbor' }],
  ['path', { d: 'M5 14v-2l7-7 7 7v2', key: 'anchor' }],
  ['path', { d: 'M2 22l5-4v4l5-4v4l5-4v4l5-4', key: 'teeth' }],
])

// Two boards meeting on a square-fingered seam.
export const FingerJointIcon = createLucideIcon('fk-finger-joint', [
  ['rect', { x: '2', y: '5', width: '20', height: '14', rx: '2', key: 'outline' }],
  ['path', { d: 'M2 14h3a1 1 0 0 0 1-1v-2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2a1 1 0 0 0 1 1h3', key: 'seam' }],
])

// Two boards meeting on a dovetail: the tail flares toward its tip.
export const DovetailIcon = createLucideIcon('fk-dovetail', [
  ['rect', { x: '2', y: '5', width: '20', height: '14', rx: '2', key: 'outline' }],
  ['path', { d: 'M2 14h7l-2-4h10l-2 4h7', key: 'seam' }],
])

// A butterfly key straddling the seam it holds shut.
export const BowtieIcon = createLucideIcon('fk-bowtie', [
  ['path', { d: 'M3 6l9 3 9-3v12l-9-3-9 3Z', key: 'key' }],
  ['path', { d: 'M12 2v3', key: 'seam-top' }],
  ['path', { d: 'M12 19v3', key: 'seam-bottom' }],
])
