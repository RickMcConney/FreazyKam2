import { describe, it, expect } from 'vitest'
import { mergeByName, parseSettings, pickKnown, SettingsFileError, SETTINGS_FORMAT } from './settingsMerge'

interface Item { id: string; name: string; dia: number; builtin?: boolean }
let n = 0
const mint = () => `new-${++n}`

describe('mergeByName', () => {
  const mine: Item[] = [{ id: 'a', name: '1/4 End Mill', dia: 6.35 }, { id: 'b', name: 'V-Bit', dia: 6.35 }]

  it('skips an entry that is already there with the same name and the same contents, whatever its id', () => {
    const r = mergeByName(mine, [{ id: 'zzz', name: '1/4 End Mill', dia: 6.35 }], mint)
    expect(r.list).toHaveLength(2)
    expect(r.same).toBe(1)
  })

  it('never overwrites: a same-name entry with different contents comes in beside it as a copy', () => {
    const r = mergeByName(mine, [{ id: 'a', name: '1/4 End Mill', dia: 6 }], mint)
    expect(r.list.find((t) => t.id === 'a')).toEqual(mine[0])
    const copy = r.list[2]
    expect(copy).toMatchObject({ name: '1/4 End Mill (imported)', dia: 6 })
    expect(copy.id).not.toBe('a')
    expect(r.copied).toEqual(['1/4 End Mill (imported)'])
  })

  it('numbers a second clashing copy rather than reusing the first copy\'s name', () => {
    const once = mergeByName(mine, [{ id: 'x', name: 'V-Bit', dia: 3 }], mint).list
    const twice = mergeByName(once, [{ id: 'y', name: 'V-Bit', dia: 4 }], mint)
    expect(twice.copied).toEqual(['V-Bit (imported 2)'])
  })

  it('adds a new name as it is, keeping its id when that id is free', () => {
    const r = mergeByName(mine, [{ id: 'c', name: 'Drill', dia: 3 }], mint)
    expect(r.list[2]).toEqual({ id: 'c', name: 'Drill', dia: 3 })
    expect(r.added).toEqual(['Drill'])
  })

  it('never brings a built-in flag in, so "reset to factory" stays the app\'s own', () => {
    const r = mergeByName(mine, [{ id: 'grbl-mm', name: 'Grbl (mm)', dia: 0, builtin: true }], mint)
    expect(r.list[2].builtin).toBeUndefined()
  })

  it('counts a built-in that matches the user\'s copy of it as the same, flag or no flag', () => {
    const pp: Item[] = [{ id: 'grbl-mm', name: 'Grbl (mm)', dia: 0, builtin: true }]
    expect(mergeByName(pp, [{ id: 'grbl-mm', name: 'Grbl (mm)', dia: 0 }], mint).same).toBe(1)
  })
})

describe('parseSettings', () => {
  it('names a project file for what it is instead of calling it damaged', () => {
    expect(() => parseSettings(JSON.stringify({ version: 4, paths: [], operations: [] })))
      .toThrow(/project \(\.fkam\)/)
  })

  it('refuses text that is not JSON as not a settings file', () => {
    expect(() => parseSettings('G21 G90')).toThrow(SettingsFileError)
  })

  it('keeps only the sections it knows', () => {
    const f = parseSettings(JSON.stringify({ format: SETTINGS_FORMAT, version: 1, sections: { tools: [], bogus: 1 } }))
    expect(Object.keys(f.sections)).toEqual(['tools'])
  })
})

describe('pickKnown', () => {
  it('takes only fields the current state has, with the same type, so a damaged value cannot install', () => {
    const cur = { units: 'mm', thicknessMM: 18, set: () => {} }
    expect(pickKnown(cur, { units: 'in', thicknessMM: 'thick', extra: 1, set: 5 })).toEqual({ units: 'in' })
  })

  it('refuses a number that is not finite', () => {
    expect(pickKnown({ a: 1 }, { a: null })).toEqual({})
    expect(pickKnown({ a: 1 }, JSON.parse('{"a": 1e999}'))).toEqual({})
  })
})
