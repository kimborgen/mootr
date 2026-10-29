#!/usr/bin/env node
// Unit tests for build step 13 of docs/cost-policy.md: cost_switch moves an agent's work to
// a successor on another preset. Covers the successor's name, the eligibility and permission
// refusals, the quiesce (wait, then interrupt after the deadline), the transactional move of
// parents, children, mail and threads, forwarding, notices, the rollback of a failed launch,
// and the worktree guard on archive. Runs against a throwaway STAM_HOME with its own tmux
// socket and two fake harnesses on two accounts; no daemon, no network, no models:
// `node --test test/cost-switch.test.mjs`.
import { test, before, after, beforeEach } from 'node:test';
import { killTmuxServer } from '../src/tmux-socket.ts';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-cost-switch-');
const socket = `cost-switch-test-${process.pid}`;
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = socket;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(
  join(home, 'settings.json'),
  JSON.stringify({
    peers: [],
    chiefOfStaff: 'cos',
    humanMail: { when: 'necessary' },
    cost: { subscriptionWarnPercent: [], accounts: { 'acct-a': { match: { harness: 'fake' }, paid: false }, 'acct-b': { match: { harness: 'fake2' }, paid: false } } },
  }),
);
writeFileSync(join(home, 'registry.json'), JSON.stringify({ presets: { cheap: { harness: 'fake2', model: 'cheap-model', effort: 'low' } } }));

let db, lifecycle, blockers, costSwitch, costNotices, mail;
// What the fake harnesses received, per agent id.
const prompts = new Map();
const launches = new Map();
const interrupts = [];
// The order of stops and launches, as 'stop:NAME' and 'launch:NAME'.
const order = [];
// How the fake harnesses misbehave in a test; reset before each.
let mode = {};
let failLaunch = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Waits until fn returns a truthy value (a switch runs in the background).
const until = async (fn, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) if (fn()) return fn();
  assert.fail('timed out');
};
before(async () => {
  db = await import('../src/db.ts');
  lifecycle = await import('../src/lifecycle.ts');
  blockers = await import('../src/blockers.ts');
  costSwitch = await import('../src/cost-switch.ts');
  costNotices = await import('../src/cost-notices.ts');
  mail = await import('../src/mail.ts');
  const { adapters } = await import('../src/adapters/index.ts');
  const fake = (name) => ({
    name,
    pushPrompt: async (a, text) => {
      prompts.set(a.id, [...(prompts.get(a.id) ?? []), text]);
      return true;
    },
    launch: async () => {
      if (failLaunch && name === 'fake2') throw new Error('harness would not start');
      if (mode.launchDelay) await sleep(mode.launchDelay);
      return { argv: ['sleep', '600'], env: {} };
    },
    afterLaunch: async (a, prompt) => {
      order.push(`launch:${a.name}`);
      launches.set(a.id, [...(launches.get(a.id) ?? []), prompt ?? null]);
      if (name === 'fake2' && mode.duringStartup) await mode.duringStartup(a);
      if (name === 'fake2' && mode.afterLaunchReject) throw new Error('the first prompt was not taken');
      if (name === 'fake2' && mode.stayStarting) return;
      // As the harness's hooks report it: the prompt starts a turn, else the session idles.
      db.updateAgent(a.id, prompt ? { activity: 'working', activity_detail: null } : { activity: 'idle', activity_detail: 'session startup' });
    },
    interrupt: async (a) => {
      interrupts.push(a.id);
      if (mode.interruptFails) return false;
      db.updateAgent(a.id, { activity: 'idle', activity_detail: 'interrupted' });
      return true;
    },
    stop: async (a) => {
      order.push(`stop:${a.name}`);
      if (name === 'fake' && mode.stopFails) throw new Error('its server still runs');
    },
  });
  adapters.fake = fake('fake');
  adapters.fake2 = fake('fake2');
});
after(() => {
  killTmuxServer(socket);
  rmSync(home, { recursive: true, force: true });
});

function agent(name, parent_id = null, fields = {}) {
  const id = db.newAgentId();
  const cwd = join(home, 'work', name);
  mkdirSync(cwd, { recursive: true });
  db.createAgent({ id, name, role: `role of ${name}`, machine: 'test', harness: 'fake', model: null, effort: null, cwd, parent_id, session_id: null, ...fields });
  db.updateAgent(id, { activity: 'idle' });
  return db.getAgent(id);
}
const get = (a) => db.getAgent(a.id);
const byName = (n) => db.getAgent(n);
const events = (a, type) => db.listEvents(a.id, 500).filter((e) => e.type === type).map((e) => JSON.parse(e.data ?? 'null'));
const fast = { softStopMinutes: 0.003, pollMs: 20 };

let cos, mgr;
beforeEach(() => {
  costNotices.notices(0); // creates the cost_notices table before it is cleared
  const d = db.open();
  for (const t of ['cost_notices', 'blockers', 'agent_parents', 'agents', 'mail_recipients', 'mail', 'events', 'itsas', 'itsa_participants', 'waits']) d.exec(`DELETE FROM ${t}`);
  killTmuxServer(socket);
  failLaunch = false;
  mode = {};
  interrupts.length = 0;
  order.length = 0;
  cos = agent('cos');
  mgr = agent('mgr', cos.id);
});

test('successor names count on as -t2, -t3, unique even among archived agents', () => {
  const x = agent('worker', mgr.id);
  assert.equal(costSwitch.successorName('worker'), 'worker-t2');
  const old = agent('worker-t2', mgr.id);
  db.updateAgent(old.id, { lifecycle: 'archived' });
  assert.equal(costSwitch.successorName('worker'), 'worker-t3');
  // A successor's successor counts on from the original name.
  assert.equal(costSwitch.successorName('worker-t2'), 'worker-t3');
  assert.equal(get(x).name, 'worker');
});

test('a switch onto a blocked account is refused with the reason, and nothing changes', async () => {
  const x = agent('worker', mgr.id);
  const onB = agent('on-b', null, { harness: 'fake2' });
  await blockers.addBlocker(onB, { kind: 'window', account: 'acct-b', reason: 'five_hour at 100%' });
  await assert.rejects(costSwitch.costSwitch({ agent: x.name, preset: 'cheap', by: mgr.id, ...fast }), /account acct-b is blocked: window \(five_hour at 100%\)/);
  assert.equal(byName('worker-t2'), undefined);
  assert.equal(get(x).lifecycle, 'active');
  assert.equal(get(x).forwarded_to, null);
  assert.equal(blockers.blockers(x).length, 0);
});

test('only a manager of the tree, the chief of staff, or the human may switch', async () => {
  const x = agent('worker', mgr.id);
  const stranger = agent('stranger');
  assert.throws(() => costSwitch.check({ agent: x.name, preset: 'cheap', by: stranger.id }), (e) => e.forbidden === true);
  assert.throws(() => costSwitch.check({ agent: x.name, preset: 'nope', by: mgr.id }), /no preset nope/);
  assert.equal(costSwitch.check({ agent: x.name, preset: 'cheap', by: cos.id }).successor, 'worker-t2');
  assert.equal(costSwitch.check({ agent: x.name, preset: 'cheap', by: 'human' }).successor, 'worker-t2');
});

test('a working agent is asked to wrap up, then interrupted after the deadline and stopped, without a pause turn', async () => {
  const x = agent('worker', mgr.id);
  db.updateAgent(x.id, { activity: 'working' });
  const r = await costSwitch.costSwitch({ agent: x.name, preset: 'cheap', by: mgr.id, ...fast });
  assert.equal(r.waited, true);
  assert.equal(r.interrupted, true);
  assert.deepEqual(interrupts, [x.id]);
  const queued = events(x, 'notice:queued').map((e) => e.text);
  assert.ok(queued.some((t) => t.startsWith('[stam] Your work is moving to another agent')), 'the wrap-up request was sent');
  // Stopped through the shutdown path, its session kept; no pause turn on the way.
  assert.equal(get(x).lifecycle, 'shut_down');
  assert.equal((prompts.get(x.id) ?? []).length, 0);
});

test('a working agent that ends its turn in time is not interrupted; an idle one skips the wait', async () => {
  const x = agent('worker', mgr.id);
  db.updateAgent(x.id, { activity: 'working' });
  setTimeout(() => db.updateAgent(x.id, { activity: 'idle', activity_detail: 'turn finished' }), 40);
  const r = await costSwitch.costSwitch({ agent: x.name, preset: 'cheap', by: mgr.id, softStopMinutes: 1, pollMs: 10 });
  assert.equal(r.waited, true);
  assert.equal(r.interrupted, false);
  assert.deepEqual(interrupts, []);

  const y = agent('idler', mgr.id);
  const t0 = Date.now();
  const r2 = await costSwitch.costSwitch({ agent: y.name, preset: 'cheap', by: mgr.id, softStopMinutes: 1 });
  assert.equal(r2.waited, false);
  assert.ok(Date.now() - t0 < 5000);
});

test('the switch moves parents, children, unread mail and open threads in one go, and forwards later mail', async () => {
  const p2 = agent('second-parent', cos.id);
  const x = agent('worker', mgr.id, {});
  db.addParent(x.id, p2.id);
  db.updateAgent(x.id, { visibility: JSON.stringify({ only: ['mgr'] }), standing: 1, personal_workspace: join(home, 'workspaces', 'worker'), first_prompt: 'Build the frobnicator.', transcript_path: join(home, 'transcript.jsonl'), workspace: JSON.stringify({ spec: { kind: 'dir', path: x.cwd }, cwd: x.cwd }) });
  writeFileSync(
    join(home, 'transcript.jsonl'),
    [JSON.stringify({ type: 'user', message: { content: 'hi' } }), JSON.stringify({ type: 'user', isCompactSummary: true, message: { content: 'Summary: the frobnicator is half built.' } })].join('\n'),
  );
  writeFileSync(join(x.cwd, 'HANDOVER.md'), '# Goal\nfrobnicator\n');
  const c1 = agent('child-one', x.id);
  const c2 = agent('child-two', cos.id);
  db.addParent(c2.id, x.id);
  // A read thread and an unread mail.
  db.createMail({ id: 'mread1', from_id: mgr.id, from_name: 'mgr', subject: 'Plan', body: 'the plan', thread_id: 'mread1', reply_to: null }, [x.id]);
  db.readMail(x.id, ['mread1']);
  db.createMail({ id: 'munread', from_id: mgr.id, from_name: 'mgr', subject: 'More', body: 'more', thread_id: 'munread', reply_to: null }, [x.id]);
  // An open cost notice about the predecessor, raised to its manager.
  costNotices.blockerChanged(x.id, 'window', 'acct-a', 'set', 'five_hour at 100%', new Date().toISOString());
  const open = costNotices.openNotices([x.id]);
  assert.equal(open.length, 1);

  // A workspace shared with the predecessor (S-896).
  const sharer = agent('sharer', mgr.id);
  db.updateAgent(sharer.id, { personal_workspace: join(home, 'workspaces', 'sharer') });
  const wshare = await import('../src/workspace-share.ts');
  wshare.share(sharer.id, x.id, 'write');

  // An open ITSA the predecessor owns, held by a delta reader before the switch (S-1208).
  const stamp = '2026-01-01T00:00:00.000Z';
  db.open().prepare('INSERT INTO itsas (id, key, parent_id, kind, title, status, owner, created_by, created_at, updated_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('IW', 'S-9', null, 'issue', 'S-9', 'in_progress', x.id, 'mgr', stamp, stamp, null);
  const summary = await import('../src/activity-summary.ts');
  const held = summary.attributionExport(null);

  const r = await costSwitch.costSwitch({ agent: x.name, preset: 'cheap', by: mgr.id, ...fast });
  const s = byName('worker-t2');
  assert.ok(s, 'the successor exists');
  // The owner change reaches a delta reader: its merge equals a full resend.
  const delta = summary.attributionExport(held.sig, -1, false, stamp);
  assert.deepEqual(delta.itsas.map((i) => i.id), ['IW']);
  assert.equal(summary.mergeRows(held.itsas, delta.itsas, delta.ids)[0].owner, s.id);
  assert.deepEqual(summary.mergeRows(held.itsas, delta.itsas, delta.ids), summary.attributionExport(null).itsas);
  assert.deepEqual(wshare.grantsFor(s.id).map((g) => g.access), ['write'], 'the successor keeps the shared workspace');
  assert.equal(r.to, 'worker-t2');
  // Same role, cwd, workspace, machine and visibility; the preset's harness and model.
  assert.equal(s.role, x.role);
  assert.equal(s.cwd, x.cwd);
  assert.equal(s.workspace, get(x).workspace);
  assert.equal(s.machine, x.machine);
  assert.equal(s.visibility, get(x).visibility);
  // A specialist's standing flag and personal workspace go to the successor (S-894).
  assert.equal(s.standing, 1);
  assert.equal(s.personal_workspace, join(home, 'workspaces', 'worker'));
  assert.equal(s.harness, 'fake2');
  assert.equal(s.model, 'cheap-model');
  assert.equal(s.first_prompt, 'Build the frobnicator.');
  // Parents (all of them), children.
  assert.deepEqual(db.parentsOf(s).sort(), [mgr.id, p2.id].sort());
  assert.deepEqual(db.childrenOf(s.id).sort(), [c1.id, c2.id].sort());
  assert.deepEqual(db.childrenOf(x.id), []);
  assert.deepEqual(db.parentsOf(get(c2)).sort(), [cos.id, s.id].sort());
  assert.deepEqual(r.moved.children.sort(), ['child-one', 'child-two']);
  // Mail: unread moved, the read thread copied as read, both threads listed for the successor.
  assert.deepEqual(db.inbox(s.id, true, 10).map((m) => m.id), ['munread']);
  assert.deepEqual(db.inbox(x.id, true, 10), []);
  assert.deepEqual(db.threads(s.id, 10).map((t) => t.thread_id).sort(), ['mread1', 'munread']);
  // Later mail to the old name reaches the successor.
  const m = await mail.sendMail({ from: mgr.id, to: ['worker'], subject: 'After', body: 'still there?' });
  assert.deepEqual(db.threadMail(m.thread_id)[0].recipients.map((x) => x.id), [s.id]);
  // The takeover prompt: original prompt, HANDOVER.md, transcript, summary, threads.
  const first = launches.get(s.id)[0];
  assert.match(first, /taking over the work of worker/);
  assert.match(first, /Build the frobnicator\./);
  assert.ok(first.includes(join(x.cwd, 'HANDOVER.md')));
  assert.ok(first.includes(join(home, 'transcript.jsonl')));
  assert.match(first, /the frobnicator is half built/);
  assert.match(first, /mread1: Plan/);
  assert.equal(r.handover, join(x.cwd, 'HANDOVER.md'));
  // The predecessor is stopped and held as taken over, not archived.
  const pred = get(x);
  assert.equal(pred.lifecycle, 'shut_down');
  assert.equal(pred.forwarded_to, s.id);
  const b = blockers.blockers(pred).find((b) => b.kind === 'taken-over');
  assert.match(b.reason, /taken over by worker-t2 on preset cheap/);
  // Notices: the open one acknowledged; the successor's parents told.
  assert.deepEqual(r.acked, [open[0].id]);
  assert.equal(costNotices.notice(open[0].id).acked_by, mgr.id);
  for (const p of [mgr, p2]) assert.deepEqual(events(p, 'cost:switched'), [{ from: 'worker', to: 'worker-t2', preset: 'cheap' }]);
  // A switched agent can't be switched again; its successor can.
  assert.throws(() => costSwitch.check({ agent: 'worker', preset: 'cheap', by: mgr.id }), /already taken over by worker-t2/);
  assert.equal(costSwitch.check({ agent: 'worker-t2', preset: 'cheap', by: mgr.id }).successor, 'worker-t3');
});

test('a failed launch rolls everything back and resumes the predecessor', async () => {
  const x = agent('worker', mgr.id, { session_id: 'sess-worker' });
  const c1 = agent('child-one', x.id);
  db.createMail({ id: 'munread', from_id: mgr.id, from_name: 'mgr', subject: 'More', body: 'more', thread_id: 'munread', reply_to: null }, [x.id]);
  db.createMail({ id: 'mread', from_id: mgr.id, from_name: 'mgr', subject: 'Old', body: 'old', thread_id: 'mread', reply_to: null }, [x.id]);
  db.readMail(x.id, ['mread']);
  failLaunch = true;
  await assert.rejects(costSwitch.costSwitch({ agent: x.name, preset: 'cheap', by: mgr.id, ...fast }), /failed, and worker was restored: harness would not start/);
  assert.equal(byName('worker-t2'), undefined, 'the successor is gone');
  const pred = get(x);
  assert.equal(pred.lifecycle, 'active');
  assert.equal(pred.forwarded_to, null);
  assert.deepEqual(blockers.blockers(pred), []);
  assert.deepEqual(db.childrenOf(x.id), [c1.id]);
  assert.equal(get(c1).parent_id, x.id);
  assert.deepEqual(db.inbox(x.id, true, 10).map((m) => m.id), ['munread']);
  assert.deepEqual(db.threadMail('mread')[0].recipients.map((r) => r.id), [x.id]);
  assert.ok(events(x, 'cost:switch').some((e) => e.step === 'rolled-back'));
  // Resumed with its conversation, and told why.
  assert.match(launches.get(x.id).at(-1), /the switch failed, so you continue yourself: harness would not start/);
  // The name is free again.
  assert.equal(costSwitch.successorName('worker'), 'worker-t2');
});

test('archiving the predecessor keeps the worktree its successor uses; the last one removes it', async () => {
  const { createWorkspace } = await import('../src/workspace.ts');
  const repo = join(home, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');
  const ws = createWorkspace({ kind: 'worktree', repo }, 'wt-worker');
  const x = agent('wt-worker', mgr.id, { cwd: ws.cwd });
  db.updateAgent(x.id, { workspace: JSON.stringify(ws) });
  await costSwitch.costSwitch({ agent: x.name, preset: 'cheap', by: mgr.id, ...fast });
  const s = byName('wt-worker-t2');
  assert.equal(s.cwd, ws.cwd);
  assert.deepEqual(lifecycle.worktreeUsers(ws.worktree.path, x.id).map((a) => a.name), ['wt-worker-t2']);

  db.updateAgent(x.id, { lifecycle: 'shut_down' });
  await lifecycle.archive(get(x));
  assert.equal(get(x).lifecycle, 'archived');
  assert.match(get(x).activity_detail, /kept worktree .*: wt-worker-t2 still uses it/);
  assert.ok(existsSync(ws.worktree.path), 'the worktree is still there');

  db.updateAgent(s.id, { lifecycle: 'shut_down' });
  await lifecycle.archive(get(s));
  assert.match(get(s).activity_detail, /removed worktree/);
  assert.ok(!existsSync(ws.worktree.path));
});

test('db.transaction writes everything or nothing', () => {
  const id = db.newAgentId();
  assert.throws(() =>
    db.transaction(() => {
      db.createAgent({ id, name: 'half-made', role: '', machine: 'test', harness: 'fake', model: null, effort: null, cwd: home, parent_id: mgr.id, session_id: null });
      db.updateAgent(mgr.id, { forwarded_to: id });
      throw new Error('midway');
    }),
  /midway/);
  assert.equal(db.getAgent(id), undefined);
  assert.equal(get(mgr).forwarded_to, null);
});

// Review finding 1: an interrupt that fails, or a paused agent still mid-turn, must not leave
// a second writer: the harness is stopped and confirmed gone before the successor launches.
test('a failed interrupt still stops the predecessor before the successor launches, paused agents too', async () => {
  mode.interruptFails = true;
  const x = agent('worker', mgr.id, { session_id: 'sess-1' });
  await lifecycle.startHarness(get(x), undefined, false);
  assert.ok(lifecycle && spawnSync('tmux', ['-L', socket, 'has-session', '-t', `=${x.id}`]).status === 0);
  db.updateAgent(x.id, { lifecycle: 'paused', paused_by: JSON.stringify(['human']), activity: 'working' });
  const r = await costSwitch.costSwitch({ agent: x.name, preset: 'cheap', by: mgr.id, ...fast });
  assert.equal(r.waited, true, 'a paused agent with a running turn is quiesced too');
  assert.equal(r.interrupted, true);
  assert.deepEqual(interrupts, [x.id]);
  assert.notEqual(spawnSync('tmux', ['-L', socket, 'has-session', '-t', `=${x.id}`]).status, 0, 'the predecessor terminal is gone');
  assert.equal(get(x).lifecycle, 'shut_down');
  assert.equal(get(x).session_id, 'sess-1', 'its session is kept');
  assert.deepEqual(order, ['launch:worker', 'stop:worker', 'launch:worker-t2']);
  assert.ok(events(x, 'cost:switch').some((e) => e.step === 'interrupt' && e.confirmed === false));
});

test('when the stop is not confirmed, no successor starts', async () => {
  mode.stopFails = true;
  const x = agent('worker', mgr.id);
  await assert.rejects(costSwitch.costSwitch({ agent: x.name, preset: 'cheap', by: mgr.id, ...fast }), /its server still runs/);
  assert.equal(byName('worker-t2'), undefined);
  assert.ok(!order.some((o) => o.startsWith('launch:worker-t2')));
  assert.deepEqual(blockers.blockers(x), []);
  assert.equal(get(x).forwarded_to, null);
});

// Review finding 2: the taken-over predecessor can't be brought back while its successor lives.
test('a taken-over predecessor refuses resume, unpause and turns, even forced, until its successor is archived', async () => {
  const admission = await import('../src/admission.ts');
  const x = agent('worker', mgr.id, { session_id: 'sess-2' });
  await costSwitch.costSwitch({ agent: x.name, preset: 'cheap', by: mgr.id, ...fast });
  const s = byName('worker-t2');
  const msg = /worker was taken over by worker-t2: switch back with `cost_switch worker-t2 PRESET`, or archive worker-t2 first/;
  await assert.rejects(lifecycle.resume(get(x)), msg);
  db.updateAgent(x.id, { lifecycle: 'paused' });
  await assert.rejects(lifecycle.unpause(get(x), { by: 'human', force: true }), msg);
  db.updateAgent(x.id, { lifecycle: 'shut_down' });
  await assert.rejects(lifecycle.startHarness(get(x), 'hello', true), msg);
  assert.equal(admission.admit(x.id, 'human').ok, false);
  assert.equal(admission.admit(x.id, 'mail').ok, false);
  // Archiving the successor releases it: its mail is its own again, and it may resume.
  db.updateAgent(s.id, { lifecycle: 'shut_down' });
  await lifecycle.archive(get(s));
  assert.equal(get(x).forwarded_to, null);
  assert.deepEqual(blockers.blockers(x), []);
  assert.equal(admission.admit(x.id, 'mail').ok, true);
  assert.equal(await lifecycle.resume(get(x)), 'resuming');
});

// Review finding 3: mail the successor got during its startup goes back on rollback.
test('rollback returns every mail the successor got, merging duplicates and keeping unread', async () => {
  const x = agent('worker', mgr.id, { session_id: 'sess-3' });
  db.createMail({ id: 'mdup', from_id: mgr.id, from_name: 'mgr', subject: 'Dup', body: 'dup', thread_id: 'mdup', reply_to: null }, [x.id]);
  db.readMail(x.id, ['mdup']);
  // An archived thread: the successor gets no read copy of it.
  db.archiveThread(x.id, 'mdup', ['mdup']);
  mode.duringStartup = async (s) => {
    await mail.sendMail({ from: mgr.id, to: ['worker'], subject: 'During', body: 'sent while it started' });
    // The same mail arriving again for the successor (a forward under its id): delivered to
    // both, read only by the predecessor, so the merge keeps it unread.
    assert.deepEqual(db.addRecipients('mdup', [s.id]), [s.id]);
  };
  mode.afterLaunchReject = true;
  await assert.rejects(costSwitch.costSwitch({ agent: x.name, preset: 'cheap', by: mgr.id, ...fast }), /the first prompt was not taken/);
  const unread = db.inbox(x.id, true, 10).map((m) => m.subject).sort();
  assert.deepEqual(unread, ['Dup', 'During']);
  assert.equal(db.open().prepare('SELECT COUNT(*) AS n FROM mail_recipients WHERE agent_id = ? AND mail_id = ?').get(x.id, 'mdup').n, 1);
  assert.equal(byName('worker-t2'), undefined);
});

// Review finding 4: a startup that errors or never finishes rolls back.
test('a successor that never finishes starting is rolled back after the startup timeout', async () => {
  const x = agent('worker', mgr.id, { session_id: 'sess-4' });
  mode.stayStarting = true;
  await assert.rejects(costSwitch.costSwitch({ agent: x.name, preset: 'cheap', by: mgr.id, ...fast, startupMs: 300 }), /worker-t2 didn't start within/);
  assert.equal(byName('worker-t2'), undefined);
  assert.equal(get(x).forwarded_to, null);
  assert.equal(get(x).lifecycle, 'active', 'resumed');
});

// Review finding 5: Claude Code's Esc goes in only while a turn runs, never types `i`, and is
// confirmed only by a new "Interrupted" line. The pane echoes keys (cat -v), so stray ones show.
test('the Claude interrupt never touches an idle input, never types i, and ignores old scrollback', async () => {
  const { adapters } = await import('../src/adapters/index.ts');
  const tmux = await import('../src/tmux.ts');
  const x = agent('claude-worker', mgr.id, { harness: 'claude' });
  const screen = (text) => {
    tmux.killSession(x.id);
    tmux.newSession(x.id, home, {}, ['sh', '-c', `printf '${text}'; stty -icanon -echo; exec cat -v`]);
  };
  const pane = () => tmux.capturePane(x.id);
  // Idle in stam's state: no key at all, even with an old spinner and "Interrupted" on screen.
  screen('⎿  Interrupted · What should Claude do instead?\\n✶ Blanching… (13s · ↓ 4 tokens)\\n-- INSERT --\\n');
  await sleep(300);
  assert.equal(await adapters.claude.interrupt(get(x)), false);
  assert.ok(!pane().includes('^['), 'no Esc on an idle agent');
  // Working with vim INSERT: two Escs, no `i`, and the old "Interrupted" line doesn't confirm.
  db.updateAgent(x.id, { activity: 'working' });
  assert.equal(await adapters.claude.interrupt(get(x)), false);
  const typed = pane().split('\n').slice(3).join('');
  assert.equal((typed.match(/\^\[/g) ?? []).length, 2);
  assert.ok(!/(^|[^\^])i/.test(typed.replace(/\^\[/g, '')), 'no i typed');
  // No spinner on screen: the turn isn't running, so no key.
  screen('-- INSERT --\\n');
  await sleep(300);
  assert.equal(await adapters.claude.interrupt(get(x)), false);
  assert.ok(!pane().includes('^['));
  tmux.killSession(x.id);
});

// Review finding 6: an agent whose cwd sits inside the worktree keeps it from being removed.
test('archive keeps a worktree while any live agent works inside it', async () => {
  const { createWorkspace } = await import('../src/workspace.ts');
  const repo = join(home, 'repo6');
  mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');
  const ws = createWorkspace({ kind: 'worktree', repo }, 'owner6');
  const owner = agent('owner6', mgr.id, { cwd: ws.cwd });
  db.updateAgent(owner.id, { workspace: JSON.stringify(ws), lifecycle: 'shut_down' });
  const sub = join(ws.cwd, 'pkg', 'inner');
  mkdirSync(sub, { recursive: true });
  // Reached through a symlink, so only the canonical path matches.
  const link = join(home, 'link6');
  execFileSync('ln', ['-s', ws.cwd, link]);
  const guest = agent('guest6', mgr.id, { cwd: join(link, 'pkg', 'inner') });
  assert.deepEqual(lifecycle.worktreeUsers(ws.worktree.path, owner.id).map((a) => a.name), ['guest6']);
  await lifecycle.archive(get(owner));
  assert.match(get(owner).activity_detail, /kept worktree .*: guest6 still uses it/);
  assert.ok(existsSync(ws.worktree.path));
  assert.equal(get(guest).lifecycle, 'active');
});

// A daemon restart drops the soft stop's timer; the quiesce event keeps its deadline, so the
// boot re-arms it: a switch cut short is interrupted at the deadline and moved as usual.
test('a restart re-arms a switch whose soft stop was cut short: its working agent is interrupted and moved', async () => {
  const x = agent('worker', mgr.id);
  db.updateAgent(x.id, { activity: 'working' });
  db.addEvent(x.id, 'cost:switch', { step: 'start', by: mgr.id, preset: 'cheap' });
  db.addEvent(x.id, 'cost:switch', { step: 'quiesce', minutes: 10, deadline: new Date(Date.now() + 200).toISOString(), preset: 'cheap', by: mgr.id });
  // Its deadline is 200 ms away, so the resumed switch waits for it before the interrupt.
  const resumed = costSwitch.resumeSwitches();
  assert.deepEqual(resumed, ['worker']);
  await until(() => byName('worker-t2'));
  assert.deepEqual(interrupts, [x.id]);
  assert.equal(get(x).lifecycle, 'shut_down');
  const s = byName('worker-t2');
  assert.equal(get(x).forwarded_to, s.id);
});

test('a restart re-arms each pending switch with its own deadline', async () => {
  const p = agent('pending-a', mgr.id);
  const q = agent('pending-b', mgr.id);
  for (const [x, ms] of [[p, 100], [q, 900]]) {
    db.updateAgent(x.id, { activity: 'working' });
    db.addEvent(x.id, 'cost:switch', { step: 'start', by: mgr.id, preset: 'cheap' });
    db.addEvent(x.id, 'cost:switch', { step: 'quiesce', minutes: 10, deadline: new Date(Date.now() + ms).toISOString(), preset: 'cheap', by: mgr.id });
  }
  assert.deepEqual(costSwitch.resumeSwitches(), ['pending-a', 'pending-b']);
  await until(() => byName('pending-a-t2'));
  assert.ok(!byName('pending-b-t2'), 'the second waits for its own, later deadline');
  await until(() => byName('pending-b-t2'));
  assert.deepEqual(interrupts.sort(), [p.id, q.id].sort());
});

test('a restart between the interrupt and the stop still resumes the switch', async () => {
  const x = agent('cut', mgr.id);
  db.updateAgent(x.id, { activity: 'working' });
  db.addEvent(x.id, 'cost:switch', { step: 'start', by: mgr.id, preset: 'cheap' });
  db.addEvent(x.id, 'cost:switch', { step: 'quiesce', minutes: 10, deadline: new Date(Date.now() - 1000).toISOString(), preset: 'cheap', by: mgr.id });
  db.addEvent(x.id, 'cost:switch', { step: 'interrupt', confirmed: true });
  assert.deepEqual(costSwitch.resumeSwitches(), ['cut']);
  await until(() => byName('cut-t2'));
  assert.equal(get(x).forwarded_to, byName('cut-t2').id);
});

test('a restart leaves alone a switch that finished or was never started', async () => {
  const done = agent('finished', mgr.id);
  db.addEvent(done.id, 'cost:switch', { step: 'start', by: mgr.id, preset: 'cheap' });
  db.addEvent(done.id, 'cost:switch', { step: 'quiesce', minutes: 10, deadline: new Date(Date.now() - 1000).toISOString(), preset: 'cheap', by: mgr.id });
  db.addEvent(done.id, 'cost:switch', { step: 'done', to: 'finished-t2' });
  const idle = agent('idle', mgr.id);
  const resumed = await costSwitch.resumeSwitches();
  assert.deepEqual(resumed, []);
  assert.equal(get(done).lifecycle, 'active');
  assert.equal(get(idle).lifecycle, 'active');
  assert.deepEqual(interrupts, []);
});

// The successor gets the predecessor's HANDOVER.md in its first prompt; without one, a brief
// stam generates: branch, head, worktree, ITSAs and the last message.
test('the successor is handed the predecessor HANDOVER.md, or a generated brief when there is none', async () => {
  const withFile = agent('writer', mgr.id);
  writeFileSync(join(withFile.cwd, 'HANDOVER.md'), '# Goal\nFinish the parser\n');
  await costSwitch.costSwitch({ agent: withFile.name, preset: 'cheap', by: mgr.id });
  const first = launches.get(byName('writer-t2').id).at(-1);
  assert.match(first, /Finish the parser/);
  assert.doesNotMatch(first, /Generated by stam/);

  const without = agent('silent', mgr.id);
  db.updateAgent(without.id, { last_message: 'Ran the tests; two fail in parser.test.' });
  await costSwitch.costSwitch({ agent: without.name, preset: 'cheap', by: mgr.id });
  const brief = launches.get(byName('silent-t2').id).at(-1);
  assert.match(brief, /Generated by stam: silent left no HANDOVER\.md/);
  assert.match(brief, /- Worktree: /);
  assert.match(brief, /- Its last message: Ran the tests; two fail in parser\.test\./);
});

test('a resume or an archive is refused while a switch of the agent is under way', async () => {
  const x = agent('busy-one', mgr.id);
  db.updateAgent(x.id, { activity: 'working' });
  const sw = costSwitch.costSwitch({ agent: x.name, preset: 'cheap', by: mgr.id, softStopMinutes: 0.05, pollMs: 20 });
  await sleep(100);
  await assert.rejects(lifecycle.unpause(get(x), { by: 'human' }), /is being switched/);
  await assert.rejects(lifecycle.archive(get(x)), /is being switched/);
  const r = await sw;
  assert.equal(r.interrupted, true);
  assert.equal(get(x).lifecycle, 'shut_down');
});

// A resume that starts before an archive keeps the agent's lock for its whole run: the archive
// is refused while the launch runs, and the agent is never archived under a running resume.
test('an archive is refused while a resume of the agent is launching', async () => {
  const x = agent('resumer', mgr.id, { session_id: 'fake-session-r' });
  await lifecycle.shutdown(get(x), true);
  mode.launchDelay = 400;
  const resuming = lifecycle.resume(get(x));
  await sleep(100);
  await assert.rejects(lifecycle.archive(get(x)), /is being resumed/);
  await resuming;
  assert.notEqual(get(x).lifecycle, 'archived');
  assert.equal(get(x).lifecycle, 'active');
});

// A failed switch's rollback resumes the predecessor under the switch's lock: an archive asked
// meanwhile is refused, not run between the release and the resume.
test('a failed switch keeps its lock through the rollback: an archive meanwhile is refused', async () => {
  const x = agent('rolled', mgr.id, { session_id: 'fake-session-rolled' });
  failLaunch = true;
  mode.launchDelay = 400;
  const sw = costSwitch.costSwitch({ agent: x.name, preset: 'cheap', by: mgr.id, softStopMinutes: 0.003, pollMs: 20 }).catch((e) => e);
  await sleep(150);
  await assert.rejects(lifecycle.archive(get(x)), /is being switched/);
  const err = await sw;
  assert.match(err.message, /failed/);
  assert.equal(get(x).lifecycle, 'active');
});

// S-357: mail a read batch handed out, whose reply never reached the client, is still owed to the
// predecessor. The switch moves it to the successor as unread, with its batch; a rollback gives it
// back with the read state it had.
test('mail owed to an unacknowledged read batch moves to the successor, and a rollback gives it back', async () => {
  const x = agent('worker', mgr.id, { session_id: 'sess-owed' });
  db.createMail({ id: 'mowed', from_id: mgr.id, from_name: 'mgr', subject: 'Owed', body: 'owed', thread_id: 'mowed', reply_to: null }, [x.id]);
  db.readMail(x.id, ['mowed'], 'batch-lost');
  assert.deepEqual(db.inbox(x.id, true, 10), []);
  await costSwitch.costSwitch({ agent: x.name, preset: 'cheap', by: mgr.id, ...fast });
  const s = byName('worker-t2');
  assert.deepEqual(db.inbox(s.id, true, 10).map((m) => m.id), ['mowed']);
  assert.deepEqual(db.defaultRead(s.id), ['mowed']);
  // Acknowledged, the mail is only the successor's unread mail; once read, nothing is owed.
  db.ackDelivered(s.id, 'batch-lost');
  assert.deepEqual(db.defaultRead(s.id), ['mowed']);
  db.readMail(s.id, ['mowed']);
  assert.deepEqual(db.defaultRead(s.id), []);
});

test('a rollback gives back the owed mail with its batch and its read state', async () => {
  const x = agent('worker', mgr.id, { session_id: 'sess-owed-rollback' });
  db.createMail({ id: 'mback', from_id: mgr.id, from_name: 'mgr', subject: 'Back', body: 'back', thread_id: 'mback', reply_to: null }, [x.id]);
  db.readMail(x.id, ['mback'], 'batch-kept');
  mode.afterLaunchReject = true;
  await assert.rejects(costSwitch.costSwitch({ agent: x.name, preset: 'cheap', by: mgr.id, ...fast }), /the first prompt was not taken/);
  assert.equal(byName('worker-t2'), undefined);
  assert.deepEqual(db.defaultRead(x.id), ['mback']);
  assert.deepEqual(db.inbox(x.id, true, 10), []);
  db.ackDelivered(x.id, 'batch-kept');
  assert.deepEqual(db.defaultRead(x.id), []);
});

// S-2490: a ring turn queued to a working predecessor is still queued when it is switched. It moves
// to the successor, which is prompted for it once, and the predecessor is never prompted for it.
test('a ring turn queued before the switch reaches the successor exactly once (S-2490)', async () => {
  const ring = await import('../src/ring.ts');
  const x = agent('worker', mgr.id);
  const other = agent('peer', mgr.id);
  db.updateAgent(x.id, { activity: 'working' });
  const topic = 'Swarm the widget seventy-seven';
  ring.createRing({ name: 'widgets', format: 'rounds', topic, members: [x.name, other.name], maxRounds: 1, createdBy: 'human' });
  assert.equal(mail.queuedNoticeCount(x.id), 1, 'the predecessor holds its ring turn');
  await costSwitch.costSwitch({ agent: x.name, preset: 'cheap', by: mgr.id, ...fast });
  const s = byName('worker-t2');
  assert.equal(mail.queuedNoticeCount(x.id), 0, 'the predecessor no longer holds it');
  assert.equal(mail.queuedNoticeCount(s.id), 1, 'the successor holds it');
  db.updateAgent(s.id, { activity: 'idle' });
  mail.schedulePush(s.id);
  await until(() => (prompts.get(s.id) ?? []).some((t) => t.includes(topic)));
  await sleep(100);
  assert.equal((prompts.get(s.id) ?? []).filter((t) => t.includes(topic)).length, 1, 'the successor is prompted once');
  assert.ok(!(prompts.get(x.id) ?? []).some((t) => t.includes(topic)), 'the predecessor is never prompted');
});

// S-923: the successor holds the predecessor's worktree and branch, and pr_open and a branch link must pass for it.
test("the successor's branch scope is its own tree's, while an unrelated agent still gets foreign", async () => {
  const { localScope } = await import('../src/branch-scope.ts');
  const branch = 'stam/worker-dev';
  const x = agent('worker', mgr.id);
  db.updateAgent(x.id, { workspace: JSON.stringify({ worktree: { branch, path: x.cwd } }) });
  const stranger = agent('stranger', cos.id);
  assert.equal(localScope(x.id, branch), 'tree');
  assert.equal(localScope(stranger.id, branch), 'foreign');

  const r = await costSwitch.costSwitch({ agent: x.name, preset: 'cheap', by: mgr.id, softStopMinutes: 1 });
  const s = byName(r.to);
  assert.equal(get(x).lifecycle !== 'archived', true, 'the stopped predecessor still holds its branch');
  assert.equal(localScope(s.id, branch), 'tree', "the successor's pr_open scope passes");
  assert.equal(localScope(stranger.id, branch), 'foreign', 'an unrelated agent is still refused');
  // A hand-made successor in the same worktree is not handed anything.
  const hand = agent('hand-made', mgr.id, { cwd: x.cwd });
  db.updateAgent(hand.id, { workspace: get(x).workspace });
  assert.equal(localScope(hand.id, branch), 'foreign');
  // The handover is in the database: it survives a reopen of it.
  assert.equal(get(x).forwarded_to, s.id);
});
