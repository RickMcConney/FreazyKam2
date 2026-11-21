// Every help link the app can open lands on a page and a section that exist. The pages
// are hand-written markdown, so a heading reworded there would otherwise break a link
// here with nothing to say so until a user clicked it.
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { marked } from 'marked'
import { slug } from '../../build/docsPlugin'
import { HELP_TOPICS, helpUrl } from './helpTopics'

const ROOT = join(__dirname, '..', '..')

/** The anchors the docs build gives a page's headings: GitHub's slug, with -1, -2 on repeats. */
function anchorsOf(file: string): Set<string> {
  const ids = new Set<string>()
  for (const t of marked.lexer(readFileSync(join(ROOT, file), 'utf-8'))) {
    if (t.type !== 'heading') continue
    const text = (marked.parseInline(t.text) as string).replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    let id = slug(text)
    if (ids.has(id)) { let n = 1; while (ids.has(`${id}-${n}`)) n++; id = `${id}-${n}` }
    ids.add(id)
  }
  return ids
}

describe('help topics', () => {
  for (const [topic, target] of Object.entries(HELP_TOPICS)) {
    it(`"${topic}" opens a page and section that exist (${target})`, () => {
      const [file, hash] = target.split('#')
      expect(existsSync(join(ROOT, file)), `no such page: ${file}`).toBe(true)
      if (hash) expect([...anchorsOf(file)], `no section #${hash} in ${file}`).toContain(hash)
    })
  }

  it('serves a markdown page as the .html the docs build writes, keeping the section', () => {
    expect(helpUrl('pocket')).toBe('/help/how-to/clear-a-pocket.html')
    expect(helpUrl('objects-strip')).toBe('/help/reference/screen.html#objects-strip')
    expect(helpUrl('view-3d')).toBe('/docs/10-export.html#2d-and-3d')
  })

  // Two controls sent to the same place means one of them lands on a page about the
  // other — the reader arrives at the top of a section they did not ask about.
  it('sends every topic somewhere of its own', () => {
    const byTarget = new Map<string, string[]>()
    for (const [topic, target] of Object.entries(HELP_TOPICS)) byTarget.set(target, [...(byTarget.get(target) ?? []), topic])
    expect([...byTarget].filter(([, ts]) => ts.length > 1)).toEqual([])
  })

  it('has no url for a name that is not a topic', () => {
    expect(helpUrl('no-such-topic')).toBeNull()
  })

  // helpAttr is what lets the compiler check a topic name; a hand-written attribute
  // would get past it.
  it('every data-help in the source goes through helpAttr', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.tsx?$/.test(name) && !name.endsWith('.test.ts')
          && /data-help=["{]/.test(readFileSync(p, 'utf-8'))) offenders.push(p)
      }
    }
    walk(join(ROOT, 'src'))
    expect(offenders).toEqual([])
  })
})
