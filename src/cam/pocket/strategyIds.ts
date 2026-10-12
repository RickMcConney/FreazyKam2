import type { PocketStrategy } from './shared'

// Pocket strategy ids that have been retired, and what each one now runs as. One table for
// the three places an old id can arrive from: a saved project (parseProject), a regenerate
// of an operation still holding one (generatePocket), and the Pocket form's remembered
// defaults in localStorage — which a project migration never touches, so a user whose last
// pocket was adaptive would otherwise open the form with no strategy selected.
const RETIRED: Record<string, PocketStrategy> = {
  spiral: 'morph',          // offset-ring spiral, dropped 2026-07 (left stock at 50%)
  spiralOffset: 'morph',
  adaptive2: 'adaptive',    // raster-marching adaptive, replaced by FreeCAD's algorithm 2026-10
  adaptiveFC: 'adaptive',   // the interim id that algorithm shipped under
}

/** The current id for a stored strategy id (unknown ids pass through for the caller to vet). */
export function currentPocketStrategy(id: string): string {
  return RETIRED[id] ?? id
}

/** Radial engagement (WOC / D) to hand the step-down calculator for a pocket strategy.
 *  Only the adaptive strategy HOLDS its engagement at the stepover — every other strategy
 *  slots its first pass full width — so only it may step down as a light-engagement cut
 *  (deeper, toward the flute length; see computeFeeds). Shared by generation and the form
 *  so the step-down shown is the one generated. */
export function pocketEngagementFraction(strategy: string | undefined, stepoverPercent: number): number | undefined {
  return currentPocketStrategy(strategy ?? 'raster') === 'adaptive' ? stepoverPercent / 100 : undefined
}
