// The wire between this tab and the freazykam-mcp server. KEEP IN STEP with
// mcp/src/protocol.ts — the server builds as its own package, so the shapes are
// written out twice; PROTOCOL_VERSION is what catches a drift.
//
// The tab is the WebSocket CLIENT: an https page may open ws://127.0.0.1 (a
// loopback address is a secure origin), but nothing outside the browser can open
// a connection into a page.

export const PROTOCOL_VERSION = 2
export const DEFAULT_PORT = 47615

/**
 * A tool as this tab declares it (tools.ts) — the server lists exactly these, so a tool
 * added to the app needs no new server. `inputSchema` is JSON Schema, passed to MCP as is.
 */
export interface ToolDef {
  name: string
  title?: string
  description: string
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] }
  annotations?: Record<string, unknown>
  /** How long the server waits for this tab's answer. Default 60 s. */
  timeoutMs?: number
  /**
   * The one thing a page cannot do: touch the computer's files. `read` — the server reads
   * the file named by `args[param]` and passes its text as `fileText` (plus `fileName`).
   * `write` — the command answers `{ fileText, message }` (or `{ fileBase64, message }` for
   * binary content) and the server writes it,
   * refusing to replace a file unless `args.overwrite` is true.
   */
  /** `binary`: a read passes `fileBase64` instead of `fileText` (a picture). A write needs no
   *  flag — the answer's `fileBase64` or `fileText` says which it is. */
  file?: { param: string; mode: 'read' | 'write'; ext: string | string[]; binary?: boolean }
}

export interface HelloMsg { type: 'hello'; protocol: number; build: string; tools: ToolDef[] }
export interface WelcomeMsg { type: 'welcome'; protocol: number; server: string }
export interface CallMsg { type: 'call'; id: number; method: string; params: unknown }
export interface ResultMsg { type: 'result'; id: number; result: unknown }
export interface ErrorMsg { type: 'error'; id: number; message: string }

export type ServerMsg = WelcomeMsg | CallMsg

/** A newer tab took over — stop retrying, or the two tabs fight forever. */
export const CLOSE_REPLACED = 4000
/** Version mismatch — retrying cannot help; the reason says which side to update. */
export const CLOSE_PROTOCOL = 4001
