// `[ESP800]` — the controller's self-description, and the only way to learn which
// port its WebSocket is on.
//
// FluidNC builds that serve WebUI 3 answer `[ESP800]json=yes` with JSON
// (`{cmd:"800", status:"ok", data:{WebSocketPort, WebCommunication, …}}`). Older
// builds ignore `json=yes` and answer in WebUI 2's `key:value # key:value` text,
// where the socket is `webcommunication: Sync: 81` and wants the `arduino`
// subprotocol. Both are read here.

export interface ControllerInfo {
  wsPort: number
  wsPath: string                 // '/' for synchronous, '/ws' for asynchronous
  wsProtocol: 'webui-v3' | 'arduino'
  firmware?: string
  hostName?: string
}

export function parseEsp800(body: string): ControllerInfo | null {
  const text = body.trim()
  if (text.startsWith('{')) {
    let j: { status?: string; data?: Record<string, string> }
    try { j = JSON.parse(text) } catch { return null }
    const d = j.data
    if (j.status === 'error' || !d || !d.WebSocketPort) return null
    const port = parseInt(d.WebSocketPort, 10)
    if (!Number.isFinite(port)) return null
    return {
      wsPort: port,
      wsPath: d.WebCommunication === 'Asynchronous' ? '/ws' : '/',
      wsProtocol: 'webui-v3',
      firmware: d.FWVersion,
      hostName: d.HostName,
    }
  }
  const ws = /webcommunication:\s*(Sync|Async)\s*:\s*(\d+)/i.exec(text)
  if (!ws) return null
  const fw = /FW version:\s*([^#]+?)\s*(#|$)/i.exec(text)
  const host = /hostname:\s*([^#\s]+)/i.exec(text)
  return {
    wsPort: parseInt(ws[2], 10),
    wsPath: ws[1].toLowerCase() === 'async' ? '/ws' : '/',
    wsProtocol: 'arduino',
    firmware: fw?.[1],
    hostName: host?.[1],
  }
}

/**
 * The WebSocket path FreazyKam opens, asking for a session of its own.
 *
 * FluidNC (WebUI/WSChannel.cpp) groups sockets into sessions by the `sessionId`
 * cookie, and "the newest websocket for a session wins": a new socket closes the
 * older ones in its session, and loading the WebUI page does the same. The relay
 * lives on the controller's origin, so it shares that cookie with any WebUI tab in
 * the same browser — and the WebUI's automatic reconnect then closed our socket
 * (seen as close code 1005 shortly after connecting). With `independent_session`
 * in the URL, FluidNC keys the session to this socket alone. Firmware without the
 * parameter ignores it.
 */
export function wsSessionPath(path: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}independent_session=1`
}

export interface WifiStatus {
  signalPct: number      // FluidNC's 0–100 bar: 2 × (RSSI + 100), clamped
  rssiDbm: number        // recovered from it, for the tooltip
  ssid?: string
  channel?: number
}

/**
 * The WiFi link from `[ESP420]json=yes` (FluidNC WebUI/WebCommands.cpp): a `data`
 * array of {id, value}, where "Signal" is "74%". The percentage is FluidNC's own
 * mapping of RSSI (WifiConfig.cpp apSignalPercent: −100 dBm → 0 %, −50 dBm → 100 %),
 * so the dBm comes back exactly within that range. Null when there is no signal
 * line (Ethernet, AP mode, or not a status reply).
 */
export function parseEsp420Wifi(body: string): WifiStatus | null {
  let j: unknown
  try { j = JSON.parse(body) } catch { return null }
  const data = (j as { data?: unknown })?.data
  if (!Array.isArray(data)) return null
  const get = (id: string): string | undefined => {
    const row = data.find((d) => d && typeof d === 'object' && (d as { id?: unknown }).id === id) as { value?: unknown } | undefined
    return row?.value === undefined ? undefined : String(row.value)
  }
  const sig = get('Signal')
  const pct = sig === undefined ? NaN : parseFloat(sig)
  if (!Number.isFinite(pct)) return null
  const signalPct = Math.max(0, Math.min(100, pct))
  const ch = Number(get('Channel'))
  return {
    signalPct,
    rssiDbm: signalPct / 2 - 100,
    ssid: get('Connected to'),
    channel: Number.isFinite(ch) && ch > 0 ? ch : undefined,
  }
}
