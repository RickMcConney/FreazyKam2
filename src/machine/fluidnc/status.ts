// Parsing a FluidNC/Grbl status report: `<Idle|MPos:1.000,2.000,3.000|FS:0,0|WCO:0,0,0>`.
//
// Grbl sends EITHER MPos or WPos per report (per $10), and sends WCO only every
// few reports (or when it changes), so one report alone cannot always give both
// positions. `applyStatus` folds a report into the last known state: it keeps the
// last WCO and derives whichever position the report left out, WPos = MPos − WCO.
//
// The logic follows ESP3D-WEBUI 3's FluidNC `filters.ts` getStatus; the full port
// (overrides, pins, accessories, SD progress) is a later step.

export type Vec = number[]

export interface StatusReport {
  state: string            // Idle, Run, Hold, Jog, Alarm, Door, Check, Home, Sleep
  subState?: string        // Hold:0, Door:1 …
  mpos?: Vec
  wpos?: Vec
  wco?: Vec
  feed?: number            // mm/min
  spindle?: number         // rpm
  sd?: SdProgress          // present on every report while an SD job runs
  ov?: Overrides           // sent only now and then, and when one changes
  pins?: string            // `Pn:` — the inputs active now (P = probe); absent means none
}

/** Override percentages: feed, rapid, spindle. */
export interface Overrides { feed: number; rapid: number; spindle: number }

export interface SdProgress { percent: number; file: string }

export function isStatusLine(line: string): boolean {
  return line.startsWith('<') && line.endsWith('>')
}

const nums = (s: string): Vec => s.split(',').map(Number)

export function parseStatus(line: string): StatusReport | null {
  if (!isStatusLine(line)) return null
  const fields = line.slice(1, -1).split('|')
  const [state, subState] = fields[0].split(':')
  const r: StatusReport = { state }
  if (subState !== undefined && subState !== '') r.subState = subState
  for (const f of fields.slice(1)) {
    const i = f.indexOf(':')
    if (i < 0) continue
    const key = f.slice(0, i)
    const val = f.slice(i + 1)
    switch (key) {
      case 'MPos': r.mpos = nums(val); break
      case 'WPos': r.wpos = nums(val); break
      case 'WCO': r.wco = nums(val); break
      case 'FS': { const [fd, sp] = nums(val); r.feed = fd; r.spindle = sp; break }
      case 'F': r.feed = Number(val); break
      case 'Ov': { const [f, r2, sp] = nums(val); r.ov = { feed: f, rapid: r2, spindle: sp }; break }
      case 'Pn': r.pins = val; break
      // `SD:45.20,/jobs/a.nc` — the file name may itself hold a comma.
      case 'SD': {
        const c = val.indexOf(',')
        r.sd = { percent: Number(c < 0 ? val : val.slice(0, c)), file: c < 0 ? '' : val.slice(c + 1) }
        break
      }
    }
  }
  return r
}

export interface Position {
  state: string
  subState?: string
  mpos: Vec
  wpos: Vec
  wco: Vec
  feed: number
  spindle: number
  sd: SdProgress | null    // the SD job running, if any
  ov: Overrides
  probe: boolean           // the probe input is on — the plate is touching the bit
}

export const EMPTY_POSITION: Position = {
  state: 'Unknown', mpos: [0, 0, 0], wpos: [0, 0, 0], wco: [0, 0, 0], feed: 0, spindle: 0, sd: null,
  ov: { feed: 100, rapid: 100, spindle: 100 }, probe: false,
}

const sub = (a: Vec, b: Vec) => a.map((v, i) => v - (b[i] ?? 0))
const add = (a: Vec, b: Vec) => a.map((v, i) => v + (b[i] ?? 0))

export function applyStatus(prev: Position, r: StatusReport): Position {
  const wco = r.wco ?? prev.wco
  let mpos = prev.mpos
  let wpos = prev.wpos
  if (r.mpos) { mpos = r.mpos; wpos = sub(r.mpos, wco) }
  else if (r.wpos) { wpos = r.wpos; mpos = add(r.wpos, wco) }
  else if (r.wco) { wpos = sub(mpos, wco) }
  return {
    state: r.state,
    subState: r.subState,
    mpos, wpos, wco,
    feed: r.feed ?? prev.feed,
    spindle: r.spindle ?? prev.spindle,
    // Not carried over: a report without the field means no job is running.
    sd: r.sd ?? null,
    // Carried over, like WCO: most reports leave it out.
    ov: r.ov ?? prev.ov,
    // NOT carried over: Grbl sends `Pn:` only while an input is on, so its absence is news.
    probe: !!r.pins && r.pins.includes('P'),
  }
}

/**
 * A feed hold that has come to a complete stop (`Hold:0`). A soft reset now
 * aborts the job WITHOUT an alarm: nothing is moving, so no steps can be lost and
 * the controller keeps its position. During `Hold:1` the axes are still
 * decelerating, and the same reset throws ALARM:3. This is Grbl 1.1's documented
 * way to cancel a job, and FluidNC keeps it.
 */
export function holdComplete(p: { state: string; subState?: string }): boolean {
  return p.state === 'Hold' && p.subState === '0'
}
