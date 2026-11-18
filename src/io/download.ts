/** Hand `content` to the browser as a file download named `filename`. The object URL is
 *  revoked a second later, not straight after `click()`: a browser may start reading the
 *  blob only after the click returns (Safari has raced a synchronous revoke). */
export function downloadText(content: string, filename: string, mimeType: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
