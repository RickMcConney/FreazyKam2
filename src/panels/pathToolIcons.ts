// Path Tools and toolbar icons drawn to the Lucide spec (24 grid, 2 px round strokes, ≥ 2 px
// between elements), built with createLucideIcon so they take the same props as the stock icons.
import { createLucideIcon } from 'lucide-react'

// A part's profile cut, broken at four holding tabs that bridge the cut.
export const TabsIcon = createLucideIcon('fk-tabs', [
  ['path', { d: 'M8 4H6a2 2 0 0 0-2 2v2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2', key: 'cut' }],
  ['rect', { x: '11', y: '2', width: '2', height: '4', rx: '1', key: 'tab-top' }],
  ['rect', { x: '11', y: '18', width: '2', height: '4', rx: '1', key: 'tab-bottom' }],
  ['rect', { x: '2', y: '11', width: '4', height: '2', rx: '1', key: 'tab-left' }],
  ['rect', { x: '18', y: '11', width: '4', height: '2', rx: '1', key: 'tab-right' }],
])

// Three letters standing on a curve: a quarter arc r 12 about (22,22), each T a 4 px stem
// on the arc's normal at 27° spacing, its bar 5 px wide.
export const AlongPathIcon = createLucideIcon('fk-along-path', [
  ['path', { d: 'M10 22a12 12 0 0 1 12-12', key: 'guide' }],
  ['path', { d: 'M6.78 17.06L2.98 15.82M2.21 18.2l1.54-4.76', key: 't1' }],
  ['path', { d: 'M10.69 10.69L7.86 7.86M6.09 9.63l3.54-3.54', key: 't2' }],
  ['path', { d: 'M17.06 6.78L15.82 2.98M13.44 3.75l4.76-1.54', key: 't3' }],
])

// Simulate: a router bit — wide shank, tapered body, cutter tip — with a play triangle tucked
// under the shank where the bit narrows (2.5 px clear of it).
export const SimulateIcon = createLucideIcon('fk-simulate', [
  ['path', { d: 'M3 2h6a1 1 0 0 1 1 1v4l-2 2v6l-2 2-2-2V9L2 7V3a1 1 0 0 1 1-1Z', key: 'bit' }],
  ['path', { d: 'M6 17v5', key: 'tip' }],
  ['path', { d: 'M12 11.75a1.25 1.25 0 0 1 1.88-1.08l7.5 4.375a1.25 1.25 0 0 1 0 2.16l-7.5 4.375A1.25 1.25 0 0 1 12 20.5Z', key: 'play' }],
])

// Fluting: a flute seen from above — a round end (r 5 about (7,13)) swelling out of nothing
// at a point (22,6), the two sides drawing together towards it as the depth runs out.
export const FlutingIcon = createLucideIcon('fk-fluting', [
  ['path', { d: 'M7 8A5 5 0 0 0 7 18C14 17.5 19 18.5 22 6C18.5 12.5 14 10 7 8Z', key: 'flute' }],
])
