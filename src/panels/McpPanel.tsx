// The toolbar's MCP button and its connect dialog: turn the MCP bridge on for
// this browser, see whether the server is answering, and the few lines of setup
// that make an AI app (any MCP client) start the server. The bridge itself is mcp/bridgeClient.ts.

import { useState } from 'react'
import { Check, Copy, Plug, X } from 'lucide-react'
import { ICON } from '../theme'
import {
  useMcpBridgeStore, setMcpBridgeEnabled, reconnectMcpBridge, setMcpBridgePort, type BridgeState,
} from '../mcp/bridgeClient'
import { DEFAULT_PORT } from '../mcp/protocol'

const DOT: Record<BridgeState, string> = {
  off: 'bg-gray-400 dark:bg-neutral-500',
  waiting: 'bg-amber-500',
  connecting: 'bg-amber-500',
  connected: 'bg-green-500',
  replaced: 'bg-gray-400 dark:bg-neutral-500',
  error: 'bg-red-500',
}

function stateText(state: BridgeState, detail: string | null): string {
  switch (state) {
    case 'off': return 'Off — no AI assistant can see this tab.'
    case 'waiting': return 'Waiting for the FreazyKam MCP server. Is your AI app running, with the server set up below?'
    case 'connecting': return 'Server found, connecting…'
    case 'connected': return `Connected${detail ? ` (${detail})` : ''}. Your AI assistant can work with this project.`
    case 'replaced': return 'Another FreazyKam tab connected, so this one let go.'
    case 'error': return detail ?? 'The connection failed.'
  }
}

export function McpButton() {
  const [open, setOpen] = useState(false)
  const state = useMcpBridgeStore((s) => s.state)
  return (
    <>
      <button
        title="Connect an AI assistant to this tab (MCP)"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 h-8 px-2 rounded text-sm transition-colors text-gray-600 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200 hover:bg-gray-300 dark:hover:bg-neutral-600"
      >
        <Plug size={ICON.md} />
        <span>MCP</span>
        <span className={`w-2 h-2 rounded-full ${DOT[state]}`} />
      </button>
      {open && <McpDialog onClose={() => setOpen(false)} />}
    </>
  )
}

const numCls = 'flex-shrink-0 w-6 h-6 rounded-full bg-blue-600 text-white text-xs font-semibold flex items-center justify-center'
const codeCls = 'px-1 rounded bg-gray-100 dark:bg-neutral-900 font-mono text-[0.85em]'
const noteCls = 'text-xs text-gray-500 dark:text-neutral-400'

function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="relative">
      <pre className="p-2 pr-9 rounded bg-gray-100 dark:bg-neutral-900 font-mono text-xs whitespace-pre-wrap break-all">{text}</pre>
      <button
        title="Copy"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }}
        className="absolute top-1.5 right-1.5 p-1 rounded text-gray-500 hover:text-gray-800 hover:bg-gray-200 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  )
}

function McpDialog({ onClose }: { onClose: () => void }) {
  const { enabled, state, detail, port, lastCall } = useMcpBridgeStore()
  const [portText, setPortText] = useState(String(port))
  const code = (t: string) => <code className={codeCls}>{t}</code>

  const env = port === DEFAULT_PORT ? '' : `,\n      "env": { "FREAZYKAM_MCP_PORT": "${port}" }`
  const desktopConfig =
`{
  "mcpServers": {
    "freazykam": {
      "command": "npx",
      "args": ["-y", "freazykam-mcp"]${env}
    }
  }
}`
  const codeCmd = port === DEFAULT_PORT
    ? 'claude mcp add freazykam -- npx -y freazykam-mcp'
    : `claude mcp add freazykam -e FREAZYKAM_MCP_PORT=${port} -- npx -y freazykam-mcp`

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-white dark:bg-neutral-800 rounded-lg shadow-2xl border border-gray-200 dark:border-neutral-700 w-[560px] max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-neutral-700">
          <h2 className="text-base font-semibold text-gray-900 dark:text-neutral-100">Connect an AI assistant (MCP)</h2>
          <button onClick={onClose} className="text-gray-600 hover:text-gray-800 dark:hover:text-neutral-200 transition-colors">
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto space-y-4 text-sm text-gray-700 dark:text-neutral-300">
          <p>
            An AI assistant that supports MCP — Claude, ChatGPT, Cursor and others — can work with
            the project open in this tab, through a small program on this computer: the FreazyKam
            MCP server. Nothing leaves your computer except what your AI app itself sends to its
            provider. It cannot run your machine.
          </p>

          <label className="flex items-center gap-2 font-medium cursor-pointer">
            <input type="checkbox" checked={enabled} onChange={(e) => setMcpBridgeEnabled(e.target.checked)} />
            Allow AI assistants to connect to this tab
          </label>

          <div className="flex items-start gap-2 p-2 rounded bg-gray-50 dark:bg-neutral-900/60">
            <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${DOT[state]}`} />
            <div className="flex-1 space-y-1">
              <p>{stateText(state, detail)}</p>
              {lastCall && state === 'connected' && (
                <p className={noteCls}>
                  Last request: {code(lastCall.method)} at {new Date(lastCall.at).toLocaleTimeString()}
                  {lastCall.ok ? '' : ' — failed'}
                </p>
              )}
            </div>
            {(state === 'replaced' || state === 'waiting' || state === 'error') && (
              <button onClick={reconnectMcpBridge} className="px-2 py-0.5 rounded bg-blue-600 hover:bg-blue-700 text-white text-xs">
                {state === 'replaced' ? 'Take over' : 'Retry now'}
              </button>
            )}
          </div>

          <h3 className="font-semibold text-gray-900 dark:text-neutral-100">One-time setup</h3>
          <ol className="space-y-4">
            <li className="flex gap-3">
              <span className={numCls}>1</span>
              <p>Install <a className="text-blue-600 dark:text-sky-400 hover:underline" href="https://nodejs.org" target="_blank" rel="noreferrer">Node.js</a> 18 or later, if you don't have it.</p>
            </li>
            <li className="flex gap-3">
              <span className={numCls}>2</span>
              <div className="flex-1 min-w-0 space-y-1.5">
                <p>
                  Add the server to your AI app. <b>Any MCP client:</b> the command is{' '}
                  {code(port === DEFAULT_PORT ? 'npx -y freazykam-mcp' : `FREAZYKAM_MCP_PORT=${port} npx -y freazykam-mcp`)}.
                </p>
                <p>
                  <b>Claude Desktop:</b> Settings → Developer → Edit Config, and add this to{' '}
                  {code('claude_desktop_config.json')} (merge it in if the file already has {code('mcpServers')}):
                </p>
                <CopyBlock text={desktopConfig} />
                <p><b>Claude Code:</b> run</p>
                <CopyBlock text={codeCmd} />
              </div>
            </li>
            <li className="flex gap-3">
              <span className={numCls}>3</span>
              <p>Restart your AI app. The light above turns green within a few seconds.</p>
            </li>
          </ol>

          <details className={noteCls}>
            <summary className="cursor-pointer">Port</summary>
            <div className="mt-2 flex items-center gap-2">
              <span>The server listens on 127.0.0.1 port</span>
              <input
                className="w-20 px-1 py-0.5 rounded border border-gray-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 text-gray-800 dark:text-neutral-200"
                value={portText}
                inputMode="numeric"
                onChange={(e) => setPortText(e.target.value)}
                onBlur={() => {
                  const n = Number(portText)
                  if (Number.isInteger(n) && n >= 1024 && n <= 65535) setMcpBridgePort(n)
                  else setPortText(String(port))
                }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              />
              <span>(default {DEFAULT_PORT}). Change it only if something else uses that port; the setup above follows.</span>
            </div>
          </details>
        </div>
      </div>
    </div>
  )
}
