// ─── Joinery fields ───────────────────────────────────────────────────────────
// One set of fields per joint, used by BOTH the shape tool's defaults (ShapePanel)
// and the Properties panel's editor for a placed joint — so the two cannot drift,
// the reason the cutting board's labels live beside its params. Every number is a fit
// against the stock or the cutter, so the readouts say what came out and the warnings
// what will not go together.
import { fmtLen } from '../../store/workpieceStore'
import { NumInput, PlainInput, Select, Check, noteCls } from './shared'
import {
  boxDims, fingerJointDims, dovetailDims, bowtieDims, JOINT_RELIEF_LABELS, JOINT_CUT_LABELS,
  type BoxSpec, type FingerJointSpec, type DovetailSpec, type BowtieSpec, type JointRelief, type JointCut,
} from '../../shapes/joineryGenerator'

type Placed<T> = Omit<T, 'cx' | 'cy'>
type Props<T> = { m: Placed<T>; u: string; set: (patch: Partial<Placed<T>>) => void }

const RELIEF_OPTIONS = Object.entries(JOINT_RELIEF_LABELS) as [JointRelief, string][]
const CUT_OPTIONS = Object.entries(JOINT_CUT_LABELS) as [JointCut, string][]
const warnCls = 'text-label text-yellow-500'

/** Thickness, clearance and the cutter — what every finger joint is fitted to. */
function FitFields<T extends { thickness: number; fingerW: number; clearance: number; toolDia: number; relief: JointRelief }>(
  { m, u, set }: { m: T; u: string; set: (patch: Partial<T>) => void },
) {
  return (<>
    <NumInput label="Thickness" valueMM={m.thickness} units={u} min={0.5} onChange={(thickness) => set({ thickness } as Partial<T>)} />
    {/* A target: the count is rounded to odd so both ends of an edge match. */}
    <NumInput label="Finger" valueMM={m.fingerW} units={u} min={1} onChange={(fingerW) => set({ fingerW } as Partial<T>)} />
    <NumInput label="Clearance" valueMM={m.clearance} units={u} min={0} step={u === 'in' ? 0.002 : 0.05} onChange={(clearance) => set({ clearance } as Partial<T>)} />
    <NumInput label="Tool Ø" valueMM={m.toolDia} units={u} min={0} onChange={(toolDia) => set({ toolDia } as Partial<T>)} />
    <Select label="Corners" value={m.relief} options={RELIEF_OPTIONS} onChange={(relief) => set({ relief } as Partial<T>)} />
  </>)
}

export function BoxFields({ m, u, set }: Props<BoxSpec>) {
  const dm = boxDims({ ...m, cx: 0, cy: 0 })
  const L = (mm: number) => fmtLen(mm, u as 'mm' | 'in')
  return (<div className="space-y-1">
    <Select label="Sizes" value={m.inside ? 'inside' : 'outside'}
      options={[['outside', 'Outside'], ['inside', 'Inside']]}
      onChange={(v) => set({ inside: v === 'inside' })} />
    <NumInput label="Width" valueMM={m.w} units={u} min={1} onChange={(w) => set({ w })} />
    <NumInput label="Depth" valueMM={m.d} units={u} min={1} onChange={(d) => set({ d })} />
    <NumInput label="Height" valueMM={m.h} units={u} min={1} onChange={(h) => set({ h })} />
    <Check label="Lid" checked={m.lid} onChange={(lid) => set({ lid })} title="A sixth panel, fingered on like the bottom" />
    <FitFields m={m} u={u} set={set} />
    <p className={noteCls}>
      Outside {L(dm.outer.w)} × {L(dm.outer.d)} × {L(dm.outer.h)}
      <br />
      Inside {L(dm.inner.w)} × {L(dm.inner.d)} × {L(dm.inner.h)}
      <br />
      Fingers {dm.nW} × {L(dm.fW)} · {dm.nD} × {L(dm.fD)} · {dm.nH} × {L(dm.fH)}
      <br />
      Profile every panel outside, right through, with the {L(m.toolDia)} bit.
    </p>
    {dm.tooSmall && <p className={warnCls}>Too small for two walls of {L(m.thickness)}.</p>}
    {dm.toolTooBig && <p className={warnCls}>The bit is wider than a finger — it cannot cut the notches.</p>}
  </div>)
}

export function FingerJointFields({ m, u, set }: Props<FingerJointSpec>) {
  const dm = fingerJointDims({ ...m, cx: 0, cy: 0 })
  const L = (mm: number) => fmtLen(mm, u as 'mm' | 'in')
  const boards = m.cut === 'board'
  return (<div className="space-y-1">
    <Select label="Cut" value={m.cut ?? 'joint'} options={CUT_OPTIONS} onChange={(cut) => set({ cut })} />
    <NumInput label="Width" valueMM={m.width} units={u} min={1} onChange={(width) => set({ width })} />
    {boards && <NumInput label="Length A" valueMM={m.lengthA} units={u} min={1} onChange={(lengthA) => set({ lengthA })} />}
    {boards && <NumInput label="Length B" valueMM={m.lengthB} units={u} min={1} onChange={(lengthB) => set({ lengthB })} />}
    <FitFields m={m} u={u} set={set} />
    <p className={noteCls}>
      {dm.n} fingers × {L(dm.finger)} · A keeps the end fingers
      <br />
      {boards
        ? <>Profile both boards outside, right through, with the {L(m.toolDia)} bit.</>
        : <>Cut each joint with an INSIDE profile right through its board&apos;s end, with the {L(m.toolDia)} bit —
          line the notches up with the end of the board; the strip past it cuts only air, and the waste drops out.</>}
    </p>
    {boards && dm.tooShort && <p className={warnCls}>A board is no longer than the other is thick.</p>}
    {dm.toolTooBig && <p className={warnCls}>The bit is wider than a finger — it cannot cut the notches.</p>}
  </div>)
}

export function DovetailFields({ m, u, set }: Props<DovetailSpec>) {
  const dm = dovetailDims({ ...m, cx: 0, cy: 0 })
  const L = (mm: number) => fmtLen(mm, u as 'mm' | 'in')
  const boards = m.cut === 'board'
  return (<div className="space-y-1">
    <Select label="Cut" value={m.cut ?? 'joint'} options={CUT_OPTIONS} onChange={(cut) => set({ cut })} />
    <NumInput label="Seam" valueMM={m.length} units={u} min={1} onChange={(length) => set({ length })} />
    {boards && <NumInput label="Panel A" valueMM={m.depthA} units={u} min={1} onChange={(depthA) => set({ depthA })} />}
    {boards && <NumInput label="Panel B" valueMM={m.depthB} units={u} min={1} onChange={(depthB) => set({ depthB })} />}
    <NumInput label="Tails" valueMM={m.tails} units="" min={1} integer onChange={(tails) => set({ tails: Math.max(1, Math.round(tails)) })} />
    <NumInput label="Tail W" valueMM={m.tailW} units={u} min={1} onChange={(tailW) => set({ tailW })} />
    <NumInput label="Tail L" valueMM={m.tailDepth} units={u} min={1} onChange={(tailDepth) => set({ tailDepth })} />
    <PlainInput label="Angle" value={m.angleDeg} unit="°" min={0} max={30} step={1} onChange={(angleDeg) => set({ angleDeg })} />
    <NumInput label="Clearance" valueMM={m.clearance} units={u} min={0} step={u === 'in' ? 0.002 : 0.05} onChange={(clearance) => set({ clearance })} />
    <NumInput label="Tool Ø" valueMM={m.toolDia} units={u} min={0} onChange={(toolDia) => set({ toolDia })} />
    <p className={noteCls}>
      Tails {L(m.tailW)} wide, {L(dm.neck)} at the neck
      <br />
      Corners are rounded for the {L(m.toolDia)} bit.
      <br />
      {boards
        ? <>Profile both panels outside, right through, with it.</>
        : <>Cut each joint with an INSIDE profile right through: the tails&apos; waste at the end of
          panel A (its end is the tails&apos; tips), the sockets at the end of panel B. The strip
          past each end cuts only air, and the waste drops out.</>}
    </p>
    {dm.crowded && <p className={warnCls}>The tails meet — fewer, or narrower.</p>}
    {!dm.crowded && dm.toolTooBig && <p className={warnCls}>The bit cannot get between two tails — fewer, narrower, or a smaller bit.</p>}
    {dm.neckTooThin && <p className={warnCls}>The neck is thinner than the bit — a shallower angle, shorter or wider tails.</p>}
  </div>)
}

export function BowtieFields({ m, u, set }: Props<BowtieSpec>) {
  const dm = bowtieDims({ ...m, cx: 0, cy: 0 })
  const L = (mm: number) => fmtLen(mm, u as 'mm' | 'in')
  const straight = m.style === 'straight'
  return (<div className="space-y-1">
    <Select label="Cut with" value={m.style}
      options={[['straight', 'Straight bit'], ['vbit', 'V-bit (Inlay)']]}
      onChange={(style) => set({ style })} />
    <NumInput label="Length" valueMM={m.length} units={u} min={1} onChange={(length) => set({ length })} />
    <NumInput label="Width" valueMM={m.width} units={u} min={1} onChange={(width) => set({ width })} />
    <NumInput label="Waist" valueMM={m.waist} units={u} min={0.5} onChange={(waist) => set({ waist })} />
    {straight && <NumInput label="Clearance" valueMM={m.clearance} units={u} min={0} step={u === 'in' ? 0.002 : 0.05} onChange={(clearance) => set({ clearance })} />}
    {straight && <NumInput label="Tool Ø" valueMM={m.toolDia} units={u} min={0} onChange={(toolDia) => set({ toolDia })} />}
    <p className={noteCls}>
      Sides flare {dm.flareDeg.toFixed(1)}°
      <br />
      {straight
        ? <>Pocket the socket across the seam; cut the key from a contrasting board with an outside profile — both with the {L(m.toolDia)} bit.</>
        : <>Select the outline and use Inlay — the V-bit cuts it as plug and socket.</>}
    </p>
    {straight && dm.waistTooThin && <p className={warnCls}>The waist is thinner than the bit.</p>}
  </div>)
}
