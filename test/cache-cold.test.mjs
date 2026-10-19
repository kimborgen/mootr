#!/usr/bin/env node
// Unit test for S-2236: cold turns after a wake or a compaction, and the cache window detected
// from a Claude transcript. Throwaway STAM_HOME, no daemon, no model:
// `node --test test/cache-cold.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-cache-cold-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `cache-cold-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let db, cold, claude, usage, scope, sessionLastId, sessionTurnAfter;
before(async () => {
  db = await import('../src/db.ts');
  usage = await import('../src/usage.ts');
  const cmod = await import('../src/adapters/claude.ts');
  claude = cmod.claude;
  sessionLastId = cmod.sessionLastId;
  sessionTurnAfter = cmod.sessionTurnAfter;
  cold = await import('../src/cache-cold.ts');
  scope = await import('../src/usage-scope.ts');
});
after(() => rmSync(home, { recursive: true, force: true }));

let n = 0;
const newAgent = () => {
  const id = `cc${String(n++).padStart(3, '0')}`;
  return db.createAgent({ id, name: `cc-${id}`, role: 'test', machine: 'x', harness: 'claude', model: 'claude-haiku-5-5', effort: null, cwd: '/tmp', parent_id: null, session_id: null });
};
const events = (id, type) => db.open().prepare('SELECT data FROM events WHERE agent_id = ? AND type = ? ORDER BY id').all(id, type).map((r) => JSON.parse(r.data));
const row = (i, cacheCreation) =>
  JSON.stringify({ type: 'assistant', uuid: `u${i}`, message: { id: `m${i}`, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 100, cache_creation: cacheCreation } } }) + '\n';

const ev = (id) => db.open().prepare("SELECT type, data FROM events WHERE agent_id = ? AND type LIKE 'cache:%' AND type NOT IN ('cache:ttl') ORDER BY id").all(id).map((r) => [r.type, JSON.parse(r.data)]);

test('the first new turn after a wake is cold when it wrote over 80% of its context, with its cause', () => {
  const a = newAgent();
  assert.equal(cold.onCacheUsage(a.id, { cacheWrite: 900, total: 1000, turn: 't1' }), false, 'no mark, no event');
  cold.markCold(a, 'wake');
  assert.equal(cold.onCacheUsage(a.id, { cacheWrite: 0, total: 0, turn: 't1' }), false, 'a report with no size keeps the mark');
  assert.equal(cold.onCacheUsage(a.id, { cacheWrite: 900, total: 1000 }), false, 'no turn id keeps the mark');
  assert.equal(cold.onCacheUsage(a.id, { cacheWrite: 900, total: 1000, turn: 't2' }), true);
  assert.deepEqual(events(a.id, 'cache:cold'), [{ tokens: 900, context: 1000, cause: 'wake' }]);
  assert.equal(cold.onCacheUsage(a.id, { cacheWrite: 900, total: 1000, turn: 't3' }), false, 'only the first turn counts');
});

test('a mark is in the events: it survives a restart, and a warm first turn is not replayed', () => {
  const a = newAgent();
  cold.markCold(a, 'wake');
  // Nothing is kept in memory: a daemon restart with the harness running reads the same events.
  assert.equal(cold.onCacheUsage(a.id, { cacheWrite: 100, total: 1000, turn: 't1' }), false);
  assert.deepEqual(ev(a.id).map((e) => e[0]), ['cache:mark', 'cache:warm']);
  assert.equal(cold.onCacheUsage(a.id, { cacheWrite: 999, total: 1000, turn: 't2' }), false, 'the warm turn resolved the mark; nothing replays');
  assert.deepEqual(ev(a.id).map((e) => e[0]), ['cache:mark', 'cache:warm']);
});

test('the cold boundary is exact: 800 of 1000 is warm, 801 of 1000 is cold', () => {
  const a = newAgent();
  cold.markCold(a, 'wake');
  assert.equal(cold.onCacheUsage(a.id, { cacheWrite: 800, total: 1000, turn: 't1' }), false);
  cold.markCold(a, 'wake');
  assert.equal(cold.onCacheUsage(a.id, { cacheWrite: 801, total: 1000, turn: 't2' }), true);
  assert.deepEqual(ev(a.id).map((e) => e[0]), ['cache:mark', 'cache:warm', 'cache:mark', 'cache:cold']);
});

// A transcript row with its own cache write and read, so a turn is cold or warm by its row alone.
const turnRow = (i, write, read) =>
  JSON.stringify({ type: 'assistant', uuid: `u${i}`, message: { id: `m${i}`, usage: { input_tokens: 0, output_tokens: 1, cache_read_input_tokens: read, cache_creation_input_tokens: write } } }) + '\n';

for (const [name, first, second, cold1] of [
  ['cold then warm', [900, 100], [10, 990], true],
  ['warm then cold', [10, 990], [900, 100], false],
]) {
  test(`${name}: two turns written between status lines, the first after the mark is the one measured`, () => {
    cold.setTurnReader((ag) => sessionLastId(ag.transcript_path), sessionTurnAfter);
    const a = newAgent();
    const file = join(home, `two-${name.replace(' ', '-')}.jsonl`);
    writeFileSync(file, turnRow(0, 5, 995));
    db.updateAgent(a.id, { transcript_path: file });
    cold.markCold(db.getAgent(a.id), 'wake');
    appendFileSync(file, turnRow(1, ...first) + turnRow(2, ...second));
    assert.equal(cold.onCacheTurn(a.id, file), cold1);
    assert.deepEqual(ev(a.id).map((e) => e[0]), ['cache:mark', cold1 ? 'cache:cold' : 'cache:warm']);
    assert.equal(ev(a.id)[1][1].tokens, first[0], 'm1 was measured, not m2');
  });
}

test('a turn the transcript already had at the mark is not measured: only a later one is', () => {
  const a = newAgent();
  cold.setTurnReader(() => 'old', () => undefined);
  cold.markCold(a, 'wake');
  cold.setTurnReader(() => undefined, () => undefined);
  assert.equal(cold.onCacheUsage(a.id, { cacheWrite: 900, total: 1000, turn: 'old' }), false, 'restored usage on resume');
  assert.deepEqual(ev(a.id).map((e) => e[0]), ['cache:mark']);
  assert.equal(cold.onCacheUsage(a.id, { cacheWrite: 900, total: 1000, turn: 'new' }), true);
});

test('a compaction keeps its cause through the relaunch wake, and the same cause is marked once', () => {
  const a = newAgent();
  cold.markCold(a, 'compaction'); // stam's compaction
  cold.markCold(a, 'compaction'); // the PostCompact hook for it
  cold.markCold(a, 'wake'); // the relaunch
  assert.deepEqual(ev(a.id).map((e) => e[1].cause), ['compaction'], 'one mark');
  assert.equal(cold.onCacheUsage(a.id, { cacheWrite: 950, total: 1000, turn: 't1' }), true);
  assert.equal(events(a.id, 'cache:cold')[0].cause, 'compaction');
  cold.markCold(a, 'wake');
  cold.markCold(a, 'compaction');
  assert.deepEqual(ev(a.id).filter((e) => e[0] === 'cache:mark').map((e) => e[1].cause), ['compaction', 'wake', 'compaction'], 'a compaction after a pending wake replaces it');
});

test('the Claude PostCompact hook marks the next turn as after a compaction', () => {
  cold.setTurnReader((ag) => sessionLastId(ag.transcript_path), sessionTurnAfter);
  const a = newAgent();
  const file = join(home, 'pc.jsonl');
  writeFileSync(file, row(0, undefined));
  db.updateAgent(a.id, { transcript_path: file });
  claude.onHook(db.getAgent(a.id), { hook_event_name: 'PostCompact' });
  claude.onHook(db.getAgent(a.id), { hook_event_name: 'PostCompact' });
  assert.deepEqual(ev(a.id), [['cache:mark', { cause: 'compaction', seen: 'm0' }]], 'once, with the last turn it saw');
});

test('the transcript shows the window: 1 h writes, 5 min writes, and the latest one wins', () => {
  const a = newAgent();
  const file = join(home, 'ttl.jsonl');
  writeFileSync(file, row(0, { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 0 }));
  assert.equal(claude.onStatusLine(a, { transcript_path: file }).cacheTtl, '1h');
  writeFileSync(file, row(0, { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 0 }) + row(1, { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 100 }));
  assert.equal(claude.onStatusLine(a, { transcript_path: file }).cacheTtl, '5m');
  const none = join(home, 'none.jsonl');
  writeFileSync(none, row(0, undefined));
  assert.equal(claude.onStatusLine(a, { transcript_path: none }).cacheTtl, undefined, 'no breakdown, unknown');
});

test('a changed window is recorded once, and usage summary lists 5 min agents and cold turns per day', () => {
  const a = newAgent();
  const b = newAgent();
  cold.onCacheTtl(a.id, '5m');
  cold.onCacheTtl(a.id, '5m');
  cold.onCacheTtl(b.id, '1h');
  assert.deepEqual(events(a.id, 'cache:ttl'), [{ ttl: '5m' }]);
  cold.markCold(a, 'wake');
  cold.onCacheUsage(a.id, { cacheWrite: 500, total: 600, turn: 'x' });
  const day = new Date().toISOString().slice(0, 10);
  const c = usage.summary(7).cache;
  assert.ok(c.ttl_5m_agents.some((x) => x.agent_id === a.id));
  assert.ok(!c.ttl_5m_agents.some((x) => x.agent_id === b.id));
  assert.ok(c.cold_by_day.find((r) => r.day === day).tokens >= 500);
  assert.ok(c.cold_total.turns >= 1);
});

test('a hidden 5 min agent is left out of a scoped summary', () => {
  const a = newAgent();
  const b = newAgent();
  cold.onCacheTtl(a.id, '5m');
  cold.onCacheTtl(b.id, '5m');
  const full = usage.summary(7);
  const scoped = scope.scopeSummary(full, new Set([a.id]));
  assert.deepEqual(scoped.cache.ttl_5m_agents.map((x) => x.agent_id), [a.id]);
  assert.ok(full.cache.ttl_5m_agents.some((x) => x.agent_id === b.id), 'the unscoped summary has it');
});

test('the usage_info queries use the partial indexes, and the mark query the agent index', () => {
  const plan = (sql, ...args) => db.open().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((r) => r.detail).join(' | ');
  assert.match(plan(`${cold.COLD_BY_DAY_SQL} GROUP BY day`, '2026-01-01'), /events_cache_cold/);
  assert.match(plan(`${cold.TTL_AGENTS_SQL} GROUP BY agent_id)`), /events_cache_ttl/);
  const p = plan(cold.PENDING_SQL, 'x', 'x', 'x');
  assert.match(p, /events_agent_type/);
  assert.doesNotMatch(p, /USING INDEX events_agent \(/);
});
