#!/usr/bin/env node
// S-1982: any agent with only stam-held waits rests when its expected wake is far off (after
// rest.graceMinutes idle), or after rest.afterMinutes idle with no known time; the never-rest
// cases, the manager rule, the churn guard, the cos and assistant default, compaction before a
// long rest, and the wakes (mail, a timer, an event). The settings keep their defaults (20 and 2
// minutes); each agent's idle_since and wait times are set directly, so nothing waits on a clock.
// A throwaway STAM_HOME and tmux socket with a fake harness; no daemon, no models:
// `node --test test/rest.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-rest-');
const socket = `rest-test-${process.pid}`;
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = socket;
process.env.STAM_EMBEDDER = 'stub';
process.env.STAM_EVENT_FOLD_MS = '0';
process.env.STAM_REST_ENABLED = '1'; // test/lib.sh turns it off for every other test
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_STANDING_IDLE_HOURS', 'STAM_REST_AFTER_MINUTES', 'STAM_REST_GRACE_MINUTES']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [], chiefOfStaff: 'rest-cos' }));

let db, lifecycle, mail, waits, watch, org;
const pushed = [];
before(async () => {
  db = await import('../src/db.ts');
  lifecycle = await import('../src/lifecycle.ts');
  mail = await import('../src/mail.ts');
  waits = await import('../src/waits.ts');
  watch = await import('../src/watch.ts');
  org = await import('../src/org.ts');
  lifecycle.startRestWaking();
  org.watchActivity();
  const { adapters } = await import('../src/adapters/index.ts');
  adapters.fake = {
    pushPrompt: async (a, text) => (pushed.push({ id: a.id, text }), true),
    launch: async () => ({ argv: ['sleep', '600'], env: {} }),
    afterLaunch: async (a) => {
      db.updateAgent(a.id, { activity: 'idle' });
    },
    turnRunning: async () => false,
  };
});
after(() => {
  spawnSync('tmux', ['-L', socket, 'kill-server']);
  rmSync(home, { recursive: true, force: true });
});

const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
let n = 0;
// An idle agent, idle for `idle` minutes. Declare its waits first, then call idleFor: a wait
// turns the activity 'waiting' and moves idle_since.
function agent({ name, kind = null, parent = null, standing = false, notices = null } = {}) {
  const id = db.newAgentId();
  const cwd = join(home, `work-${id}`);
  mkdirSync(cwd);
  db.createAgent({ id, name: name ?? `r${++n}`, role: '', machine: 'test', harness: 'fake', model: null, effort: null, cwd, parent_id: parent, session_id: `sess-${id}` });
  db.updateAgent(id, { workspace: JSON.stringify({ spec: { kind: 'dir', path: cwd }, cwd }), lifecycle: 'active', activity: 'idle', kind, standing: standing ? 1 : 0, child_notices: notices });
  return db.getAgent(id);
}
const idleFor = (a, min) => db.updateAgent(a.id, { idle_since: ago(min) });
const events = (id, type) => db.listEvents(id, 500).filter((e) => e.type === type);
const settled = async (fn) => {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail('state not reached');
};
const sweep = async (a) => {
  lifecycle.restSweep();
  // rest() runs in the agent's serial queue; let it finish before reading the state.
  await lifecycle.rest(a.id).catch(() => {});
  return db.getAgent(a.id);
};
const rests = async (a, reason) => {
  const now = await sweep(a);
  assert.equal(lifecycle.isResting(now), true, `${a.name} rests`);
  const ev = events(a.id, 'standing:rest');
  assert.equal(ev.length, 1);
  if (reason) assert.equal(JSON.parse(ev[0].data).reason, reason);
  return JSON.parse(ev[0].data);
};
const staysUp = async (a) => {
  const now = await sweep(a);
  assert.equal(now.lifecycle, 'active', `${a.name} stays up`);
  assert.equal(events(a.id, 'standing:rest').length, 0);
};
// Runs fn with these settings in settings.json, then puts the defaults back (settings() re-reads a changed file).
const withSettings = async (extra, fn) => {
  const file = join(home, 'settings.json');
  writeFileSync(file, JSON.stringify({ peers: [], chiefOfStaff: 'rest-cos', ...extra }));
  try {
    await fn();
  } finally {
    writeFileSync(file, JSON.stringify({ peers: [], chiefOfStaff: 'rest-cos' }));
  }
};
const inEvents = (a, t, min) => db.open().prepare('INSERT INTO events (agent_id, ts, type, data) VALUES (?, ?, ?, NULL)').run(a.id, ago(min), t);

// --- When it rests -----------------------------------------------------------------------

test('a wake_me far past rest.afterMinutes rests the agent after the grace period, with its expected wake', async () => {
  const a = agent();
  waits.wake(a.id, { note: 'check CI', in_minutes: 45 });
  idleFor(a, 3);
  const data = await rests(a, 'wait');
  assert.ok(Math.abs(Date.parse(data.expectedWake) - (Date.now() + 45 * 60_000)) < 60_000);
  assert.match(db.getAgent(a.id).activity_detail, /resting: waiting, expected wake/);
});

test('within the grace period it stays up', async () => {
  const a = agent();
  waits.wake(a.id, { note: 'check CI', in_minutes: 45 });
  idleFor(a, 1);
  await staysUp(a);
});

test('a wake due within rest.afterMinutes keeps it up, however long it has been idle', async () => {
  const a = agent();
  waits.wake(a.id, { note: 'soon', in_minutes: 10 });
  idleFor(a, 30);
  await staysUp(a);
});

test('a wait_for timeout and a wait_for expect_minutes each count as the expected wake', async () => {
  const t = agent();
  await waits.declare(t.id, { on: 'human', timeout_minutes: 90 });
  idleFor(t, 3);
  await rests(t, 'wait');
  const e = agent();
  await waits.declare(e.id, { on: 'human', expect_minutes: 40 });
  idleFor(e, 3);
  const data = await rests(e, 'wait');
  assert.ok(Math.abs(Date.parse(data.expectedWake) - (Date.now() + 40 * 60_000)) < 60_000);
});

test('the soonest of several expected wakes decides', async () => {
  const a = agent();
  await waits.declare(a.id, { on: 'human', expect_minutes: 120 });
  waits.wake(a.id, { note: 'soon', in_minutes: 5 });
  idleFor(a, 3);
  await staysUp(a);
});

test('expect_minutes must be positive', async () => {
  const a = agent();
  await assert.rejects(waits.declare(a.id, { on: 'human', expect_minutes: 0 }), /expect_minutes must be positive/);
});

test('with no known time it rests after rest.afterMinutes idle, waiting or not', async () => {
  const idle = agent();
  idleFor(idle, 21);
  await rests(idle, 'idle');
  const waiting = agent();
  await waits.declare(waiting.id, { on: 'human' });
  idleFor(waiting, 21);
  await rests(waiting, 'wait');
  const recent = agent();
  idleFor(recent, 15);
  await staysUp(recent);
});

test('an expected wake that has passed counts as no known time', async () => {
  const a = agent();
  const w = await waits.declare(a.id, { on: 'human', expect_minutes: 30 });
  db.open().prepare('UPDATE waits SET data = ? WHERE id = ?').run(JSON.stringify({ on: 'human', expect_at: ago(5) }), w.id);
  idleFor(a, 3);
  await staysUp(a);
  idleFor(a, 21);
  await rests(a);
});

// --- When it never rests ------------------------------------------------------------------

test('a running turn, a dialog or a starting harness keeps it up', async () => {
  for (const activity of ['working', 'dialog', 'starting']) {
    const a = agent();
    idleFor(a, 30);
    db.updateAgent(a.id, { activity });
    await staysUp(a);
  }
});

test('a pending permission keeps it up', async () => {
  const a = agent();
  idleFor(a, 30);
  db.createPermissionRequest(a.id, 'push', 'needs a push', '');
  await staysUp(a);
});

test('undelivered mail or a queued notice keeps it up', async () => {
  const m = agent();
  idleFor(m, 30);
  await mail.sendMail({ from: 'human', to: [m.name], subject: 'unread', body: 'hi' });
  await staysUp(m);
  const q = agent();
  idleFor(q, 30);
  mail.queueNotice(q.id, '[stam] something happened');
  await staysUp(q);
});

test('a wait the harness holds keeps it up', async () => {
  const a = agent();
  db.addWait({ agent_id: a.id, kind: 'event', source: 'hook', detail: 'a background task' });
  idleFor(a, 30);
  await staysUp(a);
});

test('a pending transition or a takeover keeps it up', async () => {
  const p = agent();
  idleFor(p, 30);
  db.updateAgent(p.id, { pending_action: JSON.stringify({ type: 'compact', reason: 'x' }) });
  await staysUp(p);
  const t = agent();
  const by = agent();
  idleFor(t, 30);
  db.updateAgent(t.id, { forwarded_to: by.id });
  await staysUp(t);
});

test('a harness without a session to resume keeps it up', async () => {
  const a = agent();
  idleFor(a, 30);
  db.updateAgent(a.id, { session_id: null });
  await staysUp(a);
});

test('a human pause or other hold keeps it from resting', async () => {
  const a = agent();
  idleFor(a, 30);
  await lifecycle.pause(db.getAgent(a.id), 'human');
  await sweep(a);
  assert.deepEqual(lifecycle.pauseOwners(db.getAgent(a.id)), ['human']);
  assert.equal(events(a.id, 'standing:rest').length, 0);
});

test('a client attached to its terminal keeps it up', async () => {
  const tmux = await import('../src/tmux.ts');
  const a = agent();
  idleFor(a, 30);
  tmux.newSession(a.id, a.cwd, {}, ['sleep', '600']);
  // A control-mode client counts as attached, and needs no terminal.
  const client = spawn('tmux', ['-L', socket, '-C', 'attach', '-t', `=${a.id}`], { stdio: ['pipe', 'ignore', 'ignore'] });
  try {
    await settled(() => tmux.hasClients(a.id));
    await staysUp(a);
  } finally {
    client.kill();
  }
  await settled(() => !tmux.hasClients(a.id));
  await rests(a);
});

// --- Managers, churn, types ----------------------------------------------------------------

test('a manager with busy children rests only on the no-known-time rule', async () => {
  const a = agent();
  waits.wake(a.id, { note: 'check the team', in_minutes: 45 });
  db.addWait({ agent_id: a.id, kind: 'children', source: 'stam', detail: '2 children' });
  idleFor(a, 3);
  await staysUp(a);
  idleFor(a, 21);
  await rests(a, 'wait');
});

test('three wakes within an hour stop it resting for an hour', async () => {
  const a = agent();
  for (const min of [50, 30, 10]) inEvents(a, 'standing:wake', min);
  idleFor(a, 30);
  await staysUp(a);
});

test('three wakes spread over more than an hour, or over an hour ago, are no churn', async () => {
  const spread = agent();
  for (const min of [70, 30, 10]) inEvents(spread, 'standing:wake', min);
  idleFor(spread, 30);
  await rests(spread);
  const old = agent();
  for (const min of [100, 90, 80]) inEvents(old, 'standing:wake', min);
  idleFor(old, 30);
  await rests(old);
});

test('the chief of staff and the assistant never rest by default', async () => {
  const cos = agent({ name: 'rest-cos' });
  idleFor(cos, 300);
  await staysUp(cos);
  const assistant = agent({ kind: 'assistant' });
  idleFor(assistant, 300);
  await staysUp(assistant);
});

// --- Compaction before a long rest -----------------------------------------------------------

test('a rest predicted past the cache lifetime compacts first when the idle compaction would', async () => {
  const a = agent();
  waits.wake(a.id, { note: 'tomorrow', in_minutes: 120 });
  idleFor(a, 3);
  db.updateAgent(a.id, { context_tokens: 200_000 });
  // One sweep: the next would find the fake harness's compaction failed, and rest.
  lifecycle.restSweep();
  await settled(() => events(a.id, 'context:idle-compaction').length === 1);
  assert.equal(db.getAgent(a.id).lifecycle, 'active');
  assert.equal(events(a.id, 'standing:rest').length, 0);
  const ev = events(a.id, 'context:idle-compaction');
  assert.equal(ev.length, 1);
  assert.equal(JSON.parse(ev[0].data).reason, 'before a long rest');
});

test('the cache lifetime counts from when it went idle, not from now', async () => {
  const a = agent();
  waits.wake(a.id, { note: 'in 40 minutes', in_minutes: 40 });
  idleFor(a, 20); // 20 min idle + 40 min to the wake: past the 55 min cache
  db.updateAgent(a.id, { context_tokens: 200_000 });
  lifecycle.restSweep();
  await settled(() => events(a.id, 'context:idle-compaction').length === 1);
  assert.equal(events(a.id, 'standing:rest').length, 0);
});

test('a rest within the cache lifetime, or with a small context, does not compact', async () => {
  const soon = agent();
  waits.wake(soon.id, { note: 'in half an hour', in_minutes: 30 });
  idleFor(soon, 3);
  db.updateAgent(soon.id, { context_tokens: 200_000 });
  await rests(soon);
  const small = agent();
  waits.wake(small.id, { note: 'tomorrow', in_minutes: 120 });
  idleFor(small, 3);
  db.updateAgent(small.id, { context_tokens: 20_000 });
  await rests(small);
  for (const a of [soon, small]) assert.equal(events(a.id, 'context:idle-compaction').length, 0);
});

// --- Waking --------------------------------------------------------------------------------

test('mail wakes a resting agent and reaches it', async () => {
  const a = agent();
  await waits.declare(a.id, { on: 'human', expect_minutes: 60 });
  idleFor(a, 3);
  await rests(a);
  await mail.sendMail({ from: 'human', to: [a.name], subject: 'the answer', body: 'here' });
  await settled(() => db.getAgent(a.id).lifecycle === 'active');
  assert.equal(events(a.id, 'standing:wake').length, 1);
  await settled(() => pushed.some((p) => p.id === a.id && /the answer/.test(p.text)));
});

test('its timer firing wakes a resting agent', async () => {
  const a = agent();
  waits.wake(a.id, { note: 'look again', in_minutes: 45 });
  idleFor(a, 3);
  await rests(a);
  await waits.tick(new Date(Date.now() + 46 * 60_000));
  await settled(() => db.getAgent(a.id).lifecycle === 'active');
  await settled(() => pushed.some((p) => p.id === a.id && /look again/.test(p.text)));
});

test('a wait_for timeout wakes a resting agent', async () => {
  const a = agent();
  await waits.declare(a.id, { on: 'human', timeout_minutes: 45 });
  idleFor(a, 3);
  await rests(a);
  await waits.tick(new Date(Date.now() + 46 * 60_000));
  await settled(() => db.getAgent(a.id).lifecycle === 'active');
  assert.equal(events(a.id, 'wait:timeout').length, 1);
});

test('an event its wait_for waits on wakes a resting agent', async () => {
  const a = agent();
  await waits.declare(a.id, { on: 'event', filter: { source: 'github', subjects: ['github:o/r#7'], types: ['checks.completed'] }, expect_minutes: 30 });
  idleFor(a, 3);
  await rests(a);
  watch.ingest({ source: 'github', type: 'checks.completed', subject: 'github:o/r#7', summary: 'CI passed on o/r#7', dedupe_key: `ci-${a.id}` });
  await settled(() => db.getAgent(a.id).lifecycle === 'active');
  await settled(() => pushed.some((p) => p.id === a.id && /CI passed/.test(p.text)));
});

// --- Round 2 (PR #646 review) ------------------------------------------------------------------

test('a resting child with a wait still counts as busy: its manager keeps the children wait, the grandparent hears nothing', async () => {
  const g = agent();
  const m = agent({ parent: g.id });
  const c = agent({ parent: m.id });
  waits.wake(c.id, { note: 'check CI', in_minutes: 45 });
  await settled(() => db.listWaits(m.id).some((w) => w.kind === 'children') && db.listWaits(g.id).some((w) => w.kind === 'children'));
  // Creating the fixture agents idle already announced them; count only what the rest and wake add.
  const finished = () => events(g.id, 'notice:queued').filter((e) => e.data?.includes('finished its turn')).length;
  const base = finished();
  const told = () => finished() - base;
  idleFor(c, 3);
  await rests(c);
  org.syncChildrenWaits(c.id);
  assert.ok(db.listWaits(m.id).some((w) => w.kind === 'children'), 'the manager still waits on its resting child');
  assert.equal(db.getAgent(m.id).activity, 'waiting');
  assert.equal(told(), 0, 'no false tree-idle notice reaches the grandparent');
  await mail.sendMail({ from: 'human', to: [c.name], subject: 'wake', body: 'x' });
  await settled(() => db.getAgent(c.id).lifecycle === 'active' && db.getAgent(c.id).activity !== 'starting');
  assert.ok(db.listWaits(m.id).some((w) => w.kind === 'children'), 'and after the wake');
  assert.equal(told(), 0);
});

test('a resting agent with no wait is not busy', async () => {
  const m = agent();
  const c = agent({ parent: m.id });
  idleFor(c, 21);
  await rests(c, 'idle');
  assert.equal(db.busyDescendantCount(m.id), 0);
  assert.ok(!db.busyIds().includes(c.id));
});

test('a push since it went idle keeps it up until its turn has run, however long that takes', async () => {
  for (const type of ['pushed', 'prompt:sent', 'view-prompt']) {
    const pending = agent();
    idleFor(pending, 30);
    inEvents(pending, type, 4); // pushed 4 min ago; the turn-start hook hasn't come yet
    await staysUp(pending);
  }
  // The turn ran: idle_since moved past the push.
  const ran = agent();
  inEvents(ran, 'pushed', 26);
  idleFor(ran, 25);
  await rests(ran);
  // A push that never started a turn keeps it up: a rest would lose the mail or notices it consumed.
  const lost = agent();
  idleFor(lost, 300);
  inEvents(lost, 'pushed', 120);
  await staysUp(lost);
});

test('a delayed turn start: the push holds the rest until the turn has run', async () => {
  const a = agent();
  idleFor(a, 30);
  await mail.sendMail({ from: 'human', to: [a.name], subject: 'do this', body: 'x' });
  await settled(() => db.unpushedCount(a.id) === 0 && events(a.id, 'pushed').length === 1);
  await staysUp(a); // pushed, but the turn-start hook is late
  db.updateAgent(a.id, { activity: 'working' });
  await staysUp(a);
  db.updateAgent(a.id, { activity: 'idle' });
  // Later: the push was 26 min ago, the turn it started ended 21 min ago.
  db.open().prepare("UPDATE events SET ts = ? WHERE agent_id = ? AND type = 'pushed'").run(ago(26), a.id);
  idleFor(a, 21);
  await rests(a);
});

test('the compaction boundary: 10 min idle plus a wake 50 min out passes the 55 min cache, 44 min out does not', async () => {
  const past = agent();
  waits.wake(past.id, { note: 'later', in_minutes: 50 });
  idleFor(past, 10);
  db.updateAgent(past.id, { context_tokens: 200_000 });
  lifecycle.restSweep();
  await settled(() => events(past.id, 'context:idle-compaction').length === 1);
  assert.equal(events(past.id, 'standing:rest').length, 0);
  const within = agent();
  waits.wake(within.id, { note: 'sooner', in_minutes: 44 });
  idleFor(within, 10);
  db.updateAgent(within.id, { context_tokens: 200_000 });
  await rests(within);
  assert.equal(events(within.id, 'context:idle-compaction').length, 0);
});

test('the churn guard holds a standing agent too', async () => {
  const a = agent({ standing: true });
  for (const min of [50, 30, 10]) inEvents(a, 'standing:wake', min);
  idleFor(a, 600);
  await staysUp(a);
});

test('a standing agent with a far-off wait rests on the wait rule, before its idle hours', async () => {
  const a = agent({ standing: true });
  waits.wake(a.id, { note: 'tomorrow', in_minutes: 45 });
  idleFor(a, 3);
  await rests(a, 'wait');
  const plain = agent({ standing: true });
  idleFor(plain, 30); // no wait: only standing.idleHours (4 h) applies
  await staysUp(plain);
});

test('rest.enabled false keeps every agent up but a standing one past its idle hours', async () => {
  delete process.env.STAM_REST_ENABLED;
  try {
    await withSettings({ rest: { enabled: false } }, async () => {
      const a = agent();
      idleFor(a, 30);
      await staysUp(a);
      const s = agent({ standing: true });
      idleFor(s, 300);
      await rests(s, 'idle');
    });
  } finally {
    process.env.STAM_REST_ENABLED = '1';
  }
});

test('rest.types false keeps that type up; true lets the assistant rest', async () => {
  await withSettings({ rest: { types: { untyped: false, assistant: true } } }, async () => {
    const off = agent();
    idleFor(off, 30);
    await staysUp(off);
    const assistant = agent({ kind: 'assistant' });
    idleFor(assistant, 30);
    await rests(assistant);
  });
});

test('a peer agent resting with a wait counts as busy; one resting with none does not', () => {
  const resting = { machine: 'elsewhere', lifecycle: 'paused', activity: 'unknown', paused_by: db.REST_PAUSED_BY };
  db.rememberPeerAgent({ id: 'peer-rest-w', name: 'pw', ...resting, waits: [{ kind: 'timer' }] });
  db.rememberPeerAgent({ id: 'peer-rest-n', name: 'pn', ...resting, waits: [] });
  assert.equal(db.peerAgentBusy('peer-rest-w'), true);
  assert.equal(db.peerAgentBusy('peer-rest-n'), false);
});

test('a wait clearing while its agent rests updates the busy counts above it', async () => {
  const m = agent();
  const c = agent({ parent: m.id });
  const w = waits.wake(c.id, { note: 'later', in_minutes: 45 });
  await settled(() => db.listWaits(m.id).some((x) => x.kind === 'children'));
  idleFor(c, 3);
  await rests(c);
  assert.ok(db.listWaits(m.id).some((x) => x.kind === 'children'), 'it waits on its resting child');
  db.clearWait(w.id); // cleared by hand (wait_done): nothing wakes the child
  assert.equal(lifecycle.isResting(db.getAgent(c.id)), true);
  assert.ok(!db.listWaits(m.id).some((x) => x.kind === 'children'), 'a resting child with no wait is not busy');
  waits.wake(c.id, { note: 'again', in_minutes: 45 });
  assert.ok(db.listWaits(m.id).some((x) => x.kind === 'children'), 'and a new wait makes it busy again');
});

// A manager resting while its child works (the no-known-time rule): child → manager → grandparent.
// Lets a fixture agent rest: drain the notices its fixture's creation queued, and date their push before its idle period.
async function settleFixture(a, idle) {
  await settled(() => mail.queuedNoticeCount(a.id) === 0);
  db.open().prepare("UPDATE events SET ts = ? WHERE agent_id = ? AND type = 'pushed'").run(ago(idle + 10), a.id);
  idleFor(a, idle);
}
async function restingManager({ notices = null, restGrandparent = false } = {}) {
  const g = agent();
  const m = agent({ parent: g.id, notices });
  const c = agent({ parent: m.id });
  db.updateAgent(c.id, { activity: 'working' });
  await settled(() => db.listWaits(m.id).some((w) => w.kind === 'children') && db.listWaits(g.id).some((w) => w.kind === 'children'));
  // Creating the child idle told the manager it finished a turn; that push is old news by the time it rests.
  await settled(() => mail.queuedNoticeCount(m.id) === 0);
  db.open().prepare("UPDATE events SET ts = ? WHERE agent_id = ? AND type = 'pushed'").run(ago(30), m.id);
  idleFor(m, 21);
  await rests(m, 'wait');
  if (restGrandparent) {
    await settleFixture(g, 21);
    await rests(g, 'wait');
  }
  return { g, m, c };
}
const childrenWait = (a) => db.listWaits(a.id).some((w) => w.kind === 'children');

test('a resting manager whose last child finishes is woken by the tree-idle notice', async () => {
  const { m, c } = await restingManager();
  db.updateAgent(c.id, { activity: 'idle', activity_detail: 'turn finished' });
  await settled(() => db.getAgent(m.id).lifecycle === 'active');
  assert.equal(events(m.id, 'standing:wake').length, 1);
  assert.ok(!childrenWait(m));
});

test('with child notices off, a resting manager whose last child finishes stays down and the grandparent stops waiting', async () => {
  const { g, m, c } = await restingManager({ notices: 'none' });
  db.updateAgent(c.id, { activity: 'idle', activity_detail: 'turn finished' });
  assert.ok(!childrenWait(m), 'the manager no longer waits on its child');
  assert.equal(lifecycle.isResting(db.getAgent(m.id)), true, 'nothing woke it');
  assert.ok(!childrenWait(g), 'the grandparent no longer counts the resting manager as busy');
  assert.equal(db.busyDescendantCount(g.id), 0);
});

test("wait_done on a resting agent's last wait stops its grandparent waiting", async () => {
  const g = agent();
  const m = agent({ parent: g.id });
  const c = agent({ parent: m.id });
  const w = waits.wake(c.id, { note: 'later', in_minutes: 45 });
  await settled(() => childrenWait(g));
  idleFor(c, 3);
  await rests(c);
  assert.ok(childrenWait(m) && childrenWait(g));
  assert.equal(waits.done(c.id, w.id), true);
  assert.ok(!childrenWait(m) && !childrenWait(g), 'both levels see the resting child go quiet');
});

test("a resting agent's wait timing out wakes it, and its parent's wait follows", async () => {
  const m = agent();
  const c = agent({ parent: m.id });
  await waits.declare(c.id, { on: 'human', timeout_minutes: 45 });
  await settled(() => childrenWait(m));
  idleFor(c, 3);
  await rests(c);
  await waits.tick(new Date(Date.now() + 46 * 60_000));
  await settled(() => db.getAgent(c.id).lifecycle === 'active' && db.getAgent(c.id).activity !== 'starting');
  assert.equal(db.listWaits(c.id).length, 0, 'the timeout cleared its wait');
  assert.equal(childrenWait(m), db.isBusy(db.getAgent(c.id)), "the parent's wait follows the woken child");
});

test('isBusy agrees with busyIds for a resting agent with and without a wait', async () => {
  const w = agent();
  waits.wake(w.id, { note: 'later', in_minutes: 45 });
  idleFor(w, 3);
  await rests(w);
  const n = agent();
  idleFor(n, 21);
  await rests(n);
  for (const a of [w, n]) assert.equal(db.isBusy(db.getAgent(a.id)), db.busyIds().includes(a.id));
  assert.equal(db.isBusy(db.getAgent(w.id)), true);
  assert.equal(db.isBusy(db.getAgent(n.id)), false);
});

test('a resting agent with a wait keeps its machine up; one with none does not', async () => {
  const w = agent();
  waits.wake(w.id, { note: 'later', in_minutes: 45 });
  idleFor(w, 3);
  await rests(w);
  const n = agent();
  idleFor(n, 21);
  await rests(n);
  assert.equal(db.keepsMachineUp(db.getAgent(w.id)), true);
  assert.equal(db.keepsMachineUp(db.getAgent(n.id)), false);
});

test("with child notices off on a resting manager, its owed tree-idle notice reaches its resting parent and wakes it", async () => {
  const { g, m, c } = await restingManager({ notices: 'none', restGrandparent: true });
  db.updateAgent(c.id, { activity: 'idle', activity_detail: 'turn finished' });
  await settled(() => db.getAgent(g.id).lifecycle === 'active');
  assert.ok(events(g.id, 'notice:queued').some((e) => e.data.includes(`${m.name} finished its turn`)), "the grandparent hears the manager's tree went quiet");
  assert.equal(lifecycle.isResting(db.getAgent(m.id)), true, 'telling the parents does not wake the manager');
  assert.equal(db.getAgent(m.id).idle_notified, db.getAgent(m.id).idle_since, 'the notice is recorded, so it is not sent again');
});

test('a second pause owner on a resting agent with a wait keeps it busy for fresh counts', async () => {
  const m = agent();
  const c = agent({ parent: m.id });
  const sib = agent({ parent: m.id });
  waits.wake(c.id, { note: 'later', in_minutes: 45 });
  await settled(() => childrenWait(m));
  idleFor(c, 3);
  await rests(c);
  await lifecycle.pause(db.getAgent(c.id), 'human');
  assert.deepEqual(lifecycle.pauseOwners(db.getAgent(c.id)).sort(), ['human', 'standing-idle']);
  assert.equal(db.isBusy(db.getAgent(c.id)), true);
  assert.ok(db.busyIds().includes(c.id));
  // A sibling's turn recounts the manager's busy children from scratch.
  db.updateAgent(sib.id, { activity: 'working' });
  db.updateAgent(sib.id, { activity: 'idle', activity_detail: 'turn finished' });
  assert.ok(childrenWait(m), 'the manager still waits on its paused, resting child');
  assert.equal(db.busyDescendantCount(m.id), 1);
});

test('the idle compaction skips a resting agent', async () => {
  const context = await import('../src/context.ts');
  const a = agent();
  waits.wake(a.id, { note: 'later', in_minutes: 45 });
  idleFor(a, 3);
  await rests(a);
  db.updateAgent(a.id, { idle_since: ago(120), context_tokens: 300_000 });
  context.idleSweep();
  assert.equal(events(a.id, 'context:idle-compaction').length, 0);
});

test('a rest keeps idle_since', async () => {
  const a = agent();
  idleFor(a, 21);
  const since = db.getAgent(a.id).idle_since;
  await rests(a);
  assert.equal(db.getAgent(a.id).idle_since, since);
});

test('shutting a resting agent down drops the rest owner and keeps the others', async () => {
  const a = agent();
  idleFor(a, 21);
  await rests(a);
  await lifecycle.pause(db.getAgent(a.id), 'human');
  await lifecycle.shutdown(db.getAgent(a.id), true);
  const now = db.getAgent(a.id);
  assert.equal(now.lifecycle, 'shut_down');
  assert.deepEqual(lifecycle.pauseOwners(now), ['human']);
  assert.equal(db.restOwned(now), false);
});

test('a parent archived with a resting, quiet child archives the child too', async () => {
  const p = agent();
  const c = agent({ parent: p.id });
  idleFor(c, 21);
  await rests(c, 'idle');
  await lifecycle.pause(db.getAgent(p.id), 'human'); // a paused parent archives at once, with no final round
  const r = await lifecycle.archiveCascade(db.getAgent(p.id), true);
  assert.match(r, new RegExp(`also archived idle ${c.name}`));
  assert.equal(db.getAgent(c.id).lifecycle, 'archived');
  assert.equal(db.restOwned(db.getAgent(c.id)), false);
});

test("clearing a resting child's last wait sends its owed tree-idle notice, which wakes its resting parent", async () => {
  const p = agent();
  const c = agent({ parent: p.id });
  const w = await waits.declare(c.id, { on: 'human', expect_minutes: 60 });
  await settled(() => childrenWait(p));
  await settleFixture(c, 3);
  await rests(c, 'wait');
  await settleFixture(p, 21);
  await rests(p, 'wait');
  assert.equal(waits.done(c.id, w.id), true); // cleared from outside: nothing wakes the child
  await settled(() => db.getAgent(p.id).lifecycle === 'active');
  assert.ok(events(p.id, 'notice:queued').some((e) => e.data.includes(`${c.name} finished its turn`)));
  assert.equal(lifecycle.isResting(db.getAgent(c.id)), true, 'the child stays resting');
  assert.equal(db.getAgent(c.id).idle_notified, db.getAgent(c.id).idle_since);
});
