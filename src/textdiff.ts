// A unified diff of two texts by lines, for showing a change before it is made (S-362). Line-based
// LCS with `context` unchanged lines around each change; the settings file is small enough for it.
export function unifiedDiff(a: string, b: string, labelA = 'current', labelB = 'proposed', context = 3): string {
  const x = a.split('\n');
  const y = b.split('\n');
  if (x.at(-1) === '') x.pop();
  if (y.at(-1) === '') y.pop();
  const n = x.length;
  const m = y.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  type Op = { t: ' ' | '-' | '+'; s: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) ops.push({ t: ' ', s: x[i++] }), j++;
    else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) ops.push({ t: '+', s: y[j++] });
    else ops.push({ t: '-', s: x[i++] });
  }
  const changed = ops.map((o, k) => (o.t === ' ' ? -1 : k)).filter((k) => k >= 0);
  if (!changed.length) return '';
  // Hunks: ranges of ops within `context` of a change, merged when they touch.
  const hunks: [number, number][] = [];
  for (const k of changed) {
    const lo = Math.max(0, k - context);
    const hi = Math.min(ops.length, k + context + 1);
    if (hunks.length && lo <= hunks[hunks.length - 1][1]) hunks[hunks.length - 1][1] = hi;
    else hunks.push([lo, hi]);
  }
  const out = [`--- ${labelA}`, `+++ ${labelB}`];
  for (const [lo, hi] of hunks) {
    const before = ops.slice(0, lo);
    const startA = before.filter((o) => o.t !== '+').length + 1;
    const startB = before.filter((o) => o.t !== '-').length + 1;
    const seg = ops.slice(lo, hi);
    out.push(`@@ -${startA},${seg.filter((o) => o.t !== '+').length} +${startB},${seg.filter((o) => o.t !== '-').length} @@`);
    for (const o of seg) out.push(o.t + o.s);
  }
  return out.join('\n');
}
