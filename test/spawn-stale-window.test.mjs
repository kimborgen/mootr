#!/usr/bin/env node
// A reviewer's fallback choice on a window exhausted on a stale reading (S-905). A codex reading at
// 100% goes stale once no codex agent runs (S-382), and then plan() sees no fresh window. The
// fallback gate (heldForFallback) still holds the account while its own reading is 100% with a
// valid reset ahead, so a reviewer walks its chain. It never refuses a spawn: a developer on that
// account still starts (admitSpawn), and a reviewer with no fallback starts as on main. Covers a
// stale 100% with its reset ahead (held for fallback), a passed, missing, null or garbled reset
// (not held), a stale reading under 100% (not held), a fresh 100% (held, as on main), a paid account
// (not held), the reviewer chain, and the developer and fallback-less reviewer still spawning.
// Throwaway STAM_HOME, deterministic readings, no daemon, no models:
// `node --test test/spawn-stale-window.test.mjs`.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-spawn-stale-window-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `spawn-stale-window-test-${process.pid}`;
writeFileSync(
  join(home, 'settings.json'),
  JSON.stringify({
    peers: [],
    cost: {
      subscriptionWarnPercent: [],
      accounts: {
        'acct-b': { match: { harness: 'fake2' }, paid: false },
        'acct-a': { match: { harness: 'fake' }, paid: false },
        'acct-c': { match: { harness: 'fake4' }, paid: false },
        'acct-p': { match: { harness: 'fake3' }, paid: true },
      },
    },
  }),
);
writeFileSync(
  join(home, 'registry.json'),
  JSON.stringify({
    types: {
      reviewer: { description: 'r', harness: 'fake2', model: null, effort: null, review: { fallback: 'rv-fallback', ring: null } },
      'rv-fallback': { description: 'r', harness: 'fake', model: 'rv-model', effort: 'medium', review: { fallback: 'rv-last', ring: null } },
      'rv-last': { description: 'r', harness: 'fake4', model: null, effort: null, review: { fallback: null, ring: null } },
      'reviewer-alone': { description: 'r', harness: 'fake2', model: null, effort: null, review: { fallback: null, ring: null } },
    },
  }),
);

let db, admission, reviewerChain;
const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();
// The subscriptions row a harness's reading lands in (rules.ts readingFor reads the row named for it).
const rowFor = (name, window, updatedMs) => (data) =>
  db
    .open()
    .prepare('INSERT INTO subscriptions (name, data, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
    .run(name, JSON.stringify({ [window]: data }), iso(updatedMs));
const reading = (name, pct, resetsMs, updatedMs) => rowFor(name, 'five_hour', updatedMs)({ used_percentage: pct, resets_at: resetsMs == null ? undefined : Math.round(resetsMs / 1000) });

before(async () => {
  db = await import('../src/db.ts');
  admission = await import('../src/admission.ts');
  reviewerChain = await import('../src/reviewer-chain.ts');
});

beforeEach(() => {
  db.open().exec('DELETE FROM subscriptions');
  db.open().exec('DELETE FROM blockers');
  db.open().exec('DELETE FROM window_resets');
});

test('a stale 100% reading with its reset ahead holds the account for fallback, not for a spawn', () => {
  const now = Date.now();
  reading('fake2', 100, now + 2 * HOUR, now - HOUR);
  const held = admission.heldForFallback({ harness: 'fake2' });
  assert.ok(held, 'the exhausted account reads as free for a fallback');
  assert.equal(held.account, 'acct-b');
  assert.match(held.reason, /window \(five_hour at 100%/);
  assert.equal(admission.accountHeld({ harness: 'fake2' }), null, 'the spawn gate does not refuse on a stale reading');
});

test('a stale 100% reading whose reset has passed does not hold the account', () => {
  const now = Date.now();
  reading('fake2', 100, now - HOUR, now - 2 * HOUR);
  assert.equal(admission.heldForFallback({ harness: 'fake2' }), null);
});

test('a stale 100% reading with no reset, a null reset, or a garbled one does not hold the account', () => {
  const now = Date.now();
  rowFor('fake2', 'five_hour', now - HOUR)({ used_percentage: 100 });
  assert.equal(admission.heldForFallback({ harness: 'fake2' }), null, 'missing reset');
  rowFor('fake2', 'five_hour', now - HOUR)({ used_percentage: 100, resets_at: null });
  assert.equal(admission.heldForFallback({ harness: 'fake2' }), null, 'null reset');
  rowFor('fake2', 'five_hour', now - HOUR)({ used_percentage: 100, resets_at: 'soon' });
  assert.equal(admission.heldForFallback({ harness: 'fake2' }), null, 'garbled reset');
});

test('a stale reading under 100% does not hold the account', () => {
  const now = Date.now();
  reading('fake2', 80, now + 2 * HOUR, now - HOUR);
  assert.equal(admission.heldForFallback({ harness: 'fake2' }), null);
});

test('a fresh 100% reading holds the account for a spawn as on main', () => {
  const now = Date.now();
  reading('fake2', 100, now + 2 * HOUR, now);
  assert.ok(admission.accountHeld({ harness: 'fake2' }));
  assert.ok(admission.heldForFallback({ harness: 'fake2' }));
});

test('a paid account is never held by a stale reading', () => {
  const now = Date.now();
  reading('fake3', 100, now + 2 * HOUR, now - HOUR);
  assert.equal(admission.heldForFallback({ harness: 'fake3' }), null);
});

test('a reviewer whose account is held by a stale reading falls to its fallback type', () => {
  const now = Date.now();
  reading('fake2', 100, now + 2 * HOUR, now - HOUR);
  // The spawn checks the primary's own account first (daemon.ts spawnAgentIn), then walks the chain.
  assert.ok(admission.heldForFallback({ harness: 'fake2', model: null }), 'the primary reads as held for a fallback');
  const fb = reviewerChain.freeFallback('reviewer', 'acct-b');
  assert.equal(fb.type, 'rv-fallback');
  assert.equal(fb.target.harness, 'fake');
});

test('a developer on an account exhausted on a stale reading still starts, as on main', () => {
  const now = Date.now();
  reading('fake2', 100, now + 2 * HOUR, now - HOUR);
  assert.doesNotThrow(() => admission.admitSpawn({ name: 'dev-1', harness: 'fake2', human: false }));
  assert.equal(admission.admitSpawn({ name: 'dev-2', harness: 'fake2', human: false }), null);
});

test('a reviewer with no fallback on a stale exhausted account still starts, as on main', () => {
  const now = Date.now();
  reading('fake2', 100, now + 2 * HOUR, now - HOUR);
  assert.equal(reviewerChain.freeFallback('reviewer-alone').type, null);
  assert.doesNotThrow(() => admission.admitSpawn({ name: 'rev-alone', harness: 'fake2', human: false }));
});

test('a fallback candidate whose own account is also exhausted on a stale reading is passed over', () => {
  const now = Date.now();
  reading('fake2', 100, now + 2 * HOUR, now - HOUR);
  reading('fake', 100, now + 2 * HOUR, now - HOUR);
  const fb = reviewerChain.freeFallback('reviewer', 'acct-b');
  assert.equal(fb.type, 'rv-last', fb.reasons.join('; '));
  assert.match(fb.reasons.join('; '), /rv-fallback: account acct-a is blocked: window \(five_hour at 100%/);
});
