#!/usr/bin/env node
// Unit tests for src/itsa.ts (ITSAs, step 1): readable keys, status validation from
// settings, the `get` view (parent chain, children roll-ups, links, participants), list
// filters, `set` (field changes recorded as events, reparent cycle refusal, closed_at),
// owner/participant names resolving to ids, links, atomic mutations, and a hyphenated
// key prefix, and board rank. Throwaway STAM_HOME, no daemon, no network.
// Run with `node --test test/itsa.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-itsa-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `itsa-test-${process.pid}`;
// Nothing here talks to a daemon; drop pointers to the live one anyway.
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

let db, itsa, settings;
// The seeded tree: root > mid > leaf, plus a second root.
let root, mid, leaf, other;

before(async () => {
  db = await import('../src/db.ts');
  settings = await import('../src/settings.ts');
  itsa = await import('../src/itsa.ts');
  db.open();
  db.createAgent({ id: 'a1', name: 'alice', role: 'dev', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  db.createAgent({ id: 'a2', name: 'bob', role: 'dev', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  root = await itsa.create({ title: 'Root', by: 'alice', owner: 'alice', links: [{ url: 'https://example.com/pr/1', system: 'github', external_id: '1' }] });
  mid = await itsa.create({ title: 'Mid', parent: root.key, by: 'human', participants: ['bob'] });
  leaf = await itsa.create({ title: 'Leaf', parent: mid.id, by: 'human', status: 'in_progress' });
  other = await itsa.create({ title: 'Other root', by: 'human' });
});
after(() => rmSync(home, { recursive: true, force: true }));

test('readable keys are sequential in the settings prefix', () => {
  assert.match(root.key, /^S-\d+$/);
  assert.equal(root.key, 'S-1');
  assert.equal(mid.key, 'S-2');
  assert.equal(leaf.key, 'S-3');
  assert.equal(other.key, 'S-4');
});

test('an ITSA is found by id or by key; an unknown one throws', () => {
  assert.equal(itsa.must(root.id).key, root.key);
  assert.equal(itsa.must(root.key).id, root.id);
  assert.throws(() => itsa.must('S-999'), /no ITSA S-999/);
});

test('the status set comes from settings, and an unknown status is refused', async () => {
  const names = itsa.statuses().map((s) => s.name);
  assert.ok(names.includes('in_progress') && names.includes('needs_review'));
  assert.equal(itsa.statusOf('needs_review').human, true);
  assert.equal(itsa.statusOf('in_progress').category, 'active');
  assert.equal(itsa.statusOf('nope'), undefined);
  await assert.rejects(() => itsa.create({ title: 'Bad', status: 'nope' }), /unknown status nope/);
  // A new ITSA defaults to backlog.
  assert.equal((await itsa.create({ title: 'Defaulted', by: 'human' })).status, 'backlog');
});

test('owner and participants take names or ids or human, and the owner is a participant', async () => {
  const x = await itsa.create({ title: 'People', by: 'human', owner: 'bob', participants: ['alice', 'human'] });
  assert.equal(x.owner, 'a2');
  const ps = new Set(itsa.participants(x.id));
  assert.deepEqual(ps, new Set(['a1', 'a2', 'human']));
  await assert.rejects(() => itsa.create({ title: 'Nobody', owner: 'ghost' }), /no agent ghost/);
});

test('get returns the parent chain, children with roll-ups, links, and participants', () => {
  const v = itsa.get(root.key);
  assert.deepEqual(v.parent_chain, []);
  assert.equal(v.rollup.backlog, 1); // mid
  assert.deepEqual(v.children.map((c) => c.key), [mid.key]);
  assert.deepEqual(v.children[0].rollup.active, 1); // leaf is in_progress
  assert.equal(v.links.length, 1);
  assert.equal(v.links[0].system, 'github');
  assert.deepEqual(v.participants, ['a1']);

  const deep = itsa.get(leaf.id);
  assert.deepEqual(deep.parent_chain.map((p) => p.key), [root.key, mid.key]);
  assert.deepEqual(deep.participants, []);
});

test('list filters by parent, subtree, status, category, owner, participant, and text', async () => {
  assert.deepEqual((await itsa.list({ parent: root.id })).map((x) => x.key), [mid.key]);
  assert.deepEqual(
    (await itsa.list({ subtree: root.id })).map((x) => x.key).sort(),
    [root.key, mid.key, leaf.key].sort(),
  );
  assert.deepEqual((await itsa.list({ status: 'in_progress' })).map((x) => x.key), [leaf.key]);
  assert.ok((await itsa.list({ category: 'active' })).some((x) => x.key === leaf.key));
  assert.deepEqual((await itsa.list({ owner: 'alice' })).map((x) => x.key), [root.key]);
  assert.ok((await itsa.list({ participant: 'bob' })).map((x) => x.key).includes(mid.key));
  assert.deepEqual((await itsa.list({ text: 'Other root' })).map((x) => x.key), [other.key]);
  assert.ok((await itsa.list({ parent: 'root' })).map((x) => x.key).includes(other.key));
});

test('set changes fields, records an event per change, and manages closed_at', async () => {
  const before = itsa.events(leaf.id).length;
  const r = await itsa.set(leaf.id, { status: 'done', summary: 'shipped' }, 'alice');
  assert.equal(r.itsa.status, 'done');
  assert.equal(r.changes.status.from, 'in_progress');
  assert.ok(r.itsa.closed_at, 'closing sets closed_at');
  const evs = itsa.events(leaf.id);
  assert.equal(evs.length, before + 2);
  assert.equal(evs.at(-1).actor, 'a1');
  assert.ok(evs.some((e) => e.type === 'status'));

  // A no-op set changes nothing and records nothing.
  const same = await itsa.set(leaf.id, { status: 'done' }, 'alice');
  assert.deepEqual(same.changes, {});

  // Reopening clears closed_at.
  const reopened = await itsa.set(leaf.id, { status: 'in_progress' }, 'human');
  assert.equal(reopened.itsa.closed_at, null);
});

test('reparenting refuses a cycle and a self-parent, and null makes a root', async () => {
  await assert.rejects(() => itsa.set(root.id, { parent: leaf.id }, 'human'), /cycle/);
  await assert.rejects(() => itsa.set(mid.id, { parent: mid.id }, 'human'), /its own parent/);
  const moved = await itsa.set(leaf.id, { parent: other.id }, 'human');
  assert.equal(moved.itsa.parent_id, other.id);
  assert.equal(itsa.get(other.id).children.length, 1);
  const freed = await itsa.set(leaf.id, { parent: null }, 'human');
  assert.equal(freed.itsa.parent_id, null);
  await itsa.set(leaf.id, { parent: mid.id }, 'human'); // restore for other tests
});

test('changing the owner keeps it a participant', async () => {
  const x = await itsa.create({ title: 'Handover', by: 'human', owner: 'alice' });
  await itsa.set(x.id, { owner: 'bob' }, 'human');
  assert.ok(itsa.participants(x.id).includes('a2'));
});

test('links are numbered per ITSA, added and removed with events', async () => {
  const x = await itsa.create({ title: 'Linked', by: 'human', links: [{ url: 'https://a/1', system: 'github', external_id: '7' }] });
  assert.equal(itsa.links(x.id)[0].n, 1);
  const added = await itsa.addLink(x.id, { url: 'https://b/2' }, 'human');
  assert.equal(added.link.n, 2);
  assert.equal(added.link.system, 'url');
  const gone = await itsa.removeLink(x.id, 1, 'human');
  assert.deepEqual(itsa.links(gone.id).map((l) => l.url), ['https://b/2']);
  await assert.rejects(() => itsa.removeLink(x.id, 9), /no link 9/);
  assert.ok(itsa.events(x.id).some((e) => e.type === 'link.added'));
  assert.ok(itsa.events(x.id).some((e) => e.type === 'link.removed'));
});

test('a rejected mutation leaves no partial write', async () => {
  const n0 = (await itsa.list()).length;
  // An unknown participant and a link with no url are both refused before any write.
  await assert.rejects(() => itsa.create({ title: 'Partial', by: 'human', participants: ['ghost'] }), /no agent ghost/);
  await assert.rejects(() => itsa.create({ title: 'Partial', by: 'human', links: [{ url: '' }] }), /needs a url/);
  assert.equal((await itsa.list()).length, n0, 'a rejected create inserted a row');

  // A rejected set changes nothing: not the field, not the participant, no event.
  const x = await itsa.create({ title: 'Atomic', by: 'human' });
  await assert.rejects(() => itsa.set(x.id, { title: 'Changed', participants: ['ghost'] }, 'human'), /no agent ghost/);
  assert.equal(itsa.must(x.id).title, 'Atomic', 'a rejected set changed the title');
  assert.ok(!itsa.events(x.id).some((e) => e.type === 'title'), 'a rejected set recorded an event');
});

test('concurrent sets do not lose a change or record a stale from', async () => {
  // An unowned ITSA, two sets at once: the owner must end up a participant, not dropped
  // because one write read the row before the other committed.
  const x = await itsa.create({ title: 'Concurrent', by: 'human' });
  await Promise.all([itsa.set(x.id, { owner: 'human' }, 'human'), itsa.set(x.id, { participants: [] }, 'human')]);
  assert.equal(itsa.must(x.id).owner, 'human');
  assert.deepEqual(itsa.participants(x.id), ['human'], 'the owner was dropped from participants');

  // Two concurrent title changes: each records its own "from", never the same stale one.
  const y = await itsa.create({ title: 'From zero', by: 'human' });
  await Promise.all([itsa.set(y.id, { title: 'From one' }, 'human'), itsa.set(y.id, { title: 'From two' }, 'human')]);
  const froms = itsa.events(y.id).filter((e) => e.type === 'title').map((e) => JSON.parse(e.data).from);
  assert.equal(froms.length, 2);
  assert.equal(froms.filter((v) => v === 'From zero').length, 1, 'both writes recorded the same stale from');
  assert.equal(new Set(froms).size, 2, 'the second write did not see the first');
});

test('a key prefix with a hyphen allocates distinct keys', async () => {
  const before = settings.settings().itsa;
  settings.setSetting('itsa', { ...before, keyPrefix: 'TEAM-S' });
  const a = await itsa.create({ title: 'Hyphen A', by: 'human' });
  const b = await itsa.create({ title: 'Hyphen B', by: 'human' });
  assert.match(a.key, /^TEAM-S-\d+$/);
  assert.notEqual(a.key, b.key, 'a hyphenated prefix produced a duplicate key');
  settings.setSetting('itsa', { ...before, keyPrefix: 'S' });
});

test('rank orders a board without an event, and list carries links and health', async () => {
  const x = await itsa.create({ title: 'Ranked', by: 'human' });
  assert.equal(itsa.must(x.id).rank, null, 'a new ITSA is unranked');
  const r = await itsa.set(x.id, { rank: 1.5, status: 'todo' }, 'human');
  assert.equal(r.itsa.rank, 1.5);
  assert.ok(!itsa.events(x.id).some((e) => e.type === 'rank'), 'reordering recorded an event');
  assert.ok(itsa.events(x.id).some((e) => e.type === 'status'), 'the status change beside it still did');
  await assert.rejects(itsa.set(x.id, { rank: 'high' }, 'human'), /rank must be a number/);
  assert.equal((await itsa.set(x.id, { rank: null }, 'human')).itsa.rank, null);
  const listed = await itsa.list({ parent: 'root' });
  const r0 = listed.find((y) => y.id === root.id);
  assert.deepEqual(r0.links.map((l) => l.system), ['github'], "a listed ITSA carries its links");
  assert.equal(listed.find((y) => y.id === x.id).health, null, 'no update, no health');
});

test('a system sender (the deploy watcher, S-474) acts as system:NAME, never as the human or an agent', async () => {
  // Only the human's CLI names a system sender (the daemon checks `human`); the actor is the name it carries.
  assert.equal(itsa.systemActor('deploy-watch'), 'system:deploy-watch');
  assert.throws(() => itsa.systemActor('Deploy Watch'), /bad system sender/);
  assert.throws(() => itsa.systemActor('x'), /bad system sender/, 'a name is at least two letters');
  // An agent request can't forge one: `by` naming a system actor is refused.
  assert.throws(() => itsa.requestActor('system:deploy-watch', false), /named with system/);
  assert.throws(() => itsa.requestActor('system:deploy-watch', true), /named with system/);
  assert.equal(itsa.requestActor('alice', false), 'alice');
  assert.equal(itsa.requestActor(undefined, true), 'human');

  const owner = leaf.owner;
  const r = await itsa.set(leaf.id, { status: 'todo' }, 'system:deploy-watch');
  assert.equal(r.itsa.status, 'todo');
  const ev = itsa.events(leaf.id).at(-1);
  assert.equal(ev.actor, 'system:deploy-watch', 'the event is the watcher\'s, not the human\'s');
  assert.equal(r.itsa.owner, owner, 'a system sender changes no owner');
});

test('the incident mark is set on an ITSA and cleared when it closes (S-2406)', async () => {
  const marked = await itsa.set(mid.id, { incident: true }, 'alice');
  assert.equal(marked.itsa.incident, 1);
  assert.deepEqual(marked.changes.incident, { from: 0, to: 1 });
  // Closing clears it, in the same change as the status.
  const closed = await itsa.set(mid.id, { status: 'done' }, 'alice');
  assert.equal(closed.itsa.incident, 0);
  assert.deepEqual(closed.changes.incident, { from: 1, to: 0 });
  // Reopened, it is not marked again.
  const reopened = await itsa.set(mid.id, { status: 'todo' }, 'alice');
  assert.equal(reopened.itsa.incident, 0);
});

test('provenChain walks to a root, and proves nothing about a chain with a missing parent or a cycle (S-2406)', async () => {
  const a = await itsa.create({ title: 'Chain A', by: 'human' });
  const b = await itsa.create({ title: 'Chain B', parent: a.key, by: 'human' });
  assert.deepEqual(itsa.provenChain(itsa.find(b.id)).map((x) => x.id), [b.id, a.id]);
  // A parent that isn't there: the chain is unproven, though ancestorsOf stops quietly with a partial one.
  db.open().prepare('UPDATE itsas SET parent_id = ? WHERE id = ?').run('inope', a.id);
  assert.equal(itsa.provenChain(itsa.find(b.id)), null);
  // A cycle, A -> B -> A: unproven too.
  db.open().prepare('UPDATE itsas SET parent_id = ? WHERE id = ?').run(b.id, a.id);
  assert.equal(itsa.provenChain(itsa.find(b.id)), null);
});
