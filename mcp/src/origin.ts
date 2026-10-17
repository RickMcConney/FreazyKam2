// Who may connect. The server listens on loopback only, but ANY page the user has
// open can try ws://127.0.0.1 — so the Origin header is the gate. A web page
// cannot forge it (the browser sets it), and a DNS-rebinding page still carries
// its own origin, so allowing exactly FreazyKam's origins keeps every other site
// out. A non-browser process could forge it, but a local process already has the
// user's access; it gains nothing here.

const HOSTED = ['https://freazykam.com', 'https://www.freazykam.com']

/** True when a page from `origin` may drive the bridge. `extra` comes from FREAZYKAM_MCP_ORIGINS. */
export function originAllowed(origin: string | undefined, extra: readonly string[] = []): boolean {
  if (!origin) return false
  if (HOSTED.includes(origin) || extra.includes(origin)) return true
  // `npm run dev` / `vite preview` on this machine, any port.
  let url: URL
  try { url = new URL(origin) } catch { return false }
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1') && url.pathname === '/'
}

/** True when the Host header names this server — refuses a rebound hostname even before the origin check. */
export function hostAllowed(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`
}
