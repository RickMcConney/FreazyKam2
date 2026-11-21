import type { ShapeParams } from './shapeGenerators'

/** One figure in the readout shown beside a shape while it is dragged out: a
 *  length (mm, converted for display by the caller) or a plain count. */
export type ReadoutItem =
  | { label: string; mm: number }
  | { label: string; count: number }

/** The figures that DEFINE a shape, beyond the width and height of its box —
 *  those the canvas draws as dimension lines on the box itself, so a shape that
 *  is nothing but a box (a rectangle, an ellipse) states nothing here. Each is
 *  the number its Properties panel will show once it lands, so the drag answers
 *  the question the panel would. */
export function shapeDragReadout(p: ShapeParams): ReadoutItem[] {
  switch (p.type) {
    case 'roundrect':
    case 'inroundrect': return [{ label: 'R', mm: p.r }]
    case 'circle': return [{ label: 'Ø', mm: 2 * p.radius }]
    case 'polygon': return [{ label: 'R', mm: p.radius }, { label: 'Sides', count: p.sides }]
    case 'star': return [{ label: 'Outer R', mm: p.outerRadius }, { label: 'Inner R', mm: p.innerRadius }, { label: 'Points', count: p.points }]
    case 'heart': return [{ label: 'Lobe R', mm: p.curveRadius }]
    case 'slot': return [{ label: 'Length', mm: p.length }, { label: 'Width', mm: p.width }]
    case 'spirograph': return [{ label: 'R', mm: p.radius }]
    case 'board': return [{ label: 'Field W', mm: p.w }]
    case 'cam': return [{ label: 'Base Ø', mm: p.baseDia }]
    case 'ratchet': return [{ label: 'Wheel Ø', mm: p.outerDia }, { label: 'Teeth', count: p.teeth }]
    case 'escapement': return [{ label: 'Wheel Ø', mm: p.wheelDia }, { label: 'Teeth', count: p.teeth }]
    case 'gear': return [{ label: 'Module', mm: p.module }, { label: 'Teeth', count: p.teeth }]
    case 'pendulum': return [{ label: 'Length', mm: p.length }]
    default: return []
  }
}
