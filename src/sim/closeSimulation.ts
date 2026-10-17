import { useSimStore } from '../store/simStore'
import { useUIStore } from '../store/uiStore'

/** Put the simulator away — the player's X and the toolbar's Stop. From the 3D view this
 *  also returns to 2D, since the 3D tab is the simulation's view. */
export function closeSimulation() {
  useSimStore.getState().clearSim()
  const ui = useUIStore.getState()
  if (ui.workspaceTab === '3d') ui.setWorkspaceTab('2d')
}
