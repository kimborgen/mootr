#!/usr/bin/env node
// Unit tests for subscription readings across machines (S-2367; src/peer-readings.ts, src/rules.ts,
// src/cost-pause.ts): a fresh reading of the same account on a peer clears a window blocker and a
// cost pause here, a stale or older peer reading does not, a peer's reading never sets a blocker,
// and a peer that stops answering stops counting. The peer is a stub HTTP server on localhost that
// serves fixed readings, with times passed in: no daemon, no models, no sleeps:
// `node --test test/peer-readings.test.mjs`.
import { test, before, after } from 'node:test';
import { killTmuxServer } from '../src/tmux-socket.ts';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-peer-readings-');
const socket = `peer-readings-test-${process.pid}`;
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = socket;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

// The stub peer's answer, set by each test: a machine's windows per configured account.
let served = {};
const stub = createServer((req, res) => {
  if (req.url !== '/api/usage/readings') {
    res.statusCode = 404;
    res.end('{}');
    return;
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(served));
});

let db, blockers, rules, peerReadings, costPause, STALE_MS;
const prompts = new Map();
before(async () => {
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  writeFileSync(
    join(home, 'settings.json'),
    JSON.stringify({
      peers: [{ name: 'peer1', url: `http://127.0.0.1:${stub.address().port}`, token: 'test-peer-token' }],
      cost: {
        subscriptionWarnPercent: [],
        accounts: { 'claude-max': { match: { harness: 'claude' }, paid: false } },
      },
    }),
  );
  db = await import('../src/db.ts');
  blockers = await import('../src/blockers.ts');
  rules = await import('../src/rules.ts');
  peerReadings = await import('../src/peer-readings.ts');
  costPause = await import('../src/cost-pause.ts');
  ({ STALE_MS } = await import('../src/readings.ts'));
  const { adapters } = await import('../src/adapters/index.ts');
  adapters.claude.pushPrompt = async (a, text) => {
    prompts.set(a.id, [...(prompts.get(a.id) ?? []), text]);
    return true;
  };
});
after(() => {
  stub.close();
  killTmuxServer(socket);
  rmSync(home, { recursive: true, force: true });
});

let n = 0;
function agent() {
  const id = db.newAgentId();
  db.createAgent({ id, name: `pr${++n}`, role: '', machine: 'test', harness: 'claude', model: null, effort: null, cwd: home, parent_id: null, session_id: null });
  db.updateAgent(id, { activity: 'working' });
  return db.getAgent(id);
}
const get = (a) => db.getAgent(a.id);
const of = (a, kind) => blockers.blockers(a).find((b) => b.kind === kind);
const MIN = 60_000;
const T0 = Date.now();
const RESETS = Math.floor(T0 / 1000) + 3600;
// Writes this machine's own reading, without evaluating the rules, as one stored by the statusline.
function store(data, at) {
  db.open()
    .prepare('INSERT INTO subscriptions (name, data, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
    .run('claude', JSON.stringify(data), new Date(at).toISOString());
}
// The peer's claude-max window at a percentage, taken at `at`.
const peerFive = (pct, at, match = { harness: 'claude' }) => ({ 'claude-max': { match, windows: { five_hour: { pct, resets_at: RESETS, at } } } });
function reset() {
  db.open().prepare('DELETE FROM blockers').run();
  db.open().prepare('DELETE FROM account_holds').run();
  db.open().prepare('DELETE FROM subscriptions').run();
  db.open().prepare('DELETE FROM window_resets').run();
  rules.forgetWindowClears();
  served = {};
  db.open().prepare("UPDATE agents SET lifecycle = 'archived'").run();
}

test('a local 100% overtaken by a peer\'s 1% stays overtaken when the peer later reads 100%', async () => {
  reset();
  const a = agent();
  store({ five_hour: { used_percentage: 100, resets_at: RESETS } }, T0);
  await rules.evaluateAll(T0);
  assert.ok(of(a, 'window'));
  served = peerFive(1, T0 + MIN);
  await peerReadings.refresh(T0 + MIN);
  await rules.evaluateAll(T0 + MIN);
  assert.equal(of(a, 'window'), undefined, 'the peer\'s 1% clears it');
  served = peerFive(100, T0 + 2 * MIN);
  await peerReadings.refresh(T0 + 2 * MIN);
  await rules.evaluateAll(T0 + 2 * MIN);
  assert.equal(of(a, 'window'), undefined, 'a peer\'s later 100% does not restore the overtaken local 100%');
  // A newer local reading, after the peer's reset, sets it again.
  store({ five_hour: { used_percentage: 100, resets_at: RESETS } }, T0 + 3 * MIN);
  await rules.evaluateAll(T0 + 3 * MIN);
  assert.ok(of(a, 'window'), 'a local reading taken after the reset sets it');
});

test('a peer reading at the same time as the local one: the local wins the tie and still sets', async () => {
  reset();
  const a = agent();
  store({ five_hour: { used_percentage: 100, resets_at: RESETS } }, T0);
  served = peerFive(1, T0);
  await peerReadings.refresh(T0);
  await rules.evaluateAll(T0);
  assert.ok(of(a, 'window'), 'the equal-time local 100% is not overtaken');
  assert.equal(get(a).lifecycle, 'paused');
});

test('identity compares harness and model, not the order of the keys', async () => {
  const served1 = { 'claude-max': { match: { model: 'm', harness: 'claude' }, windows: { five_hour: { pct: 1, resets_at: RESETS, at: T0 } } } };
  served = served1;
  await peerReadings.refresh(T0);
  assert.equal(peerReadings.peerWindows('claude-max', { harness: 'claude', model: 'm' }, T0 + MIN).five_hour.pct, 1);
  assert.deepEqual(peerReadings.peerWindows('claude-max', { harness: 'claude', model: 'other' }, T0 + MIN), {});
});

test('a fresh reading of the account on a peer clears a window blocker here, and an older local 100% does not set it again', async () => {
  reset();
  const a = agent();
  store({ five_hour: { used_percentage: 100, resets_at: RESETS } }, T0);
  await rules.evaluateAll(T0);
  assert.ok(of(a, 'window'), 'the local 100% sets it');
  assert.equal(get(a).lifecycle, 'paused');
  served = peerFive(1, T0 + MIN);
  await peerReadings.refresh(T0 + MIN);
  await rules.evaluateAll(T0 + MIN);
  assert.equal(of(a, 'window'), undefined, 'the peer\'s newer 1% clears it');
  assert.equal(get(a).lifecycle, 'active');
  await rules.evaluateAll(T0 + 2 * MIN);
  assert.equal(of(a, 'window'), undefined, 'the local 100%, overtaken by the peer, does not set it again');
});

test('a peer\'s reading older than this machine\'s reading never clears, and a stale one never does', async () => {
  reset();
  const a = agent();
  store({ five_hour: { used_percentage: 100, resets_at: RESETS } }, T0 + 2 * MIN);
  await rules.evaluateAll(T0 + 2 * MIN);
  assert.ok(of(a, 'window'));
  served = peerFive(1, T0 + MIN);
  await peerReadings.refresh(T0 + 3 * MIN);
  await rules.evaluateAll(T0 + 3 * MIN);
  assert.ok(of(a, 'window'), 'an older peer reading does not override the newer local one');
  // Newer than the local reading, but past STALE_MS when evaluated: it counts for nothing.
  served = peerFive(1, T0 + 3 * MIN);
  await peerReadings.refresh(T0 + 3 * MIN + STALE_MS + 1);
  await rules.evaluateAll(T0 + 3 * MIN + STALE_MS + 1);
  assert.ok(of(a, 'window'), 'a stale peer reading does not clear');
});

test('a peer\'s reading never sets a blocker, even at 100%', async () => {
  reset();
  const a = agent();
  served = peerFive(100, T0);
  await peerReadings.refresh(T0);
  await rules.evaluateAll(T0 + MIN);
  assert.equal(of(a, 'window'), undefined);
  assert.equal(get(a).lifecycle, 'active');
});

test('a peer\'s reading of an account with another match is not this account', async () => {
  reset();
  const a = agent();
  store({ five_hour: { used_percentage: 100, resets_at: RESETS } }, T0);
  await rules.evaluateAll(T0);
  served = peerFive(1, T0 + MIN, { harness: 'claude', model: 'other' });
  await peerReadings.refresh(T0 + MIN);
  await rules.evaluateAll(T0 + MIN);
  assert.ok(of(a, 'window'), 'same name, different configured identity: not cleared');
});

test('a peer that stops answering stops counting once its last reading is STALE_MS old', async () => {
  reset();
  served = peerFive(1, T0);
  await peerReadings.refresh(T0);
  const match = { harness: 'claude' };
  assert.equal(peerReadings.peerWindows('claude-max', match, T0 + MIN).five_hour.pct, 1);
  assert.deepEqual(peerReadings.peerWindows('claude-max', match, T0 + STALE_MS + 1), {});
});

test('a cost pause until=reset lifts on a fresh reading of the window on a peer', async () => {
  reset();
  const t = Date.now();
  const a = agent();
  store({ five_hour: { used_percentage: 100, resets_at: Math.floor(t / 1000) + 3600 } }, t);
  await costPause.costPause({ root: a.id, by: 'human', until: 'reset', account: 'claude-max', window: 'five_hour' });
  assert.ok(costPause.manualBlocker(get(a)), 'paused until the window resets');
  served = peerFive(1, t + MIN);
  await peerReadings.refresh(t + MIN);
  await costPause.evaluatePauses(t + 2 * MIN);
  assert.equal(costPause.manualBlocker(get(a)), undefined, 'the peer\'s reading below the 100% it was paused at lifts it');
});

// A peer's low reading that would clear a window the local machine re-set within the flap hold
// waits for the hold to end (S-2365 review): the clear reads the newest reading on any machine,
// and the hold still applies to it.
test('a peer reading that clears a window during its flap hold waits for the hold to end', async () => {
  reset();
  // The peer cache keeps the last refresh, and an earlier test's peer reading would overtake this test's local one.
  served = {};
  await peerReadings.refresh(T0 - MIN);
  const a = agent();
  store({ five_hour: { used_percentage: 100, resets_at: RESETS } }, T0);
  await rules.evaluateAll(T0);
  assert.ok(of(a, 'window'), 'the local 100% sets it');
  served = peerFive(1, T0 + MIN);
  await peerReadings.refresh(T0 + MIN);
  await rules.evaluateAll(T0 + MIN);
  assert.equal(of(a, 'window'), undefined, 'the peer clears it');
  store({ five_hour: { used_percentage: 100, resets_at: RESETS } }, T0 + 2 * MIN);
  await rules.evaluateAll(T0 + 2 * MIN);
  assert.ok(of(a, 'window'), 'set again by the local 100%, held until T0+12min');
  served = peerFive(3, T0 + 3 * MIN);
  await peerReadings.refresh(T0 + 3 * MIN);
  await rules.evaluateAll(T0 + 3 * MIN);
  assert.ok(of(a, 'window'), 'the peer 3% is held');
  await rules.evaluateAll(T0 + 12 * MIN + 1);
  assert.equal(of(a, 'window'), undefined, 'the peer reading clears once the hold ends');
});

// The fallback gate (admission.heldForFallback, S-905) reads this machine's own windows as a set does:
// a local 100% a peer reading overtook is not exhausted, even after the peer stops answering.
test('a local 100% overtaken by a peer reading does not hold a reviewer fallback, and stays overtaken once the peer ages out', async () => {
  const { heldForFallback } = await import('../src/admission.ts');
  reset();
  await peerReadings.refresh(T0 - MIN); // the peer cache from the tests above is empty
  store({ five_hour: { used_percentage: 100, resets_at: RESETS } }, T0);
  assert.ok(heldForFallback({ harness: 'claude' }), 'the local 100% holds a fallback before the peer answers');
  served = peerFive(1, T0 + MIN);
  await peerReadings.refresh(T0 + MIN);
  assert.equal(heldForFallback({ harness: 'claude' }), null, 'the peer\'s 1% overtakes it');
  // The peer stops answering: the peer's cache ages out, and the reset it recorded still suppresses the local 100%.
  served = {};
  const later = T0 + MIN + STALE_MS + 1;
  assert.deepEqual(peerReadings.peerWindows('claude-max', { harness: 'claude' }, later), {}, 'the peer reading has aged out');
  assert.deepEqual(rules.exhaustedWindows('claude-max', later), [], 'suppressed after the peer ages out');
  // A newer local reading at 100% after that peer reading sets it again.
  store({ five_hour: { used_percentage: 100, resets_at: RESETS } }, T0 + 2 * MIN);
  assert.equal(rules.exhaustedWindows('claude-max', T0 + 2 * MIN).length, 1, 'a local reading after the peer\'s sets it');
});

test('a local 100% a peer later reads at 100% still holds a fallback only through its own reading', async () => {
  reset();
  served = {};
  await peerReadings.refresh(T0 - MIN);
  store({ five_hour: { used_percentage: 100, resets_at: RESETS } }, T0);
  served = peerFive(100, T0 + MIN);
  await peerReadings.refresh(T0 + MIN);
  const { heldForFallback } = await import('../src/admission.ts');
  assert.ok(heldForFallback({ harness: 'claude' }), 'a peer 100% does not take over the local window');
});
