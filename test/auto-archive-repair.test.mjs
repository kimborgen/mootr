#!/usr/bin/env node
// Unit tests for the auto-archive repair (S-637, src/auto-archive.ts repair): it unarchives only the
// threads auto-archive archived, and only those the rule now keeps; the human's own archives stay.
// Run with `node --test test/auto-archive-repair.test.mjs`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { tempHome } from './tmphome.mjs';

process.env.STAM_HOME = tempHome('stam-auto-archive-repair-');
process.env.STAM_TMUX_SOCKET = `auto-archive-repair-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let db, repair;
before(async () => {
  db = await import('../src/db.ts');
  ({ repair } = await import('../src/auto-archive.ts'));
});

// A thread the human has read, from an agent about no ITSA and no request: never resolved, so the rule keeps it.
const plain = (id) => ({ thread_id: id, mails: [{ id: `${id}-m`, from_id: 'a1', subject: 's', created_at: '2026-10-14T06:00:00.000Z', kind: 'comment', body: 'Anything else?', itsa_id: null,
  recipients: [{ id: 'human', read_at: '2026-10-14T07:00:00.000Z' }] }] });
// A thread the rule resolves: a request the human's answer settled (approved), read, about no ITSA.
const resolved = (id) => ({ thread_id: id, mails: [{ id: `${id}-m`, from_id: 'a1', subject: 's', created_at: '2026-10-14T06:00:00.000Z', kind: null, body: 'Permission: push', itsa_id: null,
  permission_id: 'p1', permission: { status: 'approved' }, recipients: [{ id: 'human', read_at: '2026-10-14T07:00:00.000Z' }] }] });
const src = (archived) => ({
  inbox: async () => ({ active: [], archived }),
  openDecisions: async () => new Set(),
  humanWaits: async () => [],
  tellPeers: async () => {},
  peersReachable: async () => true,
});
const archivedIn = (t) => db.open().prepare('SELECT 1 AS n FROM thread_archive WHERE mailbox_id = ? AND thread_id = ?').get('human', t.thread_id) !== undefined;

test("the repair unarchives an auto-archived thread the rule keeps, and leaves the human's own archive and a resolved one alone", async () => {
  const auto = plain('ra-auto'), manual = plain('ra-manual'), done = resolved('ra-done');
  for (const t of [auto, manual, done]) db.archiveThread('human', t.thread_id, t.mails.map((m) => m.id));
  db.markAutoArchived('human', auto.thread_id);
  db.markAutoArchived('human', done.thread_id);
  const undone = await repair(src([auto, manual, done]));
  assert.deepEqual(undone, [auto.thread_id]);
  assert.equal(archivedIn(auto), false);
  assert.equal(archivedIn(manual), true, 'the human archived it by hand');
  assert.equal(archivedIn(done), true, 'the rule resolves it, so it stays archived');
  assert.deepEqual(db.autoArchivedThreads('human').sort(), [done.thread_id]);
});

test('a manual archive forgets its auto mark, so the repair leaves it alone', async () => {
  const t = plain('ra-rearchived');
  db.archiveThread('human', t.thread_id, t.mails.map((m) => m.id));
  db.markAutoArchived('human', t.thread_id);
  db.forgetAutoArchived('human', t.thread_id);
  assert.deepEqual(await repair(src([t])), []);
  assert.equal(archivedIn(t), true);
});

// Generic waits (no thread, no request): held only by the agent in the thread, not by others (S-637, #185 follow-up).
test('a generic wait holds only the thread its agent is in the middle of', async () => {
  const { humanWaited } = await import('../src/auto-archive.ts');
  const m = (id, from_id, created_at, to = 'human') => ({ id, from_id, created_at, recipients: [{ id: to }] });
  const asked = { thread_id: 'gw-asked', mails: [m('h1', 'human', '2026-10-14T06:00:00Z', 'a1'), m('a1-1', 'a1', '2026-10-14T06:01:00Z')] };
  const other = { thread_id: 'gw-other', mails: [m('h2', 'human', '2026-10-14T06:00:00Z', 'a2'), m('a2-1', 'a2', '2026-10-14T06:01:00Z', 'a2')] };
  const unansweredToHuman = { thread_id: 'gw-to-human', mails: [m('h3', 'human', '2026-10-14T06:00:00Z', 'a1'), m('a1-2', 'a1', '2026-10-14T06:01:00Z', 'human'), m('a2-2', 'a2', '2026-10-14T06:02:00Z', 'a2')] };
  const generic = [{ thread: null, target: null, agent: 'a1' }];
  assert.equal(humanWaited(asked, generic), true, "the agent's own last mail");
  assert.equal(humanWaited(other, generic), false, 'another agent\'s thread');
  assert.equal(humanWaited(unansweredToHuman, generic), true, 'the agent has a mail to the human unanswered in it');
  assert.equal(humanWaited(other, [{ thread: null, target: null, agent: null }]), true, 'a generic wait with no known agent holds every thread');
  assert.equal(humanWaited(other, [{ thread: 'gw-other', target: null, agent: 'a1' }]), true, 'a wait naming the thread holds it');
});
