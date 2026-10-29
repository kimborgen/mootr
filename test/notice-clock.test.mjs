#!/usr/bin/env node
// The clock line a child notice ends with (S-3468): the daemon's clock to the minute, the child's age since its spawn, and,
// for a tree-idle notice, how long the child has been idle. The clock is fixed with setClock, so the lines are exact. Each
// path that queues a child notice (turn finished, tree-idle, blocked, errored) is checked through the parent's queue, with
// the child's rows pinned, so the line is built from stored rows. An unparsable timestamp counts as now, as in Go.
// Run with `node --test test/notice-clock.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-notice-clock-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `notice-clock-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];
const { setClock, nowMs } = await import('../src/clock.ts');
const db = await import('../src/db.ts');
const org = await import('../src/org.ts');
const mail = await import('../src/mail.ts');
const { render } = await import('../src/templates.ts');
org.watchActivity();

const NOW = '2026-10-22T02:10:30.000Z';
const clockLine = '\nnow 2026-10-22T02:10Z · child age 10m';
const at = (iso) => () => Date.parse(iso);
const child = (created, updated) => ({ created_at: created, updated_at: updated });

// A parent and a child under it, the child spawned at 02:00:00 so its age is 10m.
const mk = (id, parent, extra = {}) => {
  db.createAgent({ id, name: `n-${id}`, role: 'developer', machine: 'here', harness: 'claude', model: 'm', effort: null, cwd: '/tmp', parent_id: parent ?? null, session_id: null });
  db.updateAgent(id, { created_at: '2026-10-22T02:00:00.000Z', ...extra });
};

test('the clock is injectable and restored by setClock(null)', () => {
  setClock(at(NOW));
  assert.equal(nowMs(), Date.parse(NOW));
  setClock(null);
  assert.ok(Math.abs(nowMs() - Date.now()) < 5_000);
});

test('the clock line gives now to the minute and the age since spawn; tree-idle adds the idle time', () => {
  const now = Date.parse(NOW);
  const a = { ...child('2026-10-22T01:56:00.000Z', '2026-10-22T02:09:00.000Z'), idle_since: '2026-10-22T02:09:00.000Z' };
  assert.equal(org.noticeClock(a, now), 'now 2026-10-22T02:10Z · child age 14m');
  assert.equal(org.noticeClock(a, now, true), 'now 2026-10-22T02:10Z · child age 14m · idle 1m');
  assert.equal(org.noticeClock({ ...a, idle_since: null }, now, true), 'now 2026-10-22T02:10Z · child age 14m');
});

test('spans read as seconds, minutes, hours and days', () => {
  const now = Date.parse(NOW);
  assert.equal(org.noticeClock(child('2026-10-22T02:10:00.000Z', ''), now), 'now 2026-10-22T02:10Z · child age 30s');
  assert.equal(org.noticeClock(child('2026-10-22T00:00:00.000Z', ''), now), 'now 2026-10-22T02:10Z · child age 2h 10m');
  assert.equal(org.noticeClock(child('2026-10-20T00:00:00.000Z', ''), now), 'now 2026-10-22T02:10Z · child age 2d 2h');
});

test('a timestamp that does not parse counts as now, so its span is 0s, as in Go', () => {
  const now = Date.parse(NOW);
  assert.equal(org.noticeClock(child('not a time', ''), now), 'now 2026-10-22T02:10Z · child age 0s');
  assert.equal(org.noticeClock({ ...child('2026-10-22T02:00:00.000Z', ''), idle_since: 'not a time' }, now, true), 'now 2026-10-22T02:10Z · child age 10m · idle 0s');
});

test('turn finished: the parent set to "turn" queues the notice with the clock line at its end', () => {
  setClock(at(NOW));
  mk('tp', null, { child_notices: 'turn' });
  mk('tc', 'tp', { activity: 'working' });
  db.updateAgent('tc', { activity: 'idle', activity_detail: 'turn finished' });
  assert.equal(mail.inTurnNotice('tp'), `[stam] Your child agent n-tc finished its turn. Its last message: (not reported)${clockLine}`);
  setClock(null);
});

test('tree-idle: the parent queues the notice with the idle time after the age', () => {
  setClock(at(NOW));
  mk('dp', null);
  mk('dc', 'dp', { activity: 'working' });
  db.updateAgent('dc', { activity: 'idle', activity_detail: 'turn finished', idle_since: '2026-10-22T02:09:00.000Z' });
  assert.equal(mail.inTurnNotice('dp'), `[stam] Your child agent n-dc finished its turn. Its last message: (not reported)${clockLine} · idle 1m`);
  setClock(null);
});

test('blocked and errored: the parent queues the trouble notice with the clock line at its end', () => {
  setClock(at(NOW));
  mk('bp', null);
  mk('bc', 'bp');
  db.updateAgent('bc', { activity: 'blocked', activity_detail: 'a dialog' });
  assert.equal(mail.inTurnNotice('bp'), `[stam] Agent n-bc, your child, is blocked: a dialog. Open its terminal with \`stam attach n-bc\` or the web UI, or help it by mail. If it needs your user's sign-off, make sure the human knows, or answer its delegate ask.${clockLine}`);
  mk('ep', null);
  mk('ec', 'ep');
  db.updateAgent('ec', { activity: 'errored', activity_detail: 'crashed' });
  assert.equal(mail.inTurnNotice('ep'), `[stam] Agent n-ec, your child, stopped with an error: crashed. Decide whether to resume, restart, or replace it.${clockLine}`);
  setClock(null);
});

test('the templates are unchanged: the clock line is appended in code, after the rendered text', () => {
  assert.equal(render('child-turn-finished', { child: 'n-x', last: 'done' }), '[stam] Your child agent n-x finished its turn. Its last message: done');
});
