import { create } from 'zustand'
import { useMachineStore } from '../machine/machineStore'
import { useUIStore } from '../store/uiStore'
import { createUpdater } from './updater'

const CHECK_EVERY_MS = 60 * 60 * 1000

interface UpdateState {
  /** A new version is here and only needs a reload. */
  ready: boolean
  /** Reload into it. Does nothing while a machine is linked. */
  apply: () => void
}

export const useAppUpdate = create<UpdateState>(() => ({ ready: false, apply: () => {} }))

/**
 * Run the app from the service worker the build generates, and watch for new versions.
 *
 * The browser only checks when the app is opened, and an installed app can sit open for days
 * by a machine, so it is also asked hourly and on coming back online.
 */
export function startAppUpdates() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  const updater = createUpdater({
    container: navigator.serviceWorker,
    machineLinked: () => useMachineStore.getState().link !== 'disconnected',
    reload: () => location.reload(),
    onUpdateReady: () => useAppUpdate.setState({ ready: true }),
    onOfflineReady: () => useUIStore.getState().showStatus('FreazyKam can now open without internet'),
  })
  useAppUpdate.setState({ apply: () => { updater.apply() } })
  navigator.serviceWorker.register('/sw.js', { scope: '/app/' })
    .then((registration) => {
      updater.attach(registration)
      setInterval(() => updater.check(), CHECK_EVERY_MS)
      window.addEventListener('online', () => updater.check())
    })
    .catch((e) => console.warn('Offline support is not available here:', e))
}
