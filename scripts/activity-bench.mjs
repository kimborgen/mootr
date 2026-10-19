#!/usr/bin/env node
// Times the activity stats on the realistic-scale fixture (S-1009, test/activity-fixture.mjs) in a
// throwaway STAM_HOME: never a live daemon. `node scripts/activity-bench.mjs [agents] [days]`.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from '../test/tmphome.mjs';

const home = tempHome('stam-activity-bench-');
process.env.STAM_HOME = home;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), JSON.stringify({ cost: { accounts: { claude: { match: { harness: 'claude' } }, codex: { match: { harness: 'codex' } }, openrouter: { match: { harness: 'opencode' }, paid: true } } } }));

const db = await import('../src/db.ts');
const { seedScale } = await import('../test/activity-fixture.mjs');
const stats = await import('../src/activity-stats.ts');
const nAgents = Number(process.argv[2] ?? 700);
const days = Number(process.argv[3] ?? 7);

let t = performance.now();
const f = seedScale(db, { agents: nAgents, days });
console.log(`seeded ${f.agents} agents, ${f.items} items, ${f.samples} usage samples, ${f.itsas} ITSAs in ${Math.round(performance.now() - t)} ms`);
// The Measure context the summary reads: worths from the last usage snapshot, never recomputed in a
// request (cachedWorth); the snapshot itself, which a stale memo refreshes in the background, timed apart.
const usage = await import('../src/usage.ts');
{
  usage.resetSnapshotMemo();
  let t0 = performance.now();
  stats.costCtx(f.now);
  const noMemo = performance.now() - t0;
  t0 = performance.now();
  usage.displayContext(f.now);
  const snapshot = performance.now() - t0;
  t0 = performance.now();
  const ctx = stats.costCtx(f.now);
  console.log(`costCtx: no memo ${noMemo.toFixed(1)} ms, with memo ${(performance.now() - t0).toFixed(1)} ms; the background snapshot refresh ${Math.round(snapshot)} ms; claude 7-day worth ${ctx.worth('claude', 'seven_day')}`);
}
const time = (label, fn) => {
  const t0 = performance.now();
  const r = fn();
  console.log(`${label.padEnd(28)} ${Math.round(performance.now() - t0)} ms`);
  return r;
};
for (const by of ['agent', 'itsa', 'model', 'type']) time(`activityStats by=${by}`, () => stats.activityStats({ by, days, now: f.now }));
const ic = await import('../src/issue-costs.ts');
time('issue-costs attributor()', () => ic.attributor());
time('issue-costs compute()', () => ic.compute({ days, now: f.now }));
const s = await import('../src/activity-summary.ts');
{
  for (const scope of [undefined, `tree:${f.roots[1]}`, 'agent:a0010', 'itsa:S-2']) {
    s.resetSummary();
    const t0 = performance.now();
    await s.activitySummary({ days, scope, now: f.now });
    const cold = performance.now() - t0;
    const t1 = performance.now();
    await s.activitySummary({ days, scope, now: f.now });
    const warm = performance.now() - t1;
    const m = s.summaryMetrics();
    console.log(`summary ${String(scope ?? 'all').padEnd(16)} cold ${Math.round(cold)} ms, warm (cached) ${Math.round(warm)} ms, merge ${m.last_merge_ms} ms, max slice ${m.max_slice_ms} ms at ${m.max_slice_at}`);
  }
}

// After one agent's items change: only that digest is rebuilt, from the change on (an ingest), or whole.
const { touched } = await import('../src/activity-changes.ts');
for (const [label, since] of [['the last 30 min', f.now - 1_800_000], ['whole', null]]) {
  touched(f.roots[0], since);
  const t2 = performance.now();
  await s.activitySummary({ days, now: f.now });
  const m = s.summaryMetrics();
  console.log(`after a touch of cos (${label}) ${Math.round(performance.now() - t2)} ms: refresh ${m.last_refresh_ms} ms, merge ${m.last_merge_ms} ms, rebuilt ${m.last_rebuilt}`);
}
const m = s.summaryMetrics();
console.log(`max synchronous slice over the run: ${m.max_slice_ms} ms at ${m.max_slice_at}`);
// The bounds the speed work promises (S-1009); a bench, not a gate, so a slow machine fails here only.
if (m.max_slice_ms >= 50) {
  console.error(`FAIL: the longest slice is ${m.max_slice_ms} ms (${m.max_slice_at}), over 50 ms`);
  process.exitCode = 1;
}
// What a peer reads of this daemon (S-1079, src/activity-wire.ts): the digests as pages. Per page, the time
// to build it (the longest slice the peer's loop is held for) and the bytes; then the reader's parse and import.
{
  const wire = await import('../src/activity-wire.ts');
  let after = '';
  let bytes = 0;
  let pages = 0;
  let digests = 0;
  let longestBuild = 0;
  let longestRead = 0;
  for (;;) {
    let t0 = performance.now();
    const page = await s.digestsPage({ days, since: -1, epoch: '', after, now: f.now });
    const build = performance.now() - t0;
    const text = JSON.stringify(page);
    t0 = performance.now();
    const back = JSON.parse(text);
    for (const w of back.digests) wire.digestFromWire(w, back.keys);
    const read = performance.now() - t0;
    bytes += text.length;
    pages++;
    digests += page.digests.length;
    longestBuild = Math.max(longestBuild, build);
    longestRead = Math.max(longestRead, read);
    if (!after) console.log(`peer first page: ${text.length} bytes; ids ${page.ids.length}, agents ${page.agents.length}, usage ${JSON.stringify(page.usage).length} bytes, ${page.digests.length} digests`);
    if (!page.next) break;
    after = page.next;
  }
  console.log(`peer digests: ${digests} digests in ${pages} pages, ${bytes} bytes (${Math.round(bytes / Math.max(1, digests))} per digest); longest page build ${longestBuild.toFixed(1)} ms, longest parse + import ${longestRead.toFixed(1)} ms`);
}
const out = await s.activitySummary({ days, now: f.now });
console.log(`answer ${JSON.stringify(out).length} bytes`);
if (process.env.BENCH_OUT) writeFileSync(process.env.BENCH_OUT, JSON.stringify(out, null, 1));
