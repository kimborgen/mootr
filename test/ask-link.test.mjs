#!/usr/bin/env node
// The open ask an agent or an ITSA waits on (S-3977, src/asks.ts openAskLinks, src/itsa.ts openAskOf): the key a
// Needs you row has, so the web's link goes to that row. An agent's is its oldest open permission ask of the human
// (not a delegate's, until escalated), else the ITSA ask its wait on the human is tied to; an ITSA's is its own ask
// while it is in a human status. Each is read from stored rows, so a settled or withdrawn ask drops out at once and a
// restart keeps the links. The key is the list's, and no ask text reaches the link. Throwaway STAM_HOME, no daemon, no
// models: `node --test test/ask-link.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-ask-link-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `ask-link-${process.pid}`;
process.env.STAM_EMBEDDER = 'stub';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), '{}');

const SECRET = 'STAM-SENTINEL-SECRET-link';
let db, asks, itsa, itsaHuman;
const agent = (id, name) => {
  db.createAgent({ id, name, role: 'dev', machine: 'x', harness: 'claude', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  db.updateAgent(id, { lifecycle: 'active', activity: 'idle' });
};
const held = () => itsaHuman.waitingIds();
// The keys the web links by; the rows themselves are read in the detail test below.
const keyed = (m) => new Map([...m].map(([id, a]) => [id, a.key]));
const links = () => { const l = asks.openAskLinks('x', held()); return { agents: keyed(l.agents), itsas: keyed(l.itsas) }; };
const open = () => asks.openAsks('x', held());

before(async () => {
  db = await import('../src/db.ts');
  asks = await import('../src/asks.ts');
  itsa = await import('../src/itsa.ts');
  itsaHuman = await import('../src/itsa-human.ts');
  await import('../src/settings.ts');
  db.open();
  agent('lk-dev', 'link-dev');
  agent('lk-other', 'link-other');
  agent('lk-watch', 'link-watch');
});
after(() => rmSync(home, { recursive: true, force: true }));

test('a pending permission the human owes links its agent, by the list\'s key', () => {
  const r = db.createPermissionRequest('lk-dev', 'git push', SECRET, `details ${SECRET}`, false, null, 'human');
  assert.equal(links().agents.get('lk-dev'), `request:${r.id}`);
  const row = open().find((a) => a.key === `request:${r.id}`);
  assert.ok(row, 'the same row is on the Needs you list');
  assert.equal(row.state, 'open');
  assert.equal(row.what, 'Permission request', 'the row says the kind, never the action or details');
  assert.ok(!JSON.stringify(open()).includes(SECRET), 'no secret reaches the list or the link');
});

test('a delegate ask is not the human\'s, so its agent gets no link until it is escalated', () => {
  const r = db.createPermissionRequest('lk-other', 'deploy', 'reason', '', false, null, 'delegate');
  assert.equal(links().agents.get('lk-other'), undefined);
  db.open().prepare("UPDATE permission_requests SET audience = 'human' WHERE id = ?").run(r.id);
  assert.equal(links().agents.get('lk-other'), `request:${r.id}`);
});

test('an answered request drops its link at once', () => {
  const { id } = db.open().prepare("SELECT id FROM permission_requests WHERE agent_id = 'lk-dev' AND status = 'pending'").get();
  db.open().prepare("UPDATE permission_requests SET status = 'approved', decided_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  assert.equal(links().agents.get('lk-dev'), undefined);
  assert.ok(!open().some((a) => a.key === `request:${id}`));
});

test('an ITSA in a human status links its own ask, and the link goes when it leaves', async () => {
  const x = await itsa.create({ title: 'Link ITSA', by: 'human', owner: 'lk-dev', kind: 'issue' });
  await itsa.set(x.id, { status: 'in_progress' }, 'human');
  assert.equal(links().itsas.get(x.id), undefined, 'no ask while it works');
  await itsa.post(x.id, { by: 'lk-dev', body: 'Done. Needs your approval.' });
  await itsa.set(x.id, { status: 'needs_approval' }, 'lk-dev');
  assert.equal(links().itsas.get(x.id), `itsa:${x.id}`);
  assert.ok(open().some((a) => a.key === `itsa:${x.id}` && a.state === 'open'), 'it is the list\'s open row');
  await itsa.set(x.id, { status: 'in_progress' }, 'human');
  assert.equal(links().itsas.get(x.id), undefined);
});

test('an agent waiting on the human for an ITSA links that ITSA\'s ask', async () => {
  const x = await itsa.create({ title: 'Watched ITSA', by: 'human', owner: 'lk-dev', kind: 'issue' });
  await itsa.set(x.id, { status: 'in_progress' }, 'human');
  await itsa.post(x.id, { by: 'lk-dev', body: 'Ready for review.' });
  await itsa.set(x.id, { status: 'needs_review' }, 'lk-dev');
  db.addWait({ agent_id: 'lk-watch', kind: 'human', target: x.id, detail: 'your review', source: 'declared' });
  assert.equal(links().agents.get('lk-watch'), `itsa:${x.id}`);
  db.clearWaits('lk-watch', 'human', x.id);
});

test('an agent with two open asks links the oldest, whatever order they were made in', () => {
  agent('lk-two', 'link-two');
  const newer = db.createPermissionRequest('lk-two', 'git push', 'reason', '', false, null, 'human');
  const older = db.createPermissionRequest('lk-two', 'deploy', 'reason', '', false, null, 'human');
  db.open().prepare('UPDATE permission_requests SET created_at = ? WHERE id = ?').run('2026-10-01T09:00:00.000Z', older.id);
  db.open().prepare('UPDATE permission_requests SET created_at = ? WHERE id = ?').run('2026-10-01T10:00:00.000Z', newer.id);
  assert.equal(links().agents.get('lk-two'), `request:${older.id}`);
});

test('a decision mail the human owes links its agent, to the mail card', () => {
  db.createMail({ id: 'lk-decision', from_id: 'lk-dev', from_name: 'link-dev', subject: 'Pick one', body: '```decision\nPick?\n- A: yes\n```', thread_id: 'lk-decision-thread', reply_to: null }, ['human']);
  db.addDecisionMail('lk-decision', 'lk-decision-thread');
  assert.equal(links().agents.get('lk-dev'), 'decision:lk-decision');
  assert.equal(open().find((a) => a.key === 'decision:lk-decision')?.thread_id, 'lk-decision-thread');
});

test('an agent with no open ask gets no link', () => {
  assert.equal(links().agents.get('lk-watch'), undefined);
});

// The text an agent reads of its open ask (find_agents, itsa_get, S-3982): the mail to open it in, and its kind. Never the
// ask's text, which stays on the card.
test('the detail of an open permission names its mail and kind, never its text', () => {
  agent('lk-text', 'link-text');
  const r = db.createPermissionRequest('lk-text', 'npm publish', SECRET, `details ${SECRET}`, false, null, 'human');
  db.open().prepare('UPDATE permission_requests SET home_thread = ? WHERE id = ?').run('lk-text-thread', r.id);
  const row = asks.openAskLinks('x', held()).agents.get('lk-text');
  assert.deepEqual(asks.askDetail(row), { mail: 'lk-text-thread', kind: 'Permission' });
  assert.ok(!JSON.stringify(asks.askDetail(row)).includes(SECRET), 'no secret reaches the detail');
  assert.equal(asks.askDetail(undefined), null, 'no open ask, no detail');
});

test('the detail of an ITSA ask names its ITSA\'s mail and the ITSA kind', async () => {
  const x = await itsa.create({ title: 'Detail ITSA', by: 'human', owner: 'lk-text', kind: 'issue' });
  await itsa.set(x.id, { status: 'in_progress' }, 'human');
  await itsa.post(x.id, { by: 'lk-text', body: 'Done. Needs your approval.' });
  await itsa.set(x.id, { status: 'needs_approval' }, 'lk-text');
  const row = asks.openAskLinks('x', held()).itsas.get(x.id);
  assert.deepEqual(asks.askDetail(row), { mail: row.thread_id, kind: 'ITSA' });
});
