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

// Stricter than sanitizeFileName, for files that go to a machine controller: many
// read only plain ASCII (an SD card in a Grbl sender, a FAT filesystem on a USB
// stick). Accents fold to their base letter, other non-ASCII symbols (°, ×, ″) are
// dropped, and everything outside letters, digits, '.', '_' and '-' — spaces
// included — becomes '_'.
const FRACTION_SLASH = String.fromCharCode(0x2044)

export function asciiFileName(name: string, fallback = 'gcode'): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .split(FRACTION_SLASH).join('/') // ½ decomposes to 1⁄2 — keep it from reading as 12
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return cleaned || fallback
}
