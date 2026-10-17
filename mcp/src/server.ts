#!/usr/bin/env node
// freazykam-mcp: an MCP server (stdio) that relays tool calls to a FreazyKam tab
// open in the user's browser, over a loopback WebSocket the tab connects to.
//
//   AI app ──stdio──► this process ──ws://127.0.0.1:47615──► FreazyKam tab
//
// It knows NOTHING about FreazyKam's features. The tab declares its tools when it
// connects (src/mcp/tools.ts in the app) and this lists them, tells the client the
// list changed, and forwards each call — so new features ship with the app, not with
// this package. The only tool of its own is get_status, which has to answer when no
// tab is there to. The tools of the last tab seen are cached on disk, so a client
// starting before the tab connects still sees the full list.
//
// stdout is the MCP channel — log to stderr only.

import { readFile, writeFile, access, mkdir } from 'node:fs/promises'
import { isAbsolute, basename, join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Bridge } from './bridge.js'
import { DEFAULT_PORT, type ToolDef } from './protocol.js'

// From package.json, so a release cannot report a stale number.
const VERSION: string = createRequire(import.meta.url)('../package.json').version

const port = Number(process.env.FREAZYKAM_MCP_PORT) || DEFAULT_PORT
const extraOrigins = (process.env.FREAZYKAM_MCP_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const log = (msg: string) => process.stderr.write(`[freazykam-mcp] ${msg}\n`)
const CACHE = process.env.FREAZYKAM_MCP_CACHE ?? join(homedir(), '.cache', 'freazykam-mcp', `tools-${port}.json`)

const howToConnect = `No FreazyKam tab is connected. Open FreazyKam, click the MCP button in the toolbar, and turn on "Allow AI assistants to connect" (port ${port}).`

const STATUS_TOOL: ToolDef = {
  name: 'get_status',
  title: 'FreazyKam status',
  description:
    'Whether a FreazyKam tab is connected, and if so a summary of its open project: name, ' +
    'stock size, how many paths and toolpaths it has, and the coordinate conventions every ' +
    'other tool uses. Call this first.',
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true },
}

let tabTools: ToolDef[] = []
let clientConnected = false

const server = new Server(
  { name: 'freazykam', version: VERSION },
  {
    capabilities: { tools: { listChanged: true } },
    instructions:
      'FreazyKam is a browser-based CNC CAM app. These tools act on the project open in the ' +
      "user's FreazyKam tab; call get_status first, which also states the coordinate " +
      'conventions. If a tool says no tab is connected, tell the user how to connect rather ' +
      'than retrying.',
  },
)

const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError ? { isError } : {}) })

/** Install a tab's tools; tell the client when the list actually changed. */
async function setTools(tools: unknown, persist: boolean) {
  if (!Array.isArray(tools)) return
  const valid = (tools as ToolDef[]).filter((t) =>
    t && typeof t.name === 'string' && t.name !== STATUS_TOOL.name && t.inputSchema?.type === 'object')
  if (JSON.stringify(valid) === JSON.stringify(tabTools)) return
  tabTools = valid
  log(`${valid.length} tools from the tab`)
  if (persist) {
    try {
      await mkdir(dirname(CACHE), { recursive: true })
      await writeFile(CACHE, JSON.stringify(valid))
    } catch (err) { log(`could not cache the tool list: ${(err as Error).message}`) }
  }
  // Before the client connects there is no one to tell; its first tools/list sees these anyway.
  if (clientConnected) await server.sendToolListChanged().catch(() => {})
}

const bridge = new Bridge(port, VERSION, extraOrigins, log, (tools) => { void setTools(tools, true) })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [STATUS_TOOL, ...tabTools].map(({ timeoutMs: _t, file: _f, ...t }) => t),
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name } = req.params
  const args = (req.params.arguments ?? {}) as Record<string, unknown>

  if (name === STATUS_TOOL.name) {
    // Not connected is an ANSWER here, not an error — it is what this tool is asked.
    if (bridge.listenError || !bridge.connected) {
      return text(JSON.stringify({ connected: false, why: bridge.listenError ?? howToConnect }, null, 2))
    }
    return forward('status', {})
  }

  const def = tabTools.find((t) => t.name === name)
  if (!def) return text(`Unknown tool "${name}". ${bridge.connected ? 'The FreazyKam tab does not offer it.' : howToConnect}`, true)
  try {
    if (def.file?.mode === 'read') return await forward(name, { ...args, ...await readArg(def.file, args) }, def.timeoutMs)
    if (def.file?.mode === 'write') return await writeVia(def, args)
    return await forward(name, args, def.timeoutMs)
  } catch (err) {
    return text((err as Error).message, true)
  }
})

/** A tool result carrying the tab's JSON answer, or the error text the tab (or the bridge) gave. */
async function forward(method: string, params: unknown, timeoutMs?: number) {
  try {
    return text(JSON.stringify(await bridge.call(method, params, timeoutMs), null, 2))
  } catch (err) {
    return text((err as Error).message, true)
  }
}

function filePath(spec: NonNullable<ToolDef['file']>, args: Record<string, unknown>): string {
  const path = args[spec.param]
  if (typeof path !== 'string' || !path) throw new Error(`"${spec.param}" must be a file path.`)
  if (!isAbsolute(path)) throw new Error(`Give an absolute path, not "${path}".`)
  const exts = Array.isArray(spec.ext) ? spec.ext : [spec.ext]
  if (!exts.some((e) => path.toLowerCase().endsWith(e))) throw new Error(`The file must end in ${exts.join(' or ')}: "${path}".`)
  return path
}

async function readArg(spec: NonNullable<ToolDef['file']>, args: Record<string, unknown>) {
  const path = filePath(spec, args)
  try {
    return spec.binary
      ? { fileBase64: (await readFile(path)).toString('base64'), fileName: basename(path) }
      : { fileText: await readFile(path, 'utf8'), fileName: basename(path) }
  } catch (err) {
    throw new Error(`Could not read ${path}: ${(err as Error).message}`)
  }
}

async function writeVia(def: ToolDef, args: Record<string, unknown>) {
  const path = filePath(def.file!, args)
  if (args.overwrite !== true && await access(path).then(() => true, () => false)) {
    return text(`${path} already exists. Ask the user before replacing it, then pass overwrite: true.`, true)
  }
  const answer = await bridge.call(def.name, args, def.timeoutMs) as { fileText?: unknown; fileBase64?: unknown; message?: unknown }
  if (typeof answer?.fileBase64 === 'string') await writeFile(path, Buffer.from(answer.fileBase64, 'base64'))
  else if (typeof answer?.fileText === 'string') await writeFile(path, answer.fileText)
  else throw new Error('The tab sent nothing to write.')
  return text(typeof answer.message === 'string' ? answer.message : `Saved ${path}`)
}

// The last tab's tools, so the list is complete before any tab connects this session.
try {
  await setTools(JSON.parse(await readFile(CACHE, 'utf8')), false)
} catch { /* first run: only get_status until a tab connects */ }

await bridge.start()
await server.connect(new StdioServerTransport())
clientConnected = true
log(`ready (MCP over stdio, tab bridge on port ${port}, ${tabTools.length} cached tools)`)

const shutdown = () => { bridge.close(); process.exit(0) }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
// The client closing stdin is how an MCP client says goodbye.
process.stdin.on('close', shutdown)
