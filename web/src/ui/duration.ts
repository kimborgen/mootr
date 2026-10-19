// A CSS time in ms: '400ms', '.4s' or '0.4s'; 0 when it isn't one. The build's CSS minifier
// writes 400ms as .4s, so a bare parseFloat reads seconds as ms (S-703).
export function durationMs(css: string): number {
  const v = css.trim()
  const n = parseFloat(v) * (v.endsWith('ms') || !v.endsWith('s') ? 1 : 1000)
  return n > 0 ? n : 0
}
