#!/usr/bin/env node
// Unit tests for build step 14 of docs/cost-policy.md: when a cost notice about a blocked agent
// goes cost.fallbackMinutes without its manager acting, stam applies the account's action and
// tells the chief of staff. Covers an ack in time, a take-over to an eligible preset, the
// fall-through to `else`, `continue` on a paid account, the timer across a daemon restart, the
// chief of staff's notice, and the human when the chief of staff is blocked. Runs against a
// throwaway STAM_HOME with its own tmux socket and fake harnesses; no daemon, no network, no
// models: `node --test test/cost-fallback.test.mjs`.
import { test, before, after, beforeEach } from 'node:test';
import { killTmuxServer } from '../src/tmux-socket.ts';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempHome } from './tmphome.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const home = tempHome('stam-cost-fallback-');
const socket = `cost-fallback-test-${process.pid}`;
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = socket;
// The private tmux server goes with the process on every exit, even when after() never runs (a signal, a crash).
process.on('exit', () => killTmuxServer(socket));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(130));
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(
  join(home, 'settings.json'),
  JSON.stringify({
    peers: [],
    chiefOfStaff: 'cos',
    humanMail: { when: 'necessary' },
    cost: {
      subscriptionWarnPercent: [],
      fallbackMinutes: 15,
      softStopMinutes: 0.02,
      accounts: {
        'acct-a': { match: { harness: 'fake' }, paid: false, onSubExhausted: { action: 'take-over', to: ['cheap'], else: 'wait' } },
        'acct-b': { match: { harness: 'fake2' }, paid: false },
        'acct-p': { match: { harness: 'fake3' }, paid: true, onCreditsOut: 'continue', onBudgetExhausted: 'continue' },
      },
    },
  }),
);
// Reviewer types: reviewer (fake2, account acct-b) falls to rv-fallback (fake, acct-a), then rv-paid (fake3, acct-p).
const rvType = (harness, model, effort, fallback) => ({ description: 'test reviewer', harness, model, effort, review: { fallback, ring: null } });
const writeRegistry = (types) => writeFileSync(join(home, 'registry.json'), JSON.stringify({ presets: { cheap: { harness: 'fake2', model: 'cheap-model', effort: 'low' } }, types }));
const baseTypes = () => ({
  reviewer: rvType('fake2', null, null, 'rv-fallback'),
  'rv-fallback': rvType('fake', 'rv-model', 'medium', 'rv-paid'),
  'rv-paid': rvType('fake3', 'other', 'low', null),
});
writeRegistry(baseTypes());

let db, blockers, costNotices, fallback, accounts, lifecycle;
const MIN = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
before(async () => {
  db = await import('../src/db.ts');
  blockers = await import('../src/blockers.ts');
  costNotices = await import('../src/cost-notices.ts');
  fallback = await import('../src/cost-fallback.ts');
  accounts = await import('../src/accounts.ts');
  lifecycle = await import('../src/lifecycle.ts');
  const { adapters } = await import('../src/adapters/index.ts');
  const fake = (name) => ({
    name,
    pushPrompt: async () => true,
    launch: async () => ({ argv: ['sleep', '600'], env: {} }),
    afterLaunch: async (a, prompt) => {
      db.updateAgent(a.id, prompt ? { activity: 'working', activity_detail: null } : { activity: 'idle', activity_detail: 'session startup' });
    },
    // Stops the turn as a real adapter does, when a test asks for it; else the turn lingers.
    interrupt: async (a) => (idleOnInterrupt && db.updateAgent(a.id, { activity: 'idle' }), true),
    stop: async () => {},
  });
  for (const n of ['fake', 'fake2', 'fake3']) adapters[n] = fake(n);
});
after(() => {
  killTmuxServer(socket);
  rmSync(home, { recursive: true, force: true });
});

let idleOnInterrupt = false;

function agent(name, parent_id = null, fields = {}) {
  const id = db.newAgentId();
  const cwd = join(home, 'work', name);
  mkdirSync(cwd, { recursive: true });
  db.createAgent({ id, name, role: `role of ${name}`, machine: 'test', harness: 'fake', model: null, effort: null, cwd, parent_id, session_id: null, ...fields });
  db.updateAgent(id, { activity: 'idle', ...(fields.type ? { type: fields.type } : {}) });
  return db.getAgent(id);
}
const get = (a) => db.getAgent(a.id);
const byName = (n) => db.getAgent(n);
// The mail one recipient got, as { subject, body }.
const mailTo = (id) =>
  db.open().prepare('SELECT m.subject, m.body FROM mail m JOIN mail_recipients r ON r.mail_id = m.id WHERE r.agent_id = ? ORDER BY m.created_at').all(id);
const fallbackMail = (id) => mailTo(id).filter((m) => m.subject.startsWith('[stam] Cost fallback ran for'));
// Blocks an agent and returns its blocker-set notice.
async function block(a, account = 'acct-a', kind = 'window') {
  await blockers.addBlocker(a, { kind, account, reason: `${account} is exhausted` });
  const n = costNotices.openNotices([a.id]).filter((x) => x.kind === 'blocker-set').at(-1);
  assert.ok(n, 'the blocker raised a notice');
  return n;
}

let cos, mgr;
beforeEach(() => {
  costNotices.notices(0); // creates the cost_notices table before it is cleared
  fallback.row('none'); // and cost_fallbacks
  const d = db.open();
  for (const t of ['cost_notices', 'cost_fallbacks', 'blockers', 'agent_parents', 'agents', 'mail_recipients', 'mail', 'events', 'itsas', 'itsa_participants', 'waits']) d.exec(`DELETE FROM ${t}`);
  killTmuxServer(socket);
  cos = agent('cos');
  mgr = agent('mgr', cos.id);
});

test('a notice its manager acks in time runs no fallback', async () => {
  const x = agent('worker', mgr.id);
  const n = await block(x);
  const r = fallback.row(n.id);
  assert.ok(Math.abs(r.due_at - (Date.parse(n.created_at) + 15 * MIN)) < 1000, 'due fallbackMinutes after the notice');
  assert.match(mailTo(mgr.id).at(-1).body, /within 15 minutes, stam applies the fallback: take over to cheap, else wait \(acct-a\.onSubExhausted\)/);
  assert.equal(costNotices.ack(n.id, mgr.id).ok, true);
  await fallback.evaluate(Date.now() + 16 * MIN);
  assert.match(fallback.row(n.id).result, /^skipped: mgr acted on it/);
  assert.equal(byName('worker-t2'), undefined);
  assert.equal(get(x).forwarded_to, null);
  assert.equal(fallbackMail(cos.id).length, 0);
});

test('a pause or unpause by anyone who may manage the tree counts as acting; a stranger\'s does not', async () => {
  const x = agent('worker', mgr.id);
  const stranger = agent('stranger');
  const assistant = agent('assistant');
  db.updateAgent(assistant.id, { kind: 'assistant' });
  const lone = agent('lone');
  assert.equal(fallback.isManagerOf(x.id, mgr.id), true);
  assert.equal(fallback.isManagerOf(x.id, 'human'), true);
  assert.equal(fallback.isManagerOf(x.id, assistant.id), true, 'the assistant counts');
  assert.equal(fallback.isManagerOf(lone.id, cos.id), true, 'the chief of staff counts on any tree');
  assert.equal(fallback.isManagerOf(x.id, stranger.id), false);
  const n = await block(x);
  assert.deepEqual(fallback.ackAgent(x.id, mgr.id, 'pause'), [n.id]);
  const ev = db.listEvents(mgr.id, 50).find((e) => e.type === 'cost:ack');
  assert.deepEqual(JSON.parse(ev.data), { event: n.id, via: 'pause' });
});

test('after the timeout the fallback takes over to the first eligible preset and tells the chief of staff', async () => {
  const x = agent('worker', mgr.id);
  const n = await block(x);
  await fallback.evaluate(Date.now() + 14 * MIN);
  assert.equal(fallback.row(n.id).ran_at, null, 'not yet due');
  await fallback.evaluate(Date.now() + 16 * MIN);
  const s = byName('worker-t2');
  assert.ok(s, 'a successor exists');
  assert.equal(s.harness, 'fake2');
  assert.equal(get(x).forwarded_to, s.id);
  assert.match(fallback.row(n.id).result, /^took over: worker now continues as worker-t2 on preset cheap/);
  await sleep(100);
  const told = fallbackMail(cos.id);
  assert.equal(told.length, 1);
  assert.match(told[0].body, /no manager acted on cost notice cn-\w+ \(window on acct-a\) within 15 minutes/);
  assert.match(told[0].body, /Result: took over/);
  assert.equal(fallbackMail('human').length, 0);
  // It runs once.
  await fallback.evaluate(Date.now() + 30 * MIN);
  assert.equal(byName('worker-t3'), undefined);
});

test('a reviewer with no action of its own on its account takes over to the reviewer fallback in settings (S-360)', async () => {
  const rv = agent('rev', mgr.id, { harness: 'fake2', role: 'Reviews the S-360 change', type: 'reviewer' });
  const n = await block(rv, 'acct-b');
  await fallback.evaluate(Date.now() + 16 * MIN);
  const s = byName('rev-t2');
  assert.ok(s, 'a successor exists');
  assert.deepEqual([s.harness, s.model, s.effort], ['fake', 'rv-model', 'medium']);
  assert.match(fallback.row(n.id).result, /^took over: rev now continues as rev-t2 on the reviewer fallback type rv-fallback/);
  // A developer on the same account has no action, so it only waits, even with the role 'reviewer'.
  const dev = agent('dev', mgr.id, { harness: 'fake2', role: 'reviewer', type: 'developer' });
  const n2 = await block(dev, 'acct-b');
  await fallback.evaluate(Date.now() + 32 * MIN);
  assert.match(fallback.row(n2.id).result, /^waited:/);
  assert.equal(byName('dev-t2'), undefined);
});

test('a legacy reviewer with no type (only the role) takes over to the reviewer fallback like a typed one (S-360)', async () => {
  const lg = agent('legacy', mgr.id, { harness: 'fake2', role: 'reviewer' });
  const n = await block(lg, 'acct-b');
  await fallback.evaluate(Date.now() + 16 * MIN);
  const s = byName('legacy-t2');
  assert.ok(s, 'a successor exists');
  assert.deepEqual([s.harness, s.model, s.effort], ['fake', 'rv-model', 'medium']);
  assert.match(fallback.row(n.id).result, /^took over: legacy now continues as legacy-t2 on the reviewer fallback type rv-fallback/);
});

test('a reviewer that is already archived or shut down gets no takeover when its fallback comes due (S-787)', async () => {
  for (const state of ['shut_down', 'archived']) {
    const rv = agent(`done-${state}`, mgr.id, { harness: 'fake2', type: 'reviewer' });
    const n = await block(rv, 'acct-b');
    db.updateAgent(rv.id, { lifecycle: state, activity: 'unknown' });
    await fallback.evaluate(Date.now() + 16 * MIN);
    assert.ok(!/took over/.test(fallback.row(n.id).result ?? ''), `${state}: no takeover`);
    assert.equal(byName(`done-${state}-t2`), undefined, `${state}: no successor`);
    assert.equal(get(rv).forwarded_to, null, state);
  }
});

test('a shut-down reviewer is not relaunched at spawn (S-787)', async () => {
  const rv = agent('dead', mgr.id, { harness: 'fake2', type: 'reviewer' });
  db.updateAgent(rv.id, { lifecycle: 'shut_down', activity: 'unknown' });
  assert.equal(await fallback.relaunchReviewerAtSpawn(rv.id), null);
  assert.equal(byName('dead-t2'), undefined);
});

test('the notice says a reviewer takes over to the reviewer fallback, and any other agent waits (S-360)', () => {
  const reviewer = fallback.describe('acct-b', 'window', { type: 'reviewer', role: null });
  assert.match(reviewer, /stam applies the fallback: take over to the reviewer fallback type rv-fallback, else wait \(review\.fallback\)\.$/);
  assert.match(fallback.describe('acct-b', 'window', { type: 'developer', role: 'reviewer' }), /: wait \(the default\)\.$/);
  assert.match(fallback.describe('acct-b', 'window', { role: 'reviewer' }), /take over to the reviewer fallback type rv-fallback/);
  assert.match(fallback.describe('acct-b', 'window'), /: wait \(the default\)\.$/);
});

test('with no eligible preset the fallback applies else', async () => {
  const onB = agent('on-b', null, { harness: 'fake2' });
  await blockers.addBlocker(onB, { kind: 'window', account: 'acct-b', reason: 'five_hour at 100%' });
  const x = agent('worker', mgr.id);
  const n = await block(x);
  await fallback.evaluate(Date.now() + 16 * MIN);
  assert.match(fallback.row(n.id).result, /^no take-over preset was eligible \(cheap: .*account acct-b is blocked.*\); then waited: worker stays held until its window blocker clears/);
  assert.equal(byName('worker-t2'), undefined);
  assert.equal(get(x).lifecycle, 'paused');
  assert.equal(blockers.blockers(x).length, 1);
  await sleep(100);
  assert.match(fallbackMail(cos.id).find((m) => m.body.includes('worker'))?.body ?? '', /Result: no take-over preset was eligible/);
});

test('continue removes the blocker on a paid account; config refuses it on an unpaid one', async () => {
  const x = agent('paid-worker', mgr.id, { harness: 'fake3' });
  const n = await block(x, 'acct-p', 'credits-out');
  await fallback.evaluate(Date.now() + 16 * MIN);
  assert.match(fallback.row(n.id).result, /^continued: removed paid-worker's credits-out blocker/);
  assert.equal(blockers.blockers(x).length, 0);
  assert.ok(db.listEvents(x.id, 50).some((e) => e.type === 'cost:override'));
  const cost = { subscriptionWarnPercent: [], dailyWarnUsd: null, global: null, onError: 'soft-stop', accounts: { u: { match: { harness: 'claude' }, paid: false, onCreditsOut: 'continue' } } };
  assert.match(accounts.validate(cost), /u\.onCreditsOut: continue needs paid: true/);
  cost.accounts.u.onCreditsOut = { action: 'take-over', to: ['cheap'], else: 'continue' };
  cost.accounts.v = { match: { harness: 'fake2' } };
  assert.match(accounts.validate(cost), /continue needs paid: true/);
});

test('continue never lifts a budget blocker', async () => {
  const x = agent('budget-worker', mgr.id, { harness: 'fake3' });
  const n = await block(x, 'acct-p', 'budget');
  await fallback.evaluate(Date.now() + 16 * MIN);
  assert.match(fallback.row(n.id).result, /^waited: a spent budget is lifted only by a period rollover or a raise/);
  assert.equal(blockers.blockers(x).length, 1);
});

test('the timer survives a daemon restart', async () => {
  const x = agent('worker', mgr.id, { harness: 'fake2' }); // acct-b: the default, wait
  const n = await block(x, 'acct-b');
  db.open().prepare('UPDATE cost_fallbacks SET due_at = ? WHERE notice_id = ?').run(Date.now() - 1000, n.id);
  // A fresh process on the same STAM_HOME, as a restarted daemon: reschedule() runs it.
  const script = `
    const fb = await import(${JSON.stringify(join(root, 'src/cost-fallback.ts'))});
    await fb.reschedule();
    await new Promise((r) => setTimeout(r, 500));
    console.log(JSON.stringify(fb.row(${JSON.stringify(n.id)})));`;
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: process.env, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const r = JSON.parse(out.stdout.trim().split('\n').at(-1));
  assert.ok(r.ran_at);
  assert.match(r.result, /^waited: worker stays held until its window blocker clears/);
  assert.equal(fallbackMail(cos.id).length, 1);
});

test('when the chief of staff is blocked, the human gets the fallback', async () => {
  await blockers.addBlocker(cos, { kind: 'manual', reason: 'paused for cost' });
  const x = agent('worker', mgr.id, { harness: 'fake2' });
  const n = await block(x, 'acct-b');
  await fallback.evaluate(Date.now() + 16 * MIN);
  assert.match(fallback.row(n.id).result, /^waited/);
  await sleep(100);
  assert.equal(fallbackMail(cos.id).length, 0);
  const human = fallbackMail('human');
  assert.equal(human.length, 1);
  assert.match(human[0].body, /The chief of staff is unavailable or blocked, so this reaches you instead/);
});

test('a window blocker stops a mid-turn agent, so the later take-over has no turn to wait for and uses the generated brief (S-3631)', async () => {
  idleOnInterrupt = true;
  try {
    const x = agent('cut', mgr.id, { session_id: 's-cut' });
    db.updateAgent(x.id, { activity: 'working' });
    const n = await block(x);
    assert.equal(get(x).activity, 'idle', 'the blocker stopped the turn');
    const t0 = Date.now();
    await fallback.evaluate(Date.now() + 16 * MIN);
    assert.ok(Date.now() - t0 < 5000, 'no soft-stop wait');
    assert.match(fallback.row(n.id).result, /^took over: cut now continues as cut-t2/);
    assert.ok(byName('cut-t2'), 'a successor exists');
  } finally {
    idleOnInterrupt = false;
  }
});

test('a human ack or a new pause during the take-over\'s quiesce cancels it before the stop', async () => {
  for (const how of ['ack', 'pause']) {
    const x = agent(`busy-${how}`, mgr.id, { session_id: `s-${how}` });
    db.updateAgent(x.id, { activity: 'working' }); // mid-turn before the blocker, as it really is; this fake's interrupt leaves the turn running, so the switch quiesces
    const n = await block(x);
    const running = fallback.evaluate(Date.now() + 16 * MIN);
    await sleep(200);
    assert.equal(fallback.row(n.id).state, 'running');
    if (how === 'ack') {
      await lifecycle.pause(get(x), 'human');
      fallback.ackAgent(x.id, 'human', 'pause');
    } else {
      await lifecycle.pause(get(x), mgr.id); // a parent's pause with no ack still cancels
    }
    await running;
    const r = fallback.row(n.id);
    assert.equal(r.state, 'done');
    assert.match(r.result, how === 'ack' ? /^cancelled: .*the human acted on it/ : /^cancelled: .*mgr paused it/);
    assert.equal(byName(`busy-${how}-t2`), undefined);
    assert.equal(get(x).forwarded_to, null);
    assert.equal(get(x).lifecycle, 'paused', 'never stopped');
    assert.deepEqual(blockers.blockers(x).map((b) => b.kind), ['window']);
  }
});

test('a timer belongs to one blocker generation: a clear retires it, a replacement skips it', async () => {
  const x = agent('worker', mgr.id);
  const n1 = await block(x);
  await blockers.clearBlocker(x, 'window', 'acct-a', 'a fresh reading');
  assert.deepEqual([fallback.row(n1.id).state, fallback.row(n1.id).result], ['done', 'skipped: the blocker cleared']);
  await sleep(5); // a new since
  const n2 = await block(x);
  assert.notEqual(n2.id, n1.id);
  // The same kind, set again without a clear notice: a newer generation.
  db.open().prepare('UPDATE blockers SET since = ? WHERE agent_id = ?').run(new Date(Date.now() + 1000).toISOString(), x.id);
  await fallback.evaluate(Date.now() + 16 * MIN);
  assert.equal(fallback.row(n2.id).result, 'skipped: the blocker was replaced by a newer one');
  assert.equal(byName('worker-t2'), undefined);
});

test('validation follows an inherited cost.onError take-over into cycles', () => {
  const base = { subscriptionWarnPercent: [], dailyWarnUsd: null, global: null };
  const cycle = {
    ...base,
    accounts: { a: { match: { harness: 'claude' } }, b: { match: { harness: 'codex' }, onSubExhausted: { action: 'take-over', to: ['a'], else: 'wait' } } },
    onError: { action: 'take-over', to: ['b'], else: 'wait' },
  };
  assert.match(accounts.validate(cycle), /take-over cycle: a -> b -> a/);
  // b's own onError overrides the inherited one, which breaks the cycle.
  cycle.accounts.b.onError = 'wait';
  cycle.accounts.b.onSubExhausted = 'wait';
  assert.equal(accounts.validate(cycle), null);
  // An account's own self-target is refused; an inherited one is skipped at run time.
  const self = { ...base, accounts: { a: { match: { harness: 'claude' }, onError: { action: 'take-over', to: ['a'] } } }, onError: 'wait' };
  assert.match(accounts.validate(self), /a\.onError: a resolves to a, the same account/);
  assert.equal(accounts.validate({ ...base, accounts: { a: { match: { harness: 'claude' } } }, onError: { action: 'take-over', to: ['a'], else: 'wait' } }), null);
  assert.match(accounts.validate({ ...base, accounts: { a: { match: { harness: 'claude' } } }, onError: 'continue' }), /onError \(inherited by a\): continue needs paid: true/);
});

test('recovery after a crash: a claimed row runs again, a running row is reconciled', async () => {
  const set = (id, fields) => {
    const keys = Object.keys(fields);
    db.open().prepare(`UPDATE cost_fallbacks SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE notice_id = ?`).run(...keys.map((k) => fields[k]), id);
  };
  // Claimed, nothing done: back to pending, and it runs.
  const w1 = agent('claimed', mgr.id, { harness: 'fake2' });
  const n1 = await block(w1, 'acct-b');
  set(n1.id, { state: 'claimed', due_at: Date.now() - 1000 });
  // Running, and the successor exists: done.
  const w2 = agent('moved', mgr.id, { harness: 'fake2' });
  const n2 = await block(w2, 'acct-b');
  const succ = agent('moved-t2', mgr.id, { harness: 'fake2' });
  db.updateAgent(w2.id, { forwarded_to: succ.id });
  set(n2.id, { state: 'running', prior: JSON.stringify({ lifecycle: 'paused', owners: [] }) });
  // Running, stopped mid-switch with no successor: undone, then one retry.
  const w3 = agent('stopped', mgr.id, { session_id: 'sess-stopped' });
  const n3 = await block(w3);
  db.updateAgent(w3.id, { lifecycle: 'shut_down' });
  await blockers.addBlocker(w3, { kind: 'taken-over', reason: 'moving' });
  set(n3.id, { state: 'running', prior: JSON.stringify({ lifecycle: 'paused', owners: [] }) });
  // Running, already retried once: gives up.
  const w4 = agent('twice', mgr.id, { harness: 'fake2' });
  const n4 = await block(w4, 'acct-b');
  set(n4.id, { state: 'running', attempts: 1, prior: JSON.stringify({ lifecycle: 'paused', owners: [] }) });

  await fallback.recover();
  assert.equal(fallback.row(n1.id).state, 'pending');
  assert.match(fallback.row(n2.id).result, /^took over \(reconciled after a restart\): moved continues as moved-t2/);
  assert.deepEqual([fallback.row(n3.id).state, fallback.row(n3.id).attempts], ['pending', 1]);
  assert.deepEqual(blockers.blockers(w3).map((b) => b.kind), ['window'], 'the taken-over blocker is gone');
  assert.equal(get(w3).lifecycle, 'paused', 'the stop is undone; it is held again');
  assert.equal(fallback.row(n4.id).result, 'failed: interrupted by a daemon restart twice');
  await fallback.evaluate(Date.now());
  assert.match(fallback.row(n1.id).result, /^waited/);
});

test('a reviewer fallback whose type changes during the quiesce is cancelled, not moved to the new target (S-360)', async () => {
  const rv = agent('rev2', mgr.id, { harness: 'fake2', type: 'reviewer', session_id: 's-rev2' });
  const n = await block(rv, 'acct-b');
  db.updateAgent(rv.id, { activity: 'working' });
  const running = fallback.evaluate(Date.now() + 16 * MIN);
  await sleep(200);
  writeRegistry({ ...baseTypes(), 'rv-fallback': rvType('fake3', 'other', 'low', null) });
  db.updateAgent(rv.id, { activity: 'idle' });
  await running;
  assert.match(fallback.row(n.id).result, /changed while rev2 finished its step/);
  assert.equal(byName('rev2-t2'), undefined);
  assert.equal(get(rv).forwarded_to, null);
});

test('a reviewer that dies on a usage limit right after its spawn is relaunched on the fallback once (S-381)', async () => {
  const rules = await import('../src/rules.ts');
  const rv = agent('quick', mgr.id, { harness: 'fake2', role: 'Reviews the S-381 change', type: 'reviewer' });
  rules.signal(rv.id, { source: 'turn/completed', class: 'limit', codexErrorInfo: 'usageLimitExceeded', message: "You've hit your usage limit. Try again at 11:59 PM." });
  for (let i = 0; i < 100 && !byName('quick-t2'); i++) await sleep(100);
  const s = byName('quick-t2');
  assert.ok(s, 'a successor exists');
  assert.deepEqual([s.harness, s.model], ['fake3', 'other']); // the fallback an earlier test set
  assert.equal(get(rv).forwarded_to, s.id);
  // The relaunch is not itself relaunched, and the original is not relaunched twice.
  assert.equal(await fallback.relaunchReviewerAtSpawn(s.id), null);
  assert.equal(await fallback.relaunchReviewerAtSpawn(rv.id), null);
  // A reviewer that has run a while is left to the notice's fallback.
  const old = agent('oldrev', mgr.id, { harness: 'fake2', role: 'Reviews', type: 'reviewer' });
  assert.equal(await fallback.relaunchReviewerAtSpawn(old.id, Date.now() + 10 * MIN), null);
  assert.equal(byName('oldrev-t2'), undefined);
});

test('a rate-limits update does not relaunch a reviewer; the relaunch keeps the brief, parent and ITSA (S-381)', async () => {
  const rules = await import('../src/rules.ts');
  const rv = agent('upd', mgr.id, { harness: 'fake2', role: 'Reviews', type: 'reviewer' });
  db.updateAgent(rv.id, { first_prompt: 'Review S-381 carefully.' });
  rules.signal(rv.id, { source: 'account/rateLimits/updated', class: 'limit', rateLimitReachedType: 'rate_limit_reached' });
  await sleep(500);
  assert.equal(byName('upd-t2'), undefined);
  assert.equal(get(rv).forwarded_to ?? null, null);
  rules.signal(rv.id, { source: 'turn/completed', class: 'limit', message: 'try again at 11:59 PM' });
  for (let i = 0; i < 100 && !byName('upd-t2'); i++) await sleep(100);
  const s = byName('upd-t2');
  assert.ok(s);
  assert.equal(s.parent_id, mgr.id);
  assert.equal(s.first_prompt, 'Review S-381 carefully.');
});

// ---- the per-type fallback chain (S-412)
test('a custom scenario reviewer type takes over along its own chain, and the successor records the fallback type (S-412)', async () => {
  writeRegistry({ ...baseTypes(), 'sec-rev': rvType('fake2', 'sec', 'high', 'rv-paid') });
  const sr = agent('sec', mgr.id, { harness: 'fake2', type: 'sec-rev' });
  const n = await block(sr, 'acct-b');
  assert.match(fallback.describe('acct-b', 'window', sr), /take over to the reviewer fallback type rv-paid/);
  await fallback.evaluate(Date.now() + 16 * MIN);
  const s = byName('sec-t2');
  assert.deepEqual([s.harness, s.model, s.effort, s.type], ['fake3', 'other', 'low', 'rv-paid']);
  assert.match(fallback.row(n.id).result, /on the reviewer fallback type rv-paid/);
});

test('a take-over skips a fallback type whose account is held and takes the next of the chain (S-412)', async () => {
  writeRegistry(baseTypes());
  await blockers.addBlocker(agent('on-a', null, { harness: 'fake' }), { kind: 'window', account: 'acct-a', reason: 'acct-a is exhausted' });
  const rv = agent('hop', mgr.id, { harness: 'fake2', type: 'reviewer' });
  const n = await block(rv, 'acct-b');
  await fallback.evaluate(Date.now() + 16 * MIN);
  const s = byName('hop-t2');
  assert.deepEqual([s.harness, s.type], ['fake3', 'rv-paid']);
  assert.match(fallback.row(n.id).result, /on the reviewer fallback type rv-paid/);
});

test('with every type of the chain held, the reviewer only waits (S-412)', async () => {
  writeRegistry(baseTypes());
  await blockers.addBlocker(agent('on-a', null, { harness: 'fake' }), { kind: 'window', account: 'acct-a', reason: 'acct-a is exhausted' });
  await blockers.addBlocker(agent('on-p', null, { harness: 'fake3' }), { kind: 'window', account: 'acct-p', reason: 'acct-p is exhausted' });
  const rv = agent('stuck', mgr.id, { harness: 'fake2', type: 'reviewer' });
  const n = await block(rv, 'acct-b');
  assert.match(fallback.describe('acct-b', 'window', rv), /: wait \(the default\)\.$/);
  await fallback.evaluate(Date.now() + 16 * MIN);
  assert.match(fallback.row(n.id).result, /^waited:/);
  assert.equal(byName('stuck-t2'), undefined);
});

test('the S-381 relaunch follows the chain of the agent\'s own type (S-412)', async () => {
  writeRegistry({ ...baseTypes(), 'sec-rev': rvType('fake2', 'sec', 'high', 'rv-paid') });
  const rules = await import('../src/rules.ts');
  const rv = agent('quick2', mgr.id, { harness: 'fake2', role: 'Reviews', type: 'sec-rev' });
  rules.signal(rv.id, { source: 'turn/completed', class: 'limit', codexErrorInfo: 'usageLimitExceeded', message: "You've hit your usage limit. Try again at 11:59 PM." });
  for (let i = 0; i < 100 && !byName('quick2-t2'); i++) await sleep(100);
  const s = byName('quick2-t2');
  assert.ok(s, 'a successor exists');
  assert.deepEqual([s.harness, s.type], ['fake3', 'rv-paid']);
});

test('a real preset named like a type target does not shadow it, and public input cannot name a type target (S-412)', async () => {
  const cs = await import('../src/cost-switch.ts');
  writeFileSync(join(home, 'registry.json'), JSON.stringify({ presets: { cheap: { harness: 'fake2', model: 'cheap-model', effort: 'low' }, 'type:rv-fallback': { harness: 'fake3', model: 'shadow', effort: 'low' } }, types: baseTypes() }));
  // public input is only ever a registry preset: the preset named type:rv-fallback is that preset,
  // and a type name that is no preset is unknown
  const rv0 = agent('pub', mgr.id, { harness: 'fake2', type: 'reviewer' });
  assert.equal(cs.check({ agent: rv0.id, preset: 'type:rv-fallback', by: 'human' }).model, 'shadow');
  assert.equal(cs.check({ agent: rv0.id, preset: 'type:rv-fallback', by: 'human' }).toType, undefined);
  assert.throws(() => cs.check({ agent: rv0.id, preset: 'type:developer', by: 'human' }), /no preset|unknown preset|type:developer/i);
  // the cost fallback of a reviewer still goes to the type, not to the preset of the same name
  const rv = agent('shadowed', mgr.id, { harness: 'fake2', type: 'reviewer' });
  await block(rv, 'acct-b');
  await fallback.evaluate(Date.now() + 16 * MIN);
  const s = byName('shadowed-t2');
  assert.deepEqual([s.harness, s.model, s.type], ['fake', 'rv-model', 'rv-fallback']);
  // the quiesce event keeps the target type, so a daemon restart resolves it again
  const q = db.listEvents(rv.id, 50).filter((e) => e.type === 'cost:switch').map((e) => JSON.parse(e.data)).find((d) => d.step === 'quiesce');
  assert.equal(q.toType, 'rv-fallback');
  writeRegistry(baseTypes());
});

test('an explicit archive or shut-down cancels a pending fallback: no successor after its deadline (S-2458)', async () => {
  for (const how of ['archive', 'shutdown']) {
    const rv = agent(`cancel-${how}`, mgr.id, { harness: 'fake2', type: 'reviewer' });
    const n = await block(rv, 'acct-b');
    if (how === 'archive') await lifecycle.archive(get(rv), true);
    else await lifecycle.explicitShutdown(get(rv), false);
    assert.match(fallback.row(n.id).result, /^skipped: the agent was (archived|shut down)$/, `${how}: the pending row is cancelled`);
    await fallback.evaluate(Date.now() + 16 * MIN);
    assert.equal(byName(`cancel-${how}-t2`), undefined, `${how}: no successor`);
    assert.equal(get(rv).forwarded_to, null);
    assert.equal(fallbackMail(cos.id).length, 0, `${how}: the chief of staff hears no fallback`);
  }
});

test('a fallback claim re-checks the agent in the same step: an archive that lands after the due scan stops that row (S-2458)', async () => {
  const early = agent('early', mgr.id, { harness: 'fake2', type: 'developer' }); // no action on acct-b: it waits
  const late = agent('late', mgr.id, { harness: 'fake2', type: 'reviewer' });
  await block(early, 'acct-b');
  await sleep(5); // the rows get different due times, so the scan orders early first
  const n2 = await block(late, 'acct-b');
  // early's run yields before it returns, so late's claim runs after this synchronous write: the archive lands between the scan and that claim.
  const running = fallback.evaluate(Date.now() + 16 * MIN);
  db.updateAgent(late.id, { pending_action: JSON.stringify({ type: 'archive', at: Date.now() + 1 }) });
  await running;
  assert.equal(fallback.row(n2.id).state, 'done');
  assert.match(fallback.row(n2.id).result, /^skipped: the agent is archived, or its archive or shut-down is pending$/);
  assert.equal(byName('late-t2'), undefined, 'no successor');
  assert.equal(get(late).forwarded_to, null);
});

test('a graceful or an immediate shut-down during a take-over\'s quiesce cancels it before the stop, no successor (S-2458)', async () => {
  for (const how of ['graceful', 'immediate']) {
    const x = agent(`quit-${how}`, mgr.id, { harness: 'fake2', type: 'reviewer', session_id: `s-quit-${how}` });
    db.updateAgent(x.id, { activity: 'working' }); // mid-turn before the blocker, as it really is; this fake's interrupt leaves the turn running, so the switch quiesces
    const n = await block(x, 'acct-b');
    const running = fallback.evaluate(Date.now() + 16 * MIN);
    await sleep(200);
    assert.equal(fallback.row(n.id).state, 'running', `${how}: ${fallback.row(n.id).result}`);
    await lifecycle.explicitShutdown(get(x), how === 'immediate');
    db.updateAgent(x.id, { activity: 'idle' }); // the turn ends, so the quiesce can finish
    await running;
    const r = fallback.row(n.id);
    assert.equal(r.state, 'done');
    assert.match(r.result, /^cancelled: .*the agent was shut down/, `${how}: the take-over is cancelled`);
    assert.equal(byName(`quit-${how}-t2`), undefined, `${how}: no successor`);
    assert.equal(get(x).forwarded_to, null);
  }
});
