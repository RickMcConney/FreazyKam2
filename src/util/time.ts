/** A whole number of seconds split into hours, minutes and seconds. Each formatter decides
 *  how to round to whole seconds first (the sim clock floors, a run-time estimate rounds). */
export function hms(t: number): { h: number; m: number; s: number } {
  return { h: Math.floor(t / 3600), m: Math.floor((t % 3600) / 60), s: t % 60 }
}
