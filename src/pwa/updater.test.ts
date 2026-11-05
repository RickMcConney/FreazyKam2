import { describe, it, expect, vi } from 'vitest'
import { createUpdater, type ContainerLike, type RegistrationLike, type WorkerLike } from './updater'

function fakeWorker(state = 'installing') {
  const changed: (() => void)[] = []
  const worker = {
    state,
    postMessage: vi.fn(),
    addEventListener: (_: 'statechange', l: () => void) => { changed.push(l) },
  } satisfies WorkerLike
  return { worker, setState: (s: string) => { worker.state = s; changed.forEach((l) => l()) } }
}

function fakeRegistration(over: Partial<RegistrationLike> = {}) {
  const found: (() => void)[] = []
  const reg: RegistrationLike = {
    waiting: null,
    installing: null,
    update: vi.fn(async () => {}),
    addEventListener: (_, l) => { found.push(l) },
    ...over,
  }
  return { reg, foundUpdate: () => found.forEach((l) => l()) }
}

function setup({ controlled = true, linked = false } = {}) {
  const changes: (() => void)[] = []
  const container: ContainerLike = {
    controller: controlled ? {} : null,
    addEventListener: (_, l) => { changes.push(l) },
  }
  const machine = { linked }
  const deps = {
    container,
    machineLinked: () => machine.linked,
    reload: vi.fn(),
    onUpdateReady: vi.fn(),
    onOfflineReady: vi.fn(),
  }
  return { updater: createUpdater(deps), deps, machine, controllerChanges: () => changes.forEach((l) => l()) }
}

describe('finding a new version', () => {
  it('offers an update already waiting when the app opens', () => {
    const { updater, deps } = setup()
    updater.attach(fakeRegistration({ waiting: fakeWorker('installed').worker }).reg)
    expect(deps.onUpdateReady).toHaveBeenCalledOnce()
  })

  it('offers an update found while the app is open, once it has finished downloading', () => {
    const { updater, deps } = setup()
    const { reg, foundUpdate } = fakeRegistration()
    updater.attach(reg)
    const next = fakeWorker()
    reg.installing = next.worker
    foundUpdate()
    expect(deps.onUpdateReady).not.toHaveBeenCalled()
    next.setState('installed')
    expect(deps.onUpdateReady).toHaveBeenCalledOnce()
  })

  it('never reloads just because an update arrived', () => {
    const { updater, deps } = setup()
    updater.attach(fakeRegistration({ waiting: fakeWorker('installed').worker }).reg)
    expect(deps.reload).not.toHaveBeenCalled()
  })

  it('calls the very first install offline-ready, not an update', () => {
    const { updater, deps } = setup({ controlled: false })
    const first = fakeWorker()
    updater.attach(fakeRegistration({ installing: first.worker }).reg)
    first.setState('installed')
    expect(deps.onOfflineReady).toHaveBeenCalledOnce()
    expect(deps.onUpdateReady).not.toHaveBeenCalled()
  })

  it('does not call the first install taking over the page an update', () => {
    const { updater, deps, controllerChanges } = setup({ controlled: false })
    updater.attach(fakeRegistration().reg)
    controllerChanges()
    expect(deps.onUpdateReady).not.toHaveBeenCalled()
    expect(deps.reload).not.toHaveBeenCalled()
  })

  it('counts a version found after the first install in the same session as an update', () => {
    const { updater, deps, controllerChanges } = setup({ controlled: false })
    const { reg, foundUpdate } = fakeRegistration()
    updater.attach(reg)
    controllerChanges()
    const next = fakeWorker()
    reg.installing = next.worker
    foundUpdate()
    next.setState('installed')
    expect(deps.onUpdateReady).toHaveBeenCalledOnce()
    expect(deps.onOfflineReady).not.toHaveBeenCalled()
  })
})

describe('applying an update', () => {
  it('activates the waiting version and reloads only once it has taken over', () => {
    const { updater, deps, controllerChanges } = setup()
    const waiting = fakeWorker('installed').worker
    updater.attach(fakeRegistration({ waiting }).reg)
    expect(updater.apply()).toBe(true)
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    expect(deps.reload).not.toHaveBeenCalled()
    controllerChanges()
    expect(deps.reload).toHaveBeenCalledOnce()
  })

  it('is refused while a machine is linked: nothing activates and nothing reloads', () => {
    const { updater, deps, controllerChanges } = setup({ linked: true })
    const waiting = fakeWorker('installed').worker
    updater.attach(fakeRegistration({ waiting }).reg)
    expect(updater.apply()).toBe(false)
    expect(waiting.postMessage).not.toHaveBeenCalled()
    controllerChanges()
    expect(deps.reload).not.toHaveBeenCalled()
  })

  it('goes through once the machine is disconnected', () => {
    const { updater, machine } = setup({ linked: true })
    const waiting = fakeWorker('installed').worker
    updater.attach(fakeRegistration({ waiting }).reg)
    updater.apply()
    machine.linked = false
    expect(updater.apply()).toBe(true)
    expect(waiting.postMessage).toHaveBeenCalledOnce()
  })

  it('still reloads when the waiting version is already gone, as after a cancelled Leave site', () => {
    const { updater, deps } = setup()
    updater.attach(fakeRegistration().reg)
    updater.apply()
    expect(deps.reload).toHaveBeenCalledOnce()
  })
})

describe('another tab applying an update', () => {
  it('does not reload this tab, which may be running a job', () => {
    const { updater, deps, controllerChanges } = setup({ linked: true })
    updater.attach(fakeRegistration().reg)
    controllerChanges()
    expect(deps.reload).not.toHaveBeenCalled()
  })

  it('tells this tab a reload is waiting', () => {
    const { updater, deps, controllerChanges } = setup()
    updater.attach(fakeRegistration().reg)
    controllerChanges()
    expect(deps.onUpdateReady).toHaveBeenCalledOnce()
  })
})

describe('checking for updates', () => {
  it('treats a failed check as being offline and stays quiet', async () => {
    const { updater } = setup()
    const update = vi.fn(async () => { throw new Error('offline') })
    updater.attach(fakeRegistration({ update }).reg)
    updater.check()
    await Promise.resolve()
    expect(update).toHaveBeenCalledOnce()
  })
})
