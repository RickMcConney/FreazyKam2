import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, extname, posix } from 'node:path'
import { marked } from 'marked'
import type { Plugin } from 'vite'

// Renders the documentation sites served beside the app:
//
//   docs/  → /docs/   the user guide — one flat folder of chapters
//   help/  → /help/   the help pages — tutorials, how-to, reference and explanation
//                     folders (the Diátaxis split), each page short and single-purpose
//
// Both are written as ordinary GitHub-readable markdown — they have to stay readable in
// the repo, which is where they are edited — so nothing here asks the source to carry
// site metadata. Order, titles and navigation are all DERIVED: the README is the index,
// pages come in the order the README links them (filename order for anything it does
// not link), and each page's title is its first H1.
//
// Two jobs beyond running marked:
//
//   1. Heading ids. The pages cross-link to anchors (`05-pockets.md#holding-tabs`), which
//      work on GitHub because GitHub slugs every heading. Nothing does that here unless
//      we do, so `slug()` reimplements the same rule and `linkAudit` VERIFIES every
//      internal link, anchor and image resolves — a broken one fails the build rather
//      than shipping a 404 nobody clicks until a user does.
//   2. Link rewriting. `foo.md` → `foo.html`, `README.md` → the folder's index, the
//      guide's `../README.md` → the landing page, and the old GitHub Pages launch URL →
//      /app/. Relative links stay relative, so a help page's `../../docs/images/x.png`
//      lands on the guide's published copy of the screenshot.
//
// Runs in both directions: `generateBundle` emits the pages into dist/ for a build, and
// `configureServer` renders them on demand so `npm run dev` serves both sites as well.

const SITE = 'https://freazykam.com'
const REPO = 'https://github.com/RickMcConney/FreazyKam2'

export interface DocSite {
  /** Source folder, relative to the repo root. */
  dir: string
  /** Where it is served, e.g. `/docs`. */
  base: string
  /** Title suffix and description noun: "— FreazyKam guide". */
  name: string
  /** Heading over the sidebar's first group. */
  tocTitle: string
  /** Walk sub-folders for pages. The guide keeps contributor notes in `images/README.md`. */
  recursive: boolean
  /** Sidebar groups, by first path segment. Pages outside every group go under tocTitle. */
  sections?: { dir: string; title: string }[]
  /**
   * Short, heavily cross-linked pages (the help site). The sidebar shows search, the
   * sections, and only the CURRENT section's pages — folded into the README's own
   * sub-groups — instead of every page; and a breadcrumb above the title says where
   * you are.
   */
  compact?: boolean
}

export const GUIDE: DocSite = {
  dir: 'docs', base: '/docs', name: 'guide', tocTitle: 'User guide', recursive: false,
}

export const HELP: DocSite = {
  dir: 'help', base: '/help', name: 'help', tocTitle: 'Help', recursive: true, compact: true,
  sections: [
    { dir: 'tutorials', title: 'Tutorials' },
    { dir: 'how-to', title: 'How-to guides' },
    { dir: 'reference', title: 'Reference' },
    { dir: 'explanation', title: 'Explanations' },
  ],
}

export const SITES: DocSite[] = [GUIDE, HELP]

export interface DocPage {
  /** Source path within the site folder, e.g. `how-to/drill-holes.md`. */
  src: string
  /** Published path within the site, e.g. `how-to/drill-holes.html` (README → `index.html`). */
  out: string
  /** Sidebar group: the first path segment, or '' for a top-level page. */
  section: string
  /**
   * Sub-group within the section: the bold line (`**Set up**`) the README lists this page
   * under, or '' when it is listed under none.
   */
  group: string
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
    .replace(/ /g, '-')
}

/** `README.md` → `index.html`, anything else `.md` → `.html`. Keeps any leading path. */
const toOut = (path: string): string =>
  /(^|\/)README\.md$/.test(path) ? path.replace(/README\.md$/, 'index.html') : path.replace(/\.md$/, '.html')

/** Strip inline tags so a heading can be slugged and indexed as plain text. */
const textOf = (html: string): string =>
  html.replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .trim()

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const isAbsolute = (url: string): boolean => /^(https?:|mailto:|data:|#|\/)/.test(url)

/** Every markdown file in the site, as posix paths relative to its folder. */
function markdownFiles(dir: string, recursive: boolean): string[] {
  const found: string[] = []
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name.startsWith('.')) continue
      const abs = join(d, name)
      if (statSync(abs).isDirectory()) {
        // images/ holds screenshots and the guide's capture notes, never a page.
        if (recursive && name !== 'images') walk(abs)
        continue
      }
      if (name.endsWith('.md')) found.push(relative(dir, abs).split('\\').join('/'))
    }
  }
  walk(dir)
  return found
}

/** Collect a site's pages: README first, then in the order the README links them. */
export function collectPages(root: string, site: DocSite): DocPage[] {
  const dir = join(root, site.dir)
  const files = markdownFiles(dir, site.recursive)
  const readme = files.includes('README.md') ? readFileSync(join(dir, 'README.md'), 'utf-8') : ''
  // Walked line by line so each page also picks up the bold sub-group label it sits under
  // (`**Set up**` in the help README). A heading ends the current sub-group.
  const linked: string[] = []
  const groupOf = new Map<string, string>()
  let group = ''
  for (const line of readme.split('\n')) {
    if (/^#{1,6}\s/.test(line)) { group = ''; continue }
    const bold = /^\*\*([^*]+)\*\*\s*$/.exec(line.trim())
    if (bold) { group = bold[1].trim(); continue }
    for (const [, url] of line.matchAll(/\]\(([^)\s#]+\.md)(?:#[^)\s]*)?\)/g)) {
      const p = posix.normalize(url)
      if (files.includes(p) && p !== 'README.md' && !linked.includes(p)) {
        linked.push(p)
        groupOf.set(p, group)
      }
    }
  }
  const ordered = [
    ...files.filter((f) => f === 'README.md'),
    ...linked,
    ...files.filter((f) => f !== 'README.md' && !linked.includes(f)).sort(),
  ]
  return ordered.map((src) => {
    const markdown = readFileSync(join(dir, src), 'utf-8')
    const h1 = /^#\s+(.+)$/m.exec(markdown)
    const title = h1 ? h1[1].trim() : src.replace(/\.md$/, '')
    return {
      src,
      out: toOut(src),
      section: src.includes('/') ? src.split('/')[0] : '',
      group: groupOf.get(src) ?? '',
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
 * a contributor note rather than a page — the guide's `images/README.md` is the
 * screenshot-capture rules — so it goes to the file on GitHub instead.
 */
function renderBody(page: DocPage, published: Set<string>, site: DocSite): Rendered {
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

  const pageDir = posix.dirname(page.src)
  html = html.replace(/(href|src)="([^"]+)"/g, (m, attr: string, url: string) => {
    if (attr === 'src') return m
    // The guide's own launch link pointed at GitHub Pages; the app lives here now.
    if (url.startsWith('https://rickmcconney.github.io/FreazyKam2')) return `${attr}="/app/"`
    if (isAbsolute(url)) return m
    const [target, hash] = url.split('#')
    if (!target.endsWith('.md')) return m   // .fkam downloads and images pass through
    const resolved = posix.normalize(posix.join(pageDir, target))
    // The guide's `../README.md` is the repo's feature list — the landing page says the same thing.
    if (resolved === '../README.md') return `${attr}="/"`
    const repoPath = posix.join(site.dir, resolved)
    // A page of the OTHER doc site (help → `../docs/05-pockets.md`) goes to where that site
    // publishes it, so the same link works on GitHub and here.
    const other = SITES.find((x) => x !== site && repoPath.startsWith(`${x.dir}/`))
    if (other) return `${attr}="${other.base}/${toOut(repoPath.slice(other.dir.length + 1))}${hash ? `#${hash}` : ''}"`
    if (resolved.startsWith('../') || !published.has(toOut(resolved))) {
      return `${attr}="${REPO}/blob/main/${repoPath}"`
    }
    return `${attr}="${toOut(target)}${hash ? `#${hash}` : ''}"`
  })

  // Every screenshot is below the fold of its own page.
  html = html.replace(/<img /g, '<img loading="lazy" decoding="async" ')

  return { html, headings }
}

/**
 * Fail the build on an internal link that goes nowhere: a page, a section, or a file
 * (screenshot, sample project) that is not on disk.
 *
 * Worth the strictness: these links are written by hand in markdown, GitHub happily
 * renders a dead one, and the only other way to find it is for a reader to click it.
 */
function linkAudit(root: string, site: DocSite, pages: DocPage[], rendered: Map<string, Rendered>): void {
  const anchors = new Map<string, Set<string>>()
  for (const p of pages) anchors.set(p.out, new Set(rendered.get(p.out)!.headings.map((h) => h.id)))

  const broken: string[] = []
  for (const p of pages) {
    const html = rendered.get(p.out)!.html
    for (const [, attr, url] of html.matchAll(/(href|src)="([^"]+)"/g)) {
      if (isAbsolute(url) && !url.startsWith('#')) continue
      const [target, hash] = url.split('#')
      const file = target === '' ? p.out : posix.normalize(posix.join(posix.dirname(p.out), target))
      if (file.endsWith('.html')) {
        if (!anchors.has(file)) { broken.push(`${p.src} → ${url} (no such page)`); continue }
        if (hash && !anchors.get(file)!.has(hash)) broken.push(`${p.src} → ${url} (no such section)`)
      } else if (!existsSync(join(root, site.dir, posix.dirname(p.src), decodeURIComponent(target)))) {
        broken.push(`${p.src} → ${url} (no such ${attr === 'src' ? 'image' : 'file'})`)
      }
    }
  }
  if (broken.length) {
    throw new Error(`[${site.dir}] broken links:\n  ${broken.join('\n  ')}`)
  }
}

/** One entry per heading, so search can land a reader on the right section. */
function buildSearchIndex(site: DocSite, pages: DocPage[], rendered: Map<string, Rendered>): string {
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
        // Absolute: a help page in how-to/ and one at the top share the same index.
        u: `${site.base}/${page.out}${h.depth > 1 ? `#${h.id}` : ''}`,
        p: page.navTitle,
        t: h.text,
        b: body.trim().slice(0, 320),
      })
    }
  }
  return JSON.stringify(entries)
}

function sidebar(site: DocSite, pages: DocPage[], current: string): string {
  if (site.compact) return compactSidebar(site, pages, current)
  const list = (group: DocPage[]) => {
    const items = group.map((p) => {
      const here = p.out === current
      return `<li><a href="${site.base}/${p.out}"${here ? ' aria-current="page"' : ''}>${escapeHtml(p.navTitle)}</a></li>`
    }).join('\n          ')
    return `<ul class="toc">\n          ${items}\n        </ul>`
  }
  const known = new Set((site.sections ?? []).map((s) => s.dir))
  const top = pages.filter((p) => !known.has(p.section))
  const groups = [`<p class="toc-title">${escapeHtml(site.tocTitle)}</p>\n        ${list(top)}`]
  for (const s of site.sections ?? []) {
    const group = pages.filter((p) => p.section === s.dir)
    if (group.length) groups.push(`<p class="toc-title">${escapeHtml(s.title)}</p>\n        ${list(group)}`)
  }
  return groups.join('\n        ')
}

/**
 * The help site's sidebar: home, then the four sections. Only the section holding the
 * current page is open; the others are one link each, to their part of the home page.
 * An open section with sub-groups folds them into <details>, the current one open — no
 * script needed, and on a phone the Contents button reveals a short list, not eighty.
 */
function compactSidebar(site: DocSite, pages: DocPage[], current: string): string {
  const here = pages.find((p) => p.out === current)
  const link = (p: DocPage) =>
    `<li><a href="${site.base}/${p.out}"${p.out === current ? ' aria-current="page"' : ''}>${escapeHtml(p.navTitle)}</a></li>`
  const known = new Set((site.sections ?? []).map((s) => s.dir))
  const top = pages.filter((p) => !known.has(p.section))
  const parts = [
    `<p class="toc-title">${escapeHtml(site.tocTitle)}</p>`,
    `<ul class="toc">${top.map(link).join('')}</ul>`,
    `<ul class="toc toc-sections">`,
  ]
  for (const s of site.sections ?? []) {
    const inSection = pages.filter((p) => p.section === s.dir)
    if (!inSection.length) continue
    if (here?.section !== s.dir) {
      parts.push(`<li><a class="toc-section" href="${site.base}/#${slug(s.title)}">${escapeHtml(s.title)}</a></li>`)
      continue
    }
    const groups = [...new Set(inSection.map((p) => p.group))]
    let body: string
    if (groups.length <= 1) {
      body = `<ul class="toc">${inSection.map(link).join('')}</ul>`
    } else {
      body = groups.map((g) => {
        const members = inSection.filter((p) => p.group === g)
        const open = members.some((p) => p.out === current) ? ' open' : ''
        return `<details class="toc-group"${open}><summary>${escapeHtml(g || 'More')}</summary><ul class="toc">${members.map(link).join('')}</ul></details>`
      }).join('')
    }
    parts.push(`<li class="toc-open"><a class="toc-section" href="${site.base}/#${slug(s.title)}">${escapeHtml(s.title)}</a>${body}</li>`)
  }
  parts.push('</ul>')
  return parts.join('\n        ')
}

/** "Help › How-to guides" above the title, for a page inside a section. */
function breadcrumb(site: DocSite, page: DocPage): string {
  const s = site.sections?.find((x) => x.dir === page.section)
  if (!site.compact || !s) return ''
  return `<nav class="crumbs" aria-label="Breadcrumb"><a href="${site.base}/">${escapeHtml(site.tocTitle)}</a><span aria-hidden="true">›</span><a href="${site.base}/#${slug(s.title)}">${escapeHtml(s.title)}</a></nav>`
}

function pageHtml(site: DocSite, page: DocPage, pages: DocPage[], rendered: Map<string, Rendered>): string {
  const r = rendered.get(page.out)!
  const i = pages.findIndex((p) => p.out === page.out)
  const prev = i > 0 ? pages[i - 1] : null
  const next = i >= 0 && i < pages.length - 1 ? pages[i + 1] : null
  const isIndex = page.out === 'index.html'
  const canonical = `${SITE}${site.base}/${isIndex ? '' : page.out}`
  const fullTitle = `${escapeHtml(page.title)} — FreazyKam ${site.name}`

  const pager = (prev || next)
    ? `<nav class="pager">
        ${prev ? `<a class="pager-prev" href="${site.base}/${prev.out}"><span>Previous</span>${escapeHtml(prev.navTitle)}</a>` : '<span></span>'}
        ${next ? `<a class="pager-next" href="${site.base}/${next.out}"><span>Next</span>${escapeHtml(next.navTitle)}</a>` : '<span></span>'}
      </nav>`
    : ''

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" href="/favicon.ico" sizes="32x32" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <title>${fullTitle}</title>
    <meta name="description" content="${escapeHtml(page.title)} — from the FreazyKam ${site.name}. Browser-based CNC CAM for makers and woodworkers." />
    <link rel="canonical" href="${canonical}" />
    <meta name="theme-color" content="#0a0a0a" media="(prefers-color-scheme: dark)" />
    <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="FreazyKam" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:title" content="${fullTitle}" />
    <meta property="og:image" content="${SITE}/og-card.png" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="stylesheet" href="/site.css" />
    <link rel="stylesheet" href="/docs.css" />
  </head>
  <body data-search-index="${site.base}/search-index.json">
    <header class="site-head">
      <div class="wrap">
        <a class="brand" href="/">
          <svg width="20" height="24" viewBox="0 0 100 122" aria-hidden="true">
            <rect y="56.5" width="100" height="65.5" fill="#b45309" />
            <path d="M46.8 64C45 71 30 71 27.5 79 25 87 40 90 58 96 74 101 88 110 97 124" fill="none" stroke="var(--bg)" stroke-width="9" stroke-linecap="round" />
            <rect x="27.3" width="39" height="16.6" rx="1.2" fill="currentColor" />
            <rect x="31.2" y="19.8" width="31.2" height="7.1" rx=".8" fill="currentColor" />
            <path d="M34.4 30H59.3V51.5L46.8 66 34.4 51.5Z" fill="currentColor" />
          </svg>
          FreazyKam
        </a>
        <nav class="site-nav">
          <a href="/help/" class="nav-hide-sm">Help</a>
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
          <label class="sr-only" for="docs-search">Search the ${site.name}</label>
          <input id="docs-search" type="search" placeholder="Search the ${site.name}…" autocomplete="off" />
        </form>
        <div class="search-results" id="search-results" hidden></div>
        ${sidebar(site, pages, page.out)}
      </aside>

      <main class="docs-main">
        ${breadcrumb(site, page)}
        <article class="prose">
${r.html}
        </article>
        ${pager}
      </main>

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

/** Everything a site is made of, keyed by its path under the site's base. */
export function buildDocs(root: string, site: DocSite = GUIDE): Map<string, string> {
  const pages = collectPages(root, site)
  const rendered = new Map<string, Rendered>()
  const published = new Set(pages.map((p) => p.out))
  for (const p of pages) rendered.set(p.out, renderBody(p, published, site))
  linkAudit(root, site, pages, rendered)

  const out = new Map<string, string>()
  for (const p of pages) out.set(p.out, pageHtml(site, p, pages, rendered))
  out.set('search-index.json', buildSearchIndex(site, pages, rendered))
  return out
}

/** Images and the sample project, copied beside the pages that link to them. */
function docAssets(root: string, site: DocSite): { path: string; abs: string }[] {
  const dir = join(root, site.dir)
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

    // `npm run dev` serves /docs/ and /help/ too, re-rendered on every request so an edit
    // to a markdown file shows up on reload without restarting the server.
    configureServer(server) {
      server.middlewares.use((req, res, nextFn) => {
        const url = (req.url ?? '').split('?')[0]
        const site = SITES.find((s) => url === s.base || url.startsWith(`${s.base}/`))
        if (!site) return nextFn()
        // `/help` without its slash would resolve the index page's relative links
        // against `/`. GitHub Pages redirects this itself; the dev server has to be told.
        if (url === site.base) { res.statusCode = 301; res.setHeader('Location', `${site.base}/`); res.end(); return }
        let rel = url.slice(site.base.length).replace(/^\//, '')
        if (rel === '' || rel.endsWith('/')) rel += 'index.html'
        try {
          if (rel.endsWith('.html') || rel.endsWith('.json')) {
            const files = buildDocs(root, site)
            const body = files.get(rel)
            if (body === undefined) return nextFn()
            res.setHeader('Content-Type', rel.endsWith('.json') ? 'application/json' : 'text/html')
            res.end(body)
            return
          }
          const asset = docAssets(root, site).find((a) => a.path === decodeURIComponent(rel))
          if (!asset) return nextFn()
          if (rel.endsWith('.svg')) res.setHeader('Content-Type', 'image/svg+xml')
          res.end(readFileSync(asset.abs))
        } catch (err) {
          res.statusCode = 500
          res.end(`<pre>${escapeHtml(String(err))}</pre>`)
        }
      })
    },

    generateBundle() {
      for (const site of SITES) {
        const dir = site.base.replace(/^\//, '')
        for (const [name, source] of buildDocs(root, site)) {
          this.emitFile({ type: 'asset', fileName: `${dir}/${name}`, source })
        }
        for (const asset of docAssets(root, site)) {
          this.emitFile({ type: 'asset', fileName: `${dir}/${asset.path}`, source: readFileSync(asset.abs) })
        }
      }
    },
  }
}
