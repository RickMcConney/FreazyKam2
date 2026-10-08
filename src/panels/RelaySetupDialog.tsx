// One-time setup of the relay: download controller/relay.html (bundled into the
// app, so it always matches this build's relayClient) under the name the
// controller needs, and copy it to the controller's flash.
//
// FreazyKam cannot do the first copy itself: until the relay is on the
// controller, the browser will not let an HTTPS page reach the controller's
// plain-http server at all (mixed content) — the relay IS the way in. So it goes
// through the controller's own WebUI, served over http by the controller.
//
// Why freazyKam.html on FluidNC v4+ but 404.htm on v3: see RELAY_PATH in
// machine/relayClient.ts.

import { Download, ExternalLink, X } from 'lucide-react'
import relayHtml from '../../controller/relay.html?raw'
import { controllerOrigin, RELAY_FILE_NAME, RELAY_LEGACY_FILE_NAME, RELAY_PATH } from '../machine/relayClient'

interface Props {
  address: string
  onClose: () => void
}

export function downloadRelay(name: string = RELAY_FILE_NAME) {
  const url = URL.createObjectURL(new Blob([relayHtml], { type: 'text/html' }))
  const a = document.createElement('a')
  a.href = url
  // The name is load-bearing: FreazyKam opens /flash/freazyKam.html, and FluidNC v3
  // serves only its not-found page, 404.htm, inline.
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const numCls = 'flex-shrink-0 w-6 h-6 rounded-full bg-blue-600 text-white text-xs font-semibold flex items-center justify-center'
const codeCls = 'px-1 rounded bg-gray-100 dark:bg-neutral-900 font-mono text-[0.85em]'
const linkCls = 'inline-flex items-center gap-1 text-blue-600 dark:text-sky-400 hover:underline'
const noteCls = 'text-xs text-gray-500 dark:text-neutral-400'

export default function RelaySetupDialog({ address, onClose }: Props) {
  let origin = 'http://fluidnc.local'
  try { origin = controllerOrigin(address.trim() || 'fluidnc.local') } catch { /* keep the default */ }
  const relayUrl = `${origin}${RELAY_PATH}`
  const code = (t: string) => <code className={codeCls}>{t}</code>

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-white dark:bg-neutral-800 rounded-lg shadow-2xl border border-gray-200 dark:border-neutral-700 w-[540px] max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-neutral-700">
          <h2 className="text-base font-semibold text-gray-900 dark:text-neutral-100">Set up the controller link</h2>
          <button onClick={onClose} className="text-gray-600 hover:text-gray-800 dark:hover:text-neutral-200 transition-colors">
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto space-y-4 text-sm text-gray-700 dark:text-neutral-300">
          <p>
            FreazyKam talks to a FluidNC controller through a small page, the <b>relay</b>, kept on the
            controller itself. Copy it there once per controller.
          </p>

          <ol className="space-y-4">
            <li className="flex gap-3">
              <span className={numCls}>1</span>
              <div className="space-y-1.5">
                <p>Download the relay. It is saved as {code(RELAY_FILE_NAME)} — keep that name.</p>
                <button onClick={() => downloadRelay()}
                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white text-sm">
                  <Download size={15} /> Download {RELAY_FILE_NAME}
                </button>
                <p className={noteCls}>
                  That is for FluidNC v4.0 and later. On v3,{' '}
                  <button onClick={() => downloadRelay(RELAY_LEGACY_FILE_NAME)} className={linkCls}>
                    download it as {RELAY_LEGACY_FILE_NAME}
                  </button>{' '}
                  instead: v3 hands any file asked for by name to the browser as a download, never as a
                  page — except its "page not found" page, {code(RELAY_LEGACY_FILE_NAME)}. The WebUI's
                  About box shows the version.
                </p>
              </div>
            </li>

            <li className="flex gap-3">
              <span className={numCls}>2</span>
              <div className="space-y-1">
                <p>
                  Open the controller's WebUI:{' '}
                  <a href={origin} target="_blank" rel="noreferrer" className={linkCls}>{origin} <ExternalLink size={13} /></a>
                </p>
                <p className={noteCls}>Its IP address works too, if {code('.local')} names do not on your network.</p>
              </div>
            </li>

            <li className="flex gap-3">
              <span className={numCls}>3</span>
              <div className="space-y-1">
                <p>
                  In the WebUI's <b>Files</b> panel, switch the drop-down from <b>SD</b> to <b>Flash</b>, and
                  upload the relay ({code(RELAY_FILE_NAME)}, or {code(RELAY_LEGACY_FILE_NAME)} on v3) to the top folder — next to {code('index.html.gz')} and
                  your {code('config.yaml')}.
                </p>
                <p className={noteCls}>
                  Flash, not the SD card. Do not rename or replace {code('index.html.gz')}: that is the
                  WebUI itself, and the relay leaves it alone.
                </p>
              </div>
            </li>

            <li className="flex gap-3">
              <span className={numCls}>4</span>
              <div className="space-y-1">
                <p>
                  Check it: open{' '}
                  <a href={relayUrl} target="_blank" rel="noreferrer" className={linkCls}>{relayUrl} <ExternalLink size={13} /></a>.
                  A small page titled <b>FreazyKam link</b> means it is in place. Close that tab.
                </p>
                <p className={noteCls}>
                  If the browser downloads a file, or shows a blank or "not found" page instead, the relay
                  is not on the flash under the name your FluidNC version needs — repeat steps 1 and 3.
                </p>
              </div>
            </li>

            <li className="flex gap-3">
              <span className={numCls}>5</span>
              <p>
                Back here, enter the controller's address and press <b>Connect</b>. Allow pop-ups for this
                site if the browser asks: the relay opens as a small window and must stay open while you
                are connected (it can sit behind this one).
              </p>
            </li>
          </ol>

          <div className="rounded border border-amber-400/60 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 space-y-1 text-xs text-amber-900 dark:text-amber-200">
            <p className="font-semibold">Good to know</p>
            <p>On FluidNC v3 the controller must be on your WiFi network (station mode). In access-point mode v3 answers with its captive portal instead of the relay.</p>
            <p>Connect before starting a job: while the machine is moving, FluidNC will not serve pages from its flash.</p>
            <p>On v3, any mistyped address on the controller now shows the relay page instead of "not found". That is harmless — the relay only takes orders from FreazyKam.</p>
          </div>
        </div>

        <div className="flex justify-end px-5 py-3 border-t border-gray-200 dark:border-neutral-700">
          <button onClick={onClose}
            className="px-4 py-1.5 rounded text-sm border border-gray-400 dark:border-neutral-600 text-gray-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700">
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
