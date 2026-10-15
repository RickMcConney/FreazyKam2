import type { AnyOperation } from '../store/toolpathStore'

/**
 * Does this operation reach a generated G-code program? Done, visible, with a toolpath, and
 * generated here rather than imported (an imported .gcode op is its own program and is
 * played on its own — see io/CLAUDE.md).
 *
 * THE ONE COPY of the rule. `generateGcode` walks exactly these ops, so everything that
 * predicts or summarises the program — the export check, the per-sheet count, the
 * simulator's reload key, the SD upload's "nothing to send" — must ask the same question,
 * or it describes a different file from the one written. The SD upload's own copy had
 * already lost the imported-G-code clause. Kept free of imports so the sheet layout and the
 * stores can use it without a cycle.
 */
export const reachesProgram = (op: AnyOperation): boolean =>
  op.visible && op.status === 'done' && op.type !== 'gcode' && op.segments.length > 0
