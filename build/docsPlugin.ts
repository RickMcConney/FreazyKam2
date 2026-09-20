import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'
import { marked } from 'marked'
import type { Plugin } from 'vite'

// Renders docs/*.md into the static documentation site served at /docs/.
//
// The guide is written as ordinary GitHub-readable markdown — it has to stay readable in
// the repo, which is where it is edited — so nothing here asks the source to carry site
// metadata. Order, titles and navigation are all DERIVED: the filenames sort
// (README, 01-…, 02-…), and each page's title is its first H1.
//
// Two jobs beyond running marked:
//
//   1. Heading ids. The guide cross-links to anchors (`05-pockets.md#holding-tabs`), which
//      work on GitHub because GitHub slugs every heading. Nothing does that here unless
//      we do, so `slug()` reimplements the same rule and `linkAudit` VERIFIES every
//      internal link and anchor resolves — a broken one fails the build rather than
//      shipping a 404 nobody clicks until a user does.
//   2. Link rewriting. `foo.md` → `foo.html`, `README.md` → the docs index, `../README.md`
//      → the landing page, and the old GitHub Pages launch URL → /app/.
//
// Runs in both directions: `generateBundle` emits the pages into dist/ for a build, and
// `configureServer` renders them on demand so `npm run dev` serves /docs/ as well.

const DOCS_DIR = 'docs'
const SITE = 'https://freazykam.com'
const REPO = 'https://github.com/RickMcConney/FreazyKam2'

export interface DocPage {
  /** Source file name, e.g. `01-quick-start.md`. */
  src: string
  /** Published name, e.g. `01-quick-start.html` (README becomes `index.html`). */
  out: string
  /** The page's H1, verbatim. */
  title: string
  /** Title trimmed for the sidebar — everything before the em dash. */
  navTitle: string
  markdown: string
}

/** GitHub's heading-anchor rule: lowercase, drop punctuation, spaces to hyphens. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')      // inline html (`<code>`) contributes nothing
    .replace(/&[a-z]+;/g, '')     // nor do entities marked has already escaped
    .replace(/[^\w\- ]+/g, '')
    .trim()
    .replace(/ +/g, '-')
}

/** Strip inline tags so a heading can be slugged and indexed as plain text. */
const textOf = (html: string): string =>
  html.replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .trim()

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** Collect the guide in filename order, with README first as the index. */
export function collectPages(root: string): DocPage[] {
  const dir = join(root, DOCS_DIR)
  const files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'images')
  const ordered = [
    ...files.filter((f) => f === 'README.md'),
    ...files.filter((f) => f !== 'README.md').sort(),
  ]
  return ordered.map((src) => {
    const markdown = readFileSync(join(dir, src), 'utf-8')
    const h1 = /^#\s+(.+)$/m.exec(markdown)
    const title = h1 ? h1[1].trim() : src.replace(/\.md$/, '')
    return {
      src,
      out: src === 'README.md' ? 'index.html' : src.replace(/\.md$/, '.html'),
      title,
      // "1. Quick Start — your first part" reads as "1. Quick Start" in the sidebar; the
      // rest is a subtitle on the index page, where there is room for it.
      navTitle: title.split(' — ')[0].trim(),
      markdown,
    }
  })
}

interface Rendered {
  html: string
  /** Every heading on the page, for the anchor audit and the search index. */
  headings: { depth: number; id: string; text: string }[]
}

/**
 * Markdown → the page body, with heading ids injected and links repointed.
 *
 * `published` is every page this site actually has. A .md link to something NOT in it is
 * a contributor note living in docs/ rather than a chapter — `images/README.md` is the
 * screenshot-capture rules — so it goes to the file on GitHub instead of being published
 * as a reader-facing page.
 */
function renderBody(page: DocPage, published: Set<string>): Rendered {
  // The capture notes ("<!-- FULL APP · 1600 px wide -->") are instructions for whoever
  // recaptures a screenshot, not content.
  const src = page.markdown.replace(/<!--[\s\S]*?-->/g, '')

  let html = marked.parse(src, { async: false }) as string

  const headings: Rendered['headings'] = []
  const used = new Set<string>()
  html = html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_m, d: string, inner: string) => {
    const depth = Number(d)
    const text = textOf(inner)
    let id = slug(text)
    // Two headings can slug alike ("Next" closes most chapters); GitHub appends -1, -2.
    if (used.has(id)) { let n = 1; while (used.has(`${id}-${n}`)) n++; id = `${id}-${n}` }
    used.add(id)
    headings.push({ depth, id, text })
    // The anchor link is the heading itself, so a reader can copy a link to any section.
    return `<h${depth} id="${id}">${inner}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${depth}>`
  })

  html = html.replace(/(href|src)="([^"]+)"/g, (m, attr: string, url: string) => {
    if (attr === 'src') return m
    // The guide's own launch link pointed at GitHub Pages; the app lives here now.
    if (url.startsWith('https://rickmcconney.github.io/FreazyKam2')) return `${attr}="/app/"`
    if (/^(https?:|mailto:|#|\/)/.test(url)) return m
    // `../README.md` is the repo's feature list — the landing page says the same thing.
    if (url === '../README.md') return `${attr}="/"`
    const [target, hash] = url.split('#')
    if (!target.endsWith('.md')) return m   // .fkam downloads and images pass through
    const out = target === 'README.md' ? 'index.html' : target.replace(/\.md$/, '.html')
    if (!published.has(out)) return `${attr}="${REPO}/blob/main/docs/${target}"`
    return `${attr}="${out}${hash ? `#${hash}` : ''}"`
  })

  // Every screenshot in the guide is below the fold of its own page.
  html = html.replace(/<img /g, '<img loading="lazy" decoding="async" ')

  return { html, headings }
}

/**
 * Fail the build on an internal link that goes nowhere.
 *
 * Worth the strictness: these links are written by hand in markdown, GitHub happily
 * renders a dead one, and the only other way to find it is for a reader to click it.
 */
function linkAudit(pages: DocPage[], rendered: Map<string, Rendered>): void {
  const anchors = new Map<string, Set<string>>()
  for (const p of pages) anchors.set(p.out, new Set(rendered.get(p.out)!.headings.map((h) => h.id)))

  const broken: string[] = []
  for (const p of pages) {
    const html = rendered.get(p.out)!.html
    for (const [, url] of html.matchAll(/href="([^"]+)"/g)) {
      if (/^(https?:|mailto:|\/)/.test(url)) continue
      const [target, hash] = url.split('#')
      const file = target === '' ? p.out : target
      if (file.endsWith('.html')) {
        if (!anchors.has(file)) { broken.push(`${p.src} → ${url} (no such page)`); continue }
        if (hash && !anchors.get(file)!.has(hash)) broken.push(`${p.src} → ${url} (no such section)`)
      }
    }
  }
  if (broken.length) {
    throw new Error(`[docs] broken links:\n  ${broken.join('\n  ')}`)
  }
}

/** One entry per heading, so search can land a reader on the right section. */
function buildSearchIndex(pages: DocPage[], rendered: Map<string, Rendered>): string {
  const entries: { u: string; p: string; t: string; b: string }[] = []
  for (const page of pages) {
    const { html, headings } = rendered.get(page.out)!
    // The page's text, split at each heading, so an entry carries its own section's body.
    // The heading anchors ("<a class=anchor>#</a>") are chrome, not prose — left in, every
    // snippet starts with a stray '#'.
    const plain = textOf(
      html.replace(/<a class="anchor"[\s\S]*?<\/a>/g, '')
        .replace(/<pre[\s\S]*?<\/pre>/g, ' ')
        .replace(/\s+/g, ' '),
    )
    for (let i = 0; i < headings.length; i++) {
      const h = headings[i]
      const start = plain.indexOf(h.text)
      const next = i + 1 < headings.length ? plain.indexOf(headings[i + 1].text, start + 1) : plain.length
      const body = start < 0 ? '' : plain.slice(start + h.text.length, next < 0 ? plain.length : next)
      entries.push({
        u: `${page.out}${h.depth > 1 ? `#${h.id}` : ''}`,
        p: page.navTitle,
        t: h.text,
        b: body.trim().slice(0, 320),
      })
    }
  }
  return JSON.stringify(entries)
}

function sidebar(pages: DocPage[], current: string): string {
  const items = pages.map((p) => {
    const here = p.out === current
    return `<li><a href="${p.out}"${here ? ' aria-current="page"' : ''}>${escapeHtml(p.navTitle)}</a></li>`
  }).join('\n          ')
  return `<ul class="toc">\n          ${items}\n        </ul>`
}

/** The on-page contents list: the H2s, which are the steps or topics of a chapter. */
function onThisPage(r: Rendered): string {
  const tops = r.headings.filter((h) => h.depth === 2)
  if (tops.length < 3) return ''
  const items = tops.map((h) => `<li><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`).join('\n          ')
  return `<nav class="onpage" aria-label="On this page">\n        <p class="onpage-title">On this page</p>\n        <ul>\n          ${items}\n        </ul>\n      </nav>`
}

function pageHtml(page: DocPage, pages: DocPage[], rendered: Map<string, Rendered>): string {
  const r = rendered.get(page.out)!
  const i = pages.findIndex((p) => p.out === page.out)
  const prev = i > 0 ? pages[i - 1] : null
  const next = i >= 0 && i < pages.length - 1 ? pages[i + 1] : null
  const isIndex = page.out === 'index.html'
  const canonical = `${SITE}/docs/${isIndex ? '' : page.out}`

  const pager = (prev || next)
    ? `<nav class="pager">
        ${prev ? `<a class="pager-prev" href="${prev.out}"><span>Previous</span>${escapeHtml(prev.navTitle)}</a>` : '<span></span>'}
        ${next ? `<a class="pager-next" href="${next.out}"><span>Next</span>${escapeHtml(next.navTitle)}</a>` : '<span></span>'}
      </nav>`
    : ''

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" type="image/x-icon" href="/favicon.ico" />
    <title>${escapeHtml(page.title)} — FreazyKam guide</title>
    <meta name="description" content="${escapeHtml(page.title)} — from the FreazyKam user guide. Browser-based CNC CAM for makers and woodworkers." />
    <link rel="canonical" href="${canonical}" />
    <meta name="theme-color" content="#0a0a0a" media="(prefers-color-scheme: dark)" />
    <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="FreazyKam" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:title" content="${escapeHtml(page.title)} — FreazyKam guide" />
    <meta property="og:image" content="${SITE}/og-card.png" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="stylesheet" href="/site.css" />
    <link rel="stylesheet" href="/docs.css" />
  </head>
  <body>
    <header class="site-head">
      <div class="wrap">
        <a class="brand" href="/">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 2v9" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" />
            <path d="M8.2 11h7.6L12 17.4 8.2 11Z" fill="var(--accent)" />
            <path d="M3 21h18" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" opacity=".45" />
          </svg>
          FreazyKam
        </a>
        <nav class="site-nav">
          <a href="/docs/" class="nav-hide-sm">Guide</a>
          <a href="https://github.com/RickMcConney/FreazyKam2" class="nav-hide-sm">GitHub</a>
          <a class="btn btn-primary" href="/app/">Launch app</a>
        </nav>
      </div>
    </header>

    <div class="docs-layout wrap">
      <button class="toc-toggle" type="button" aria-expanded="false" aria-controls="docs-side">Contents</button>

      <aside class="docs-side" id="docs-side">
        <form class="search" role="search" onsubmit="return false">
          <label class="sr-only" for="docs-search">Search the guide</label>
          <input id="docs-search" type="search" placeholder="Search the guide…" autocomplete="off" />
        </form>
        <div class="search-results" id="search-results" hidden></div>
        <p class="toc-title">User guide</p>
        ${sidebar(pages, page.out)}
      </aside>

      <main class="docs-main">
        <article class="prose">
${r.html}
        </article>
        ${pager}
      </main>

      ${onThisPage(r)}
    </div>

    <footer class="site-foot">
      <div class="wrap">
        <span>FreazyKam — CNC CAM in the browser</span>
        <span class="spacer"></span>
        <a href="/">Home</a>
        <a href="/app/">Launch</a>
        <a href="https://github.com/RickMcConney/FreazyKam2">GitHub</a>
        <a href="https://github.com/RickMcConney/FreazyKam2/issues">Report a problem</a>
      </div>
    </footer>

    <script src="/docs.js" defer></script>
  </body>
</html>
`
}

/** Everything the docs site is made of, keyed by its path under /docs/. */
export function buildDocs(root: string): Map<string, string> {
  const pages = collectPages(root)
  const rendered = new Map<string, Rendered>()
  const published = new Set(pages.map((p) => p.out))
  for (const p of pages) rendered.set(p.out, renderBody(p, published))
  linkAudit(pages, rendered)

  const out = new Map<string, string>()
  for (const p of pages) out.set(p.out, pageHtml(p, pages, rendered))
  out.set('search-index.json', buildSearchIndex(pages, rendered))
  return out
}

/** Images and the sample project, copied beside the pages that link to them. */
function docAssets(root: string): { path: string; abs: string }[] {
  const dir = join(root, DOCS_DIR)
  const found: { path: string; abs: string }[] = []
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const abs = join(d, name)
      if (name.startsWith('.')) continue   // .DS_Store and friends are not content
      if (statSync(abs).isDirectory()) { walk(abs); continue }
      if (extname(name) === '.md') continue
      found.push({ path: relative(dir, abs).split('\\').join('/'), abs })
    }
  }
  walk(dir)
  return found
}

export function docsPlugin(): Plugin {
  let root = process.cwd()
  return {
    name: 'freazykam-docs',
    configResolved(cfg) { root = cfg.root },

    // `npm run dev` serves /docs/ too, re-rendered on every request so an edit to a
    // markdown file shows up on reload without restarting the server.
    configureServer(server) {
      server.middlewares.use((req, res, nextFn) => {
        const url = (req.url ?? '').split('?')[0]
        if (!url.startsWith('/docs')) return nextFn()
        let rel = url.slice('/docs'.length).replace(/^\//, '')
        if (rel === '') rel = 'index.html'
        try {
          if (rel.endsWith('.html') || rel.endsWith('.json')) {
            const files = buildDocs(root)
            const body = files.get(rel)
            if (body === undefined) return nextFn()
            res.setHeader('Content-Type', rel.endsWith('.json') ? 'application/json' : 'text/html')
            res.end(body)
            return
          }
          const asset = docAssets(root).find((a) => a.path === decodeURIComponent(rel))
          if (!asset) return nextFn()
          res.end(readFileSync(asset.abs))
        } catch (err) {
          res.statusCode = 500
          res.end(`<pre>${escapeHtml(String(err))}</pre>`)
        }
      })
    },

    generateBundle() {
      for (const [name, source] of buildDocs(root)) {
        this.emitFile({ type: 'asset', fileName: `docs/${name}`, source })
      }
      for (const asset of docAssets(root)) {
        this.emitFile({ type: 'asset', fileName: `docs/${asset.path}`, source: readFileSync(asset.abs) })
      }
    },
  }
}
