#!/usr/bin/env node
// Unit tests for prompt suggestions (S-1459): the recency and thread boosts, the agent source's
// text and queueing, the agent source ranking by meaning (archived below live), the decoded-vector
// cache's invalidation, and the query time at 20,000 stub vectors. Stub embedder only.
// Run with `node --test test/suggest.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmphome.mjs';

process.env.STAM_HOME = tempDir('stam-suggest-unit-');
process.env.STAM_EMBEDDER = 'stub';
const { stubVector, currentModel } = await import('../src/embed.ts');
const { nearest } = await import('../src/vectors.ts');
const db = await import('../src/db.ts');
const { agentText } = await import('../src/agent-vectors.ts');
const S = await import('../src/suggest.ts');
const { turnsOf } = await import('../src/turn-vectors.ts');

const put = (source, ref, text) => {
  const v = stubVector(text);
  db.putEmbedding({ source, ref, model: currentModel(), dim: v.length, vec: new Uint8Array(v.buffer), hash: ref });
};

test('a recent id gets a boost that decays with position, and none when absent', () => {
  const recent = ['a', 'b', 'c'];
  assert.equal(S.recentBoost(recent, 'a'), S.RECENT_BOOST);
  assert.ok(S.recentBoost(recent, 'b') < S.recentBoost(recent, 'a'));
  assert.ok(S.recentBoost(recent, 'c') < S.recentBoost(recent, 'b'));
  assert.equal(S.recentBoost(recent, 'z'), 0);
  assert.equal(S.recentBoost(recent, 'z', 'b'), S.recentBoost(recent, 'b'), 'an alternative id counts');
});

test('a thread boost is full now and halves every half life', () => {
  const now = Date.parse('2026-10-17T12:00:00Z');
  assert.ok(Math.abs(S.threadBoost(new Date(now).toISOString(), now) - S.THREAD_BOOST) < 1e-9);
  const old = new Date(now - S.THREAD_HALF_LIFE_DAYS * 86_400_000).toISOString();
  assert.ok(Math.abs(S.threadBoost(old, now) - S.THREAD_BOOST / 2) < 1e-9);
});

test('the agent text is name, role and brief, and an agent change queues its vector', () => {
  const text = agentText({ name: 'login-fix', role: 'developer', first_prompt: 'Repair the sign-in redirect loop' });
  assert.match(text, /login-fix/);
  assert.match(text, /sign-in redirect/);
  const seen = [];
  db.onAgentText((id) => seen.push(id));
  const mk = (id, name, role) => db.createAgent({ id, name, role, machine: 'test', harness: 'claude', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  mk('ag1', 'login-fix', 'repair the sign-in redirect loop');
  db.updateAgent('ag1', { role: 'repair the logout redirect' });
  db.updateAgent('ag1', { activity: 'working' });
  assert.deepEqual(seen, ['ag1', 'ag1'], 'created and role changed; an activity change is not a text change');
});

test('agents rank by meaning, and an archived agent ranks below a live one with the same text', async () => {
  const mk = (id, name, role, lifecycle) => {
    db.createAgent({ id, name, role, machine: 'test', harness: 'claude', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
    if (lifecycle) db.updateAgent(id, { lifecycle });
    put('agent', id, agentText(db.getAgent(id)));
  };
  mk('live', 'live-one', 'invoice reconciliation for september');
  mk('gone', 'gone-one', 'invoice reconciliation for september', 'archived');
  mk('other', 'other-one', 'dashboard colour palette');
  const out = await S.suggest('reconcile the september invoices', { limit: 8, recent: [], local: true, humanMail: false });
  assert.deepEqual(out.map((r) => r.id), ['live', 'gone'], JSON.stringify(out));
  assert.equal(out[0].kind, 'agent');
  assert.equal(out[0].by, 'meaning');
  const boosted = await S.suggest('reconcile the september invoices', { limit: 8, recent: ['gone'], local: true, humanMail: false });
  const gap = (r) => r.find((x) => x.id === 'live').score - r.find((x) => x.id === 'gone').score;
  assert.ok(gap(boosted) < gap(out), 'a recent id narrows the archive penalty');
  assert.deepEqual(await S.suggest('   ', { limit: 8, recent: [], local: true, humanMail: false }), []);
  assert.deepEqual(await S.suggest('zzqx unrelated gibberish', { limit: 8, recent: [], local: true, humanMail: false }), [], 'below the floor');
});

test('the vector cache follows puts and deletes', () => {
  put('cache', 'one', 'alpha beta');
  const q = stubVector('alpha beta');
  assert.deepEqual(nearest('cache', q, undefined, 5).map((n) => n.ref), ['one']);
  put('cache', 'two', 'alpha beta gamma');
  assert.deepEqual(nearest('cache', q, undefined, 5).map((n) => n.ref).sort(), ['one', 'two']);
  db.deleteEmbedding('cache', 'one');
  assert.deepEqual(nearest('cache', q, undefined, 5).map((n) => n.ref), ['two']);
  assert.deepEqual(nearest('cache', q, undefined, 5, 0.99).map((n) => n.ref), [], 'min drops lower scores');
});

test('a query over 20,000 cached vectors stays near the 20 ms budget', () => {
  const words = ['alpha', 'beta', 'gamma', 'delta', 'omega', 'sigma', 'kappa', 'theta', 'lambda', 'zeta'];
  db.transaction(() => {
    for (let i = 0; i < 20_000; i++) put('perf', `r${i}`, `${words[i % 10]} ${words[(i * 7) % 10]} item${i}`);
  });
  const q = stubVector('alpha omega item5');
  nearest('perf', q, undefined, 8); // loads the cache
  const runs = [];
  for (let i = 0; i < 20; i++) {
    const t = performance.now();
    nearest('perf', q, undefined, 8, S.SUGGEST_FLOOR);
    runs.push(performance.now() - t);
  }
  runs.sort((a, b) => a - b);
  const median = runs[10];
  console.log(`nearest over 20000 stub vectors: median ${median.toFixed(1)} ms, max ${runs[19].toFixed(1)} ms`);
  assert.ok(median < 40, `median ${median} ms`);
});

const msg = (id, role, parts, extra = {}) => ({ id, role, at: 1_000, parts, ...extra });
const txt = (text) => ({ type: 'text', text });
const tool = (name) => ({ type: 'tool', id: name, name, input: { secret: 'tool-input' }, output: 'tool-result', status: 'done' });

test('a turn is its prompt, tool names and final reply, never tool inputs or results', () => {
  const turns = turnsOf('ag', [
    msg('u1', 'user', [txt('Fix the login redirect')]),
    msg('a1', 'assistant', [txt('Looking.'), tool('Grep'), tool('Edit'), tool('Grep'), txt('Fixed the redirect loop.')]),
    msg('n1', 'system', [txt('a notice')], { kind: 'notice' }),
    msg('u2', 'user', [{ type: 'mail', id: 'm', from_id: 'p', from: 'parent', subject: 'Next', body: 'Now the logout page', thread: 't', read_at: null }]),
    msg('a2', 'assistant', [txt('Done with logout.')]),
    msg('u3', 'user', [txt('still going')]),
    msg('a3', 'assistant', [txt('half')], { running: true }),
  ], false, false, 'p');
  assert.deepEqual(turns.map((t) => t.ref), ['ag:u1', 'ag:u2'], 'refs are stable ids; the running turn is left out');
  assert.match(turns[0].text, /Fix the login redirect/);
  assert.match(turns[0].text, /tools: Grep Edit\b/);
  assert.match(turns[0].text, /Fixed the redirect loop/);
  assert.doesNotMatch(turns[0].text, /Looking|tool-input|tool-result|notice/);
  assert.match(turns[1].text, /Now the logout page/);
  assert.equal(turnsOf('ag', [msg('u1', 'user', [txt('x')]), msg('a1', 'assistant', [txt('y')])], false, true).length, 0, 'an open agent drops its last turn');
  assert.equal(turnsOf('ag', [msg('a0', 'assistant', [txt('cut off')]), msg('u1', 'user', [txt('x')]), msg('a1', 'assistant', [txt('y')])], true, false).length, 1, 'a turn cut by the page start is skipped');
});

test('an agent is one row at the best of its own vector and its turns, with the turn as the snippet', async () => {
  const mk = (id, role) => {
    db.createAgent({ id, name: `${id}-n`, role, machine: 'test', harness: 'claude', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
    put('agent', id, agentText(db.getAgent(id)));
  };
  mk('tq', 'helper');
  mk('plain', 'helper');
  put('turn', 'tq:t1', 'zebra ledger migration plan');
  put('turn', 'tq:t2', 'zebra ledger migration plan done');
  db.putTurnSnippet('tq:t1', Date.now(), 'Migrate the zebra ledger');
  db.putTurnSnippet('tq:t2', Date.now(), 'Migrate the zebra ledger, finished');
  const out = await S.suggest('zebra ledger migration plan', { limit: 8, recent: [], local: true, humanMail: false });
  const rows = out.filter((r) => r.id === 'tq');
  assert.equal(rows.length, 1, JSON.stringify(out));
  assert.equal(rows[0].turn, 't1', 'the best turn');
  assert.equal(rows[0].snippet, 'Migrate the zebra ledger');
  assert.equal(out.find((r) => r.id === 'plain'), undefined);
});

test('a query over 70,000 cached 384-dimension vectors: time and cache memory', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) - 0.5;
  const mkVec = () => Float32Array.from({ length: 384 }, rnd);
  db.transaction(() => {
    for (let i = 0; i < 70_000; i++) {
      const v = mkVec();
      db.putEmbedding({ source: 'turnperf', ref: `a:${i}`, model: currentModel(), dim: 384, vec: new Uint8Array(v.buffer), hash: String(i) });
    }
  });
  const q = mkVec();
  global.gc?.();
  const before = process.memoryUsage().arrayBuffers;
  nearest('turnperf', q, undefined, 8); // loads the cache
  const mb = (process.memoryUsage().arrayBuffers - before) / 1_048_576;
  const runs = [];
  for (let i = 0; i < 20; i++) {
    const t = performance.now();
    nearest('turnperf', q, undefined, 8, S.SUGGEST_FLOOR);
    runs.push(performance.now() - t);
  }
  runs.sort((a, b) => a - b);
  console.log(`nearest over 70000 vectors of 384: median ${runs[10].toFixed(1)} ms, worst ${runs[19].toFixed(1)} ms, cache ${mb.toFixed(0)} MB`);
  assert.ok(runs[10] < 500, `median ${runs[10]} ms`);
});

test('mail inside a turn: only the human or the parent opens one, and sent mail is skipped', () => {
  const mail = (id, from_id, body, extra = {}) =>
    msg(id, 'user', [{ type: 'mail', id, from_id, from: from_id, subject: 's', body, thread: id, read_at: null, ...extra }], { kind: 'mail' });
  const turns = turnsOf(
    'ag',
    [
      mail('m1', 'human', 'Please do the migration'),
      msg('a1', 'assistant', [txt('Starting.'), tool('send_mail')]),
      mail('m2', 'ag', 'SENT-BODY-SECRET', { to: [{ id: 'kid', name: 'kid', read_at: null }] }),
      mail('m3', 'kid', 'CHILD-BODY-SECRET'),
      msg('a2', 'assistant', [txt('Migration finished.')]),
      mail('m4', 'boss', 'Parent asks for a summary'),
      msg('a3', 'assistant', [txt('Summary sent.')]),
    ],
    false,
    false,
    'boss',
  );
  assert.deepEqual(turns.map((t) => t.ref), ['ag:m1', 'ag:m4'], 'sent and child mail neither split nor open a turn');
  assert.doesNotMatch(turns[0].text, /SENT-BODY|CHILD-BODY/);
  assert.match(turns[0].text, /Please do the migration/);
  assert.match(turns[0].text, /Migration finished/);
  assert.match(turns[1].text, /Parent asks/);
});

test('a put or delete keeps the vector cache, and a query right after a put stays fast', () => {
  const store = (ref, text) => put('inplace', ref, text);
  for (let i = 0; i < 3; i++) store(`r${i}`, `word${i} alpha`);
  const q = stubVector('word1 alpha');
  assert.equal(nearest('inplace', q, undefined, 1)[0].ref, 'r1'); // loads the cache
  const cached = db.decodedEmbeddingsOf('inplace', currentModel());
  store('r3', 'word1 alpha extra');
  store('r1', 'zzz other');
  assert.strictEqual(db.decodedEmbeddingsOf('inplace', currentModel()), cached, 'the cached array is kept');
  assert.deepEqual(cached.map((r) => r.ref).sort(), ['r0', 'r1', 'r2', 'r3']);
  assert.equal(nearest('inplace', q, undefined, 1)[0].ref, 'r3', 'a replaced vector is used');
  db.deleteEmbedding('inplace', 'r3');
  db.deleteEmbedding('inplace', 'r0');
  assert.deepEqual(cached.map((r) => r.ref).sort(), ['r1', 'r2']);
  // The 70,000-vector source from the measurement above: a put leaves the next query a scan, not a decode.
  const big = Float32Array.from({ length: 384 }, (_, i) => Math.sin(i));
  nearest('turnperf', big, undefined, 8);
  const t = performance.now();
  db.putEmbedding({ source: 'turnperf', ref: 'a:new', model: currentModel(), dim: 384, vec: new Uint8Array(big.buffer), hash: 'n' });
  assert.equal(nearest('turnperf', big, undefined, 1)[0].ref, 'a:new');
  const took = performance.now() - t;
  console.log(`put then nearest over 70000 vectors: ${took.toFixed(1)} ms`);
  assert.ok(took < 150, `${took} ms`);
});

test('turns older than the window are expired from the index and skipped in the search', async () => {
  db.createAgent({ id: 'ex', name: 'ex-n', role: 'helper', machine: 'test', harness: 'claude', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  put('turn', 'ex:old', 'ancient quokka census report');
  put('turn', 'ex:new', 'recent quokka census report');
  const day = 86_400_000;
  db.putTurnSnippet('ex:old', Date.now() - 20 * day, 'old');
  db.putTurnSnippet('ex:new', Date.now() - day, 'new');
  const out = await S.suggest('quokka census report', { limit: 8, recent: [], local: true, humanMail: false });
  assert.equal(out.find((r) => r.id === 'ex')?.turn, 'new', 'the old turn is outside turnDays');
  db.expireTurns(Date.now() - 7 * day);
  assert.equal(db.embeddingRow('turn', 'ex:old'), undefined);
  assert.equal(db.turnSnippet('ex:old'), undefined);
  assert.ok(db.embeddingRow('turn', 'ex:new'));
});
