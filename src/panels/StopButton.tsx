import { OctagonX } from 'lucide-react'
import { useMachineStore } from '../machine/machineStore'

// ONE WAY TO STOP THAT ALWAYS WORKS, whatever is moving and whatever started it: a go-to or
// Safe-Z move is a jog, which the job box's Stop never covered, and the jog pad's cancel
// ignores programs and homing. It sits on the go-to map, in its bottom-left corner — where
// the eye already is while the machine moves, near the middle of the screen, and never
// scrolled away. (It was pinned to the top of the control column, which a laptop scrolled
// out of view to reach the macros.) It needs the link: it is no substitute for the
// machine's own E-stop.
export default function StopButton({ className = '' }: { className?: string }) {
  const stopMotion = useMachineStore((s) => s.stopMotion)
  const connected = useMachineStore((s) => s.link === 'connected')
  const homing = useMachineStore((s) => s.position.state === 'Home')
  return (
    <button
      onClick={(e) => { e.stopPropagation(); stopMotion() }}
      disabled={!connected}
      title={!connected
        ? 'Not connected — use the machine\'s own E-stop or power switch'
        : homing
          ? 'Stop homing (soft reset — the machine will alarm)'
          : 'Stop all motion now: jogs and go-to moves cancel, a running job pauses (then Resume or Cancel)'}
      className={`w-16 h-16 flex flex-col items-center justify-center gap-0.5 rounded-xl shadow-lg bg-red-600 hover:bg-red-700 active:bg-red-800 text-white text-sm font-bold tracking-wider disabled:opacity-40 disabled:hover:bg-red-600 ${className}`}>
      <OctagonX size={24} />
      STOP
    </button>
  )
}
