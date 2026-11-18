// Conventional adaptive is cut by mirroring the geometry in X, clearing it in the engine's
// natural (climb) hand and mirroring the result back. The engine is stood in for here so it
// can hand back what the real one could at any time: ONE point object shared by two paths
// (a link's end that is also the next cut's start). Negated in place, that point is flipped
// once per path holding it and lands back on the mirrored side.
import { describe, it, expect, vi } from 'vitest'
import type { Pt2 } from '../pathFlattener'
import type { Tool } from '../../store/toolStore'
import type { MotionSegment } from '../../store/toolpathStore'

vi.mock('../adaptiveFC/engine', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../adaptiveFC/engine')>()
  class AdaptiveFC {
    constructor(_: unknown) {}
    // In the engine's own (mirrored) frame: everything at x < 0.
    execute() {
      const shared: [number, number] = [-20, 5]
      return [{
        helixCenter: [-10, 10] as [number, number], startPoint: [-12, 10] as [number, number],
        adaptivePaths: [
          { motion: orig.MotionType.Cutting, pts: [[-12, 10], [-16, 8], shared] as Array<[number, number]> },
          { motion: orig.MotionType.Cutting, pts: [shared, [-24, 4], [-28, 2]] as Array<[number, number]> },
        ],
        returnMotionType: 0, clearedArea: 0, startPointNotFound: false, leadPathFailed: false,
        tooManyFailedEngagements: false, unclearedAreaRemains: false, failedToSetUpFinishingPass: false,
        finishingLeadInFailed: false,
      }]
    }
  }
  return { ...orig, AdaptiveFC }
})

const { planAdaptiveFCPocket } = await import('./adaptiveFC')

const TOOL: Tool = { id: 't', name: 'em6', type: 'endmill', diameterMM: 6, fluteCount: 2, rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 25 }
const BOX: Pt2[] = [[0, 0], [40, 0], [40, 20], [0, 20]]

describe('adaptive, conventional — the mirror back', () => {
  it('puts every point, a point shared by two paths included, back on the drawing\'s side', () => {
    const plan = planAdaptiveFCPocket(BOX, [], TOOL, { direction: 'conventional', stepoverPercent: 20, safeHeightMM: 5 } as never)!
    const segs: MotionSegment[] = []
    plan.emitCuts(-3, 0, null, segs)
    const xs = segs.filter((s) => !s.rapid && s.z === -3 && !s.arc).map((s) => s.x)
    expect(xs).toContain(20)                       // the shared point, mirrored once
    expect(xs.every((x) => x > 0)).toBe(true)
  })
})
