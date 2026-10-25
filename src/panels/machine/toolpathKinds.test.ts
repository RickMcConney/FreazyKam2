import { describe, it, expect } from 'vitest'
import { TOOLPATH_KINDS, checkSettings, type PlanContext, type SettingSpec } from './toolpathKinds'
import { profile3dSettingsOf } from './opDefaults'
import type { Profile3dOperation } from '../../store/toolpathStore'
import type { Tool, ToolType } from '../../store/toolStore'

const tool = (id: string, type: ToolType, diameterMM = 6): Tool => ({
  id, name: id, type, diameterMM, fluteCount: 2, rpm: 18000, xyFeedMmMin: 1000, zFeedMmMin: 300, maxDepthMM: 20,
  ...(type === 'vbit' || type === 'taper' ? { vbitAngleDeg: 60 } : {}),
})
// Two of every type, so a test can always ask for a tool that is NOT the default.
const tools: Tool[] = (['endmill', 'ballnose', 'bullnose', 'vbit', 'taper', 'drill'] as ToolType[])
  .flatMap((t) => [tool(`${t}-a`, t), tool(`${t}-b`, t, 3)])
const ctx: PlanContext = { tools, thicknessMM: 10, saved: () => null }

/** A valid value for `spec` that is not `current` — so seeing it in the plan proves it was used. */
function another(spec: SettingSpec, current: unknown, s: Record<string, unknown>): unknown {
  if (spec.enum) return spec.enum.find((v) => v !== current)
  if (spec.toolsFor) return spec.toolsFor(tools, s).find((t) => t.id !== current)?.id
  if (spec.type === 'boolean') return !current
  if (spec.type === 'number') {
    const now = typeof current === 'number' ? current : 0
    const step = spec.multipleOf ?? 0.37
    return now + step <= (spec.maximum ?? Infinity) ? now + step : now - step
  }
  return undefined
}

describe('the toolpath registry', () => {
  for (const kind of Object.values(TOOLPATH_KINDS)) {
    describe(kind.type, () => {
      const defaults = kind.plan([], {}, ctx, []).settings

      // A setting that only means something with another (a roughing tool, a depth map) is
      // pinned with that other below, by name — not skipped silently.
      for (const [key, spec] of Object.entries(kind.settings).filter(([, sp]) => !sp.onlyWith)) {
        it(`a "${key}" given to create reaches the operation's settings`, () => {
          let s: Record<string, unknown>
          if (key === 'toolId') {
            const allowed = kind.allowedTools(tools, defaults)
            s = { toolId: allowed.find((t) => t.id !== defaults.toolId)!.id }
          } else {
            s = { [key]: another(spec, defaults[key], defaults) }
            // A spring pass is a second finishing pass; with no finishing pass there is nothing to repeat.
            if (key === 'springPass') s.finishPassMM = 0.3
          }
          checkSettings(kind, s) // every value above is one the registry itself calls valid
          expect(kind.plan([], s, ctx, []).settings[key]).toEqual(s[key])
        })
      }

      it('offers a tool by default that it also allows', () => {
        const plan = kind.plan([], {}, ctx, [])
        expect(kind.allowedTools(tools, plan.settings).map((t) => t.id)).toContain(plan.tool.id)
      })
    })
  }
})

describe('a 3D Profile setting that only means something with another', () => {
  const kind = TOOLPATH_KINDS.profile3d
  const picture = { id: 'pic', name: 'pic', d: 'M0 0 L10 0 L10 10 L0 10 Z', visible: true, color: '#000', imageSrc: 'data:,' }
  const ring = { id: 'ring', name: 'ring', d: 'M-5 -5 L20 -5 L20 20 L-5 20 Z', visible: true, color: '#000' }
  const fieldsOf = (s: Record<string, unknown>, paths = [picture], c: PlanContext = ctx) =>
    kind.plan(paths, s, c, []).items[0].fields as Record<string, unknown>

  for (const [key, value] of [['roughingStepoverPercent', 45], ['roughingStepDownMM', 1.5], ['roughingStockAllowanceMM', 0.4], ['roughingRasterAngleDeg', 30]] as const) {
    it(`"${key}" reaches the operation once there is a roughing tool, and not without one`, () => {
      expect(fieldsOf({ roughingToolId: 'endmill-b', [key]: value })[key]).toBe(value)
      expect(fieldsOf({ [key]: value })[key]).toBeUndefined()
    })
  }

  for (const [key, value] of [['reliefDepthMM', 4.5], ['invertDepth', true]] as const) {
    it(`"${key}" reaches the operation of a depth-map picture`, () => {
      expect(fieldsOf({ [key]: value })[key]).toBe(value)
    })
  }

  it('"boundaryPathId" reaches the operation with boundary "path", and is refused naming no path', () => {
    const withPaths: PlanContext = { ...ctx, allPaths: [picture, ring] }
    expect(fieldsOf({ boundary: 'path', boundaryPathId: 'ring' }, [picture], withPaths).boundaryPathId).toBe('ring')
    expect(() => fieldsOf({ boundary: 'path', boundaryPathId: 'gone' }, [picture], withPaths)).toThrow(/boundaryPathId/)
  })

  it('an op made without roughing reads back with the form\'s roughing fallbacks, not blanks — a blank stepover is no roughing pass', () => {
    const op = { type: 'profile3d', toolId: 'ballnose-a', stepoverPercent: 20, rasterAngleDeg: 0, maxDepthMM: 6, pathId: 'pic' } as unknown as Profile3dOperation
    const back = profile3dSettingsOf(op)
    expect(back).toMatchObject({ roughingToolId: '', roughingStepoverPercent: 60, roughingStepDownMM: 2, roughingStockAllowanceMM: 0.3 })
    // ...so adding a roughing tool later gives the operation a real roughing pass.
    expect(fieldsOf({ ...back, roughingToolId: 'endmill-b' })).toMatchObject({ roughingToolId: 'endmill-b', roughingStepoverPercent: 60 })
  })

  it('names both tools when it roughs, which is why an edit renames it', () => {
    expect(kind.plan([picture], { roughingToolId: 'endmill-b' }, ctx, []).items[0].name).toMatch(/rough: endmill-b \/ finish: /)
  })
})

describe('checkSettings refuses a bad setting by name rather than cutting the default', () => {
  const profile = TOOLPATH_KINDS.profile
  it('refuses a setting the type does not have, listing the ones it does', () => {
    expect(() => checkSettings(profile, { width: 3 })).toThrow(/no setting "width".*side/)
  })
  it('refuses a value of the wrong type', () => {
    expect(() => checkSettings(profile, { depthMM: '3' })).toThrow(/"depthMM" must be a number/)
  })
  it('refuses a choice that is not on the list', () => {
    expect(() => checkSettings(profile, { side: 'left' })).toThrow(/"side" must be one of inside, outside, centerline/)
  })
  it('refuses a depth of zero — a cut that goes nowhere', () => {
    expect(() => checkSettings(profile, { depthMM: 0 })).toThrow(/"depthMM" must be more than 0/)
  })
  it('refuses a raster angle between its steps rather than rounding it', () => {
    expect(() => checkSettings(TOOLPATH_KINDS.photovcarve, { passAngleDeg: 37 })).toThrow(/multiple of 5/)
  })
  it('refuses a stepover past 100%', () => {
    expect(() => checkSettings(TOOLPATH_KINDS.pocket, { stepoverPercent: 120 })).toThrow(/at most 100/)
  })
  it('refuses, on an update, a setting only a new toolpath can take, and says why', () => {
    expect(() => checkSettings(TOOLPATH_KINDS.drill, { drillMode: 'helical' }, true)).toThrow(/can't be changed: .*create it again/)
    expect(checkSettings(TOOLPATH_KINDS.drill, { drillMode: 'helical' })).toEqual({ drillMode: 'helical' })
  })
})

describe('a toolpath type refuses a tool it cannot cut with', () => {
  it('a pocket will not take a V-bit, and names the tools it will take', () => {
    expect(() => TOOLPATH_KINDS.pocket.plan([], { toolId: 'vbit-a' }, ctx, [])).toThrow(/cannot use tool "vbit-a".*endmill-a/)
  })
  it('a helical drill will not take a drill bit — it bores with the side of the tool', () => {
    expect(() => TOOLPATH_KINDS.drill.plan([], { drillMode: 'helical', toolId: 'drill-a' }, ctx, [])).toThrow(/helical drill cannot use tool "drill-a"/)
  })
})

describe('a profile made through create_toolpath uses the saved settings of its side', () => {
  const profile = TOOLPATH_KINDS.profile
  // Lettering with a V-bit on the centerline was generated first, then a part cut out on
  // the outside with an end mill — so outside is the last profile generated.
  const saved: Record<string, Record<string, unknown>> = {
    'profile:centerline': { side: 'centerline', toolId: 'vbit-a', depthMM: 1 },
    'profile:outside': { side: 'outside', toolId: 'endmill-b', depthMM: 6 },
    profile: { side: 'outside', toolId: 'endmill-b', depthMM: 6 },
  }
  const c: PlanContext = { ...ctx, saved: (k) => saved[k] ?? null }
  const plan = (s: Record<string, unknown>) => profile.plan([], s, c, []).settings

  it('takes the tool and depth saved for the side it is asked for', () => {
    expect(plan({ side: 'centerline' })).toMatchObject({ side: 'centerline', toolId: 'vbit-a', depthMM: 1 })
    expect(plan({ side: 'outside' })).toMatchObject({ side: 'outside', toolId: 'endmill-b', depthMM: 6 })
  })

  it('cuts on the side generated last when no side is asked for', () => {
    expect(plan({})).toMatchObject({ side: 'outside', toolId: 'endmill-b', depthMM: 6 })
  })

  it('falls back on the last profile\'s settings for a side never generated', () => {
    expect(plan({ side: 'inside' })).toMatchObject({ side: 'inside', toolId: 'endmill-b', depthMM: 6 })
  })

  it('lets a setting given to create override the side\'s saved one', () => {
    expect(plan({ side: 'centerline', depthMM: 0.5 })).toMatchObject({ toolId: 'vbit-a', depthMM: 0.5 })
  })
})
