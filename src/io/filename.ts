// Make a user-typed name safe to use as a download filename: strip characters
// that are illegal in filenames across OSes, collapse whitespace, and fall back
// to a default if nothing usable is left. Spaces are kept (they're valid in
// filenames); only path/reserved characters are replaced.
export function sanitizeFileName(name: string, fallback = 'project'): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\n\r\t]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || fallback
}
