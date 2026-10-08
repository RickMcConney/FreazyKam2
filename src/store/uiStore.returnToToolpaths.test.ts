import { describe, it, expect } from 'vitest'
import { useUIStore } from './uiStore'

describe('returning to the Toolpaths list after an edit', () => {
  it('survives the edit form consuming its request, which clears the request', () => {
    const ui = useUIStore.getState()
    ui.setRequestEditOpId('op-1')
    ui.setReturnToToolpaths(true)
    ui.setRequestEditOpId(null)   // what MachinePanel does as it opens the form
    expect(useUIStore.getState().returnToToolpaths).toBe(true)
  })

  it('is dropped by a new edit request from anywhere else, such as an Objects chip', () => {
    useUIStore.getState().setReturnToToolpaths(true)
    useUIStore.getState().setRequestEditOpId('op-2')
    expect(useUIStore.getState().returnToToolpaths).toBe(false)
  })
})
