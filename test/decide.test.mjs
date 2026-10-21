#!/usr/bin/env node
// Unit tests for the decision model (src/decide.ts) against a throwaway STAM_HOME and a
// stubbed HTTP server (STAM_OPENROUTER_URL), no live daemon, no network. Check the request
// and the answer shapes (noul, choice, score), the usage row under the openrouter-system account
// attributed to stam with the purpose, the event, and that a failure returns null.
// Run with `node --test test/decide.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-decide-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `decide-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'OPENROUTER_API_KEY']) delete process.env[k];
writeFileSync(join(home, 'opencode.env'), 'OPENROUTER_API_KEY=test-key\n');
writeFileSync(join(home, 'settings.json'), JSON.stringify({ decisions: { model: 'test/decision-model', mailCheck: true } }));

// The stub stands in for openrouter.ai/api/alpha/decisions: it echoes fixed answers of each
// type and records the requests, so a test can assert what decide sent.
const state = { status: 200, answers: true, cost: 0.0000017 };
const requests = [];
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    if (state.status !== 200) return res.writeHead(state.status).end('{}');
    if (!state.answers) return res.writeHead(200).end('{"model":"x"}');
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        model: 'test/decision-model-20260101',
        answers: {
          yes: { type: 'noul', noul: 0.83 },
          pick: { type: 'choice', choice: 'prime', probabilities: { prime: 0.99, composite: 0.01 }, confidence: 0.98 },
          rate: { type: 'score', score: 0.53, legend: { 0: 'correctness', 1: 'clarity' }, probabilities: { 0: 0.47, 1: 0.53 }, confidence: 0.06 },
        },
        usage: { input_tokens: 41, output_tokens: 2, cost: state.cost },
        id: 'gen-dec-test',
        provider: 'Azure',
      }),
    );
  });
});

let db, decide;
const usageRow = () => db.open().prepare("SELECT * FROM usage WHERE agent_id = 'stam'").get();
const events = (type) => db.open().prepare('SELECT data FROM events WHERE agent_id = ? AND type = ?').all('stam', type).map((r) => JSON.parse(r.data));

before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.STAM_OPENROUTER_URL = `http://127.0.0.1:${server.address().port}`;
  db = await import('../src/db.ts');
  decide = await import('../src/decide.ts');
  db.open();
});
after(() => { server.close(); rmSync(home, { recursive: true, force: true }); });

test('decide > sends the model, state, and questions, and returns the answers', async () => {
  requests.length = 0;
  const questions = {
    yes: { type: 'noul', instructions: 'Is it so?' },
    pick: { type: 'choice', instructions: 'Which?', criteria: { prime: 'a prime', composite: 'a composite' } },
    rate: { type: 'score', instructions: 'Rate it', criteria: ['correctness', 'clarity'] },
  };
  const r = await decide.decide('The number 7 is prime.', questions, { purpose: 'decide:test' });
  assert.equal(r?.model, 'test/decision-model-20260101');
  assert.equal(r?.answers.yes.noul, 0.83);
  assert.equal(r?.answers.pick.choice, 'prime');
  assert.equal(r?.answers.rate.score, 0.53);
  assert.equal(decide.noul(r, 'yes'), 0.83);
  assert.equal(decide.noul(r, 'missing'), null);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/decisions');
  assert.equal(requests[0].auth, 'Bearer test-key');
  assert.deepEqual(requests[0].body, { model: 'test/decision-model', state: 'The number 7 is prime.', questions });
});

test('decide > records the cost under the openrouter-system account for stam, with the purpose', async () => {
  db.open().prepare("DELETE FROM usage WHERE agent_id = 'stam'").run();
  const r = await decide.decide('state', { yes: { type: 'noul', instructions: '?' } }, { purpose: 'decide:mail-check' });
  assert.ok(r);
  const row = usageRow();
  assert.equal(row.agent_id, 'stam');
  assert.equal(row.account, 'openrouter-system');
  assert.equal(row.harness, 'openrouter');
  assert.equal(row.model, 'decide:mail-check');
  assert.ok(Math.abs(row.cost_usd - 0.0000017) < 1e-9, `cost ${row.cost_usd}`);
  assert.equal(row.tokens_in, 41);
  assert.equal(row.tokens_out, 2);
  const day = new Date().toISOString().slice(0, 10);
  assert.equal(row.day, day);
  // The Usage page reads these queries (src/usage.ts summary).
  const byAgent = db.open().prepare("SELECT agent_id, SUM(cost_usd) AS c FROM usage GROUP BY agent_id").all();
  assert.ok(byAgent.some((x) => x.agent_id === 'stam' && x.c > 0));
  const byModel = db.open().prepare("SELECT harness, model FROM usage WHERE agent_id = 'stam'").get();
  assert.deepEqual([byModel.harness, byModel.model], ['openrouter', 'decide:mail-check']);
});

test('decide > logs a decide event with the purpose', async () => {
  const found = events('decide').filter((e) => e.purpose === 'decide:mail-check');
  assert.ok(found.length >= 1);
  assert.equal(found[0].model, 'test/decision-model-20260101');
});

test('decide > an HTTP error returns null and logs decide:error, never throwing', async () => {
  state.status = 500;
  const before = events('decide:error').length;
  const r = await decide.decide('state', { yes: { type: 'noul', instructions: '?' } }, { purpose: 'decide:test' });
  assert.equal(r, null);
  const errs = events('decide:error');
  assert.equal(errs.length, before + 1);
  assert.equal(errs.at(-1).purpose, 'decide:test');
  assert.match(errs.at(-1).error, /500/);
  state.status = 200;
});

test('decide > a body without answers returns null', async () => {
  state.answers = false;
  const r = await decide.decide('state', { yes: { type: 'noul', instructions: '?' } }, { purpose: 'decide:test' });
  assert.equal(r, null);
  assert.match(events('decide:error').at(-1).error, /no answers/);
  state.answers = true;
});

test('decide > no key, no call', async () => {
  const key = join(home, 'opencode.env');
  const saved = 'OPENROUTER_API_KEY=test-key\n';
  rmSync(key);
  // The key was imported into the secret store (S-2114): no key means neither file.
  rmSync(join(home, 'secrets.json'), { force: true });
  requests.length = 0;
  const r = await decide.decide('state', { yes: { type: 'noul', instructions: '?' } }, { purpose: 'decide:test' });
  assert.equal(r, null);
  assert.equal(requests.length, 0);
  writeFileSync(key, saved);
});

test('decide > the By model view splits stam spend by purpose, for period, today, and lifetime', async () => {
  // Two purposes on one day share one usage row (model = last purpose); By model must still
  // show each purpose's own spend and tokens (S-272), read from the decide events.
  db.open().prepare("DELETE FROM usage WHERE agent_id = 'stam'").run();
  const q = { yes: { type: 'noul', instructions: '?' } };
  state.cost = 0.01;
  await decide.decide('state', q, { purpose: 'decide:alpha' });
  state.cost = 0.02;
  await decide.decide('state', q, { purpose: 'decide:alpha' });
  state.cost = 0.005;
  await decide.decide('state', q, { purpose: 'decide:beta' });
  state.cost = 0.0000017;
  // An older event for alpha, three days back: in period and lifetime, not today.
  const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
  db.open().prepare("INSERT INTO events (agent_id, ts, type, data) VALUES ('stam', ?, 'decide', ?)")
    .run(old, JSON.stringify({ purpose: 'decide:alpha', model: 'x', cost: 0.5, tokens_in: 100, tokens_out: 10 }));
  const usage = await import('../src/usage.ts');
  const byModel = usage.summary(14).by_model;
  const alpha = byModel.find((m) => m.harness === 'openrouter' && m.model === 'decide:alpha');
  const beta = byModel.find((m) => m.harness === 'openrouter' && m.model === 'decide:beta');
  // Period: 0.01 + 0.02 + 0.5 = 0.53; tokens 41+41+100 and 2+2+10 out.
  assert.equal(alpha?.cost_usd, 0.53);
  assert.equal(alpha?.tokens_in, 182);
  assert.equal(alpha?.tokens_out, 14);
  // Today: only the two calls made now.
  assert.equal(alpha?.today.cost_usd, 0.03);
  assert.equal(alpha?.today.tokens_in, 82);
  // Lifetime matches the period here (no older alpha events in this home).
  assert.equal(alpha?.lifetime.cost_usd, 0.53);
  assert.equal(alpha?.lifetime.tokens_in, 182);
  assert.equal(beta?.cost_usd, 0.005);
  assert.equal(beta?.today.cost_usd, 0.005);
  assert.equal(beta?.lifetime.cost_usd, 0.005);
});

test('decide > By model totals per purpose over many decide events, through the index (S-272)', async (t) => {
  // The activity classifier adds a decide event per call, so the split is one SQL aggregate
  // over the events_agent_type index, not a scan of every event. Seed 20k events.
  const d = db.open();
  const ins = d.prepare("INSERT INTO events (agent_id, ts, type, data) VALUES ('stam', ?, 'decide', ?)");
  const base = Date.now();
  d.exec('BEGIN');
  for (let i = 0; i < 20_000; i++) {
    const ts = new Date(base - (i % 14) * 86_400_000).toISOString();
    ins.run(ts, JSON.stringify({ purpose: `decide:bulk-${i % 3}`, model: 'x', cost: 0.0001, tokens_in: 10, tokens_out: 1 }));
  }
  d.exec('COMMIT');
  const usage = await import('../src/usage.ts');
  const t0 = performance.now();
  const byModel = usage.summary(14).by_model;
  t.diagnostic(`summary() took ${(performance.now() - t0).toFixed(1)} ms`);
  // Exact totals per purpose: bulk-0 and bulk-1 get 6667 events, bulk-2 gets 6666.
  const expect = { 'decide:bulk-0': 6667, 'decide:bulk-1': 6667, 'decide:bulk-2': 6666 };
  for (const [purpose, n] of Object.entries(expect)) {
    const row = byModel.find((m) => m.harness === 'openrouter' && m.model === purpose);
    assert.ok(row, purpose);
    assert.equal(row.cost_usd, Math.round(n * 0.0001 * 1e4) / 1e4, `${purpose} period cost`);
    assert.equal(row.tokens_in, n * 10, `${purpose} period tokens_in`);
    assert.equal(row.tokens_out, n, `${purpose} period tokens_out`);
    assert.ok(Math.abs(row.lifetime.cost_usd - n * 0.0001) < 1e-6, `${purpose} lifetime cost`);
    assert.equal(row.lifetime.tokens_in, n * 10, `${purpose} lifetime tokens_in`);
    assert.equal(row.lifetime.tokens_out, n, `${purpose} lifetime tokens_out`);
  }
  // The aggregate runs through the events_agent_type index, not a scan of all events.
  const plan = d.prepare(`EXPLAIN QUERY PLAN ${usage.DECIDE_DAY_SQL}`).all().map((r) => r.detail).join('\n');
  t.diagnostic(plan);
  assert.match(plan, /USING INDEX events_agent_type/);
  assert.doesNotMatch(plan, /SCAN events(?! USING INDEX)/);
});
