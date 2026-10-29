#!/usr/bin/env node
// Unit tests for how the Codex reading is shown (S-1361; src/codex-usage-view.ts, src/readings.ts,
// src/usage.ts): a window whose reset time has passed is shown as reset with the reading's age
// and never as its old percentage, a fresh peer reading beats an older local one, Claude's
// reading is unchanged, and no token or account id appears. The peer is a stub HTTP server with
// fixed readings and every time is passed in: no daemon, no Codex, no sleeps:
// `node --test test/codex-usage-view.test.mjs`.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-codex-usage-view-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `codex-usage-view-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let served = {};
const stub = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(req.url === '/api/usage/readings' ? JSON.stringify(served) : '{}');
});

const NOW = Date.parse('2026-10-22T12:00:00Z');
const sec = (iso) => Math.floor(Date.parse(iso) / 1000);
let db, readings, peerReadings, usage;
before(async () => {
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  writeFileSync(
    join(home, 'settings.json'),
    JSON.stringify({
      peers: [{ name: 'peer1', url: `http://127.0.0.1:${stub.address().port}`, token: 'secret-token' }],
      cost: { subscriptionWarnPercent: [], accounts: { codex: { match: { harness: 'codex' } }, 'claude-max': { match: { harness: 'claude' } } } },
    }),
  );
  db = await import('../src/db.ts');
  readings = await import('../src/readings.ts');
  peerReadings = await import('../src/peer-readings.ts');
  usage = await import('../src/usage.ts');
});
after(() => {
  stub.close();
  rmSync(home, { recursive: true, force: true });
});
beforeEach(() => {
  served = {};
  db.open().exec('DELETE FROM subscriptions');
});

const put = (name, data, at) => db.open().prepare('INSERT INTO subscriptions (name, data, updated_at) VALUES (?, ?, ?)').run(name, JSON.stringify(data), at);
const codexRow = () => readings.accountReadings(NOW).find((r) => r.account === 'codex');

test('a Codex window past its reset is reset with the reading age, not its old percentage', () => {
  put('codex', { five_hour: { used_percentage: 21, resets_at: sec('2026-10-22T08:16:00Z') }, seven_day: { used_percentage: 20, resets_at: sec('2026-10-25T00:00:00Z') } }, '2026-10-22T03:30:00Z');
  const r = codexRow();
  assert.equal(r.windows.five_hour, undefined);
  assert.deepEqual(r.reset_windows.five_hour, { reset: true, resets_at: sec('2026-10-22T08:16:00Z'), age_ms: NOW - Date.parse('2026-10-22T03:30:00Z') });
  assert.equal(r.windows.seven_day.used_percentage, 20);
  assert.equal(r.age_ms, NOW - Date.parse('2026-10-22T03:30:00Z'));
  assert.equal(r.stale, true);
});

test('usage summary shows the same: reset window, no percentage, and the entry age', () => {
  put('codex', { five_hour: { used_percentage: 21, resets_at: sec('2026-10-22T08:16:00Z') }, credits: { balance: '0' }, planType: 'plus' }, '2026-10-22T03:30:00Z');
  const sub = usage.summary(1).subscriptions.find((s) => s.name === 'codex');
  assert.equal(sub.windows.five_hour.reset, true);
  assert.equal('used_percentage' in sub.windows.five_hour, false);
  assert.equal(sub.windows.planType, 'plus');
  assert.equal(typeof sub.age_ms, 'number');
});

test('a fresh peer reading replaces an older local one', async () => {
  put('codex', { five_hour: { used_percentage: 21, resets_at: sec('2026-10-22T08:16:00Z') } }, '2026-10-22T03:30:00Z');
  const at = NOW - 60_000;
  served = { codex: { match: { harness: 'codex' }, windows: { five_hour: { pct: 64, resets_at: sec('2026-10-22T13:00:00Z'), at } } } };
  await peerReadings.refresh(NOW);
  const r = codexRow();
  assert.equal(r.windows.five_hour.used_percentage, 64);
  assert.equal(r.updated_at, new Date(at).toISOString());
  assert.equal(r.age_ms, 60_000);
  assert.deepEqual(r.reset_windows, {});
});

test("Claude's reading is unchanged and carries no reset_windows", () => {
  put('claude', { five_hour: { used_percentage: 33, resets_at: sec('2026-10-22T08:16:00Z') } }, '2026-10-22T03:30:00Z');
  const r = readings.accountReadings(NOW).find((x) => x.account === 'claude-max');
  assert.equal(r.windows.five_hour.used_percentage, 33);
  assert.equal(r.reset_windows, undefined);
});

test('no token appears in the Codex reading', () => {
  put('codex', { five_hour: { used_percentage: 5, resets_at: sec('2026-10-22T13:00:00Z') } }, '2026-10-22T11:59:00Z');
  assert.doesNotMatch(JSON.stringify(codexRow()) + JSON.stringify(usage.summary(1).subscriptions), /secret-token/);
});

test('a peer `other/five_hour` key stays out of the codex entry', async () => {
  put('codex', { five_hour: { used_percentage: 10, resets_at: sec('2026-10-22T13:00:00Z') } }, '2026-10-22T11:59:00Z');
  const at = NOW - 1000;
  served = { codex: { match: { harness: 'codex' }, windows: { 'other/five_hour': { pct: 90, resets_at: sec('2026-10-22T13:00:00Z'), at } } } };
  await peerReadings.refresh(NOW);
  const r = codexRow();
  assert.equal(r.windows['other/five_hour'], undefined);
  assert.equal(r.windows.five_hour.used_percentage, 10);
  const sub = usage.summary(1).subscriptions.find((s) => s.name === 'codex');
  assert.equal(sub.windows['other/five_hour'], undefined);
});

test('each live window has its own age; a fresh peer window leaves an old one old', async () => {
  put('codex', { five_hour: { used_percentage: 10, resets_at: sec('2026-10-22T13:00:00Z') }, seven_day: { used_percentage: 20, resets_at: sec('2026-10-25T00:00:00Z') } }, '2026-10-22T06:00:00Z');
  served = { codex: { match: { harness: 'codex' }, windows: { five_hour: { pct: 30, resets_at: sec('2026-10-22T13:00:00Z'), at: NOW - 60_000 } } } };
  await peerReadings.refresh(NOW);
  const { codexView } = await import('../src/codex-usage-view.ts');
  const row = db.open().prepare("SELECT data, updated_at FROM subscriptions WHERE name = 'codex'").get();
  const v = codexView(JSON.parse(row.data), row.updated_at, NOW);
  assert.equal(v.live.five_hour.age_ms, 60_000);
  assert.equal(v.live.seven_day.age_ms, NOW - Date.parse('2026-10-22T06:00:00Z'));
  assert.equal(v.age_ms, v.live.seven_day.age_ms);
  assert.equal(codexRow().age_ms, v.age_ms);
});

test('stam usage lines: reset window with its age, live window with its age', async () => {
  const { windowLine } = await import('../src/usage-line.ts');
  const reset = { reset: true, resets_at: sec('2026-10-22T08:16:00Z'), age_ms: 8 * 3_600_000 };
  assert.equal(windowLine('codex', 'five_hour', reset), 'codex five_hour: reset at 08:16Z (reading 8h old)');
  assert.equal(windowLine('codex', 'seven_day', { used_percentage: 20, resets_at: sec('2026-10-25T00:00:00Z'), age_ms: 600_000 }), 'codex seven_day: 20% (resets 2026-10-25T00:00Z, reading 10m old)');
  assert.equal(windowLine('claude', 'five_hour', { used_percentage: 33, resets_at: sec('2026-10-22T13:00:00Z') }), 'claude five_hour: 33% (resets 2026-10-22T13:00Z)');
  assert.equal(windowLine('codex', 'planType', 'plus'), null);
  // A live window with no resets_at (or an invalid one) omits the reset part and does not throw.
  assert.equal(windowLine('codex', 'five_hour', { used_percentage: 7 }), 'codex five_hour: 7%');
  assert.equal(windowLine('codex', 'five_hour', { used_percentage: 7, resets_at: NaN, age_ms: 600_000 }), 'codex five_hour: 7% (reading 10m old)');
});
