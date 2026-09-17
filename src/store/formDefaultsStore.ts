import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Tool } from './toolStore'

interface FormDefaultsState {
  defaults: Record<string, Record<string, unknown>>
  save: (type: string, state: object) => void
  load: (type: string) => Record<string, unknown> | null
}

export const useFormDefaultsStore = create<FormDefaultsState>()(
  persist(
    (set, get) => ({
      defaults: {},
      save: (type, state) => set((s) => ({ defaults: { ...s.defaults, [type]: state as Record<string, unknown> } })),
      load: (type) => get().defaults[type] ?? null,
    }),
    { name: 'kam-form-defaults' }
  )
)

// Merges saved defaults over fallback, re-validating any *ToolId / toolId fields
// against the current tool list so stale IDs fall back gracefully.
export function mergeWithDefaults<T extends Record<string, unknown>>(
  saved: Record<string, unknown> | null,
  fallback: T,
  tools: Tool[]
): T {
  if (!saved) return fallback
  const merged = { ...fallback, ...saved } as T
  for (const key of Object.keys(merged)) {
    if (key === 'toolId' || key.endsWith('ToolId')) {
      const id = merged[key] as string
      // 'none' is an explicit "no tool" sentinel (e.g. inlay finish=None), not a stale ID.
      if (id !== 'none' && !tools.some((t) => t.id === id)) (merged as Record<string, unknown>)[key] = fallback[key]
    }
  }
  return merged
}
