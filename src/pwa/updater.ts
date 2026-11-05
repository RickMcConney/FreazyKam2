// Installing an update means reloading the app, and a reload is not free here: the relay
// link dies with the page (`relayClient.ts`), and the relay cannot reopen while the machine
// moves. A reload mid-job leaves the job running with no controls until it ends. So nothing
// reloads by itself: a new version waits until the user asks for it, and asking is refused
// while a machine is connected.
//
// That is why this is not vite-plugin-pwa's own `registerSW`, which reloads on a controller
// change. The service worker is shared by every tab, so applying an update in one tab changes
// the controller of all of them, including one running a job. Here a tab only reloads if IT
// asked to; any other tab is told a reload is waiting and carries on.
//
// Everything the browser provides is passed in, so the rules can be tested under node.

export interface WorkerLike {
  state: string
  postMessage(message: unknown): void
  addEventListener(type: 'statechange', listener: () => void): void
}

export interface RegistrationLike {
  waiting: WorkerLike | null
  installing: WorkerLike | null
  update(): Promise<unknown>
  addEventListener(type: 'updatefound', listener: () => void): void
}

export interface ContainerLike {
  controller: unknown
  addEventListener(type: 'controllerchange', listener: () => void): void
}

export interface UpdaterDeps {
  container: ContainerLike
  /** Anything but fully disconnected: a link being retried may still be a job in progress. */
  machineLinked: () => boolean
  reload: () => void
  onUpdateReady: () => void
  onOfflineReady: () => void
}

export function createUpdater(deps: UpdaterDeps) {
  const { container, machineLinked, reload, onUpdateReady, onOfflineReady } = deps
  let registration: RegistrationLike | null = null
  let applying = false
  // No controller yet is the first install, which is not an update. `clientsClaim` then
  // takes this page over, so what is true at load stops being true: it is re-read after.
  let hadController = !!container.controller

  const watchInstalling = (worker: WorkerLike) => {
    worker.addEventListener('statechange', () => {
      if (worker.state !== 'installed') return
      if (hadController) onUpdateReady()
      else onOfflineReady()
    })
  }

  container.addEventListener('controllerchange', () => {
    if (applying) reload()
    // Another tab applied it. This tab's code is now older than the cache behind it.
    else if (hadController) onUpdateReady()
    hadController = true
  })

  return {
    attach(reg: RegistrationLike) {
      registration = reg
      if (reg.waiting && hadController) onUpdateReady()
      if (reg.installing) watchInstalling(reg.installing)
      reg.addEventListener('updatefound', () => {
        if (reg.installing) watchInstalling(reg.installing)
      })
    },

    /** Move to the new version. False, and nothing happens, while a machine is linked. */
    apply(): boolean {
      if (machineLinked()) return false
      const waiting = registration?.waiting
      // Nothing waiting: already taken over, by another tab or by a "Leave site?" answered
      // Cancel on the last try. Only the reload is left to do.
      if (!waiting) { reload(); return true }
      applying = true
      waiting.postMessage({ type: 'SKIP_WAITING' })
      return true
    },

    /** Look for a new version. A failed check is just being offline, so it is not reported. */
    check() {
      registration?.update().catch(() => {})
    },
  }
}
