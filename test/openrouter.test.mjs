#!/usr/bin/env node
// Unit tests for the OpenRouter credit balance: src/credits.ts against a throwaway
// STAM_HOME and a stubbed HTTP server (STAM_OPENROUTER_URL), no live daemon, no network.
// Run with `node --test test/openrouter.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-openrouter-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `openrouter-test-${process.pid}`;
// Nothing here talks to a daemon; drop a parent agent's pointers to the live one anyway.
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'OPENROUTER_API_KEY']) delete process.env[k];
writeFileSync(join(home, 'opencode.env'), 'OPENROUTER_API_KEY=test-key\n');
// The credit warning is 'important': the default humanMail.when 'necessary' sends it to the
// responsible manager only (docs/cost-policy.md, build step 11).
writeFileSync(join(home, 'settings.json'), JSON.stringify({ humanMail: { when: 'important' } }));

// The stub server stands in for openrouter.ai/api/v1: /credits and /key, each with its own
// status so a test can fail one call and leave the other working.
const state = {
  credits: { status: 200, total_credits: 10, total_usage: 1 },
  key: { status: 200, limit: null, limit_remaining: null },
};
const hits = [];
// Each call's path and Authorization header; while `holdCredits` is set, /credits waits for it (the call is pending at the server).
const calls = [];
let holdCredits = null;
let onCredits = () => {};
const server = createServer(async (req, res) => {
  hits.push(req.url);
  calls.push([req.url, req.headers.authorization]);
  res.setHeader('content-type', 'application/json');
  if (req.url === '/api/v1/credits' && holdCredits) {
    onCredits();
    await holdCredits;
  }
  if (req.url === '/api/v1/credits') {
    res.writeHead(state.credits.status);
    res.end(state.credits.status === 200 ? JSON.stringify({ data: { total_credits: state.credits.total_credits, total_usage: state.credits.total_usage } }) : '{}');
  } else if (req.url === '/api/v1/key') {
    res.writeHead(state.key.status);
    res.end(state.key.status === 200 ? JSON.stringify({ data: { limit: state.key.limit, limit_remaining: state.key.limit_remaining } }) : '{}');
  } else res.writeHead(404).end('{}');
});

let db, credits;
const entry = () => { const r = db.open().prepare("SELECT data FROM subscriptions WHERE name = 'openrouter'").get(); return r ? JSON.parse(r.data) : undefined; };
const creditsOf = () => entry()?.credits;
// The human's credit-warning mail, not the cost notice a manager (or the human fallback)
// gets for the same event, whose subject also names the low credit.
const lowMails = () => db.open().prepare("SELECT COUNT(*) AS n FROM mail m JOIN mail_recipients r ON r.mail_id = m.id WHERE r.agent_id = 'human' AND m.subject LIKE '%OpenRouter credit low%' AND m.subject NOT LIKE '%Cost notice%'").get().n;
const reset = () => db.open().prepare("DELETE FROM subscriptions WHERE name = 'openrouter'").run();
const setCredits = (o) => Object.assign(state.credits, { status: 200, total_credits: 10, total_usage: 1 }, o);
const setKey = (o) => Object.assign(state.key, { status: 200, limit: null, limit_remaining: null }, o);

before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.STAM_OPENROUTER_URL = `http://127.0.0.1:${server.address().port}/api/v1`;
  db = await import('../src/db.ts');
  credits = await import('../src/credits.ts');
  db.createAgent({ id: 'a1', name: 'spender', role: 'test', machine: 'x', harness: 'opencode', model: 'openrouter/deepseek/deepseek-v4.1-flash', effort: null, cwd: '/tmp', parent_id: null, session_id: null });
});
after(() => { server.close(); rmSync(home, { recursive: true, force: true }); });

test('pollCredits > stores the balance as a subscription entry', async () => {
  setCredits({ total_credits: 10, total_usage: 1.17 });
  setKey({});
  reset();
  const before = lowMails();
  await credits.pollCredits();
  const c = creditsOf();
  assert.equal(c.total, 10);
  assert.equal(c.used, 1.17);
  assert.ok(Math.abs(c.remaining - 8.83) < 1e-9);
  assert.equal(c.key_limit, null);
  assert.equal(lowMails(), before, 'above the threshold, so no warning');
  assert.ok(hits.includes('/api/v1/credits') && hits.includes('/api/v1/key'));
});

test('pollCredits > one poll uses one key: a rotation while /credits is pending does not reach /key', async () => {
  setCredits({});
  setKey({});
  reset();
  calls.length = 0;
  let release;
  holdCredits = new Promise((r) => (release = r));
  const reached = new Promise((r) => (onCredits = r));
  try {
    const poll = credits.pollCredits();
    await reached;
    // The key rotates while the server holds /credits; the poll's /key call still uses the key it started with.
    writeFileSync(join(home, 'opencode.env'), 'OPENROUTER_API_KEY=rotated-key\n');
    release();
    await poll;
  } finally {
    holdCredits = null;
    writeFileSync(join(home, 'opencode.env'), 'OPENROUTER_API_KEY=test-key\n');
  }
  assert.deepEqual(calls, [['/api/v1/credits', 'Bearer test-key'], ['/api/v1/key', 'Bearer test-key']]);
});

test('pollCredits > a key limit caps the remaining balance', async () => {
  setCredits({ total_credits: 10, total_usage: 1 });
  setKey({ limit: 5, limit_remaining: 4.5 });
  reset();
  await credits.pollCredits();
  assert.equal(creditsOf().remaining, 4.5, 'the smaller of account and key remaining');
  assert.equal(creditsOf().key_limit, 5);
});

test('pollCredits > a /credits 401 falls back to the key limit', async () => {
  setCredits({ status: 401 });
  setKey({ limit: 5, limit_remaining: 1.5 });
  reset();
  await credits.pollCredits();
  const c = creditsOf();
  assert.equal(c.remaining, 1.5, 'the key alone still gives a balance');
  assert.equal(c.key_limit, 5);
  assert.equal(c.total, null, 'no account totals from a failed /credits');
});

test('pollCredits > an error keeps the last valid reading, never zero', async () => {
  setCredits({ total_credits: 10, total_usage: 1 });
  setKey({});
  reset();
  await credits.pollCredits();
  assert.equal(creditsOf().remaining, 9);
  const before = lowMails();
  // Both calls fail: the stored balance must stay put and no warning may fire.
  setCredits({ status: 500 });
  setKey({ status: 429 });
  await credits.pollCredits();
  assert.equal(creditsOf().remaining, 9);
  assert.equal(lowMails(), before);
});

test('pollCredits > a /key error keeps the cap', async () => {
  setCredits({ total_credits: 10, total_usage: 1 });
  setKey({ limit: 5, limit_remaining: 4.5 });
  reset();
  await credits.pollCredits();
  assert.equal(creditsOf().remaining, 4.5);
  // Usage grows, but /key fails: the cap must not be silently dropped.
  setCredits({ total_credits: 10, total_usage: 3 });
  setKey({ status: 500 });
  await credits.pollCredits();
  assert.equal(creditsOf().remaining, 4.5, 'the last key remaining still caps the account');
  assert.equal(creditsOf().key_limit, 5);
  // When /key recovers, its newer figure wins.
  setKey({ limit: 5, limit_remaining: 2 });
  await credits.pollCredits();
  assert.equal(creditsOf().remaining, 2);
});

test('pollCredits > mails once per top-up and re-arms when the balance recovers', async () => {
  setCredits({ total_credits: 10, total_usage: 1 });
  setKey({});
  reset();
  const before = lowMails();
  await credits.pollCredits();
  assert.equal(lowMails(), before);

  // Drop below $2: warn once, naming the agent that uses OpenRouter.
  setCredits({ total_credits: 10, total_usage: 9.2 });
  await credits.pollCredits();
  assert.equal(lowMails(), before + 1);
  // Still low: no second mail for the same top-up.
  setCredits({ total_credits: 10, total_usage: 9.5 });
  await credits.pollCredits();
  assert.equal(lowMails(), before + 1);
  // Recover above the threshold, then drop again: warn again.
  setCredits({ total_credits: 20, total_usage: 0 });
  await credits.pollCredits();
  assert.equal(lowMails(), before + 1);
  setCredits({ total_credits: 20, total_usage: 19.9 });
  await credits.pollCredits();
  assert.equal(lowMails(), before + 2);
});

test('pollCredits > a top-up that stays below the threshold re-arms', async () => {
  setCredits({ total_credits: 10, total_usage: 9 });
  setKey({});
  reset();
  const before = lowMails();
  await credits.pollCredits();
  assert.equal(lowMails(), before + 1, 'warns at $1 left');
  // A top-up raises the capacity but spending keeps the balance below $2: warn again.
  setCredits({ total_credits: 12, total_usage: 11.5 });
  await credits.pollCredits();
  assert.equal(lowMails(), before + 2, 'a new top-up is warned about even while still low');
});

test('pollCredits > a warning goes out with no active agent', async () => {
  setCredits({ total_credits: 10, total_usage: 9 });
  setKey({});
  reset();
  const before = lowMails();
  db.updateAgent('a1', { lifecycle: 'shut_down' }); // the system sender needs no agent
  await credits.pollCredits();
  assert.equal(lowMails(), before + 1, 'the warning was sent');
  assert.equal(entry().pending, false);
  assert.equal(db.open().prepare("SELECT from_id FROM mail WHERE subject LIKE '%OpenRouter%' ORDER BY rowid DESC LIMIT 1").get()?.from_id, 'system:cost');
  db.updateAgent('a1', { lifecycle: 'active' });
});

test('pollCredits > keeps a warning pending until a send succeeds', async () => {
  setCredits({ total_credits: 10, total_usage: 9 });
  setKey({});
  reset();
  const before = lowMails();
  db.open().exec('ALTER TABLE mail RENAME TO mail_aside'); // the send fails
  try {
    await credits.pollCredits();
  } finally {
    db.open().exec('ALTER TABLE mail_aside RENAME TO mail');
  }
  assert.equal(lowMails(), before, 'nothing was sent');
  assert.equal(entry().pending, true, 'the warning stays pending');
  await credits.pollCredits();
  assert.equal(lowMails(), before + 1, 'the pending warning is retried');
  assert.equal(entry().pending, false);
});

test('pollCredits > no key, no call, no entry', async () => {
  // The key was imported into the secret store at first read (S-2114): no key means neither file.
  rmSync(join(home, 'opencode.env'));
  rmSync(join(home, 'secrets.json'), { force: true });
  reset();
  const count = hits.length;
  await credits.pollCredits();
  assert.equal(hits.length, count, 'without a key the stub is never called');
  assert.equal(entry(), undefined);
});

