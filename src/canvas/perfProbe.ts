// Dev-only canvas timing, reached from the console as `__fkam.perf` (debugHooks.ts).
//
// FOR COMPARISONS TAKEN BACK TO BACK, WITH DEVTOOLS CLOSED (src/canvas/CLAUDE.md): with
// the panel open the canvas stalls on garbage collection that has nothing to do with the
// drawing. Run a probe, close the panel, read the result afterwards from `__fkam.perf.last`.
//
//   await __fkam.perf.layers()        // what each layer, and each group of layer 0, costs to draw
//   await __fkam.perf.frames(5000)    // fps and draws per layer over a gesture or a sim playback
//
// A draw is timed through a one-pixel readback, which waits for the canvas to finish
// rasterising — `drawScene` alone measures command SUBMISSION, which can be a small
// fraction of the work.
import Konva from 'konva'

type Row = Record<string, string | number>

function stage(): Konva.Stage {
  const s = Konva.stages[0]
  if (!s) throw new Error('no Konva stage — is the 2D view showing?')
  return s
}

function nodeCount(n: Konva.Node): number {
  if (!(n instanceof Konva.Container)) return 1
  let k = 1
  for (const c of n.getChildren()) k += nodeCount(c)
  return k
}

/** Milliseconds to draw `layer` once, rasterising included (median of `runs`). */
function timeDraw(layer: Konva.Layer, runs: number): number {
  const ctx = layer.getNativeCanvasElement().getContext('2d')!
  const t: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    layer.draw()
    ctx.getImageData(0, 0, 1, 1)
    t.push(performance.now() - t0)
  }
  t.sort((a, b) => a - b)
  return +t[t.length >> 1].toFixed(2)
}

function label(n: Konva.Node, i: number): string {
  return n.name() || `#${i} ${n.getClassName()}`
}

export const perf = {
  last: null as unknown,

  /**
   * Each layer's whole draw, then what each top-level group of the CNC layer adds — found
   * by hiding it and timing again, so the rows are costs the user would actually get back.
   */
  async layers(runs = 9): Promise<Row[]> {
    const rows: Row[] = []
    const layers = stage().getLayers()
    layers.forEach((l, i) => rows.push({ what: `layer ${i}`, nodes: nodeCount(l), ms: timeDraw(l, runs) }))
    const cnc = layers[0]
    const whole = timeDraw(cnc, runs)
    cnc.getChildren().forEach((g, i) => {
      if (!g.visible()) return
      g.visible(false)
      const without = timeDraw(cnc, runs)
      g.visible(true)
      rows.push({ what: `  ${label(g, i)}`, nodes: nodeCount(g), ms: +(whole - without).toFixed(2) })
    })
    cnc.draw()
    console.table(rows)
    perf.last = rows
    return rows
  },

  /**
   * Frame rate over `ms` of whatever is happening — start a sim playback or a pan, then
   * call this — and how many times, and for how long, each layer drew in that time.
   */
  async frames(ms = 5000): Promise<Row> {
    const layers = stage().getLayers()
    const draws = layers.map(() => ({ n: 0, ms: 0 }))
    const originals = layers.map((l, i) => {
      const orig = l.drawScene
      l.drawScene = function (this: Konva.Layer, ...args: Parameters<typeof orig>) {
        const t0 = performance.now()
        const r = orig.apply(this, args)
        draws[i].n++
        draws[i].ms += performance.now() - t0
        return r
      } as typeof orig
      return orig
    })
    const gaps: number[] = []
    await new Promise<void>((done) => {
      const start = performance.now()
      let prev = start
      const tick = (now: number) => {
        gaps.push(now - prev)
        prev = now
        if (now - start < ms) requestAnimationFrame(tick)
        else done()
      }
      requestAnimationFrame(tick)
    })
    layers.forEach((l, i) => { l.drawScene = originals[i] })
    gaps.shift()
    const sorted = [...gaps].sort((a, b) => a - b)
    const row: Row = {
      fps: +(1000 * gaps.length / gaps.reduce((a, b) => a + b, 0)).toFixed(1),
      p50ms: +sorted[sorted.length >> 1].toFixed(1),
      p95ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(1),
      over50ms: gaps.filter((g) => g > 50).length,
    }
    draws.forEach((d, i) => {
      row[`layer${i} draws`] = d.n
      row[`layer${i} submit ms`] = +d.ms.toFixed(1)
    })
    console.table([row])
    perf.last = row
    return row
  },
}
