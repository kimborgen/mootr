#!/usr/bin/env node
// Unit tests for build step 6 of docs/cost-policy.md: per-agent tokens per 5-minute bucket
// beside the daily table, window readings kept only when they change, and pruning both
// tables to the last 35 days. Runs against a throwaway STAM_HOME with no daemon, no network,
// and no models: `node --test test/samples.test.mjs`.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-samples-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `samples-test-${process.pid}`;
// Nothing here talks to a daemon; drop a parent agent's pointers to the live one anyway.
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let db, usage;
before(async () => {
  db = await import('../src/db.ts');
  usage = await import('../src/usage.ts');
});
after(() => rmSync(home, { recursive: true, force: true }));

let n = 0;
function agent(model = 'test/model', harness = 'opencode') {
  const id = `s-agent-${++n}`;
  db.createAgent({ id, name: `sample-${n}`, role: 'test', machine: 'x', harness, model, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  return db.getAgent(id);
}
const sampleRows = (id) => db.open().prepare('SELECT * FROM usage_samples WHERE agent_id = ? ORDER BY bucket').all(id);
const dailyRow = (id) => db.open().prepare('SELECT * FROM usage WHERE agent_id = ?').get(id);
const readingRows = (name, window) => db.open().prepare('SELECT * FROM window_readings WHERE name = ? AND window = ? ORDER BY at').all(name, window);

beforeEach(() => {
  const d = db.open();
  d.exec('DELETE FROM usage');
  d.exec('DELETE FROM usage_samples');
  d.exec('DELETE FROM window_readings');
  d.exec('DELETE FROM agents');
});

test('bucket > a report lands on the UTC start of its 5-minute bucket', () => {
  // 12:04:59.999 is the last instant of the 12:00 bucket; 12:05:00.000 starts the next.
  assert.equal(usage.bucketOf(Date.parse('2026-10-11T12:04:59.999Z')), '2026-10-11T12:00:00.000Z');
  assert.equal(usage.bucketOf(Date.parse('2026-10-11T12:05:00.000Z')), '2026-10-11T12:05:00.000Z');
  assert.equal(usage.bucketOf(Date.parse('2026-10-11T12:09:59.999Z')), '2026-10-11T12:05:00.000Z');
  assert.equal(usage.bucketOf(0), '1970-01-01T00:00:00.000Z');
});

test('samples > the sum over buckets equals the daily row', () => {
  const a = agent();
  const t = Date.parse('2026-10-11T12:02:00.000Z');
  usage.report(a, { cost: 1, tokensIn: 10, tokensOut: 20, tokensCacheRead: 30, tokensCacheWrite: 40 }, t);
  // A second report in the same bucket adds to that bucket's row.
  usage.report(db.getAgent(a.id), { cost: 0.5, tokensIn: 5, tokensOut: 6, tokensCacheRead: 7, tokensCacheWrite: 8 }, t + 60_000);
  // A report in the next bucket is a row of its own.
  usage.report(db.getAgent(a.id), { cost: 2, tokensIn: 1, tokensOut: 2, tokensCacheRead: 3, tokensCacheWrite: 4 }, Date.parse('2026-10-11T12:06:00.000Z'));
  const rows = sampleRows(a.id);
  assert.deepEqual(rows.map((r) => r.bucket), ['2026-10-11T12:00:00.000Z', '2026-10-11T12:05:00.000Z']);
  assert.equal(rows[0].cost_usd, 1.5);
  assert.equal(rows[0].tokens_in, 15);
  const sum = (col) => rows.reduce((s, r) => s + r[col], 0);
  const daily = dailyRow(a.id);
  for (const col of ['cost_usd', 'tokens_in', 'tokens_out', 'tokens_cache_read', 'tokens_cache_write']) {
    assert.equal(sum(col), daily[col], `sum of ${col} matches the daily row`);
  }
});

test('samples > a null model is stored as an empty key, so its bucket still upserts', () => {
  const a = agent(null);
  const t = Date.parse('2026-10-11T12:02:00.000Z');
  usage.report(a, { tokensIn: 10 }, t);
  usage.report(db.getAgent(a.id), { tokensIn: 5 }, t + 60_000);
  const rows = sampleRows(a.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, '');
  assert.equal(rows[0].tokens_in, 15);
});

test('samples > reads one account\'s buckets in a window, oldest first', () => {
  const a = agent();
  const t = Date.parse('2026-10-11T12:02:00.000Z');
  usage.report(a, { cost: 1, tokensIn: 10, tokensOut: 20, tokensCacheRead: 30, tokensCacheWrite: 40 }, t);
  usage.report(db.getAgent(a.id), { cost: 2, tokensIn: 1, tokensOut: 2, tokensCacheRead: 3, tokensCacheWrite: 4 }, t + 6 * 60_000);
  // `until` is exclusive: the first bucket only.
  const first = usage.samples('', '2026-10-11T12:00:00.000Z', '2026-10-11T12:05:00.000Z');
  assert.equal(first.length, 1);
  assert.equal(first[0].tokens_in, 10);
  const all = usage.samples('', '2026-10-11T00:00:00.000Z', '2026-10-12T00:00:00.000Z');
  assert.deepEqual(all.map((r) => r.bucket), ['2026-10-11T12:00:00.000Z', '2026-10-11T12:05:00.000Z']);
  assert.equal(all[0].agent_id, a.id);
  assert.equal(all[0].harness, 'opencode');
  assert.equal(usage.summary().sample_count, 2);
});

test('window readings > stored only when the percentage or reset time changes', () => {
  const at = Date.parse('2026-10-11T12:00:00.000Z');
  const read = (used_percentage, resets_at, t) => usage.reportSubscription('claude', { five_hour: { used_percentage, resets_at } }, t);
  read(10, 1000, at);
  read(10, 1000, at + 60_000); // unchanged: nothing stored
  assert.equal(readingRows('claude', 'five_hour').length, 1);
  read(20, 1000, at + 120_000); // the percentage changed
  read(20, 1000, at + 180_000); // unchanged
  read(20, 2000, at + 240_000); // the reset time changed
  read(20, 2000, at + 300_000); // unchanged
  read(0, 3000, at + 360_000); // a reset: both changed
  const rows = readingRows('claude', 'five_hour');
  assert.deepEqual(rows.map((r) => r.used_percentage), [10, 20, 20, 0]);
  assert.deepEqual(rows.map((r) => r.resets_at), [1000, 1000, 2000, 3000]);
  assert.equal(rows[0].at, new Date(at).toISOString());
});

test('prune > both tables keep the last 35 days, at most once an hour', () => {
  const a = agent();
  const now = Date.parse('2026-10-12T12:00:00.000Z');
  const old = new Date(now - 40 * 86_400_000).toISOString();
  const recent = new Date(now - 86_400_000).toISOString();
  const d = db.open();
  const insSample = d.prepare('INSERT INTO usage_samples (agent_id, account, harness, model, bucket, cost_usd) VALUES (?, ?, ?, ?, ?, ?)');
  const insReading = d.prepare('INSERT INTO window_readings (name, window, at, used_percentage) VALUES (?, ?, ?, ?)');
  insSample.run(a.id, 'acct', 'claude', 'm', old, 1);
  insSample.run(a.id, 'acct', 'claude', 'm', recent, 1);
  insReading.run('claude', 'five_hour', old, 5);
  insReading.run('claude', 'five_hour', recent, 6);
  // A report an hour or more after the last prune prunes: the 40-day rows go, the recent stay.
  usage.report(a, { tokensIn: 1 }, now);
  assert.deepEqual(sampleRows(a.id).filter((r) => r.bucket === old), []);
  assert.equal(sampleRows(a.id).filter((r) => r.bucket === recent).length, 1);
  assert.deepEqual(readingRows('claude', 'five_hour').filter((r) => r.at === old), []);
  assert.equal(readingRows('claude', 'five_hour').filter((r) => r.at === recent).length, 1);
  // Within the hour a report does not prune again. The token count rises so the report is a
  // real delta, not an unchanged baseline that returns before the prune check.
  insSample.run(a.id, 'acct', 'claude', 'm', old, 1);
  usage.report(db.getAgent(a.id), { tokensIn: 2 }, now + 60_000);
  assert.equal(sampleRows(a.id).filter((r) => r.bucket === old).length, 1);
  // An hour later it does.
  usage.report(db.getAgent(a.id), { tokensIn: 3 }, now + 3_600_001);
  assert.deepEqual(sampleRows(a.id).filter((r) => r.bucket === old), []);
});
