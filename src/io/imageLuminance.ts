// Decodes an image-backed path's picture into the greyscale grid the CAM side carves
// (see cam/photoVcarve.ts). Lives on the main thread — decoding needs Image + canvas —
// and the result is handed to the worker as a plain typed array, the same split the 3D
// profile uses for STL geometry.

import type { PhotoImage } from '../cam/photoVcarve'

// Longest side of the decoded grid. A V-bit resolves nothing finer than its groove
// spacing, so a 6000 px phone photo carries no information a 2048 px one doesn't — and
// the full-size grid is tens of MB that would be cloned into the worker on every
// regenerate.
const MAX_DIM = 2048

// Rec. 709 luma. Photographs are carved by perceived brightness, so a mid green must
// come out lighter than a mid blue, which a flat channel average gets wrong.
const R_W = 0.2126, G_W = 0.7152, B_W = 0.0722

// Decoding the same picture again on every regenerate is pure waste — the data URL is
// the identity of the image, and a project holds a handful of them at most.
const CACHE_LIMIT = 4
const cache = new Map<string, PhotoImage>()

export function loadImageLuminance(src: string): Promise<PhotoImage> {
  const hit = cache.get(src)
  if (hit) return Promise.resolve(hit)

  return new Promise((resolve, reject) => {
    const img = new window.Image()
    img.onload = () => {
      try {
        const nw = img.naturalWidth, nh = img.naturalHeight
        if (nw < 1 || nh < 1) throw new Error('Image has no pixels')
        const scale = Math.min(1, MAX_DIM / Math.max(nw, nh))
        const w = Math.max(1, Math.round(nw * scale))
        const h = Math.max(1, Math.round(nh * scale))

        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) throw new Error('Could not get a 2D canvas context')
        ctx.drawImage(img, 0, 0, w, h)
        const { data } = ctx.getImageData(0, 0, w, h)

        const lum = new Uint8Array(w * h)
        for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
          // Transparent pixels read as white — nothing there to carve, so no cut. Composited
          // against white rather than left at the raw RGB, which is usually black and would
          // carve a cut-out's background at full depth.
          const a = data[p + 3] / 255
          const g = data[p] * R_W + data[p + 1] * G_W + data[p + 2] * B_W
          lum[i] = Math.round(g * a + 255 * (1 - a))
        }

        const out: PhotoImage = { lum, w, h }
        if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
        cache.set(src, out)
        resolve(out)
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    }
    img.onerror = () => reject(new Error('Could not decode the image'))
    img.src = src
  })
}
