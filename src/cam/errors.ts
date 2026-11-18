/**
 * The shape is too small (or too thin) for the tool to cut anything — as opposed to a
 * bad setting or a bug. Inlay runs several generators per half and treats this one as
 * "skip that sub-cut and say so" (cam/notes.ts); every other error still fails the op.
 *
 * It replaced a regex over the MESSAGE, which was brittle both ways: it matched
 * "Stepover too small" — a setting, which was then swallowed — and any rewording of a
 * real geometry message would have started failing inlays that used to generate.
 *
 * It crosses the worker pool by NAME (workerClient's errorFromWorker), which rebuilds it,
 * so `instanceof` holds on the main thread as well.
 */
export class GeometryTooSmallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GeometryTooSmallError'
  }
}
