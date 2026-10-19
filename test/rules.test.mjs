#!/usr/bin/env node
// Unit tests for the user's cost rules (docs/cost-policy.md, Rule enforcement; src/rules.ts):
// window, paid-forbidden and credits-out blockers set and cleared from readings and cost
// signals. For each rule: it sets, re-evaluating is idempotent (same `since`, no new
// events), a fresh reading clears it, a stale one doesn't, window and paid-forbidden
// clear on a timer past their reset with no reading, and an unmanaged agent is never
// touched. Runs against a throwaway STAM_HOME with stubbed harness prompts; no daemon, no
// network, no models: `node --test test/rules.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-rules-');
const socket = `rules-test-${process.pid}`;
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = socket;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(
  join(home, 'settings.json'),
  JSON.stringify({
    peers: [],
    cost: {
      subscriptionWarnPercent: [],
      accounts: {
        'claude-max': { match: { harness: 'claude' }, paid: false },
        'codex-plus': { match: { harness: 'codex' }, paid: false },
        openrouter: { match: { harness: 'opencode', model: 'openrouter/' }, subscription: false, lowCreditsUsd: 2 },
      },
    },
  }),
);

let db, blockers, rules, usage, admission, probes;
const prompts = new Map();
// How long the stub harness takes to take a prompt, such as the pause notice.
let slowMs = 0;
before(async () => {
  db = await import('../src/db.ts');
  blockers = await import('../src/blockers.ts');
  rules = await import('../src/rules.ts');
  usage = await import('../src/usage.ts');
  admission = await import('../src/admission.ts');
  probes = await import('../src/cost-probes.ts');
  const { adapters } = await import('../src/adapters/index.ts');
  for (const h of ['claude', 'codex', 'opencode'])
    adapters[h].pushPrompt = async (a, text) => {
      if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
      prompts.set(a.id, [...(prompts.get(a.id) ?? []), text]);
      return true;
    };
});
after(() => {
  spawnSync('tmux', ['-L', socket, 'kill-server']);
  rmSync(home, { recursive: true, force: true });
});

let n = 0;
function agent(harness, model = null) {
  const id = db.newAgentId();
  db.createAgent({ id, name: `r${++n}`, role: '', machine: 'test', harness, model, effort: null, cwd: home, parent_id: null, session_id: null });
  db.updateAgent(id, { activity: 'working' });
  return db.getAgent(id);
}
const get = (a) => db.getAgent(a.id);
const of = (a, kind) => blockers.blockers(a).find((b) => b.kind === kind);
const events = (a, type) => db.listEvents(a.id, 500).filter((e) => e.type === type).map((e) => JSON.parse(e.data ?? 'null'));
const MIN = 60_000;
const settle = () => new Promise((r) => setTimeout(r, 50));
// Readings at a chosen time; reportSubscription evaluates the rules itself.
async function claude(now, five, resetsAt = Math.floor(now / 1000) + 3600) {
  usage.reportSubscription('claude', { five_hour: { used_percentage: five, resets_at: resetsAt }, seven_day: { used_percentage: 40, resets_at: resetsAt + 86400 } }, now);
  await rules.evaluateRules('claude-max', {}, now); // waits for the chained evaluation
}
// Writes a reading without evaluating the rules, as one stored before a daemon start.
function store(name, data, at) {
  db.open()
    .prepare('INSERT INTO subscriptions (name, data, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
    .run(name, JSON.stringify(data), new Date(at).toISOString());
}
function reset() {
  db.open().prepare('DELETE FROM blockers').run();
  db.open().prepare('DELETE FROM account_holds').run();
  db.open().prepare('DELETE FROM subscriptions').run();
  db.open().prepare("UPDATE agents SET lifecycle = 'archived'").run();
}

test('window: a fresh 100% reading on a paid: false account blocks every agent on it, is idempotent, and a fresh reading below 100% clears it', async () => {
  reset();
  const t0 = Date.now();
  const a = agent('claude');
  const b = agent('claude');
  const free = agent('fake'); // unmanaged
  await claude(t0, 100);
  for (const x of [a, b]) {
    const w = of(x, 'window');
    assert.ok(w, 'window blocker set');
    assert.equal(w.account, 'claude-max');
    assert.match(w.reason, /five_hour at 100%, resets \d{4}-\d\d-\d\d \d\d:\d\d UTC/);
    assert.equal(get(x).lifecycle, 'paused');
  }
  assert.equal(blockers.blockers(free).length, 0, 'unmanaged agent untouched');
  assert.equal(get(free).lifecycle, 'active');
  assert.equal(events(a, 'cost:rule').filter((e) => e.action === 'set' && e.rule === 'window').length, 1);
  // Idempotent: the same reading again keeps since and records nothing new.
  const since = of(a, 'window').since;
  await claude(t0 + MIN, 100, Math.floor(t0 / 1000) + 3600);
  await rules.evaluateAll(t0 + MIN);
  assert.equal(of(a, 'window').since, since);
  assert.equal(events(a, 'cost:rule').length, 1);
  assert.equal(events(a, 'blocker:add').length, 1);
  // The gate refuses a turn and a spawn onto the account; an unmanaged spawn passes.
  assert.equal(admission.admit(a, 'mail').ok, false);
  assert.throws(() => admission.admitSpawn({ name: 'new', harness: 'claude', human: false }), /account claude-max is blocked: window/);
  assert.equal(admission.admitSpawn({ name: 'new', harness: 'fake', human: false }), null);
  // A fresh reading below 100% clears it and unpauses both.
  await claude(t0 + 2 * MIN, 3, Math.floor(t0 / 1000) + 5 * 3600);
  await settle();
  for (const x of [a, b]) {
    assert.equal(of(x, 'window'), undefined);
    assert.equal(get(x).lifecycle, 'active');
  }
  assert.equal(events(a, 'cost:rule').filter((e) => e.action === 'clear').length, 1);
});

test('window: a stale reading neither sets nor clears; past resets_at, within the margin, needs a fresh reading', async () => {
  reset();
  const t0 = Date.now();
  const a = agent('claude');
  // An old 100% reading, evaluated now (as at daemon start), sets nothing.
  store('claude', { five_hour: { used_percentage: 100, resets_at: Math.floor(t0 / 1000) + 3600 } }, t0 - 20 * MIN);
  await rules.evaluateAll(t0);
  assert.equal(of(a, 'window'), undefined);
  // Set it fresh; a reading below 100% that has gone stale doesn't clear it.
  const resets = Math.floor(t0 / 1000) + 3600;
  await claude(t0, 100, resets);
  assert.ok(of(a, 'window'));
  store('claude', { five_hour: { used_percentage: 3, resets_at: resets } }, t0 + 1000);
  await rules.evaluateAll(t0 + 20 * MIN);
  assert.ok(of(a, 'window'), 'stale reading');
  // Past resets_at but within the margin, with no fresh reading: still set.
  await rules.evaluateAll(resets * 1000 + 30_000);
  assert.ok(of(a, 'window'), 'within the margin');
  // A fresh reading after the reset that still carries the old 100% and resets_at confirms it.
  usage.reportSubscription('claude', { five_hour: { used_percentage: 100, resets_at: resets } }, resets * 1000 + 40_000);
  await rules.evaluateRules('claude-max', {}, resets * 1000 + 40_000);
  assert.equal(of(a, 'window'), undefined);
  const clear = events(a, 'cost:rule').find((e) => e.action === 'clear');
  assert.equal(clear.unconfirmed, undefined, 'confirmed by a reading');
});

test('window and paid-forbidden: with no fresh reading they clear on a timer at resets_at plus the margin, marked unconfirmed', async () => {
  reset();
  rules.setResetMargin(200);
  try {
    const t0 = Date.now();
    const a = agent('claude');
    const resets = Math.ceil(t0 / 1000) + 1;
    usage.reportSubscription('claude', { five_hour: { used_percentage: 100, resets_at: resets } }, t0);
    usage.report(a, { cost: 1 }, t0);
    usage.report(get(a), { cost: 2 }, t0 + 1);
    await rules.evaluateRules('claude-max', {}, t0);
    assert.ok(of(a, 'window'));
    assert.ok(of(a, 'paid-forbidden'));
    // No reading and no evaluation from here: only the timer can clear them.
    await new Promise((r) => setTimeout(r, resets * 1000 + 200 + 400 - Date.now()));
    await rules.evaluateRules('claude-max', {}, Date.now()); // waits for the timer's evaluation in the chain
    assert.equal(of(a, 'window'), undefined);
    assert.equal(of(a, 'paid-forbidden'), undefined);
    const clears = events(a, 'cost:rule').filter((e) => e.action === 'clear');
    assert.deepEqual(clears.map((e) => [e.rule, e.unconfirmed]).sort(), [['paid-forbidden', true], ['window', true]]);
    assert.equal(get(a).lifecycle, 'active');
  } finally {
    rules.setResetMargin(60_000);
  }
});

test('window: at daemon start, a blocker whose resets_at has passed clears with no fresh reading; a limit blocker with no reset time stays', async () => {
  reset();
  const t0 = Date.now();
  const a = agent('claude');
  const b = agent('claude');
  const past = Math.floor(t0 / 1000) - 600;
  await blockers.addBlocker(a, { kind: 'window', account: 'claude-max', reason: 'five_hour at 100%', clear: { windows: { five_hour: { pct: 100, resets_at: past, after: new Date(t0 - 3600_000).toISOString() } } } });
  await rules.evaluateAll();
  assert.equal(of(a, 'window'), undefined);
  assert.equal(events(a, 'cost:rule').find((e) => e.action === 'clear')?.unconfirmed, true);
  // A limit error that named no window keeps waiting for a fresh reading.
  rules.signal(b.id, { source: 'StopFailure', class: 'limit', error: 'rate_limit' });
  await rules.evaluateRules('claude-max', {}, t0 + 3 * 3600_000);
  assert.match(of(b, 'window')?.reason ?? '', /no window named/);
});

test('window: a limit error blocks the account even below 100%, and only a reading taken after it clears it', async () => {
  reset();
  const t0 = Date.now();
  usage.reportSubscription('claude', { five_hour: { used_percentage: 87, resets_at: Math.floor(t0 / 1000) + 3600 } }, t0 - MIN);
  const a = agent('claude');
  const b = agent('claude');
  rules.signal(a.id, { source: 'StopFailure', class: 'limit', error: 'rate_limit' });
  await rules.evaluateRules('claude-max', {}, t0);
  for (const x of [a, b]) assert.match(of(x, 'window')?.reason ?? '', /limit error \(StopFailure \(rate_limit\)\): five_hour at 87%/);
  // The fresh window's reset time is the deadline, not '*'.
  assert.equal(of(a, 'window').clear.windows.five_hour.resets_at, Math.floor(t0 / 1000) + 3600);
  assert.equal(events(a, 'cost:signal').length, 1);
  // The reading from before the error doesn't clear it; a later one does.
  await rules.evaluateAll(Date.now());
  assert.ok(of(a, 'window'));
  const t1 = Date.now() + 1000;
  usage.reportSubscription('claude', { five_hour: { used_percentage: 88, resets_at: Math.floor(t0 / 1000) + 3600 } }, t1);
  await rules.evaluateRules('claude-max', {}, t1);
  assert.equal(of(a, 'window'), undefined);
  assert.equal(of(b, 'window'), undefined);
});

test('an unmanaged agent ignores limit and credits signals; an account without windows gets no window blocker', async () => {
  reset();
  const t0 = Date.now();
  const or = agent('opencode', 'openrouter/x');
  const free = agent('fake');
  rules.signal(free.id, { source: 'x', class: 'limit' });
  rules.signal(free.id, { source: 'x', class: 'credits' });
  await settle();
  assert.equal(blockers.blockers(free).length, 0);
  await rules.evaluateRules('openrouter', {}, t0);
  assert.equal(blockers.blockers(or).length, 0);
});

test('paid-forbidden: Claude cost growing while a window reads 100% sets it; it clears only after the window resets', async () => {
  reset();
  const t0 = Date.now();
  const a = agent('claude');
  const resets = Math.floor(t0 / 1000) + 3600;
  usage.reportSubscription('claude', { five_hour: { used_percentage: 100, resets_at: resets } }, t0);
  usage.report(a, { cost: 1 }, t0);
  usage.report(get(a), { cost: 1.5 }, t0 + 1000);
  await rules.evaluateRules('claude-max', {}, t0 + 1000);
  const p = of(a, 'paid-forbidden');
  assert.ok(p, 'paid-forbidden set');
  assert.match(p.reason, /paid spend on a paid: false account: r\d+'s cost grew \$1\.0000.*clears when five_hour resets \d{4}-/);
  // More spend keeps the same blocker.
  usage.report(get(a), { cost: 2 }, t0 + 2000);
  await rules.evaluateRules('claude-max', {}, t0 + 2000);
  assert.equal(of(a, 'paid-forbidden').since, p.since);
  assert.equal(events(a, 'cost:rule').filter((e) => e.rule === 'paid-forbidden').length, 1);
  // Before the reset a fresh reading doesn't clear it; after it, within the margin, a stale one doesn't either.
  usage.reportSubscription('claude', { five_hour: { used_percentage: 100, resets_at: resets } }, t0 + 3000);
  await rules.evaluateRules('claude-max', {}, t0 + 3000);
  assert.ok(of(a, 'paid-forbidden'));
  await rules.evaluateAll(resets * 1000 + 30_000);
  assert.ok(of(a, 'paid-forbidden'), 'stale reading after the reset');
  // A fresh reading after resets_at clears it (and the window blocker with it).
  const t1 = resets * 1000 + 40_000;
  usage.reportSubscription('claude', { five_hour: { used_percentage: 2, resets_at: resets + 18000 } }, t1);
  await rules.evaluateRules('claude-max', {}, t1);
  assert.equal(of(a, 'paid-forbidden'), undefined);
  assert.equal(of(a, 'window'), undefined);
  assert.equal(get(a).lifecycle, 'active');
});

test('paid-forbidden: a Codex credits balance that drops sets it', async () => {
  reset();
  const t0 = Date.now();
  const a = agent('codex');
  const free = agent('fake');
  const resets = Math.floor(t0 / 1000) + 600;
  usage.reportSubscription('codex', { five_hour: { used_percentage: 50, resets_at: resets }, credits: { balance: '5.00' } }, t0);
  await rules.evaluateRules('codex-plus', {}, t0);
  assert.equal(of(a, 'paid-forbidden'), undefined, 'a first balance is not a drop');
  usage.reportSubscription('codex', { five_hour: { used_percentage: 50, resets_at: resets }, credits: { balance: '4.20' } }, t0 + 1000);
  await rules.evaluateRules('codex-plus', {}, t0 + 1000);
  assert.match(of(a, 'paid-forbidden')?.reason ?? '', /credits balance fell from 5 to 4\.2; clears when five_hour resets/);
  assert.equal(blockers.blockers(free).length, 0);
  const t1 = resets * 1000 + 1000;
  usage.reportSubscription('codex', { five_hour: { used_percentage: 0, resets_at: resets + 18000 }, credits: { balance: '4.20' } }, t1);
  await rules.evaluateRules('codex-plus', {}, t1);
  assert.equal(of(a, 'paid-forbidden'), undefined);
});

function openrouter(remaining, now) {
  const credits = { remaining, observed_at: new Date(now).toISOString() };
  store('openrouter', { credits }, now);
  return rules.onReading('openrouter', null, { credits }, now);
}

test('credits-out: an OpenRouter balance at zero sets it, idempotently; a stale reading never clears it; a fresh balance >= lowCreditsUsd does', async () => {
  reset();
  const t0 = Date.now();
  const a = agent('opencode', 'openrouter/deepseek/x');
  const other = agent('opencode', 'anthropic/x'); // opencode, not OpenRouter: unmanaged
  await openrouter(0, t0);
  assert.match(of(a, 'credits-out')?.reason ?? '', /OpenRouter credit balance is \$0\.00/);
  assert.equal(get(a).lifecycle, 'paused');
  assert.equal(blockers.blockers(other).length, 0);
  assert.throws(() => admission.admitSpawn({ name: 'n', harness: 'opencode', model: 'openrouter/y', human: false }), /credits-out/);
  const since = of(a, 'credits-out').since;
  await openrouter(-0.01, t0 + 1000);
  await openrouter(-0.01, t0 + 2000);
  assert.equal(of(a, 'credits-out').since, since);
  assert.equal(events(a, 'blocker:add').length, 2, 'only the reason change re-adds it');
  // Topped up, but only to below lowCreditsUsd: still out.
  await openrouter(1, t0 + 3000);
  assert.ok(of(a, 'credits-out'));
  // Topped up, then evaluated once the reading is stale: still out until a fresh one.
  db.open().prepare('UPDATE subscriptions SET data = ?, updated_at = ? WHERE name = ?').run(JSON.stringify({ credits: { remaining: 10, observed_at: new Date(t0 - 20 * MIN).toISOString() } }), new Date(t0 - 20 * MIN).toISOString(), 'openrouter');
  await rules.evaluateAll(t0 + 4000);
  assert.ok(of(a, 'credits-out'), 'stale balance');
  await openrouter(10, t0 + 5000);
  assert.equal(of(a, 'credits-out'), undefined);
  assert.equal(get(a).lifecycle, 'active');
});

test('credits-out: an archived or shut-down agent gets no blocker, and its manager no notice (S-787)', async () => {
  reset();
  const t0 = Date.now();
  const mgr = agent('fake'); // a live manager, off the account
  const down = agent('opencode', 'openrouter/deepseek/x');
  const archived = agent('opencode', 'openrouter/deepseek/x');
  const live = agent('opencode', 'openrouter/deepseek/x');
  db.updateAgent(down.id, { lifecycle: 'shut_down', activity: 'unknown' });
  db.updateAgent(archived.id, { lifecycle: 'archived', activity: 'unknown' });
  // A parent each, so a blocker-set notice would have a manager to reach.
  db.open().prepare('UPDATE agents SET parent_id = ? WHERE id IN (?, ?, ?)').run(mgr.id, down.id, archived.id, live.id);
  await openrouter(0, t0);
  assert.equal(of(down, 'credits-out'), undefined, 'no blocker on a shut-down agent');
  assert.equal(of(archived, 'credits-out'), undefined, 'no blocker on an archived agent');
  assert.equal(get(down).lifecycle, 'shut_down');
  assert.equal(get(archived).lifecycle, 'archived');
  assert.ok(of(live, 'credits-out'), 'a live agent on the account still gets it');
  assert.equal(get(live).lifecycle, 'paused');
  assert.equal(events(mgr, 'cost:notice').length, 1, 'only the live agent\'s notice reached the manager');
});

test('credits-out: a credits signal sets it, Codex spendControlReached sets it, and a fresh reading with headroom clears it', async () => {
  reset();
  const t0 = Date.now();
  const a = agent('codex');
  rules.signal(a.id, { source: 'turn/completed', class: 'credits', codexErrorInfo: 'sessionBudgetExceeded' });
  await rules.evaluateRules('codex-plus', {}, t0);
  assert.match(of(a, 'credits-out')?.reason ?? '', /a credits error, turn\/completed \(sessionBudgetExceeded\)/);
  const t1 = Date.now() + 1000;
  usage.reportSubscription('codex', { five_hour: { used_percentage: 30, resets_at: Math.floor(t1 / 1000) + 3600 }, spendControlReached: true }, t1);
  await rules.evaluateRules('codex-plus', {}, t1);
  assert.match(of(a, 'credits-out')?.reason ?? '', /spend control reached/);
  const t2 = t1 + 1000;
  usage.reportSubscription('codex', { five_hour: { used_percentage: 30, resets_at: Math.floor(t1 / 1000) + 3600 }, spendControlReached: false }, t2);
  await rules.evaluateRules('codex-plus', {}, t2);
  assert.equal(of(a, 'credits-out'), undefined);
});

test('credits-out: a failed OpenRouter poll keeps the old observation time, so it never clears a blocker a credits error set', async () => {
  reset();
  const { createServer } = await import('node:http');
  let mode = { remaining: 10, fail: false };
  const server = createServer((req, res) => {
    if (mode.fail) return res.writeHead(500).end();
    const body = req.url.endsWith('/credits') ? { data: { total_credits: 10, total_usage: 10 - mode.remaining } } : { data: { limit: null, limit_remaining: null } };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.STAM_OPENROUTER_URL = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(home, 'opencode.env'), 'OPENROUTER_API_KEY=test-key\n');
  const credits = await import('../src/credits.ts');
  const poll = async () => {
    await credits.pollCredits();
    await rules.evaluateRules('openrouter');
  };
  try {
    const a = agent('opencode', 'openrouter/deepseek/x');
    await poll(); // $10 left, observed now
    assert.equal(of(a, 'credits-out'), undefined);
    await new Promise((r) => setTimeout(r, 5));
    rules.signal(a.id, { source: 'session.execution.failed', class: 'credits', status: 402 });
    await rules.evaluateRules('openrouter');
    assert.ok(of(a, 'credits-out'), 'set by the 402');
    // Both calls fail: the entry is rewritten from the last figures with a new updated_at.
    mode = { remaining: 10, fail: true };
    await poll();
    assert.ok(of(a, 'credits-out'), 'a failed poll is not a fresh balance');
    // A poll that fetches the balance clears it.
    mode = { remaining: 10, fail: false };
    await poll();
    assert.equal(of(a, 'credits-out'), undefined);
  } finally {
    server.close();
    delete process.env.STAM_OPENROUTER_URL;
  }
});

test('credits-out: a Claude billing error holds past 30 minutes and starts the account probe that clears it', async () => {
  reset();
  const t0 = Date.now();
  const a = agent('claude');
  rules.signal(a.id, { source: 'StopFailure', class: 'credits', error: 'billing_error' });
  await rules.evaluateRules('claude-max', {}, t0);
  const b = of(a, 'credits-out');
  assert.match(b?.reason ?? '', /billing_error.*stam probes the account \(1, 2, 4, 8, 16 minutes, then every 16\) and clears this when one succeeds/);
  await settle();
  assert.equal(probes.nextProbe('claude-max')?.attempt, 0, 'the probe is scheduled');
  await rules.evaluateRules('claude-max', {}, Date.parse(b.clear.after) + 3 * 3600_000);
  assert.ok(of(a, 'credits-out'), 'no timer lifts it');
  await rules.probeCleared('claude-max', 'a probe succeeded', probes.generation('claude-max'));
  assert.equal(of(a, 'credits-out'), undefined);
  probes.reset();
});

test('credits-out: a paid: false Codex account at zero balance with its window exhausted gets only the window blocker', async () => {
  reset();
  const t0 = Date.now();
  const a = agent('codex');
  const resets = Math.floor(t0 / 1000) + 3600;
  usage.reportSubscription('codex', { five_hour: { used_percentage: 100, resets_at: resets }, credits: { balance: '0' } }, t0);
  await rules.evaluateRules('codex-plus', {}, t0);
  assert.ok(of(a, 'window'));
  assert.equal(of(a, 'credits-out'), undefined);
});

test('spawn: an exhausted account with no agent on it refuses the first spawn; a forced one gets the blockers before launch', async () => {
  reset();
  const t0 = Date.now();
  store('claude', { five_hour: { used_percentage: 100, resets_at: Math.floor(t0 / 1000) + 3600 } }, t0);
  assert.equal(blockers.blockersFor('claude-max').length, 0, 'no agent, no rows');
  assert.throws(() => admission.admitSpawn({ name: 'first', harness: 'claude', human: false }), /account claude-max is blocked: window \(five_hour at 100%/);
  const held = admission.admitSpawn({ name: 'first', harness: 'claude', human: true, force: true });
  assert.equal(held.account, 'claude-max');
  // As daemon.spawn does for a forced spawn, before startHarness.
  const a = agent('claude');
  db.updateAgent(a.id, { lifecycle: 'paused' });
  await rules.attachSpawn(get(a));
  assert.match(of(a, 'window')?.reason ?? '', /five_hour at 100%/);
  assert.equal(get(a).lifecycle, 'paused');
});

test('timer: a deadline that passes while the pause notice is being delivered still clears the blocker', async () => {
  reset();
  rules.setResetMargin(0);
  slowMs = 2500;
  try {
    const t0 = Date.now();
    const a = agent('claude');
    const resets = Math.ceil(t0 / 1000) + 1;
    await claude(t0, 100, resets); // returns after the slow pause delivery, past the deadline
    assert.ok(Date.now() > resets * 1000, 'the deadline passed during the pause');
    // No further reading or call: the timer set before the pause does it.
    await new Promise((r) => setTimeout(r, 300));
    await settle();
    assert.equal(of(a, 'window'), undefined);
  } finally {
    slowMs = 0;
    rules.setResetMargin(60_000);
  }
});

test('parseResetTime: reads a time of day, rolls to the next day when past, null when none', () => {
  const at = (h, m) => new Date(2026, 9, 13, h, m, 0, 0).getTime();
  const now = at(14, 2);
  assert.equal(rules.parseResetTime("You've hit your usage limit. Try again at 3:25 PM.", now), at(15, 25));
  assert.equal(rules.parseResetTime('try again at 12:05 AM', now), at(24, 5));
  assert.equal(rules.parseResetTime('try again at 15:25', now), at(15, 25));
  assert.equal(rules.parseResetTime('try again at 1:00 PM', now), at(13, 0) + 86400_000);
  assert.equal(rules.parseResetTime('try again later', now), null);
  assert.equal(rules.parseResetTime(undefined, now), null);
  // The dated form of a longer limit keeps its date, not tomorrow.
  assert.equal(rules.parseResetTime('Try again at Oct 17th, 2026 9:05 AM.', now), new Date(2026, 9, 17, 9, 5).getTime());
  assert.equal(rules.parseResetTime('Try again at Nov 2, 2026 12:00 PM.', now), new Date(2026, 10, 2, 12, 0).getTime());
  // A date it can't read, or a named zone, falls to the default.
  assert.equal(rules.parseResetTime('Try again at Octember 17th 9:05 AM.', now), null);
  assert.equal(rules.parseResetTime('retry after 2026-10-13T15:25:00Z', now), null);
  assert.equal(rules.parseResetTime('try again at 3:25 PM UTC', now), null);
  // Truncated to the minute: a time a few seconds past means now; an hour and more means tomorrow.
  const late = new Date(2026, 9, 13, 15, 25, 30).getTime();
  assert.equal(rules.parseResetTime('try again at 3:25 PM', late), late);
  assert.equal(rules.parseResetTime('try again at 3:25 PM', late + 2 * 3600_000), at(15, 25) + 86400_000);
});

test('window: a Codex usage-limit message holds the account until its reset time, past the agent that hit it', async () => {
  reset();
  const t0 = Date.now();
  // A stale reading: no fresh window, as in S-381.
  store('codex', { five_hour: { used_percentage: 77, resets_at: Math.floor(t0 / 1000) + 3600 } }, t0 - 3 * 3600_000);
  const a = agent('codex', 'gpt-6.1-sol');
  assert.equal(admission.accountHeld({ harness: 'codex', model: 'gpt-6.1-sol' }), null);
  const reset1 = new Date(t0 + 3600_000);
  const hh = reset1.getHours() % 12 || 12;
  const msg = `You've hit your usage limit. Try again at ${hh}:${String(reset1.getMinutes()).padStart(2, '0')} ${reset1.getHours() >= 12 ? 'PM' : 'AM'}.`;
  rules.signal(a.id, { source: 'turn/completed', class: 'limit', codexErrorInfo: 'usageLimitExceeded', message: msg });
  await rules.evaluateRules('codex-plus', {}, t0);
  const w = of(a, 'window');
  assert.ok(w);
  assert.ok(Math.abs(w.clear.windows['*'].resets_at * 1000 - reset1.getTime()) < 60_000);
  // The agent dies and is archived; its blockers go, the account hold stays.
  db.deleteBlockers(a.id);
  assert.match(admission.accountHeld({ harness: 'codex', model: 'gpt-6.1-sol' })?.reason ?? '', /window/);
  // After the reset time the hold is gone.
  assert.equal(rules.spawnBlockers('codex-plus', reset1.getTime() + 5 * MIN).length, 0);
});

test('window: a usage-limit message with no time holds the account for 30 minutes and says so', async () => {
  reset();
  const t0 = Date.now();
  const a = agent('codex', 'gpt-6.1-sol');
  rules.signal(a.id, { source: 'turn/completed', class: 'limit', message: 'You have hit your limit.' });
  await rules.evaluateRules('codex-plus', {}, t0);
  assert.match(of(a, 'window')?.reason ?? '', /held 30 minutes/);
  assert.equal(rules.spawnBlockers('codex-plus', t0 + 10 * MIN).length > 0, true);
  assert.equal(rules.spawnBlockers('codex-plus', t0 + 32 * MIN).length, 0);
});

test('window: a usage-limit hold survives a restart, and a new agent gets the blocker before launch', async () => {
  reset();
  const t0 = Date.now();
  const a = agent('codex', 'gpt-6.1-sol');
  rules.signal(a.id, { source: 'turn/completed', class: 'limit', message: 'try again later' });
  await rules.evaluateRules('codex-plus', {}, t0);
  // A restart: the agents' blockers are rebuilt from the readings and the hold alone.
  db.open().prepare('DELETE FROM blockers').run();
  await rules.evaluateAll(t0 + MIN);
  const b = agent('codex', 'gpt-6.1-sol');
  await rules.attachSpawn(b);
  assert.match(of(b, 'window')?.reason ?? '', /held 30 minutes/);
});
