// Documentation-page behaviour: search over the generated index, and the contents
// drawer on narrow screens. Plain script at a stable URL — the pages are written out
// by build/docsPlugin.ts, outside Vite's module graph, so they cannot import one.

(function () {
  'use strict'

  // ── Contents drawer (narrow screens only) ─────────────────────────────────
  var toggle = document.querySelector('.toc-toggle')
  var side = document.getElementById('docs-side')
  if (toggle && side) {
    // The drawer is only ever collapsed under the media query that reveals its button;
    // above that width the sidebar is a column and must stay visible, so the hidden
    // attribute is cleared when the viewport grows back.
    var narrow = window.matchMedia('(max-width: 760px)')
    var sync = function () {
      if (narrow.matches) {
        side.hidden = toggle.getAttribute('aria-expanded') !== 'true'
      } else {
        side.hidden = false
      }
    }
    toggle.addEventListener('click', function () {
      toggle.setAttribute('aria-expanded', toggle.getAttribute('aria-expanded') === 'true' ? 'false' : 'true')
      sync()
    })
    narrow.addEventListener('change', sync)
    sync()
  }

  // ── Search ────────────────────────────────────────────────────────────────
  var input = document.getElementById('docs-search')
  var results = document.getElementById('search-results')
  if (!input || !results) return

  var index = null
  var loading = null

  // Fetched on the first keystroke rather than on load: most readers never search,
  // and the index is a hundred-odd kilobytes they would otherwise pay for on arrival.
  function load() {
    if (index) return Promise.resolve(index)
    if (!loading) {
      loading = fetch('/docs/search-index.json')
        .then(function (r) { return r.json() })
        .then(function (data) { index = data; return index })
        .catch(function () { index = []; return index })
    }
    return loading
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    })
  }

  // Highlight each term where it appears, working on the ESCAPED string so a term
  // like "<" cannot reopen a tag.
  function mark(text, terms) {
    var out = escapeHtml(text)
    terms.forEach(function (t) {
      if (t.length < 2) return
      var re = new RegExp('(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi')
      out = out.replace(re, '<mark>$1</mark>')
    })
    return out
  }

  // Every term has to appear somewhere in the entry — heading, page name or body.
  // Title hits rank above body hits so "pocket" leads with the chapter about pockets.
  function score(entry, terms) {
    var title = entry.t.toLowerCase()
    var page = entry.p.toLowerCase()
    var body = entry.b.toLowerCase()
    var total = 0
    for (var i = 0; i < terms.length; i++) {
      var t = terms[i]
      var s = 0
      if (title.indexOf(t) === 0) s = 100
      else if (title.indexOf(t) >= 0) s = 60
      else if (page.indexOf(t) >= 0) s = 25
      else if (body.indexOf(t) >= 0) s = 10
      if (s === 0) return 0
      total += s
    }
    return total
  }

  function render(query) {
    var terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length === 0) { results.hidden = true; results.innerHTML = ''; return }

    var hits = []
    for (var i = 0; i < index.length; i++) {
      var s = score(index[i], terms)
      if (s > 0) hits.push({ e: index[i], s: s })
    }
    hits.sort(function (a, b) { return b.s - a.s })
    hits = hits.slice(0, 8)

    results.hidden = false
    if (hits.length === 0) {
      results.innerHTML = '<p class="search-empty">Nothing found for “' + escapeHtml(query) + '”.</p>'
      return
    }
    results.innerHTML = hits.map(function (h) {
      return '<a href="' + h.e.u + '">' +
        '<span class="r-page">' + escapeHtml(h.e.p) + '</span>' +
        '<span class="r-title">' + mark(h.e.t, terms) + '</span>' +
        (h.e.b ? '<span class="r-body">' + mark(h.e.b.slice(0, 150), terms) + '…</span>' : '') +
        '</a>'
    }).join('')
  }

  var timer = null
  input.addEventListener('input', function () {
    var q = input.value.trim()
    clearTimeout(timer)
    if (!q) { results.hidden = true; results.innerHTML = ''; return }
    timer = setTimeout(function () {
      load().then(function () { render(q) })
    }, 90)
  })

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { input.value = ''; results.hidden = true; results.innerHTML = '' }
    // Enter goes to the top hit, which is what a reader who typed and pressed Enter meant.
    if (e.key === 'Enter') {
      var first = results.querySelector('a')
      if (first) { e.preventDefault(); window.location.href = first.getAttribute('href') }
    }
  })

  // "/" focuses search from anywhere on the page, as long as you are not typing already.
  document.addEventListener('keydown', function (e) {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return
    var el = document.activeElement
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
    e.preventDefault()
    if (side && side.hidden && toggle) { toggle.click() }
    input.focus()
  })
})()
