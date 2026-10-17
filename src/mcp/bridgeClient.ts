// This tab's end of the MCP bridge: a WebSocket to the freazykam-mcp server on
// loopback, answering the commands it forwards from an AI assistant (any MCP client).
//
// Off until the user turns it on (the toolbar's MCP button), and remembered per
// browser after that: the server is started by the AI app, whenever it starts, so
// an enabled tab keeps knocking — quietly, backing off to every 10 s — until one
// answers. Two things stop the knocking for good, because retrying cannot fix
// them: a newer tab taking over (CLOSE_REPLACED — or the two would steal the
// server back and forth forever) and a protocol mismatch (CLOSE_PROTOCOL).
//
// What a refused connection looks like: the server rejects a foreign Origin at the
// handshake, which a page sees only as an ordinary failed connect (code 1006) —
// indistinguishable from no server at all. So "waiting" covers both.

import { create } from 'zustand'
import { BUILD_DATE } from '../version'
import { runCommand } from './commands'
import { TOOLS } from './tools'
import {
  CLOSE_PROTOCOL, CLOSE_REPLACED, DEFAULT_PORT, PROTOCOL_VERSION,
  type ErrorMsg, type HelloMsg, type ResultMsg, type ServerMsg,
} from './protocol'

export type BridgeState =
  | 'off'         // not enabled
  | 'waiting'     // enabled, no server answering yet (or it refused us)
  | 'connecting'  // socket open, hello sent, no welcome yet
  | 'connected'
  | 'replaced'    // another tab took the server; stays here until the user reconnects
  | 'error'       // protocol mismatch; `detail` says which side to update

export interface LastCall { method: string; ok: boolean; at: number }

interface McpBridgeStore {
  enabled: boolean
  port: number
  state: BridgeState
  /** The server's version once connected, or why we stopped. */
  detail: string | null
  lastCall: LastCall | null
}

const ENABLED_KEY = 'freazykam.mcp.enabled'
const PORT_KEY = 'freazykam.mcp.port'

function readPref(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function writePref(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch { /* private window: the toggle just won't survive a reload */ }
}

export const useMcpBridgeStore = create<McpBridgeStore>()(() => ({
  enabled: readPref(ENABLED_KEY) === '1',
  port: Number(readPref(PORT_KEY)) || DEFAULT_PORT,
  state: 'off',
  detail: null,
  lastCall: null,
}))

const set = (patch: Partial<McpBridgeStore>) => useMcpBridgeStore.setState(patch)

let socket: WebSocket | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryDelay = 1000
const MAX_RETRY = 10_000

function clearRetry() {
  if (retryTimer !== null) clearTimeout(retryTimer)
  retryTimer = null
}

function connect() {
  clearRetry()
  const { port } = useMcpBridgeStore.getState()
  let ws: WebSocket
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}`)
  } catch (err) {
    // Only a malformed URL or a blocked scheme throws here — retrying the same thing won't help.
    set({ state: 'error', detail: `This browser would not open a connection to 127.0.0.1: ${(err as Error).message}` })
    return
  }
  socket = ws
  set({ state: 'waiting' })

  ws.onopen = () => {
    if (socket !== ws) return
    set({ state: 'connecting' })
    const hello: HelloMsg = { type: 'hello', protocol: PROTOCOL_VERSION, build: BUILD_DATE, tools: TOOLS }
    ws.send(JSON.stringify(hello))
  }

  ws.onmessage = (ev) => {
    if (socket !== ws) return
    let msg: ServerMsg
    try { msg = JSON.parse(String(ev.data)) } catch { return }
    if (msg.type === 'welcome') {
      retryDelay = 1000
      set({ state: 'connected', detail: `freazykam-mcp ${msg.server}` })
      return
    }
    if (msg.type === 'call') void answer(ws, msg.id, msg.method, msg.params)
  }

  ws.onclose = (ev) => {
    if (socket !== ws) return // a socket we already let go of
    socket = null
    if (!useMcpBridgeStore.getState().enabled) { set({ state: 'off', detail: null }); return }
    if (ev.code === CLOSE_REPLACED) { set({ state: 'replaced', detail: ev.reason || null }); return }
    if (ev.code === CLOSE_PROTOCOL) { set({ state: 'error', detail: ev.reason || 'Protocol mismatch' }); return }
    set({ state: 'waiting', detail: null })
    retryTimer = setTimeout(connect, retryDelay)
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY)
  }
}

async function answer(ws: WebSocket, id: number, method: string, params: unknown) {
  let reply: ResultMsg | ErrorMsg
  try {
    const result = await runCommand(method, params)
    reply = { type: 'result', id, result: result === undefined ? null : result }
    // Stringify here so a result that cannot be serialized fails as THIS call's error
    // instead of leaving the server waiting for a reply that never comes.
    ws.send(JSON.stringify(reply))
    set({ lastCall: { method, ok: true, at: Date.now() } })
    return
  } catch (err) {
    reply = { type: 'error', id, message: err instanceof Error ? err.message : String(err) }
  }
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply))
  set({ lastCall: { method, ok: false, at: Date.now() } })
}

function disconnect() {
  clearRetry()
  const ws = socket
  socket = null
  ws?.close()
  set({ state: 'off', detail: null })
}

/** Turn the bridge on or off for this browser. On starts knocking at once. */
export function setMcpBridgeEnabled(on: boolean) {
  writePref(ENABLED_KEY, on ? '1' : null)
  set({ enabled: on })
  if (on) { retryDelay = 1000; connect() } else disconnect()
}

/** Try again now — after another tab took over, or to skip the back-off wait. */
export function reconnectMcpBridge() {
  if (!useMcpBridgeStore.getState().enabled) return
  const ws = socket
  socket = null
  ws?.close()
  retryDelay = 1000
  connect()
}

export function setMcpBridgePort(port: number) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return
  writePref(PORT_KEY, port === DEFAULT_PORT ? null : String(port))
  set({ port })
  reconnectMcpBridge()
}

/** At boot: reconnect if the user left the bridge on. */
export function startMcpBridgeIfEnabled() {
  if (useMcpBridgeStore.getState().enabled) connect()
}
