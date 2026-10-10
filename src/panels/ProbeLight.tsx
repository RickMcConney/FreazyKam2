import { useMachineStore } from '../machine/machineStore'

// THE PROBE INPUT, LIVE, BIG: it sits on the go-to map right above STOP, the same size,
// because it is read from across the room — standing at the machine, touching the plate
// to the bit to test the clip and lead, the user looks back at the screen for green. As a
// 10 px dot under the Probe row it could not be seen from there.
export default function ProbeLight({ className = '' }: { className?: string }) {
  const connected = useMachineStore((s) => s.link === 'connected')
  const touching = useMachineStore((s) => s.position.probe)
  const lit = connected && touching
  return (
    <div
      title={!connected
        ? 'The probe input — connect to read it'
        : 'The probe input as the controller reads it. Touch the plate to the bit to test the clip and lead: it should turn green.'}
      className={`w-16 h-16 flex flex-col items-center justify-center gap-1 rounded-xl border-2 text-[11px] font-bold tracking-wider ${lit
        ? 'bg-green-500 border-green-600 text-white shadow-lg shadow-green-500/40'
        : 'bg-gray-100 dark:bg-neutral-800 border-gray-400 dark:border-neutral-600 text-gray-600 dark:text-neutral-400'} ${connected ? '' : 'opacity-40'} ${className}`}>
      <span className={`w-6 h-6 rounded-full ${lit ? 'bg-white' : 'bg-gray-300 dark:bg-neutral-600 ring-1 ring-gray-400 dark:ring-neutral-500'}`} />
      {lit ? 'TOUCH' : 'PROBE'}
    </div>
  )
}
