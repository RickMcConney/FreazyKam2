// The wire between this server and a FreazyKam tab. KEEP IN STEP with
// src/mcp/protocol.ts in the app — the two packages build separately, so the
// shapes are written out twice; PROTOCOL_VERSION is what catches a drift (the
// server refuses a tab speaking another version and says which side to update).
//
// The tab is the WebSocket CLIENT: an https page can open ws://127.0.0.1 (a
// loopback address is a secure origin), but nothing outside the browser can open
// a connection INTO a page.
//
// THE TAB DECLARES ITS TOOLS (protocol 2). The hello carries every tool's name,
// description and JSON Schema, and this server lists exactly those — so a feature
// shipped in the app reaches the client the next time a tab connects, with no new
// version of this package. Bump PROTOCOL_VERSION only for a change to the wire itself.

export const PROTOCOL_VERSION = 2
export const DEFAULT_PORT = 47615

/** A tool as the tab declares it. `inputSchema` is a JSON Schema object, passed to MCP untouched. */
export interface ToolDef {
  name: string
  title?: string
  description: string
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown }
  annotations?: Record<string, unknown>
  /** How long the server waits for the tab's answer. Default 60 s. */
  timeoutMs?: number
  /**
   * The one thing a page cannot do: touch this computer's files. `read` — the server
   * reads the file named by `args[param]` and passes its text as `fileText` (plus
   * `fileName`). `write` — the tab answers `{ fileText, message }` (or `{ fileBase64, message }`
   * for binary content) and the server writes it, refusing to replace a file unless `args.overwrite` is true.
   */
  /** `binary`: a read passes `fileBase64` instead of `fileText` (a picture). A write needs no
   *  flag — the answer's `fileBase64` or `fileText` says which it is. */
  file?: { param: string; mode: 'read' | 'write'; ext: string | string[]; binary?: boolean }
}

/** tab → server, first message after the socket opens. */
export interface HelloMsg { type: 'hello'; protocol: number; build: string; tools: ToolDef[] }
/** server → tab, the answer to a hello it accepted. */
export interface WelcomeMsg { type: 'welcome'; protocol: number; server: string }
/** server → tab: run a command. */
export interface CallMsg { type: 'call'; id: number; method: string; params: unknown }
/** tab → server: a command finished. */
export interface ResultMsg { type: 'result'; id: number; result: unknown }
/** tab → server: a command threw. */
export interface ErrorMsg { type: 'error'; id: number; message: string }

export type TabMsg = HelloMsg | ResultMsg | ErrorMsg

/** Close codes the tab acts on — anything else and it retries. */
export const CLOSE_REPLACED = 4000 // a newer tab took over: stop retrying, or the two fight forever
export const CLOSE_PROTOCOL = 4001 // version mismatch: retrying cannot help
