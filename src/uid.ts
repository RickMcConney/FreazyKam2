// Collision-safe ID minting for objects that outlive the session (paths,
// operations, tools, tabs, groups live in .fkam project files and localStorage).
//
// Why not module counters: they reset to 0 every session while the ids they
// minted persist, so loading a project (or rehydrating the tool library) and
// then creating a new object reused an existing id — see tofix.md B2.
// Why not crypto.randomUUID: unavailable outside secure contexts, and this app
// is commonly served over plain http on a LAN or opened from file://.
//
// Format: <prefix>-<ms epoch, base36>-<6 random base36 chars>. Uniqueness needs
// either a different millisecond or different randomness (36^6 ≈ 2.2e9), with
// no persisted state to maintain.
export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
