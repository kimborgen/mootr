#!/usr/bin/env node
// S-920: a standing agent over a growth threshold gets one notice per crossing (and none while it has an
// open growth proposal), and who may approve a growth proposal: your user for any, the chief of staff for
// `Growth: helpers` only. Fixed loads through injected thresholds; throwaway STAM_HOME, no daemon, no model:
// `node --test test/standing-growth.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-standing-growth-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `standing-growth-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

let db, itsa, loop, growth, mail, settings;
const agent = (id, name, extra = {}) => db.createAgent({ id, name, role: 'dev', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: home, parent_id: null, session_id: null, ...extra });
const T = { openItsas: 2, leadHours: 1000, contextPct: 1000 };
let t = 1_000_000;
const S1 = { owner: 's1', created_by: 's1' };

before(async () => {
  db = await import('../src/db.ts');
  itsa = await import('../src/itsa.ts');
  loop = await import('../src/retro-loop.ts');
  growth = await import('../src/standing-growth.ts');
  mail = await import('../src/mail.ts');
  settings = await import('../src/settings.ts');
  settings.setSetting('search', { embedder: 'off' });
  db.open();
  agent('s1', 'spec');
  agent('s2', 'quiet');
  for (const id of ['s1', 's2']) db.updateAgent(id, { standing: 1 });
  agent('d1', 'plain');
  agent('cos', 'cos');
  settings.setSetting('chiefOfStaff', 'cos');
  loop.watchProposals();
});
after(() => rmSync(home, { recursive: true, force: true }));

const own = (n, by) => Promise.all(Array.from({ length: n }, (_, i) => itsa.create({ title: `work ${by} ${i}`, kind: 'issue', status: 'in_progress', owner: by, by })));
const tick = () => (t += 120_000); // past the 60 s load cache

test('crossings name each threshold the load is over', () => {
  const load = { open_itsas: 5, median_lead_s: 7200, lead_n: 4, context_ratio: 0.9 };
  assert.equal(growth.crossings(load, { openItsas: 5, leadHours: 2, contextPct: 90 }).length, 0);
  assert.equal(growth.crossings(load, { openItsas: 4, leadHours: 1, contextPct: 50 }).length, 3);
  assert.equal(growth.crossings({ ...load, median_lead_s: null, context_ratio: null }, { openItsas: 4, leadHours: 1, contextPct: 50 }).length, 1);
});

test('one notice per crossing; none under the threshold, off, for a plain agent, or with an open growth proposal', async () => {
  await own(3, 's1');
  await own(1, 's2');
  await own(5, 'd1');
  assert.deepEqual(await growth.growthSweep({ thresholds: T, enabled: false, now: tick() }), []);
  assert.deepEqual(await growth.growthSweep({ thresholds: T, now: tick() }), ['s1']);
  assert.equal(mail.queuedNoticeCount('s1'), 1);
  // Still over: not told again.
  assert.deepEqual(await growth.growthSweep({ thresholds: T, now: tick() }), []);
  assert.equal(mail.queuedNoticeCount('s1'), 1);
  // Under every threshold clears it; over again is a new crossing.
  assert.deepEqual(await growth.growthSweep({ thresholds: { ...T, openItsas: 50 }, now: tick() }), []);
  assert.deepEqual(await growth.growthSweep({ thresholds: T, now: tick() }), ['s1']);
  assert.equal(mail.queuedNoticeCount('s1'), 2);
  assert.equal(mail.queuedNoticeCount('s2'), 0);
  assert.equal(mail.queuedNoticeCount('d1'), 0);
});

test('an open growth proposal of its own stops the notice; a closed one does not', async () => {
  growth.resetGrowthTold();
  const p = await itsa.create({ title: 'grow', kind: 'proposal', status: 'needs_approval', body: 'Growth: helpers\nopen 3', by: 's1' });
  const before = mail.queuedNoticeCount('s1');
  assert.deepEqual(await growth.growthSweep({ thresholds: T, now: tick() }), []);
  await itsa.set(p.key, { status: 'canceled' }, 'human');
  assert.deepEqual(await growth.growthSweep({ thresholds: T, now: tick() }), ['s1']);
  assert.equal(mail.queuedNoticeCount('s1'), before + 1);
});

test('growthKind reads the first line of the body', () => {
  assert.equal(loop.growthKind('Growth: helpers\nwhy'), 'helpers');
  assert.equal(loop.growthKind('Growth: split'), 'split');
  assert.equal(loop.growthKind('Growth: team\n'), 'team');
  assert.equal(loop.growthKind('Growth: other'), null);
  assert.equal(loop.growthKind('Answers: S-1\nGrowth: team'), null);
  assert.equal(loop.growthKind(null), null);
});

const propose = (kind, by = 's1') => itsa.create({ title: `grow ${kind}`, kind: 'proposal', status: 'needs_approval', body: `Growth: ${kind}\nopen 3, why`, owner: by, by });

test('the chief of staff hears a helpers proposal; a split or a team goes to your user alone', async () => {
  const n0 = mail.queuedNoticeCount('cos');
  await propose('split');
  await propose('team');
  assert.equal(mail.queuedNoticeCount('cos'), n0);
  await propose('helpers');
  assert.equal(mail.queuedNoticeCount('cos'), n0 + 1);
});

test('the chief of staff is not told of a helpers proposal it can not approve', async () => {
  const n0 = mail.queuedNoticeCount('cos');
  await itsa.create({ title: 'fenced helpers', kind: 'proposal', status: 'needs_approval', body: 'Growth: helpers\n- > ```ts', owner: 's1', by: 's1' });
  assert.equal(mail.queuedNoticeCount('cos'), n0);
});

test('the specialist can not apply its own growth proposal', async () => {
  const p = await propose('helpers');
  await assert.rejects(itsa.set(p.key, { status: 'done' }, 's1'), /chief of staff hasn't approved/);
  const split = await propose('split');
  await assert.rejects(itsa.set(split.key, { status: 'done' }, 's1'), /your user hasn't approved/);
});

test('the chief of staff approves helpers: the specialist applies it, and hears it', async () => {
  const p = await propose('helpers');
  const n0 = mail.queuedNoticeCount('s1');
  await itsa.set(p.key, { status: 'in_progress' }, 'cos');
  assert.equal(mail.queuedNoticeCount('s1'), n0 + 1);
  assert.equal((await itsa.set(p.key, { status: 'done' }, 's1')).itsa.status, 'done');
});

test('the chief of staff approves nothing but helpers', async () => {
  for (const kind of ['split', 'team']) {
    const p = await propose(kind);
    await assert.rejects(itsa.set(p.key, { status: 'ready_to_merge' }, 'cos'), /your user hasn't approved/);
    await itsa.set(p.key, { status: 'in_progress' }, 'cos'); // a non-applying move, which approves nothing
    await assert.rejects(itsa.set(p.key, { status: 'done' }, 's1'), /your user hasn't approved/);
  }
});

test('a body rewritten to helpers after the chief of staff moved it is not approved', async () => {
  const p = await propose('split');
  await itsa.set(p.key, { status: 'in_progress' }, 'cos');
  await itsa.set(p.key, { body: 'Growth: helpers\nrewritten' }, 's1');
  await assert.rejects(itsa.set(p.key, { status: 'done' }, 's1'), /hasn't approved/);
});

test('your user approves a split or a team; the specialist applies it', async () => {
  for (const kind of ['split', 'team']) {
    const p = await propose(kind);
    const n0 = mail.queuedNoticeCount('s1');
    await itsa.set(p.key, { status: 'in_progress', action: 'approve' }, 'human');
    assert.equal(mail.queuedNoticeCount('s1'), n0 + 1);
    assert.equal((await itsa.set(p.key, { status: 'done' }, 's1')).itsa.status, 'done');
  }
});

test('Request changes from your user overrides a chief of staff approval', async () => {
  const p = await propose('helpers');
  await itsa.set(p.key, { status: 'in_progress' }, 'cos');
  await itsa.set(p.key, { status: 'waiting', action: 'changes' }, 'human');
  await assert.rejects(itsa.set(p.key, { status: 'done' }, 's1'), /hasn't approved/);
});

test('a chief of staff rejection is not an approval, and the owner is not told it was approved', async () => {
  for (const status of ['canceled', 'wont_do', 'blocked']) {
    const p = await propose('helpers');
    const n0 = mail.queuedNoticeCount('s1');
    await itsa.set(p.key, { status }, 'cos');
    assert.equal(mail.queuedNoticeCount('s1'), n0, status);
    await assert.rejects(itsa.set(p.key, { status: 'done' }, 's1'), /hasn't approved/, status);
  }
});

test('a body swapped in the applying call is not approved', async () => {
  const p = await propose('helpers');
  await itsa.set(p.key, { status: 'in_progress' }, 'cos');
  await assert.rejects(itsa.set(p.key, { status: 'done', body: 'Growth: helpers\nAnswers: S-1\ndiff --git a/x b/x' }, 's1'), /hasn't approved/);
  assert.equal((await itsa.set(p.key, { status: 'done' }, 's1')).itsa.status, 'done');
});

test('a clean helpers body swapped in the applying call is refused by the unchanged-body check alone', async () => {
  assert.ok(loop.cosMayApprove('Growth: helpers\nrewritten, still prose', S1));
  const p = await propose('helpers');
  await itsa.set(p.key, { status: 'in_progress' }, 'cos');
  await assert.rejects(itsa.set(p.key, { status: 'done', body: 'Growth: helpers\nrewritten, still prose' }, 's1'), /hasn't approved/);
});

test('the chief of staff path is closed to a body with an Answers line or a diff', async () => {
  for (const extra of ['Answers: S-1', 'diff --git a/x b/x', '+++ b/src/x.ts', 'diff -u a b\n--- a\n+++ b', '@@ -1,2 +1,3 @@', '*** a/x\n--- b/x', '```diff\n+x\n```', '~~~\ncode\n~~~', '  diff --git a/x b/x', '> ```ts', '> diff --git a/x b/x', '- +++ b/src/x.ts', '- > ```ts', '> - ~~~', '1. - > diff --git a/x b/x', '- - ```', '- @@ -1 +1 @@', '1. --- a/x\n2. +++ b/x', '<pre>', '<CODE class=x>']) {
    const p = await itsa.create({ title: 'sneaky', kind: 'proposal', status: 'needs_approval', body: `Growth: helpers\n${extra}`, owner: 's1', by: 's1' });
    const n0 = mail.queuedNoticeCount('s1');
    await assert.rejects(itsa.set(p.key, { status: 'ready_to_merge' }, 'cos'), /your user hasn't approved/, extra);
    await itsa.set(p.key, { status: 'in_progress' }, 'cos');
    assert.equal(mail.queuedNoticeCount('s1'), n0, extra);
    await assert.rejects(itsa.set(p.key, { status: 'done' }, 's1'), /your user hasn't approved/, extra);
  }
});

test('the chief of staff path needs a standing owner and creator that are not the retro steward', async () => {
  agent('st1', 'steward-x', { type: 'retro-steward' });
  db.updateAgent('st1', { standing: 1, type: 'retro-steward' });
  const body = 'Growth: helpers\nopen 3, why';
  assert.equal(loop.cosMayApprove(body, S1), true);
  assert.equal(loop.cosMayApprove(body, { owner: 's1', created_by: 'd1' }), false, 'a non-standing creator');
  assert.equal(loop.cosMayApprove(body, { owner: 'd1', created_by: 's1' }), false, 'a non-standing owner');
  assert.equal(loop.cosMayApprove(body, { owner: 'st1', created_by: 'st1' }), false, 'the steward');
  const p = await itsa.create({ title: 'steward helpers', kind: 'proposal', status: 'needs_approval', body: 'Growth: helpers\nPlain prose about the diff of the load, no markers.', owner: 'st1', by: 'st1' });
  await assert.rejects(itsa.set(p.key, { status: 'ready_to_merge' }, 'cos'), /your user hasn't approved/);
  await itsa.set(p.key, { status: 'in_progress' }, 'cos');
  await assert.rejects(itsa.set(p.key, { status: 'done' }, 'st1'), /your user hasn't approved/);
});

test('prose that mentions a diff or a list still passes', () => {
  const x = S1;
  for (const prose of ['- diff of load rose to 9', '1. open ITSAs: 9', '> the lead time doubled', 'a diff between weeks', '- a --- b dash', '    four-space indented text']) assert.ok(loop.cosMayApprove(`Growth: helpers\n${prose}`, x), prose);
});
