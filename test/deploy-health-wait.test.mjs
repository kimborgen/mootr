#!/usr/bin/env node
// The post-restart health wait of `stam deploy` (src/deploy.ts awaitRestart, S-436's deploy path) on a virtual
// clock, with a stubbed health API, loadavg and systemctl, so nothing waits in real time and nothing touches the
// live daemon. Covered: the deadline is 20 s plus 10 s per whole point of load above the CPU count, capped at 90 s;
// a slow but healthy start passes inside a scaled deadline, and every health request gets the 5 s timeout; a unit
// that goes inactive, failed, or gets a new main process rolls back at once, not at the deadline; under load 22 on
// 4 CPUs the wait is capped at 90 s, and a start that answers at 85 s still passes. Run with
// `node --test test/deploy-health-wait.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempHome } from './tmphome.mjs';

// deploy.ts reads STAM_HOME when it loads; a throwaway one keeps the live home out of reach.
process.env.STAM_HOME = tempHome('stam-health-wait-test-');
const { healthDeadline, awaitRestart } = await import('../src/deploy.ts');

// A virtual clock: sleeping moves it on, and a health request that gets no answer takes its whole timeout.
function fakeMachine({ load1, cpus, answerAt = Infinity, unit = () => ({ pid: 42, state: 'active' }) }) {
  let t = 0;
  const timeouts = [];
  const logs = [];
  const origLog = console.log;
  const deps = {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    load: () => ({ load1, cpus }),
    unit: () => unit(t),
    answers: async (_release, timeoutMs) => {
      timeouts.push(timeoutMs);
      if (t >= answerAt) return true;
      t += timeoutMs;
      return false;
    },
  };
  const run = async (pid = 42) => {
    console.log = (...a) => logs.push(a.join(' '));
    try {
      return await awaitRestart('rel-new', pid, deps);
    } finally {
      console.log = origLog;
    }
  };
  return { run, elapsed: () => t, timeouts, logs };
}

test('the deadline is 20 s, plus 10 s per whole point of load above the CPU count, capped at 90 s', () => {
  assert.equal(healthDeadline(0.5, 4), 20_000);
  assert.equal(healthDeadline(3.9, 4), 20_000);
  assert.equal(healthDeadline(6, 4), 40_000);
  assert.equal(healthDeadline(6.9, 4), 40_000);
  assert.equal(healthDeadline(22, 4), 90_000);
  assert.equal(healthDeadline(400, 4), 90_000);
});

test('a slow but healthy start passes inside the scaled deadline, with the 5 s request timeout', async () => {
  // Load 6 on 4 CPUs: a 40 s deadline. The daemon answers at 30 s, after several requests have timed out.
  const m = fakeMachine({ load1: 6, cpus: 4, answerAt: 30_000 });
  assert.equal(await m.run(), 'answering');
  assert.ok(m.elapsed() <= 40_000, `answered at ${m.elapsed()} ms`);
  assert.ok(m.timeouts.length > 1, 'it polled more than once');
  assert.ok(m.timeouts.every((ms) => ms === 5_000), `request timeouts ${m.timeouts}`);
  assert.ok(m.logs.some((l) => l.includes('waiting up to 40 s for rel-new (load 6.0 on 4 CPUs)')), m.logs.join('\n'));
});

test('a unit that stops while starting rolls back at once, not at the deadline', async () => {
  // Quiet load: a 20 s deadline. The unit fails at 2 s and never answers.
  const m = fakeMachine({ load1: 0.5, cpus: 4, unit: (t) => (t >= 2_000 ? { pid: 42, state: 'failed' } : { pid: 42, state: 'activating' }) });
  assert.equal(await m.run(), 'crashed');
  assert.ok(m.elapsed() < 10_000, `gave up at ${m.elapsed()} ms`);
});

test('a unit that restarts under a new main process rolls back at once', async () => {
  // systemd restarted a crashed daemon: the main process changed while the wait was on.
  const m = fakeMachine({ load1: 0.5, cpus: 4, unit: (t) => (t >= 1_000 ? { pid: 77, state: 'active' } : { pid: 42, state: 'active' }) });
  assert.equal(await m.run(42), 'crashed');
  assert.ok(m.elapsed() < 10_000, `gave up at ${m.elapsed()} ms`);
});

test('an empty unit state (systemctl failed or timed out) keeps polling, and a later healthy start passes', async () => {
  // systemctl gives nothing for the first 3 s; the start then answers at 4 s. That is no crash.
  const m = fakeMachine({ load1: 0.5, cpus: 4, answerAt: 4_000, unit: (t) => (t < 3_000 ? { pid: 0, state: '' } : { pid: 42, state: 'active' }) });
  assert.equal(await m.run(), 'answering');
  assert.ok(m.elapsed() <= 20_000, `answered at ${m.elapsed()} ms`);
});

test('a unit pid of 0 (unknown) is not a new main process', async () => {
  // The pid is unreadable, but the unit is active: the wait must not read the 0 as a restart.
  const m = fakeMachine({ load1: 0.5, cpus: 4, answerAt: 3_000, unit: () => ({ pid: 0, state: 'active' }) });
  assert.equal(await m.run(42), 'answering');
});

test('the deadline is capped at 90 s under load 22 on 4 CPUs, and a start within the cap still passes', async () => {
  // Never answers: the wait gives up near 90 s, not after 20 s + 18 x 10 s.
  const never = fakeMachine({ load1: 22, cpus: 4 });
  assert.equal(await never.run(), 'timeout');
  assert.ok(never.elapsed() >= 90_000 && never.elapsed() < 96_000, `gave up at ${never.elapsed()} ms`);
  assert.ok(never.logs.some((l) => l.includes('waiting up to 90 s')), never.logs.join('\n'));

  // Answers at 85 s, inside the cap.
  const late = fakeMachine({ load1: 22, cpus: 4, answerAt: 85_000 });
  assert.equal(await late.run(), 'answering');
  assert.ok(late.elapsed() <= 90_000, `answered at ${late.elapsed()} ms`);
});
