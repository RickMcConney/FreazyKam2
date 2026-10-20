// Which model a 3D Profile cuts, and how the Model list names them. Found on a double-
// sided rosette: the duplicate on side B could never be picked — the form started on the
// original whatever was selected, and listed both under one name.
import { describe, it, expect } from 'vitest'
import { modelLabels, pickModelPathId } from './modelPick'

const models = [{ id: 'orig', name: 'Rosette' }, { id: 'copy', name: 'Rosette' }, { id: 'dog', name: 'Dog' }]

describe('the model a 3D Profile cuts', () => {
  it('is the selected one — a copy just as much as the original', () => {
    expect(pickModelPathId(models, ['copy'], 'orig')).toBe('copy')
    expect(pickModelPathId(models, ['dog', 'other-path'], '')).toBe('dog')
  })

  it('stays the one chosen when nothing model-like is selected', () => {
    expect(pickModelPathId(models, ['other-path'], 'copy')).toBe('copy')
  })

  it('falls back to the first when the chosen one is gone, and to nothing when there are none', () => {
    expect(pickModelPathId(models, [], 'deleted')).toBe('orig')
    expect(pickModelPathId([], [], 'x')).toBe('')
  })
})

describe('the Model list', () => {
  it('names a model by its name alone when no other shares it', () => {
    expect(modelLabels(models, () => 'Sheet 1').get('dog')).toBe('Dog')
  })

  it('tells copies sharing a name apart by where each is', () => {
    const where = (m: { id: string }) => (m.id === 'copy' ? 'Sheet 2 · Side B' : 'Sheet 1 · Side A')
    const l = modelLabels(models, where)
    expect(l.get('orig')).toBe('Rosette — Sheet 1 · Side A')
    expect(l.get('copy')).toBe('Rosette — Sheet 2 · Side B')
  })

  it('numbers copies that are in the same place too', () => {
    const l = modelLabels(models, () => 'Sheet 1')
    expect(l.get('orig')).toBe('Rosette — Sheet 1 #1')
    expect(l.get('copy')).toBe('Rosette — Sheet 1 #2')
  })
})
