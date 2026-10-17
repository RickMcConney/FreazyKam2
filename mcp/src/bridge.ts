// The WebSocket end of the bridge: holds at most one FreazyKam tab and forwards
// tool calls to it.
//
// One tab, newest wins. Two tabs both answering would leave the assistant editing a
// project the user is not looking at; the replaced tab is told why (CLOSE_REPLACED)
// and stops retrying until the user reconnects it.

import { WebSocketServer, WebSocket } from 'ws'
import { hostAllowed, originAllowed } from './origin.js'
import {
  CLOSE_PROTOCOL, CLOSE_REPLACED, PROTOCOL_VERSION,
  type CallMsg, type TabMsg, type ToolDef, type WelcomeMsg,
} from './protocol.js'

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

export interface TabInfo { build: string; origin: string; since: Date }

export class Bridge {
  private wss: WebSocketServer | null = null
  private tab: WebSocket | null = null
  private info: TabInfo | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  /** Why the server is not listening, when it is not — reported by every tool call. */
  listenError: string | null = null

  constructor(
    readonly port: number,
    private readonly serverVersion: string,
    private readonly extraOrigins: readonly string[] = [],
    private readonly log: (msg: string) => void = () => {},
    /** Called with the tools a newly connected tab declares. */
    private readonly onTools: (tools: ToolDef[]) => void = () => {},
  ) {}

  start(): Promise<void> {
    return new Promise((resolve) => {
      const wss = new WebSocketServer({
        host: '127.0.0.1',
        port: this.port,
        verifyClient: ({ origin, req }, cb) => {
          if (!hostAllowed(req.headers.host, this.port)) return cb(false, 403, 'Bad host')
          if (!originAllowed(origin, this.extraOrigins)) {
            this.log(`refused a connection from origin ${origin ?? '(none)'}`)
            return cb(false, 403, 'Origin not allowed')
          }
          cb(true)
        },
      })
      wss.on('listening', () => {
        this.wss = wss
        this.log(`listening on ws://127.0.0.1:${this.port}`)
        resolve()
      })
      wss.on('error', (err: NodeJS.ErrnoException) => {
        // Not fatal: the MCP side still answers, and every tool call says why it cannot
        // reach the tab. The usual cause is a second MCP client (Claude Desktop AND Claude
        // Code, say) each having started a server.
        this.listenError = err.code === 'EADDRINUSE'
          ? `Port ${this.port} is already in use — probably another FreazyKam MCP server started by another AI app. Quit that one, or give this one another port with FREAZYKAM_MCP_PORT (and set the same port in FreazyKam).`
          : `Could not listen on port ${this.port}: ${err.message}`
        this.log(this.listenError)
        resolve()
      })
      wss.on('connection', (ws, req) => this.accept(ws, req.headers.origin ?? ''))
    })
  }

  private accept(ws: WebSocket, origin: string) {
    let greeted = false
    ws.on('message', (raw) => {
      let msg: TabMsg
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (!greeted) {
        if (msg.type !== 'hello') return
        if (msg.protocol !== PROTOCOL_VERSION) {
          const newer = msg.protocol > PROTOCOL_VERSION ? 'this MCP server (update freazykam-mcp)' : 'the FreazyKam page (reload it)'
          ws.close(CLOSE_PROTOCOL, `Protocol ${msg.protocol} vs ${PROTOCOL_VERSION}: update ${newer}`)
          return
        }
        greeted = true
        if (this.tab && this.tab !== ws) this.tab.close(CLOSE_REPLACED, 'Another FreazyKam tab connected')
        this.tab = ws
        this.info = { build: msg.build, origin, since: new Date() }
        const welcome: WelcomeMsg = { type: 'welcome', protocol: PROTOCOL_VERSION, server: this.serverVersion }
        ws.send(JSON.stringify(welcome))
        this.log(`tab connected from ${origin} (build ${msg.build}, ${msg.tools?.length ?? 0} tools)`)
        if (Array.isArray(msg.tools)) this.onTools(msg.tools)
        return
      }
      if (msg.type !== 'result' && msg.type !== 'error') return
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.type === 'result') p.resolve(msg.result)
      else p.reject(new Error(msg.message))
    })
    ws.on('close', () => {
      if (this.tab !== ws) return
      this.tab = null
      this.info = null
      // A call in flight on a closed tab will never answer.
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error('The FreazyKam tab disconnected before answering.'))
        this.pending.delete(id)
      }
      this.log('tab disconnected')
    })
  }

  get connected(): TabInfo | null { return this.info }

  /** Run `method` in the tab. Rejects with a message meant for the user when there is no tab. */
  call(method: string, params: unknown, timeoutMs = 60_000): Promise<unknown> {
    if (this.listenError) return Promise.reject(new Error(this.listenError))
    const tab = this.tab
    if (!tab || tab.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(
        `No FreazyKam tab is connected. Open FreazyKam, click the MCP button in the toolbar, and turn on "Allow AI assistants to connect" (port ${this.port}).`))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`FreazyKam did not answer "${method}" within ${Math.round(timeoutMs / 1000)} s.`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      const msg: CallMsg = { type: 'call', id, method, params }
      tab.send(JSON.stringify(msg))
    })
  }

  close() { this.wss?.close() }
}
