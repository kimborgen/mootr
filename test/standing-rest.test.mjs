#!/usr/bin/env node
// S-897: a standing agent idle past standing.idleHours rests (paused for 'standing-idle', its
// harness stopped, no model turn), and mail, a fired wake_me or an assigned ITSA wakes it.
// A non-standing agent never rests, and a pause by the human or a cost blocker is never lifted
// by a wake. Runs against a throwaway STAM_HOME and tmux socket with a fake harness; no daemon,
// no models: `node --test test/standing-rest.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-standing-rest-');
const socket = `standing-rest-test-${process.pid}`;
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = socket;
process.env.STAM_EMBEDDER = 'stub';
process.env.STAM_STANDING_IDLE_HOURS = '0.001'; // 3.6 s
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [] }));

let db, lifecycle, mail, waits, itsa;
const pushed = [];
before(async () => {
  db = await import('../src/db.ts');
  lifecycle = await import('../src/lifecycle.ts');
  mail = await import('../src/mail.ts');
  waits = await import('../src/waits.ts');
  itsa = await import('../src/itsa.ts');
  lifecycle.startRestWaking();
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

const longAgo = (s) => new Date(Date.now() - s * 1000).toISOString();
let n = 0;
function agent({ standing = true, idleFor = 60 } = {}) {
  const id = db.newAgentId();
  const cwd = join(home, `work-${id}`);
  mkdirSync(cwd);
  db.createAgent({ id, name: `s${++n}`, role: '', machine: 'test', harness: 'fake', model: null, effort: null, cwd, parent_id: null, session_id: `sess-${id}` });
  db.updateAgent(id, { workspace: JSON.stringify({ spec: { kind: 'dir', path: cwd }, cwd }), lifecycle: 'active', activity: 'idle', standing: standing ? 1 : 0 });
  db.updateAgent(id, { idle_since: longAgo(idleFor) });
  return db.getAgent(id);
}
const events = (id, type) => db.listEvents(id, 500).filter((e) => e.type === type);
const settled = async (fn) => {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail('state not reached');
};
const rested = async (a) => {
  lifecycle.restSweep();
  await settled(() => db.getAgent(a.id).lifecycle === 'paused');
};
const mailTo = (a, subject) => mail.sendMail({ from: 'human', to: [a.name], subject, body: 'hi' });

test('a standing agent idle past the threshold rests without a prompt', async () => {
  const a = agent();
  const before = pushed.length;
  await rested(a);
  const now = db.getAgent(a.id);
  assert.deepEqual(lifecycle.pauseOwners(now), ['standing-idle']);
  assert.equal(lifecycle.isResting(now), true);
  assert.match(now.activity_detail, /resting/);
  assert.equal(events(a.id, 'standing:rest').length, 1);
  assert.equal(pushed.length, before, 'no prompt is sent to a resting agent');
});

test('a standing agent idle for less than the threshold does not rest', () => {
  const a = agent({ idleFor: 0 });
  lifecycle.restSweep();
  assert.equal(db.getAgent(a.id).lifecycle, 'active');
});

test('a non-standing agent never rests', () => {
  const a = agent({ standing: false });
  lifecycle.restSweep();
  assert.equal(db.getAgent(a.id).lifecycle, 'active');
});

test('mail wakes a resting agent, and the mail reaches it', async () => {
  const a = agent();
  await rested(a);
  await mailTo(a, 'wake up');
  await settled(() => db.getAgent(a.id).lifecycle === 'active');
  assert.equal(db.getAgent(a.id).paused_by, null);
  assert.equal(events(a.id, 'standing:wake').length, 1);
  await settled(() => pushed.some((p) => p.id === a.id && /wake up/.test(p.text)));
  assert.equal(db.unpushedCount(a.id), 0, 'the mail was delivered');
});

test('an agent waiting on a wake_me rests, and the timer firing wakes it', async () => {
  const a = agent();
  waits.wake(a.id, { note: 'check the queue', in_minutes: 1 });
  db.updateAgent(a.id, { activity: 'idle', idle_since: longAgo(60) });
  assert.equal(db.getAgent(a.id).activity, 'waiting');
  await rested(a);
  assert.equal(lifecycle.isResting(db.getAgent(a.id)), true);
  await waits.tick(new Date(Date.now() + 2 * 60_000));
  await settled(() => db.getAgent(a.id).lifecycle === 'active');
  assert.equal(events(a.id, 'standing:wake').length, 1);
});

test('an agent with a hook-owned wait does not rest', () => {
  const a = agent();
  db.addWait({ agent_id: a.id, kind: 'event', source: 'hook', detail: 'a background task' });
  db.updateAgent(a.id, { activity: 'idle', idle_since: longAgo(60) });
  lifecycle.restSweep();
  assert.equal(db.getAgent(a.id).lifecycle, 'active');
});

test('an ITSA set to a resting agent as owner wakes it', async () => {
  const a = agent();
  const x = await itsa.create({ title: 'set owner', by: 'human' });
  await rested(a);
  await itsa.set(x.key, { owner: a.id }, 'human');
  await settled(() => db.getAgent(a.id).lifecycle === 'active');
  assert.equal(events(a.id, 'standing:wake').length, 1);
  await settled(() => pushed.some((p) => p.id === a.id && p.text.includes(x.key)));
});

test('an ITSA created with a resting agent as owner wakes it', async () => {
  const a = agent();
  await rested(a);
  const x = await itsa.create({ title: 'created owned', owner: a.id, by: 'human' });
  await settled(() => db.getAgent(a.id).lifecycle === 'active');
  assert.ok(x.key);
});

test('an ITSA given to an active standing agent changes nothing', async () => {
  const a = agent({ idleFor: 0 });
  const before = events(a.id, 'notice:queued').length;
  await itsa.create({ title: 'to active', owner: a.id, by: 'human' });
  assert.equal(events(a.id, 'notice:queued').length, before);
});

test('a human pause keeps a resting agent down when mail arrives', async () => {
  const a = agent();
  await rested(a);
  await lifecycle.pause(db.getAgent(a.id), 'human');
  assert.deepEqual(lifecycle.pauseOwners(db.getAgent(a.id)).sort(), ['human', 'standing-idle']);
  assert.equal(lifecycle.isResting(db.getAgent(a.id)), false);
  await mailTo(a, 'still paused');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(db.getAgent(a.id).lifecycle, 'paused');
  assert.equal(events(a.id, 'standing:wake').length, 0);
});

test('an agent unpausing, with only the rest left, wakes the agent for mail that waited', async () => {
  const boss = agent({ idleFor: 0 });
  const a = agent();
  await rested(a);
  await lifecycle.pause(db.getAgent(a.id), boss.id);
  await mailTo(a, 'held mail');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(db.getAgent(a.id).lifecycle, 'paused');
  await lifecycle.unpause(db.getAgent(a.id), { by: boss.id });
  await settled(() => db.getAgent(a.id).lifecycle === 'active');
  assert.equal(events(a.id, 'standing:wake').length, 1);
});

// S-922: a failed wake is retried on a backoff, with an injected timer so no test waits.
function manualTimer() {
  const q = [];
  const timer = (fn, ms) => {
    const t = { fn, ms, live: true };
    q.push(t);
    return () => (t.live = false);
  };
  const fire = async () => {
    const t = q.find((x) => x.live);
    assert.ok(t, 'a retry is pending');
    t.live = false;
    t.fn();
    await new Promise((r) => setTimeout(r, 150));
  };
  return { timer, fire, pending: () => q.filter((x) => x.live), q };
}
async function failingWake(failures) {
  const { adapters } = await import('../src/adapters/index.ts');
  const ok = adapters.fake.launch;
  let calls = 0;
  adapters.fake.launch = async (...args) => {
    if (++calls <= failures) throw new Error('launch boom');
    return ok(...args);
  };
  return () => (adapters.fake.launch = ok);
}

test('a failed wake is retried and wakes the agent on the second try', async () => {
  const m = manualTimer();
  lifecycle.setWakeRetry({ delays: [1, 5, 15], timer: m.timer });
  const restore = await failingWake(1);
  try {
    const a = agent();
    await rested(a);
    await mailTo(a, 'retry me');
    await settled(() => events(a.id, 'standing:wake-error').length === 1);
    assert.equal(lifecycle.isResting(db.getAgent(a.id)), true);
    assert.deepEqual(m.pending().map((t) => t.ms), [1]);
    await m.fire();
    await settled(() => db.getAgent(a.id).lifecycle === 'active');
    assert.equal(m.pending().length, 0, 'no retry is left after the wake');
    assert.equal(events(a.id, 'standing:wake-gave-up').length, 0);
  } finally {
    restore();
    lifecycle.setWakeRetry();
  }
});

test('a wake that always fails retries three times, then gives up once', async () => {
  const m = manualTimer();
  lifecycle.setWakeRetry({ delays: [1, 5, 15], timer: m.timer });
  const restore = await failingWake(100);
  try {
    const a = agent();
    await rested(a);
    await mailTo(a, 'doomed');
    await settled(() => events(a.id, 'standing:wake-error').length === 1);
    for (const ms of [5, 15]) {
      await m.fire();
      assert.deepEqual(m.pending().map((t) => t.ms), [ms]);
    }
    await m.fire();
    assert.equal(m.pending().length, 0);
    assert.equal(events(a.id, 'standing:wake-error').length, 4);
    assert.equal(events(a.id, 'standing:wake-retry').length, 3);
    assert.equal(events(a.id, 'standing:wake-gave-up').length, 1);
    assert.equal(lifecycle.isResting(db.getAgent(a.id)), true, 'it stays resting');
  } finally {
    restore();
    lifecycle.setWakeRetry();
  }
});

test('an agent archived mid-retry is not retried', async () => {
  const m = manualTimer();
  lifecycle.setWakeRetry({ delays: [1, 5, 15], timer: m.timer });
  const restore = await failingWake(100);
  try {
    const a = agent();
    await rested(a);
    await mailTo(a, 'then archived');
    await settled(() => events(a.id, 'standing:wake-error').length === 1);
    db.updateAgent(a.id, { lifecycle: 'archived' });
    await m.fire();
    assert.equal(events(a.id, 'standing:wake-error').length, 1, 'no second launch');
    assert.equal(m.pending().length, 0);
  } finally {
    restore();
    lifecycle.setWakeRetry();
  }
});

test('mail wakes during the backoff do not count toward the retry limit', async () => {
  const m = manualTimer();
  lifecycle.setWakeRetry({ delays: [1, 5, 15], timer: m.timer });
  const restore = await failingWake(100);
  try {
    const a = agent();
    await rested(a);
    await mailTo(a, 'first');
    await settled(() => events(a.id, 'standing:wake-error').length === 1);
    for (const s of ['two', 'three', 'four']) await mailTo(a, s);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(events(a.id, 'standing:wake-error').length, 1, 'mail wakes are skipped while a retry is pending');
    assert.equal(events(a.id, 'standing:wake-gave-up').length, 0);
    assert.deepEqual(m.pending().map((t) => t.ms), [1]);
  } finally {
    restore();
    lifecycle.setWakeRetry();
  }
});

test('two agents failing to wake at once each keep their own retry', async () => {
  const m = manualTimer();
  lifecycle.setWakeRetry({ delays: [1, 5, 15], timer: m.timer });
  const restore = await failingWake(2);
  try {
    const a = agent(), b = agent();
    await rested(a);
    await rested(b);
    await Promise.all([mailTo(a, 'a'), mailTo(b, 'b')]);
    await settled(() => events(a.id, 'standing:wake-error').length === 1 && events(b.id, 'standing:wake-error').length === 1);
    assert.equal(m.pending().length, 2);
    await m.fire();
    await m.fire();
    await settled(() => db.getAgent(a.id).lifecycle === 'active' && db.getAgent(b.id).lifecycle === 'active');
    assert.equal(m.pending().length, 0);
  } finally {
    restore();
    lifecycle.setWakeRetry();
  }
});

test('a hold or an unpause cancels a pending retry', async () => {
  const m = manualTimer();
  lifecycle.setWakeRetry({ delays: [1, 5, 15], timer: m.timer });
  const restore = await failingWake(100);
  try {
    const held = agent(), unpaused = agent();
    for (const a of [held, unpaused]) {
      await rested(a);
      await mailTo(a, 'x');
      await settled(() => events(a.id, 'standing:wake-error').length === 1);
    }
    await lifecycle.pause(db.getAgent(held.id), 'human');
    restore();
    await m.fire(); // the held agent's retry finds a hold and cancels
    assert.equal(events(held.id, 'standing:wake-error').length, 1, 'no launch for the held agent');
    assert.equal(m.pending().length, 1, 'only the other retry is left');
    await lifecycle.unpause(db.getAgent(unpaused.id), { by: 'human' });
    await m.fire();
    assert.equal(events(unpaused.id, 'standing:wake-error').length, 1, 'no further launch after the unpause');
    assert.equal(m.pending().length, 0);
  } finally {
    restore();
    lifecycle.setWakeRetry();
  }
});

test('a wake prompt that fails after the agent went active tells the parent and does not retry', async () => {
  const m = manualTimer();
  lifecycle.setWakeRetry({ delays: [1, 5, 15], timer: m.timer });
  const { adapters } = await import('../src/adapters/index.ts');
  const tmux = await import('../src/tmux.ts');
  const ok = adapters.fake.pushPrompt;
  try {
    const a = agent();
    await rested(a);
    // A terminal still up sends resumeNow down the prompt path rather than a relaunch.
    tmux.newSession(a.id, a.cwd, {}, ['sleep', '600']);
    adapters.fake.pushPrompt = () => { throw new Error('prompt boom'); };
    await lifecycle.wakeResting(a.id, 'test').catch(() => {});
    assert.equal(events(a.id, 'standing:wake-error').length, 1);
    assert.equal(m.pending().length, 0, 'no retry is scheduled');
    assert.equal(events(a.id, 'standing:wake-retry').length, 0);
  } finally {
    adapters.fake.pushPrompt = ok;
    lifecycle.setWakeRetry();
  }
});
