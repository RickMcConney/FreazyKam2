// Perf/debug logging gate (tofix.md H4). True in Vite dev builds and under the
// node script harnesses (where import.meta.env doesn't exist); statically false
// in the production bundle, so the logs are stripped by minification.
//
// NOT used by adaptiveClearing.ts / tileRaster.ts / clearedRaster.ts /
// sweptArea.ts — those are transpiled standalone by scripts/*.sh with
// --rootDir src/cam, so they must not import outside that directory.
export const DEBUG_PERF: boolean =
  typeof import.meta.env === 'undefined' || !!import.meta.env.DEV

export function perfLog(...args: unknown[]): void {
  if (DEBUG_PERF) console.log(...args)
}
