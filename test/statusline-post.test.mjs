#!/usr/bin/env node
// Unit test for S-2126: a Claude Code status-line POST must not stall the daemon's event loop.
// Checks the per-agent gate (an unchanged report is skipped, any other runs at once, nothing is
// held), that a cold 20 MB transcript is read in full by the first POST with exact persisted
// totals, and that 50 agents posting stay inside a time and query budget.
// The gate takes its clock as an argument, so no test waits on time. Throwaway STAM_HOME, no
// daemon, no model: `node --test test/statusline-post.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-sl-post-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `sl-post-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let db, usage, claude, gateMod, sessionTokens;
before(async () => {
  db = await import('../src/db.ts');
  usage = await import('../src/usage.ts');
  const mod = await import('../src/adapters/claude.ts');
  sessionTokens = mod.sessionTokens;
  claude = mod.claude;
  gateMod = await import('../src/statusline-gate.ts');
});
after(() => rmSync(home, { recursive: true, force: true }));

const PAD = 6000; // ~6 KB a row: a 20 MB file holds ~3,300 usage rows
// One assistant row with a usage block, padded so the file reaches a realistic size.
const row = (i, pad) =>
  JSON.stringify({ type: 'assistant', uuid: `u${i}`, message: { id: `msg_${i}`, usage: { input_tokens: 3, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 }, content: 'x'.repeat(pad) } }) + '\n';
function bigTranscript(path, bytes) {
  const rows = Math.ceil(bytes / (PAD + 250));
  const lines = [];
  for (let i = 0; i < rows; i++) lines.push(row(i, PAD));
  writeFileSync(path, lines.join(''));
  return rows;
}
let n = 0;
const newAgent = () => {
  const id = `sl${String(n++).padStart(3, '0')}`;
  return db.createAgent({ id, name: `sl-${id}`, role: 'test', machine: 'x', harness: 'claude', model: 'claude-haiku-5-5', effort: null, cwd: '/tmp', parent_id: null, session_id: null });
};
const payload = (file, cost, rate = 10) => ({
  transcript_path: file,
  context_window: { context_window_size: 200000, current_usage: { input_tokens: 5, cache_read_input_tokens: 1000 } },
  cost: { total_cost_usd: cost },
  rate_limits: { five_hour: { used_percentage: rate, resets_at: 4102444800 } },
});
// The daemon's processing of one report, as in src/daemon.ts.
function handle(a, body) {
  const f = claude.onStatusLine(a, body);
  if (f.context_tokens !== undefined || f.context_window !== undefined) db.updateAgent(a.id, { context_tokens: f.context_tokens, context_window: f.context_window });
  usage.reportStatusline(a, f);
}
const persisted = (id) => db.open().prepare('SELECT COALESCE(SUM(tokens_in),0) AS tin, COALESCE(SUM(tokens_cache_read),0) AS tcr, COALESCE(SUM(cost_usd),0) AS cost FROM usage WHERE agent_id = ?').get(id);

test('gate: skips only an identical report, runs every other at once, holds nothing', () => {
  const seen = [];
  const gate = gateMod.createStatuslineGate((slot, body) => void seen.push([slot, body.cost.total_cost_usd]));
  const p = (cost, file = '/t') => ({ transcript_path: file, cost: { total_cost_usd: cost }, context_window: { context_window_size: 1, current_usage: { input_tokens: 1 } } });
  assert.equal(gate.submit('a', p(1), 1000), true);
  assert.equal(gate.submit('a', p(1), 1500), false, 'unchanged inside 10 s is skipped');
  assert.equal(gate.submit('a', p(2), 1600), true, 'a change runs at once, even inside 2 s');
  assert.equal(gate.submit('a', p(3, '/other'), 1700), true, 'an X to Y session change runs at once');
  assert.equal(gate.submit('a', p(3, '/t'), 1800), true, 'and so does the change back');
  assert.equal(gate.submit('a', p(3, '/t'), 12_000), true, 'unchanged after 10 s runs again');
  assert.equal(gate.submit('b', p(9), 12_000), true, 'agents are independent');
  assert.deepEqual(seen, [['a', 1], ['a', 2], ['a', 3], ['a', 3], ['a', 3], ['b', 9]]);
});

test('gate: slots older than 10 s are swept, so archived agents leak nothing', () => {
  const gate = gateMod.createStatuslineGate(() => {});
  for (let i = 0; i < 100; i++) gate.submit(`agent${i}`, { transcript_path: `/t${i}` }, 2000);
  assert.equal(gate.size(), 100);
  gate.submit('z', { transcript_path: '/z' }, 30_000);
  assert.equal(gate.size(), 1);
});

test('two agents with different rate-limit readings each record their own reading', () => {
  const a = newAgent();
  const b = newAgent();
  const f1 = join(home, 'rl1.jsonl');
  writeFileSync(f1, row(0, 100));
  const gate = gateMod.createStatuslineGate((slot, body) => handle(db.getAgent(slot), body));
  gate.submit(a.id, payload(f1, 1, 10), 1000);
  gate.submit(b.id, payload(f1, 1, 30), 1001);
  const data = JSON.parse(db.open().prepare("SELECT data FROM subscriptions WHERE name = 'claude'").get().data);
  assert.equal(data.five_hour.used_percentage, 30, 'the latest processed reading is stored');
  assert.equal(gate.submit(b.id, payload(f1, 1, 30), 1500), false);
});

test('a session change X to Y restarts the token counters, and the totals persist exactly', () => {
  const a = newAgent();
  const x = join(home, 'x.jsonl');
  const y = join(home, 'y.jsonl');
  writeFileSync(x, row(0, 100) + row(1, 100));
  writeFileSync(y, row(0, 100));
  const gate = gateMod.createStatuslineGate((slot, body) => handle(db.getAgent(slot), body));
  gate.submit(a.id, payload(x, 1), 1000);
  gate.submit(a.id, payload(y, 1.5), 1100);
  assert.deepEqual({ tin: persisted(a.id).tin, tcr: persisted(a.id).tcr }, { tin: 9, tcr: 300 }, '2 rows of X plus 1 row of Y');
  assert.equal(persisted(a.id).cost, 1.5);
});

test('a 20 MB transcript is read in full by the first POST, and the persisted totals are exact', () => {
  const a = newAgent();
  const file = join(home, 'big.jsonl');
  const rows = bigTranscript(file, 20 << 20);
  const gate = gateMod.createStatuslineGate((slot, body) => handle(db.getAgent(slot), body));
  const s = performance.now();
  assert.equal(gate.submit(a.id, payload(file, 1), 1000), true);
  const cold = performance.now() - s;
  assert.deepEqual({ tin: persisted(a.id).tin, tcr: persisted(a.id).tcr }, { tin: 3 * rows, tcr: 100 * rows });
  assert.ok(cold < 500, `cold 20 MB POST ${cold} ms`);
  assert.equal(gate.submit(a.id, payload(file, 1), 1100), false, 'an identical report is skipped');
  // A small append is read inside the request.
  appendFileSync(file, row(rows, 100));
  assert.equal(sessionTokens(file).input, 3 * (rows + 1));
  appendFileSync(file, row(rows, 100)); // a repeated message id replaces its row
  assert.equal(sessionTokens(file).input, 3 * (rows + 1));
});

test('50 agents cold-loading 4 MB transcripts each (200 MB in all), then posting, stay inside a time and query budget', () => {
  const agents = [];
  const files = [];
  for (let i = 0; i < 50; i++) {
    agents.push(newAgent());
    files.push(join(home, `t${i}.jsonl`));
    bigTranscript(files[i], 4 << 20);
  }
  let queries = 0;
  const d = db.open();
  const realPrepare = d.prepare.bind(d);
  d.prepare = (sql) => (queries++, realPrepare(sql));
  const gate = gateMod.createStatuslineGate((slot, body) => handle(db.getAgent(slot), body));
  const processed = [];
  const all = [];
  let skipped = 0;
  // Round-robin, as concurrent agents post: one cold read each, then 20 identical repeats.
  for (let rep = 0; rep < 21; rep++) {
    for (let i = 0; i < 50; i++) {
      const s = performance.now();
      const ran = gate.submit(agents[i].id, payload(files[i], 1), 1000 + rep);
      const t = performance.now() - s;
      all.push(t);
      if (ran) processed.push(t);
      else skipped++;
    }
  }
  d.prepare = realPrepare;
  processed.sort((x, y) => x - y);
  const p95 = processed[Math.floor(processed.length * 0.95)];
  console.log(`# 1,050 posts: ${processed.length} processed, ${skipped} skipped, processed p95 ${p95.toFixed(2)} ms, max ${processed.at(-1).toFixed(1)} ms, ${queries} queries`);
  assert.equal(processed.length, 50, 'one cold request per agent runs; every repeat after is skipped');
  assert.ok(p95 < 20, `processed p95 ${p95} ms`);
  assert.ok(processed.at(-1) < 150, `slowest ${processed.at(-1)} ms`);
  assert.ok(queries < 50 * 12, `${queries} queries`);
  for (const a of agents) assert.equal(persisted(a.id).tin, 3 * Math.ceil((4 << 20) / (PAD + 250)));
});
