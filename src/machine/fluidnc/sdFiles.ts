// The controller's SD card, as WebUI 3 drives it on FluidNC (DIRECTSD-source.ts):
//   GET  /upload?path=/dir&action=list                  → the listing, JSON
//   GET  /upload?path=/dir&action=delete&filename=f.nc  → deletes, answers the new listing
//   POST /upload  multipart: path, "<full path>S" = size (the controller checks the
//        upload arrived whole against it), "<full path>T" = mtime, then the file itself
//        as `myfiles` named by its full path              → answers the new listing
//   GET  /sd/dir/f.nc                                   → the file's contents
//   $SD/Run=/dir/f.nc                                   → runs it; progress comes back as
//                                                         `SD:<percent>,<file>` in status reports
// A directory is an entry whose size is "-1".

export interface SdEntry {
  name: string
  size: string          // as the controller formats it ("1.23 KB"); "-1" for a directory
  isDir: boolean
}

export interface SdListing {
  path: string
  files: SdEntry[]      // directories first, then files, each alphabetical
  total?: string
  used?: string
  occupation?: number   // percent full
  status?: string
}

/** Parse a listing reply; null when it is not one (an HTML error page, a truncated body). */
export function parseSdListing(body: string): SdListing | null {
  let j: unknown
  try { j = JSON.parse(body) } catch { return null }
  if (!j || typeof j !== 'object' || !Array.isArray((j as { files?: unknown }).files)) return null
  const o = j as Record<string, unknown> & { files: Record<string, unknown>[] }
  const files = o.files
    .filter((f) => f && typeof f.name === 'string' && f.name !== '')
    .map((f): SdEntry => {
      const size = String(f.size ?? '')
      return { name: String(f.name), size, isDir: size === '-1' }
    })
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.isDir ? -1 : 1))
  const occ = Number(o.occupation)
  return {
    path: typeof o.path === 'string' && o.path ? o.path : '/',
    files,
    total: o.total !== undefined ? String(o.total) : undefined,
    used: o.used !== undefined ? String(o.used) : undefined,
    occupation: Number.isFinite(occ) ? occ : undefined,
    status: o.status !== undefined ? String(o.status) : undefined,
  }
}

/** `/dir` + `f.nc` → `/dir/f.nc`, without doubling the slash at the root. */
export function sdJoin(dir: string, name: string): string {
  return `${dir.endsWith('/') ? dir : `${dir}/`}${name}`
}

/** The parent of an SD directory; the root is its own parent. */
export function sdParent(dir: string): string {
  const i = dir.replace(/\/+$/, '').lastIndexOf('/')
  return i <= 0 ? '/' : dir.slice(0, i)
}

/** The download URL path for a file: each segment encoded, the slashes kept. */
export function sdDownloadPath(dir: string, name: string): string {
  return `/sd${sdJoin(dir, name).split('/').map(encodeURIComponent).join('/')}`
}

export function sdRunCommand(dir: string, name: string): string {
  return `$SD/Run=${sdJoin(dir, name)}`
}

/** The multipart fields of an upload, in the order the controller reads them. */
export function sdUploadForm(dir: string, file: Blob, name: string, mtime: Date): [string, string | Blob, string?][] {
  const full = sdJoin(dir, name)
  const p2 = (n: number) => String(n).padStart(2, '0')
  const t = `${mtime.getFullYear()}-${p2(mtime.getMonth() + 1)}-${p2(mtime.getDate())}-${p2(mtime.getHours())}-${p2(mtime.getMinutes())}-${p2(mtime.getSeconds())}`
  return [
    ['path', dir],
    [`${full}S`, String(file.size)],
    [`${full}T`, t],
    ['myfiles', file, full],
  ]
}
