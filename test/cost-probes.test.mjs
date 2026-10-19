#!/usr/bin/env node
// Unit tests for error blockers and probes (docs/cost-policy.md, build step 15; src/cost-probes.ts):
// a provider error after the harness's retries blocks the account, its manager hears it and the
// onError fallback is armed, the human hears an auth error once per outage, the probe backs off
// 1, 2, 4, 8, 16 then 16 minutes with one probe per account, and a Claude account probes with
// one agent's turn while the rest stay held. Errors come through the Claude adapter's own hook
// handler (StopFailure), probes are stubbed, and the schedule is read, not waited for. Runs
// against a throwaway STAM_HOME; no daemon, no network, no models:
// `node --test test/cost-probes.test.mjs`.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-cost-probes-');
const socket = `cost-probes-test-${process.pid}`;
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = socket;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(
  join(home, 'settings.json'),
  JSON.stringify({
    peers: [],
    humanMail: { when: 'necessary' },
    cost: {
      subscriptionWarnPercent: [],
      accounts: {
        'claude-max': { match: { harness: 'claude' }, paid: false },
        'codex-plus': { match: { harness: 'codex' }, paid: false },
      },
    },
  }),
);

let db, blockers, probes, admission, fallback, costNotices, claude, lifecycle, rules;
const prompts = new Map();
before(async () => {
  db = await import('../src/db.ts');
  blockers = await import('../src/blockers.ts');
  probes = await import('../src/cost-probes.ts');
  admission = await import('../src/admission.ts');
  fallback = await import('../src/cost-fallback.ts');
  costNotices = await import('../src/cost-notices.ts');
  lifecycle = await import('../src/lifecycle.ts');
  rules = await import('../src/rules.ts');
  const { adapters } = await import('../src/adapters/index.ts');
  claude = adapters.claude;
  for (const h of ['claude', 'codex', 'fake'])
    (adapters[h] ??= { name: h }).pushPrompt = async (a, text) => {
      prompts.set(a.id, [...(prompts.get(a.id) ?? []), text]);
      return true;
    };
});
after(() => {
  probes.reset();
  spawnSync('tmux', ['-L', socket, 'kill-server']);
});

let n = 0;
function agent(harness, parent_id = null) {
  const id = db.newAgentId();
  db.createAgent({ id, name: `p${++n}`, role: '', machine: 'test', harness, model: null, effort: null, cwd: home, parent_id, session_id: null });
  db.updateAgent(id, { activity: 'working' });
  return db.getAgent(id);
}
const get = (a) => db.getAgent(a.id);
const of = (a, kind) => blockers.blockers(a).find((b) => b.kind === kind);
const mailTo = (id) =>
  db.open().prepare('SELECT m.subject, m.body FROM mail m JOIN mail_recipients r ON r.mail_id = m.id WHERE r.agent_id = ? ORDER BY m.created_at').all(id);
const MIN = 60_000;
// Waits for a state, never for a fixed time.
async function until(cond, what) {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}
const fail = (a, error) => claude.onHook(get(a), { hook_event_name: 'StopFailure', error });
beforeEach(() => {
  probes.reset();
  probes.setProber(null);
  db.open().prepare('DELETE FROM blockers').run();
  db.open().prepare("UPDATE agents SET lifecycle = 'archived'").run();
});

test('a transient error after retries blocks the account, tells the manager, arms onError, and spares the human', async () => {
  const mgr = agent('fake');
  const a = agent('claude', mgr.id);
  const b = agent('claude', mgr.id);
  const free = agent('fake'); // unmanaged
  const before = mailTo('human').length;
  const t0 = Date.now();
  fail(a, 'overloaded');
  await until(() => of(a, 'error') && of(b, 'error') && get(b).lifecycle === 'paused', 'the error blocker on both');
  assert.match(of(a, 'error').reason, /provider error after the harness's retries, StopFailure \(overloaded\); stam probes the account/);
  assert.equal(of(a, 'error').account, 'claude-max');
  assert.equal(get(a).lifecycle, 'paused');
  assert.equal(blockers.blockers(free).length, 0, 'unmanaged agent untouched');
  assert.equal(admission.admit(a, 'mail').ok, false);
  assert.throws(() => admission.admitSpawn({ name: 'new', harness: 'claude', human: false }), /account claude-max is blocked: error/);
  // The manager got the blocker-set notice (in-turn: it is working), with the onError fallback armed.
  const notice = costNotices.openNotices([a.id]).find((x) => x.kind === 'blocker-set');
  assert.deepEqual(notice.managers, [mgr.id]);
  assert.ok(db.listEvents(mgr.id, 100).some((e) => e.type === 'cost:notice' && JSON.parse(e.data).event === notice.id));
  assert.equal(fallback.row(notice.id)?.kind, 'error');
  assert.equal(mailTo('human').length, before, 'no human mail for a transient error');
  // One probe for the account, a minute out.
  const p = probes.nextProbe('claude-max');
  assert.equal(p.attempt, 0);
  assert.ok(p.due - t0 >= MIN && p.due - Date.now() <= MIN);
  // A second error on the other agent neither resets nor adds a probe.
  fail(b, 'server_error');
  await until(() => /server_error/.test(of(a, 'error').reason), 'the refreshed reason');
  assert.equal(probes.nextProbe('claude-max').attempt, 0);
});

test('the probe backs off 1, 2, 4, 8, 16, then 16 minutes, one per account, and its success clears every agent', async () => {
  const a = agent('codex');
  const b = agent('codex');
  let calls = 0;
  let ok = false;
  probes.setProber(async (account) => {
    assert.equal(account, 'codex-plus');
    calls++;
    return ok ? 'ok' : 'fail';
  });
  await probes.onError(a.id, 'transient', 'turn/completed');
  assert.ok(of(a, 'error') && of(b, 'error'));
  const waits = [];
  for (let i = 0; i < 6; i++) {
    const now = Date.now();
    await probes.runProbe('codex-plus', now);
    const p = probes.nextProbe('codex-plus');
    waits.push((p.due - now) / MIN);
  }
  assert.deepEqual(waits, [2, 4, 8, 16, 16, 16], 'the waits after probes 0-5 (probe 0 came a minute after the error)');
  assert.equal(calls, 6, 'one probe per step for the account, not per agent');
  assert.ok(of(a, 'error'), 'failed probes clear nothing');
  ok = true;
  await probes.runProbe('codex-plus');
  await until(() => !of(a, 'error') && !of(b, 'error') && get(a).lifecycle === 'active' && get(b).lifecycle === 'active', 'both cleared');
  assert.equal(probes.nextProbe('codex-plus'), null, 'probing stopped');
  assert.ok(db.listEvents(a.id, 100).some((e) => e.type === 'blocker:clear' && /a probe of codex-plus succeeded/.test(e.data)));
});

test('an auth error mails the human once per account per outage', async () => {
  const a = agent('codex');
  const b = agent('codex');
  probes.setProber(async () => 'ok');
  const human = () => mailTo('human').filter((m) => /codex-plus: authentication error stops its agents/.test(m.subject));
  const start = human().length;
  await probes.onError(a.id, 'auth', 'turn/completed (unauthorized)');
  await probes.onError(b.id, 'auth', 'turn/completed (unauthorized)');
  await until(() => human().length === start + 1, 'the human mail');
  assert.match(human().at(-1).body, /Fix the login/);
  assert.equal(of(b, 'error').clear.human, true, 'recorded, so a restart does not mail again');
  await probes.onError(b.id, 'auth', 'turn/completed (unauthorized)');
  // The outage ends; the next one mails again.
  await probes.runProbe('codex-plus');
  await until(() => !of(a, 'error'), 'cleared');
  await probes.onError(a.id, 'auth', 'turn/completed (unauthorized)');
  await until(() => human().length === start + 2, 'the second outage mail');
});

test('Claude: a billing error probes with one agent\'s turn while the rest stay held; a failure re-holds it, a Stop clears all', async () => {
  const a = agent('claude');
  const b = agent('claude');
  fail(a, 'billing_error');
  await until(() => of(a, 'credits-out') && of(b, 'credits-out') && get(a).lifecycle === 'paused' && probes.nextProbe('claude-max'), 'credits-out and the probe');
  // The default prober: Claude probes with a turn. a has been blocked longest.
  await probes.runProbe('claude-max');
  assert.equal(probes.nextProbe('claude-max').turn, a.id);
  assert.equal(get(a).lifecycle, 'active');
  assert.match(prompts.get(a.id).at(-1), /unpaused to test your account/);
  assert.ok(of(a, 'credits-out'), 'its blocker stays in place');
  assert.equal(admission.admit(a, 'mail').ok, true, 'the probe agent is admitted');
  assert.equal(admission.admit(b, 'mail').ok, false, 'the rest stay held');
  assert.equal(get(b).lifecycle, 'paused');
  // The probe turn fails: a is held again and the next step waits.
  fail(a, 'billing_error');
  await until(() => get(a).lifecycle === 'paused' && probes.nextProbe('claude-max').turn == null, 'a re-held');
  assert.equal(admission.admit(a, 'mail').ok, false);
  assert.equal(probes.nextProbe('claude-max').attempt, 1);
  // The next probe turn reaches the model: a Stop hook clears the account.
  await probes.runProbe('claude-max');
  assert.equal(probes.nextProbe('claude-max').turn, a.id);
  claude.onHook(get(a), { hook_event_name: 'Stop', last_assistant_message: 'done' });
  await until(() => !of(a, 'credits-out') && !of(b, 'credits-out') && get(b).lifecycle === 'active', 'credits-out cleared');
  assert.match(prompts.get(b.id).at(-1), /no longer paused.*the probe, got a model response/s);
  assert.equal(probes.nextProbe('claude-max'), null);
});

test('Claude: a probe success that reaches the rules chain behind a newer billing error leaves its credits-out', async () => {
  const a = agent('claude');
  fail(a, 'billing_error');
  await until(() => of(a, 'credits-out') && get(a).lifecycle === 'paused', 'credits-out');
  await probes.runProbe('claude-max');
  assert.equal(probes.nextProbe('claude-max').turn, a.id);
  // c joins the account unblocked; holding its serial chain holds the next evaluation (it adds
  // c's credits-out) and so the account's rules chain.
  const c = agent('claude');
  let release;
  const hold = lifecycle.serial(c.id, () => new Promise((r) => (release = r)));
  await until(() => release, 'the hold running');
  // A new billing error, queued on the held chain; then a's Stop, the old probe's success.
  fail(a, 'billing_error');
  claude.onHook(get(a), { hook_event_name: 'Stop', last_assistant_message: 'done' });
  const gen = probes.generation('claude-max');
  const cleared = rules.probeCleared('claude-max', 'an older probe succeeded', gen - 1);
  release();
  await hold;
  // Queued last, so it settles after the evaluation and any success the Stop queued.
  await cleared;
  assert.ok(of(c, 'credits-out'), 'the evaluation ran');
  assert.ok(of(a, 'credits-out'), 'the newer billing error still holds a');
  assert.ok(probes.nextProbe('claude-max'), 'and is probed');
  assert.equal(probes.nextProbe('claude-max').turn, null, 'the old turn is over');
});

test('Claude: a probe turn that shows nothing by the next step is abandoned and another agent probes', async () => {
  const a = agent('claude');
  const b = agent('claude');
  fail(a, 'overloaded');
  await until(() => of(b, 'error') && get(a).lifecycle === 'paused' && get(b).lifecycle === 'paused', 'both held');
  await probes.runProbe('claude-max');
  assert.equal(probes.nextProbe('claude-max').turn, a.id);
  await probes.runProbe('claude-max');
  assert.equal(probes.nextProbe('claude-max').turn, b.id, 'the abandoned agent goes last, so b probes');
  await until(() => get(a).lifecycle === 'paused', 'a re-held');
  // A model response mid-turn (a tool ran) is enough.
  claude.onHook(get(b), { hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  await until(() => !of(a, 'error') && get(a).lifecycle === 'active', 'cleared');
});

test('at daemon start, an account with an error blocker is probed from the first step', async () => {
  const a = agent('codex');
  await blockers.addBlocker(a, { kind: 'error', account: 'codex-plus', reason: 'a provider error', clear: { after: new Date().toISOString(), class: 'transient' } });
  probes.reset();
  const t0 = Date.now();
  probes.resumeAll(t0);
  assert.deepEqual(probes.nextProbe('claude-max'), null);
  assert.equal(probes.nextProbe('codex-plus').due, t0 + MIN);
});

test('the probe exemption admits only the probe agent, and only past its account\'s probe blockers', async () => {
  const a = agent('claude');
  const b = agent('claude');
  const other = agent('codex');
  fail(a, 'overloaded');
  await probes.onError(other.id, 'transient', 'turn/completed');
  await until(() => get(a).lifecycle === 'paused' && get(b).lifecycle === 'paused' && get(other).lifecycle === 'paused', 'all held');
  // b also carries a budget blocker on its account: it is never picked, and a's turn starts.
  await blockers.addBlocker(b, { kind: 'budget', account: 'claude-max', reason: 'budget spent' });
  await probes.runProbe('claude-max');
  assert.equal(probes.nextProbe('claude-max').turn, a.id);
  assert.equal(admission.admit(a, 'mail').ok, true);
  assert.equal(admission.admit(b, 'mail').ok, false, 'another agent on the account');
  assert.equal(admission.admit(other, 'mail').ok, false, 'an agent on another account');
  // A budget or window blocker added to the probe agent itself still holds it.
  for (const kind of ['budget', 'window']) {
    await blockers.addBlocker(a, { kind, account: 'claude-max', reason: `${kind} hit` });
    assert.match(admission.admit(a, 'mail').reason ?? '', new RegExp(`^${kind} on claude-max`));
    await blockers.clearBlocker(a, kind, 'claude-max');
  }
  // Once a's turn is abandoned, b (budget-blocked) is still never picked.
  await probes.runProbe('claude-max');
  assert.notEqual(probes.nextProbe('claude-max').turn, b.id);
  assert.equal(get(b).lifecycle, 'paused');
});

test('a human pause queued ahead of the probe\'s resume wins: the agent stays paused by the human', async () => {
  const a = agent('claude');
  fail(a, 'overloaded');
  await until(() => get(a).lifecycle === 'paused', 'held');
  // Hold a's serial chain, queue the human's pause behind the hold (not applied yet), then
  // let the probe pick a and queue its resume behind the pause.
  let release;
  const hold = lifecycle.serial(a.id, () => new Promise((r) => (release = r)));
  const pausing = lifecycle.pause(get(a), 'human');
  assert.deepEqual(lifecycle.pauseOwners(get(a)), [], 'the pause is still queued');
  const probing = probes.runProbe('claude-max');
  await until(() => release, 'the hold running');
  release();
  await Promise.all([hold, pausing, probing]);
  assert.equal(get(a).lifecycle, 'paused');
  assert.deepEqual(lifecycle.pauseOwners(get(a)), ['human'], 'the human\'s pause is kept');
  assert.equal(probes.nextProbe('claude-max').turn, null, 'no probe turn ran');
});

test('auth, then transient, then auth in one outage mails the human once', async () => {
  const a = agent('codex');
  probes.setProber(async () => 'fail');
  const human = () => mailTo('human').filter((m) => /codex-plus: authentication error/.test(m.subject));
  const start = human().length;
  await probes.onError(a.id, 'auth', 'turn/completed (401)');
  await probes.onError(a.id, 'transient', 'turn/completed (503)');
  assert.equal(of(a, 'error').clear.human, true, 'the transient error keeps the mark');
  await probes.onError(a.id, 'auth', 'turn/completed (401)');
  await until(() => human().length >= start + 1, 'the mail');
  await new Promise((r) => setImmediate(r));
  assert.equal(human().length, start + 1);
});

test('a probe turn running at a daemon restart is taken up again, and its Stop still clears the account', async () => {
  const a = agent('claude');
  fail(a, 'overloaded');
  await until(() => get(a).lifecycle === 'paused', 'held');
  await probes.runProbe('claude-max');
  assert.equal(get(a).lifecycle, 'active');
  // The daemon restarts: in-memory probe state is gone, the blockers and events remain.
  probes.reset();
  probes.resumeAll();
  assert.equal(probes.nextProbe('claude-max').turn, a.id);
  assert.equal(admission.admit(a, 'mail').ok, true);
  claude.onHook(get(a), { hook_event_name: 'Stop', last_assistant_message: 'done' });
  await until(() => !of(a, 'error'), 'cleared');
});

// The review's race reproducer (m7afac3c).
test('two auth errors at once on one account mail the human once', async () => {
  const a = agent('codex');
  const b = agent('codex');
  probes.setProber(async () => 'fail');
  const human = () => mailTo('human').filter((m) => /codex-plus: authentication error/.test(m.subject));
  const start = human().length;
  await Promise.all([probes.onError(a.id, 'auth', '401'), probes.onError(b.id, 'auth', '401')]);
  await until(() => human().length > start, 'the mail');
  assert.equal(human().length - start, 1);
});

test('a failure that arrives while an endpoint probe runs stays blocked when the probe succeeds', async () => {
  const a = agent('codex');
  await probes.onError(a.id, 'transient', 'old failure');
  let release;
  probes.setProber(() => new Promise((r) => (release = r)));
  const running = probes.runProbe('codex-plus');
  await until(() => release, 'the probe running');
  await probes.onError(a.id, 'auth', 'new failure');
  release('ok');
  await running;
  assert.ok(of(a, 'error'), 'the newer failure stays');
  assert.equal(probes.nextProbe('codex-plus').attempt, 1, 'the next step probes again');
  // The next probe tests the new failure and may clear it.
  probes.setProber(async () => 'ok');
  await probes.runProbe('codex-plus');
  await until(() => !of(a, 'error'), 'cleared by a probe of the new generation');
});

test('blockers cleared another way while a probe runs stop probing without a throw', async () => {
  const a = agent('codex');
  await probes.onError(a.id, 'transient', 'failure');
  let release;
  probes.setProber(() => new Promise((r) => (release = r)));
  const running = probes.runProbe('codex-plus');
  await until(() => release, 'the probe running');
  await blockers.clearBlocker(a.id, 'error', 'codex-plus', 'fallback continue');
  release('fail');
  await running;
  assert.equal(probes.nextProbe('codex-plus'), null);
});
