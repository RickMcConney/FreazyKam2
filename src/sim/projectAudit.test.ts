// Audit saved .fkam projects against the sim height map.
//
// Drop a .fkam in the repo's scratch/ directory and run:
//   npm run audit                       — audits every project in scratch/
//   FKAM_AUDIT=/path/to/one.fkam npm run audit
//
// Opt-in by design: without FKAM_AUDIT/FKAM_AUDIT_DIR this file audits nothing and passes,
// so a work-in-progress project sitting in scratch/ can't turn the default suite red.
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { auditProjectFile } from './projectAudit'
import { auditReport } from './toolpathAudit'

const SCRATCH = join(process.cwd(), 'scratch')

function projectFiles(): string[] {
  const one = process.env.FKAM_AUDIT
  if (one) return one.split(',').map(s => s.trim()).filter(Boolean)
  const dir = process.env.FKAM_AUDIT_DIR
  if (!dir) return []
  const resolved = dir === 'scratch' ? SCRATCH : dir
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) return []
  return readdirSync(resolved).filter(f => f.endsWith('.fkam')).sort().map(f => join(resolved, f))
}

const files = projectFiles()

describe('saved project audit', () => {
  if (files.length === 0) {
    it('nothing to audit', () => {
      console.log('[audit] nothing to audit — run `npm run audit` (scratch/) or set FKAM_AUDIT=<file>')
      expect(true).toBe(true)
    })
    return
  }

  for (const file of files) {
    it(`clears everything it should: ${file.split('/').pop()}`, async () => {
      const a = await auditProjectFile(file)
      const report = `${file}\n${auditReport(a)}${a.errors.length ? '\n  errors: ' + a.errors.join(' | ') : ''}`
      console.log(report)

      expect(a.errors, report).toEqual([])
      expect(a.warnings, report).toEqual([])
      // Slack covers wall-cell quantization only; a skipped ring or a helical descent runs to
      // hundreds of cells.
      expect(a.uncut, report).toBeLessThanOrEqual(50)
      expect(a.shallow, report).toBeLessThanOrEqual(50)
      if (a.gouged >= 0) expect(a.gouged, report).toBeLessThanOrEqual(50)
    }, 120_000)
  }
})
