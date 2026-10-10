// Z touch-plate probing on FluidNC (Grbl 1.1 G38).
//
//   G38.2 Z… F…   move toward the target until the probe input closes, then stop; the
//                 controller reports `[PRB:x,y,z:1]` — the MACHINE position at the moment
//                 of contact, exact, before the deceleration that follows — or
//                 `[PRB:…:0]` and ALARM:5 if the move ended without one. A probe already
//                 closed when the move starts is ALARM:4.
//   G10 L2 P0 Z…  set the active work offset's Z to a MACHINE coordinate. Used rather than
//                 G10 L20 (which zeroes where the tool now IS): after contact the machine
//                 has coasted a little past the trigger point, and the PRB line is where
//                 the plate actually was.
//
// Checked against FluidNC's own source (bdring/FluidNC, main, Oct 2026), not assumed from Grbl:
//   - MotionControl.cpp mc_probe_cycle: ALARM:4 (ProbeFailInitial) if the probe is tripped
//     before moving; on a G38.2 that never touches, ALARM:5 (ProbeFailContact) is sent
//     BEFORE the PRB line, and that PRB line repeats the previous probe's position with :0.
//     With no probe pin configured it logs `[MSG:ERR: Probe pin is not configured]` and
//     does not move.
//   - Report.cpp report_probe_parameters: `[PRB:` + machine position (mm to 3 places, 4 in
//     inch-report mode) + `:` + 0/1; on by default (Config.h MESSAGE_PROBE_COORDINATES).
//     Its position list has one value per configured axis, so it may hold more than three.
//   - GCode.cpp G10: L2 P0 sets the CURRENTLY selected system's offset to the value, in
//     machine coordinates. The work position is MPos − WCS − G92 − TLO, so an active G92 or
//     tool-length offset would shift the result; FreazyKam sends neither.
//   - Report.cpp: `Pn:` lists P for the probe (T for a toolsetter, plus limit pins).
//   - FluidNC also takes `G38.2 … P<plate>` to set the offset itself in one step. Not used:
//     plain Grbl has no such word, and G10 L2 does the same everywhere.
//   - Probe.cpp probe_hard_limit (off by default) alarms (18) if the probe TRIPS during a
//     jog; the back-off jog here starts touching and releases, so it does not trip it.
//
// Pure: the store sequences them (probeZ in machineStore.ts).

export interface ProbeResult { mpos: number[]; ok: boolean }

/** `[PRB:1.000,2.000,-10.500:1]` → machine position and whether it touched; else null. */
export function parsePrb(line: string): ProbeResult | null {
  const m = /^\[PRB:([^:\]]+):([01])\]$/.exec(line.trim())
  if (!m) return null
  const mpos = m[1].split(',').map(Number)
  if (mpos.length < 3 || mpos.some((v) => !Number.isFinite(v))) return null
  return { mpos, ok: m[2] === '1' }
}

const fmt = (v: number) => String(Number(v.toFixed(4)))

/** Probe straight down to work Z `targetZ` (absolute, mm) at `feed` mm/min. */
export function probeDownCommand(targetZ: number, feed: number): string {
  return `G90 G21 G38.2 Z${fmt(targetZ)} F${Math.round(feed)}`
}

/**
 * Set work Z0 from a touch: the bit touched the plate's top at machine Z `contactZ`, and the
 * plate lies ON the surface Z0 is measured from, `plateMM` below that. Which surface is the
 * user's to choose in Setup and to match with the plate: the stock top (Z origin "top"), or
 * the table beside the stock (Z origin "bottom" — the stock bottom is flush with it). The
 * formula is the same either way, so nothing here reads the Z origin — adding the stock's
 * thickness for a bottom origin was tried, and would have put Z0 a stock thickness under
 * the table.
 */
export function zOffsetFromProbe(contactZ: number, plateMM: number): string {
  return `G10 L2 P0 Z${fmt(contactZ - plateMM)}`
}

/** What a probing alarm means, in the words the user acts on. */
export function probeAlarmMessage(code: number, searchMM: number): string | null {
  if (code === 4) return 'The probe was already touching before it moved — is the clip on the bit instead of the plate, or the lead shorted? Unlock, then fix it and try again.'
  if (code === 5) return `The probe never touched in ${fmt(searchMM)} mm — is the plate under the bit and the clip on the bit? Unlock, then try again.`
  return null
}
