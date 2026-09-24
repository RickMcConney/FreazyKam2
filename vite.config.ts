/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { execSync } from 'child_process'
import { docsPlugin } from './build/docsPlugin'

// The date shown in the status bar ("FreazyKam MM/DD/YYYY") is the date of the commit
// being built. It is read at build time rather than written into a source file: the
// old repo stamped src/version.ts from a local pre-commit hook, and hooks are not
// cloned, so the date froze the day the project moved. `git log` works in the Pages
// workflow's shallow checkout too (HEAD is always fetched). Outside a git checkout
// it falls back to today.
function commitDate(): string {
  try {
    return execSync('git log -1 --format=%cd --date=format:%m/%d/%Y', { encoding: 'utf-8' }).trim()
  } catch {
    const d = new Date()
    return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`
  }
}

// jspoly.js has require() calls guarded by DISABLE_REQUIRE=true (dead code).
// Rolldown resolves them statically at the native level before JS transforms run,
// so we intercept at the load hook and strip them before rolldown parses the file.
// Must be in both plugins[] and worker.plugins() since the worker bundle is separate.
const jspolyPlugin = {
  name: 'stub-jspoly-dead-requires',
  enforce: 'pre' as const,
  load(id: string) {
    if (!id.includes('jspoly.js') || id.includes('?')) return null
    const code = readFileSync(id, 'utf-8')
    return { code: code.replace(/require\(['"][^'"]+['"]\)/g, '({})') }
  },
}

// The CAM pipeline runs in a Web Worker (src/workers/worker.ts), which Vite bundles
// as a separate module graph. HMR on the main thread never reaches it, so editing
// src/cam/* would leave the worker running stale code until a manual full reload.
// Force a full reload whenever a worker-graph file changes so the worker restarts.
const reloadWorkerGraph = {
  name: 'full-reload-worker-graph',
  handleHotUpdate({ file, server }: { file: string; server: { ws: { send: (p: unknown) => void } } }) {
    if (/\/src\/(cam|workers)\//.test(file)) {
      server.ws.send({ type: 'full-reload' })
      return []
    }
  },
}

// The site is three things at one origin (freazykam.com):
//   /       the landing page   — index.html, plain HTML, no React
//   /app/   the CAM app        — app/index.html, the Vite/React entry
//   /docs/  the user guide     — rendered from docs/*.md by docsPlugin at build time
// `base` is '/' because a custom domain serves from the root; it was '/FreazyKam2/'
// while the only home was the project page at rickmcconney.github.io.
export default defineConfig({
  base: '/',
  define: {
    __BUILD_DATE__: JSON.stringify(commitDate()),
  },
  plugins: [react(), jspolyPlugin, reloadWorkerGraph, docsPlugin()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // 'verbose' names every test as it passes; the default reporter collapses a
    // passing file to one line, which says nothing about what was checked.
    reporters: ['verbose'],
    coverage: {
      provider: 'v8',
      // text = table in the terminal, html = browsable report in coverage/.
      reporter: ['text', 'html'],
      // .tsx is deliberately out: tests are logic-only in a node environment
      // (no jsdom), so React/Konva components can never be covered and would
      // only drag the percentage down. Same for the worker entry and the
      // vendored jspoly.
      include: ['src/**/*.ts'],
      // A .tsx that a test happens to IMPORT is reported even though `include`
      // never picked it up, so it has to be excluded outright — otherwise the
      // 13 machine forms sit in the table at 0% and flatten the headline number.
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts', 'src/vite-env.d.ts', 'src/**/jspoly.js', 'src/**/*.tsx'],
    },
  },
  worker: {
    plugins: () => [jspolyPlugin],
  },
  build: {
    rollupOptions: {
      // Two HTML entries. The landing page is listed first so it is the site root.
      input: {
        landing: resolve(__dirname, 'index.html'),
        app: resolve(__dirname, 'app/index.html'),
      },
      output: {
        manualChunks(id: string) {
          if (id.includes('/react/') || id.includes('/react-dom/')) return 'react'
          if (id.includes('/konva/') || id.includes('/react-konva/')) return 'konva'
          if (id.includes('/three/')) return 'three'
        },
      },
    },
  },
})
