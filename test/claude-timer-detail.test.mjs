#!/usr/bin/env node
// Unit test for the detail of a Claude Code timer wait (S-3391): a one-shot ScheduleWakeup shows its
// fire time in UTC, not its cron text, which reads as a daily repeat; a recurring cron keeps its
// cron; both say they are the harness's own timer. Deterministic: a fixed clock and zone, no daemon.
// `node --test test/claude-timer-detail.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'Europe/Oslo';
const { nextCronFire, harnessTimerDetail } = await import('../src/adapters/claude-timer.ts');

// 2026-10-21 16:35Z is 18:35 in Oslo (CEST), so the next 18:45 is 16:45Z the same day.
const from = new Date('2026-10-21T16:35:00Z');

test('a one-off timer shows its fire time in UTC, and its fire time is unchanged', () => {
  const until = nextCronFire('45 18 * * *', from);
  assert.equal(until, '2026-10-21T16:45:00.000Z');
  assert.equal(harnessTimerDetail({ schedule: '45 18 * * *', recurring: false }, until), 'harness timer at 16:45Z');
});

test('a one-off a day or more away shows its date too, so it does not read as today', () => {
  const until = nextCronFire('30 14 25 12 *', from);
  // 14:30 in Oslo in December is 13:30Z.
  assert.equal(until, '2026-12-25T13:30:00.000Z');
  assert.equal(harnessTimerDetail({ schedule: '30 14 25 12 *', recurring: false }, until, from.getTime()), 'harness timer at 12-25 13:30Z');
  // Under a day away, the time alone.
  assert.equal(harnessTimerDetail({ schedule: '45 18 * * *', recurring: false }, '2026-10-21T16:45:00.000Z', from.getTime()), 'harness timer at 16:45Z');
});

test('a recurring cron keeps its cron, and says it is the harness’s', () => {
  assert.equal(harnessTimerDetail({ schedule: '*/30 * * * *', recurring: true }, null), 'harness cron */30 * * * *');
});

test('a one-off whose fire time cannot be worked out keeps its cron, still as the harness’s timer', () => {
  assert.equal(nextCronFire('*/5 * * * *', from), null);
  assert.equal(harnessTimerDetail({ schedule: '*/5 * * * *', recurring: false }, null), 'harness timer */5 * * * *');
});
