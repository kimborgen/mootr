#!/usr/bin/env node
// Unit test for Codex usage and rate-limit readings (docs/cost-policy.md, build step 3).
// `thread/tokenUsage/updated` cumulative totals become the four token columns (uncached
// input, output which already includes reasoning, cache read, cache write), and
// `account/rateLimits/*` snapshots become a `codex` subscription entry in the shape Claude's
// windows use. The payloads are built from `codex app-server generate-json-schema`
// (codex-cli 0.162.1), not recorded from a live agent. Runs against a throwaway STAM_HOME,
// no daemon: `node --test test/codex-usage.test.mjs`.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-codex-usage-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `codex-usage-test-${process.pid}`;
// Nothing here talks to a daemon; drop pointers to the live one anyway.
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
// The subscription warning is 'important': the default humanMail.when 'necessary' sends it
// to the responsible manager only (docs/cost-policy.md, build step 11).
writeFileSync(join(home, 'settings.json'), JSON.stringify({ humanMail: { when: 'important' } }));

let db, codex;
before(async () => {
  db = await import('../src/db.ts');
  // Import the adapter index first: codex.ts imports usage.ts, which imports mail.ts, which
  // imports index.ts, and loading the index first keeps that cycle from seeing codex before
  // it is initialized.
  await import('../src/adapters/index.ts');
  codex = await import('../src/adapters/codex.ts');
});
after(() => rmSync(home, { recursive: true, force: true }));

let n = 0;
function agent() {
  const id = `c-agent-${++n}`;
  db.createAgent({ id, name: `codex-${n}`, role: 'test', machine: 'x', harness: 'codex', model: 'gpt-6.1-sol', effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  return db.getAgent(id);
}
const usageRow = (id) => db.open().prepare('SELECT * FROM usage WHERE agent_id = ?').get(id);
const subData = (name = 'codex') => {
  const row = db.open().prepare('SELECT data FROM subscriptions WHERE name = ?').get(name);
  return row ? JSON.parse(row.data) : undefined;
};

beforeEach(() => {
  db.open().exec('DELETE FROM usage');
  db.open().exec('DELETE FROM subscriptions');
});

// A `thread/tokenUsage/updated` params payload: the cumulative `total` and the model's
// context window, as the schema requires.
const tokenPayload = (threadId, total) => ({ threadId, turnId: 'turn-1', tokenUsage: { last: { ...total }, total, modelContextWindow: 200000 } });

test('thread/tokenUsage/updated > cumulative totals become the four token columns', () => {
  const a = agent();
  codex.recordTokenUsage(a, tokenPayload('thread-1', { inputTokens: 1000, cachedInputTokens: 400, cacheWriteInputTokens: 100, outputTokens: 150, reasoningOutputTokens: 50, totalTokens: 1150 }));
  let r = usageRow(a.id);
  assert.equal(r.cost_usd, 0); // Codex reports no cost
  assert.equal(r.tokens_in, 500); // input 1000 - 400 cached - 100 cache write
  assert.equal(r.tokens_out, 150); // outputTokens, which already includes reasoning
  assert.equal(r.tokens_cache_read, 400);
  assert.equal(r.tokens_cache_write, 100);
  // A later cumulative report counts only the growth, per counter.
  codex.recordTokenUsage(db.getAgent(a.id), tokenPayload('thread-1', { inputTokens: 1500, cachedInputTokens: 600, cacheWriteInputTokens: 200, outputTokens: 300, reasoningOutputTokens: 80, totalTokens: 1800 }));
  r = usageRow(a.id);
  assert.equal(r.tokens_in, 700); // 500 + 200
  assert.equal(r.tokens_out, 300); // 150 + 150
  assert.equal(r.tokens_cache_read, 600);
  assert.equal(r.tokens_cache_write, 200);
});

test('account/rateLimits/read > each bucket becomes its own subscription entry', () => {
  codex.recordRateLimitsRead({
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 42, resetsAt: 1893456000, windowDurationMins: 300 },
      secondary: { usedPercent: 7, resetsAt: 1894060800, windowDurationMins: 10080 },
      credits: { hasCredits: true, unlimited: false, balance: '18.40' },
      planType: 'plus',
    },
    rateLimitsByLimitId: {
      codex: {}, // the default bucket, already covered by `rateLimits`
      codex_other: { limitId: 'codex_other', primary: { usedPercent: 88, resetsAt: 1735693200, windowDurationMins: 30 }, planType: 'plus' },
    },
  });
  const data = subData();
  assert.deepEqual(data.five_hour, { used_percentage: 42, resets_at: 1893456000 });
  assert.deepEqual(data.seven_day, { used_percentage: 7, resets_at: 1894060800 });
  assert.deepEqual(data.credits, { hasCredits: true, unlimited: false, balance: '18.40' });
  assert.equal(data.planType, 'plus');
  // The other bucket has its own entry, so its warnings have their own keys.
  assert.equal(subData('codex:codex_other')['30m'].used_percentage, 88);
  assert.equal(subData('codex:codex'), undefined); // the default bucket isn't duplicated
});

test('account/rateLimits/read > replaces a bucket, dropping a removed window', () => {
  codex.recordRateLimitsRead({ rateLimits: { limitId: 'codex', primary: { usedPercent: 42, windowDurationMins: 300 }, secondary: { usedPercent: 7, windowDurationMins: 10080 }, planType: 'plus' } });
  // The read no longer names a secondary window: replacing drops it, where a merge kept it.
  codex.recordRateLimitsRead({ rateLimits: { limitId: 'codex', primary: { usedPercent: 50, windowDurationMins: 300 }, planType: 'plus' } });
  const data = subData();
  assert.equal(data.five_hour.used_percentage, 50);
  assert.equal(data.seven_day, undefined);
});

test('account/rateLimits/updated > a sparse update merges into its bucket', () => {
  codex.recordRateLimitsRead({ rateLimits: { limitId: 'codex', primary: { usedPercent: 42, resetsAt: 1893456000, windowDurationMins: 300 }, planType: 'plus' } });
  // Only the secondary window and a null planType come through: neither clears a known value.
  codex.recordRateLimits({ rateLimits: { limitId: 'codex', secondary: { usedPercent: 90, resetsAt: 1894060800, windowDurationMins: 10080 }, planType: null } });
  const data = subData();
  assert.equal(data.five_hour.used_percentage, 42);
  assert.equal(data.seven_day.used_percentage, 90);
  assert.equal(data.planType, 'plus');
});

test('account/rateLimits > an unnamed window duration is keyed by its minutes', () => {
  codex.recordRateLimits({ rateLimits: { limitId: 'codex', primary: { usedPercent: 10, windowDurationMins: 1440 } } });
  assert.equal(subData()['1440m'].used_percentage, 10);
});

test('account/rateLimits > a window at a warn threshold mails the human', async () => {
  agent(); // the mail needs a running agent as its sender
  // reportSubscription warns at 80 and 95 percent on the same used_percentage it stored.
  codex.recordRateLimitsRead({ rateLimits: { limitId: 'codex', primary: { usedPercent: 96, resetsAt: 1999999999, windowDurationMins: 300 } } });
  // The human's mail is sent asynchronously, so poll until it lands rather than read it at once.
  const mailed = () => db.open().prepare("SELECT subject FROM mail WHERE subject LIKE '%codex%'").all();
  for (let i = 0; i < 100 && !mailed().some((m) => /five-hour usage at 96%/.test(m.subject)); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(mailed().some((m) => /five-hour usage at 96%/.test(m.subject)), JSON.stringify(mailed()));
});
