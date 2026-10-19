#!/usr/bin/env node
// Unit tests for waiting states change 5 (src/waits.ts, src/mail.ts): the cron parser where a
// daylight-saving gap removes an hour, and stam's own mail never clearing a declared wait.
// Free; a throwaway STAM_HOME, no daemon, no network, no models:
// `TZ=Europe/Helsinki node --test test/waits.test.mjs` (the test sets TZ itself).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

// nextCron works in local time, and the DST case needs a zone with the gap.
process.env.TZ = 'Europe/Helsinki';
const home = tempHome('stam-waits-');
process.env.STAM_HOME = home;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let db, waits, mail;
before(async () => {
  db = await import('../src/db.ts');
  waits = await import('../src/waits.ts');
  mail = await import('../src/mail.ts');
});
after(() => rmSync(home, { recursive: true, force: true }));

function agent(id, name) {
  db.createAgent({ id, name, role: 'test', machine: 'x', harness: 'external', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  db.updateAgent(id, { activity: 'idle' });
  return db.getAgent(id);
}

test('nextCron skips the hour a daylight-saving gap removes', () => {
  // Finland springs forward on 2027-03-28: 03:00-03:59 local doesn't exist, so `* 3 * * *`
  // must fire at 03:00 the next day (00:00 UTC), not every minute of 04:00-04:59 that day.
  const next = waits.nextCron('* 3 * * *', new Date('2027-03-28T00:30:00Z'));
  assert.equal(next.toISOString(), '2027-03-29T00:00:00.000Z');
});

test('nextCron still finds a real fire time on the gap day', () => {
  // 09:00 local exists on the gap day (it is EEST by then): 09:00 EEST = 06:00 UTC.
  const next = waits.nextCron('*/15 9 * * *', new Date('2027-03-28T00:30:00Z'));
  assert.equal(next.toISOString(), '2027-03-28T06:00:00.000Z');
});

test("mail stam sends never clears a declared wait", async () => {
  const a = agent('wa-standin', 'standin');
  const b = agent('wa-waiter', 'waiter');
  // The stand-in for stam's own mail is the first active agent, here `a`.
  assert.equal(mail.stamSender().id, a.id);
  const w = await waits.declare(b.id, { on: 'agent', target: a.id, note: 'the real reply' });
  assert.ok(db.listWaits(b.id).some((x) => x.id === w.id));
  assert.equal(await mail.sendFromStam([b.id], 'Subject', 'Body'), true);
  assert.ok(db.listWaits(b.id).some((x) => x.id === w.id), "stam's own mail cleared the declared wait");
  // A real mail from the awaited agent does clear it.
  await mail.sendMail({ from: a.id, to: [b.id], subject: 'the real reply', body: 'here', new_thread: true });
  assert.ok(!db.listWaits(b.id).some((x) => x.id === w.id), 'a real mail did not clear the wait');
});
test("an agent wait without a detail is summed up by the agent's name", () => {
  agent('ws1', 'summed');
  agent('ws2', 'awaited');
  db.addWait({ agent_id: 'ws1', kind: 'agent', source: 'declared', target: 'ws2' });
  assert.equal(db.waitSummary(db.listWaits('ws1')), "waiting for awaited's reply");
});
