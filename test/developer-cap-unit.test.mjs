#!/usr/bin/env node
// The developer slot cap (S-2008): a developer spawn over `developerCap` is refused with the holders
// named; reviewers (which also default to a worktree) and other types are never capped, a paused
// developer holds no slot, and a cap of 0 turns it off. Pure functions, no daemon, no model:
// `node --test test/developer-cap-unit.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { incidentRefusal, homeSaysMarked, chainMarked, mayMarkIncident, demoteRevoked, developerCapRefusal, developerHolders, reserveSlot, releaseSlot, enqueueWaiter, grantSlots, queuedWaiters, queuePlace, dropWaiter, restoreQueue, saveQueueFile, loadQueueFile, hostHasRoom, roomRefusal, hostReadingFrom, cancelState, mayCancelWaiter, findDuplicate, spawnerKey, IDLE_HOLD_MS, SLOT_MIN_FREE_BYTES } = await import('../src/developer-cap.ts');

// Host readings for grantSlots (S-2120): a quiet machine, and one over the load limit, one short of memory.
const room = { load1: 1, freeBytes: 8 * 1024 ** 3 };
const loaded = { load1: 5, freeBytes: 8 * 1024 ** 3 };
const lowMemory = { load1: 1, freeBytes: SLOT_MIN_FREE_BYTES };

const types = {
  developer: { worktree: true },
  reviewer: { worktree: true, review: { ring: false } },
  manager: {},
};
const wt = JSON.stringify({ worktree: { branch: 'b' } });
const dev = (name, lifecycle = 'active', machine = 'm1') => ({ name, type: 'developer', workspace: wt, lifecycle, machine });
const full = [dev('a'), dev('b'), dev('c')];

test('a developer is refused at the cap, and the refusal names the holders', () => {
  const r = developerCapRefusal(full, types, types.developer, true, 3, 'm1');
  assert.match(r, /3 of 3/);
  for (const n of ['a', 'b', 'c']) assert.match(r, new RegExp(`\\b${n}\\b`));
  assert.match(r, /wait_for/);
  assert.equal(developerCapRefusal(full, types, types.developer, true, 4, 'm1'), null);
});

test('a reviewer or a manager spawns at the cap', () => {
  assert.equal(developerCapRefusal(full, types, types.reviewer, true, 3, 'm1'), null);
  assert.equal(developerCapRefusal(full, types, types.manager, false, 3, 'm1'), null);
  assert.equal(developerCapRefusal(full, types, undefined, false, 3, 'm1'), null);
});

test('reviewers do not hold developer slots', () => {
  const agents = [...full, { name: 'r', type: 'reviewer', workspace: wt, lifecycle: 'active', machine: 'm1' }];
  assert.deepEqual(developerHolders(agents, types, 'm1'), ['a', 'b', 'c']);
});

test('a developer that went idle or started waiting holds its slot only for IDLE_HOLD_MS', () => {
  const now = Date.parse('2026-10-19T10:00:00Z');
  const since = (ms) => new Date(now - ms).toISOString();
  const agent = (name, activity, idle_since) => ({ ...dev(name), activity, idle_since });
  const agents = [
    agent('work', 'working', null),
    agent('start', 'starting', null),
    agent('blocked', 'blocked', null),
    agent('fresh-wait', 'waiting', since(IDLE_HOLD_MS - 1000)),
    agent('fresh-idle', 'idle', since(1000)),
    agent('review', 'waiting', since(IDLE_HOLD_MS + 1000)),
    agent('rested', 'idle', since(3 * IDLE_HOLD_MS)),
  ];
  assert.deepEqual(developerHolders(agents, types, 'm1', now), ['work', 'start', 'blocked', 'fresh-wait', 'fresh-idle']);
  // A reviewer's wait releases the slot: a new developer spawn is allowed with one holder over the cap-of-one.
  assert.equal(developerCapRefusal([agent('review', 'waiting', since(IDLE_HOLD_MS + 1000))], types, types.developer, true, 1, 'm1', now), null);
  assert.match(developerCapRefusal([agent('fresh', 'waiting', since(1000))], types, types.developer, true, 1, 'm1', now), /1 of 1/);
});

test('an idle developer with no idle time recorded still holds its slot', () => {
  assert.deepEqual(developerHolders([{ ...dev('a'), activity: 'idle', idle_since: null }], types, 'm1'), ['a']);
});

test('paused, shut down, archived and other-machine developers do not count', () => {
  const agents = [dev('a'), dev('b', 'paused'), dev('c', 'shut_down'), dev('d', 'archived'), dev('e', 'active', 'm2')];
  assert.deepEqual(developerHolders(agents, types, 'm1'), ['a']);
  assert.equal(developerCapRefusal(agents, types, types.developer, true, 2, 'm1'), null);
});

test('developerCap 0 disables the cap', () => {
  assert.equal(developerCapRefusal(full, types, types.developer, true, 0, 'm1'), null);
});

test('a spawn in flight holds a slot until released', () => {
  const two = [dev('a'), dev('b')];
  assert.equal(developerCapRefusal(two, types, types.developer, true, 3, 'm1'), null);
  reserveSlot('c');
  const r = developerCapRefusal(two, types, types.developer, true, 3, 'm1');
  assert.match(r, /c \(starting\)/);
  releaseSlot('c');
  assert.equal(developerCapRefusal(two, types, types.developer, true, 3, 'm1'), null);
});

test('a reserved name that is already a holder counts once', () => {
  reserveSlot('a');
  assert.equal(developerCapRefusal([dev('a'), dev('b')], types, types.developer, true, 3, 'm1'), null);
  releaseSlot('a');
});

test('an untyped worktree spawn is capped and counted; an untyped plain directory is not', () => {
  const untyped = { name: 'u', type: null, workspace: wt, lifecycle: 'active', machine: 'm1' };
  assert.deepEqual(developerHolders([untyped, { ...untyped, name: 'p', workspace: JSON.stringify({}) }], types, 'm1'), ['u']);
  assert.match(developerCapRefusal([untyped], types, undefined, true, 1, 'm1'), /1 of 1/);
  assert.equal(developerCapRefusal([untyped], types, undefined, false, 1, 'm1'), null);
});

// The slot queue (S-2053).
const waiter = (name, extra = {}) => ({ name, body: {}, at: Date.now(), ...extra });
const alive = () => true;
const clear = () => queuedWaiters().map((w) => w.name).forEach(dropWaiter);

test('urgent waiters queue ahead of normal ones, first come first served within each class', () => {
  clear();
  assert.equal(enqueueWaiter(waiter('n1')), 1);
  assert.equal(enqueueWaiter(waiter('n2')), 2);
  assert.equal(enqueueWaiter(waiter('u1', { urgent: 'red-main' })), 1);
  assert.equal(enqueueWaiter(waiter('u2', { urgent: 'approved-pr' })), 2);
  assert.deepEqual(queuedWaiters().map((w) => w.name), ['u1', 'u2', 'n1', 'n2']);
  assert.equal(queuePlace('n2'), 4);
  clear();
});

test('two waiters and one free slot: the head gets the slot, reserved, and a newer spawn sees it full', () => {
  clear();
  enqueueWaiter(waiter('w1'));
  enqueueWaiter(waiter('w2'));
  const two = [dev('a'), dev('b')];
  const { granted } = grantSlots(two, types, 3, 'm1', alive, room);
  assert.deepEqual(granted.map((w) => w.name), ['w1']);
  // Between the grant and the agent row, the slot is held: a spawn arriving now is refused, w2 stays queued.
  assert.match(developerCapRefusal(two, types, types.developer, true, 3, 'm1'), /w1 \(starting\)/);
  assert.deepEqual(grantSlots(two, types, 3, 'm1', alive, room).granted, []);
  assert.deepEqual(queuedWaiters().map((w) => w.name), ['w2']);
  // The agent row exists: w1 holds through the row, and w2 waits for the next free slot.
  releaseSlot('w1');
  const three = [...two, dev('w1')];
  assert.deepEqual(grantSlots(three, types, 3, 'm1', alive, room).granted, []);
  assert.deepEqual(grantSlots([dev('a'), dev('w1')], types, 3, 'm1', alive, room).granted.map((w) => w.name), ['w2']);
  releaseSlot('w2');
  clear();
});

test('a waiter whose caller is archived is dropped and does not hold the queue; a live caller waits however long', () => {
  clear();
  enqueueWaiter(waiter('dead', { by: 'gone' }));
  enqueueWaiter(waiter('old', { by: 'ok', at: 0 }));
  enqueueWaiter(waiter('live', { by: 'ok' }));
  const { granted, dropped } = grantSlots([dev('a')], types, 2, 'm1', (w) => w.by !== 'gone', room);
  assert.deepEqual(dropped.map((w) => w.name), ['dead']);
  assert.deepEqual(granted.map((w) => w.name), ['old']);
  assert.deepEqual(queuedWaiters().map((w) => w.name), ['live']);
  releaseSlot('old');
  dropWaiter('live');
  assert.equal(queuedWaiters().length, 0);
});

test('a waiter whose caller is archived is dropped even while the host is too busy to grant', () => {
  clear();
  enqueueWaiter(waiter('dead', { by: 'gone' }));
  const { granted, dropped } = grantSlots([], types, 2, 'm1', (w) => w.by !== 'gone', loaded);
  assert.deepEqual(dropped.map((w) => w.name), ['dead']);
  assert.deepEqual(granted, []);
  assert.equal(queuedWaiters().length, 0);
});

test('the load guard holds the queue under the cap: load of 5 or more, or 3 GB or less free, grants nothing', () => {
  clear();
  enqueueWaiter(waiter('w1'));
  assert.deepEqual(grantSlots([], types, 6, 'm1', alive, loaded).granted, []);
  assert.deepEqual(grantSlots([], types, 6, 'm1', alive, lowMemory).granted, []);
  assert.deepEqual(grantSlots([], types, 6, 'm1', alive, { load1: 4.99, freeBytes: SLOT_MIN_FREE_BYTES + 1 }).granted.map((w) => w.name), ['w1']);
  releaseSlot('w1');
});

test('the load guard reads one host reading: hostHasRoom needs load under 5 and more than 3 GB free', () => {
  assert.equal(hostHasRoom({ load1: 0, freeBytes: SLOT_MIN_FREE_BYTES + 1 }), true);
  assert.equal(hostHasRoom({ load1: 0, freeBytes: SLOT_MIN_FREE_BYTES }), false);
  assert.equal(hostHasRoom({ load1: 5, freeBytes: 16 * 1024 ** 3 }), false);
});

// The host reading: the sampler's latest sample while fresh, else the OS readings (S-2120 review). The OS
// readings are stubbed, and nothing reads /proc.
const GiB = 1024 ** 3;
const MAX_AGE = 10_000;
const T = Date.parse('2026-10-19T11:00:00Z');
const sample = (load1, freeGb, ts = T) => ({ ts, load: [load1, 0, 0], ramTotal: 16 * GiB, ramUsed: (16 - freeGb) * GiB });
const osQuiet = () => ({ load1: 0.5, freeBytes: 12 * GiB });
const osBusy = () => ({ load1: 9, freeBytes: 1 * GiB });
const host = (s, now, os) => hostReadingFrom(s, now, MAX_AGE, os);

test('a fresh busy sample is trusted; after a failed read it is stale and the OS readings answer', () => {
  const busy = sample(9, 12);
  assert.deepEqual(host(busy, T + 5000, osQuiet), { load1: 9, freeBytes: 12 * GiB });
  // /proc unreadable from here on: the sampler keeps the busy sample, which is too old to trust.
  assert.deepEqual(host(busy, T + MAX_AGE + 1, osQuiet), { load1: 0.5, freeBytes: 12 * GiB });
});

test('a fresh quiet sample is trusted; after a failed read the OS readings answer, even when busy', () => {
  const quiet = sample(0.1, 12);
  assert.deepEqual(host(quiet, T + 5000, osBusy), { load1: 0.1, freeBytes: 12 * GiB });
  assert.deepEqual(host(quiet, T + MAX_AGE + 1, osBusy), { load1: 9, freeBytes: 1 * GiB });
  assert.equal(hostHasRoom(host(quiet, T + MAX_AGE + 1, osBusy)), false);
});

test('malformed telemetry is not a reading: NaN load, no RAM total, or memory used above the total fall back to the OS', () => {
  assert.deepEqual(host({ ts: T, load: [Number.NaN], ramTotal: 16 * GiB, ramUsed: 4 * GiB }, T, osQuiet), { load1: 0.5, freeBytes: 12 * GiB });
  assert.deepEqual(host({ ts: T, load: [], ramTotal: 16 * GiB, ramUsed: 4 * GiB }, T, osQuiet), { load1: 0.5, freeBytes: 12 * GiB });
  assert.deepEqual(host({ ts: T, load: [0.1], ramTotal: 0, ramUsed: 0 }, T, osBusy), { load1: 9, freeBytes: 1 * GiB });
  assert.deepEqual(host({ ts: T, load: [0.1], ramTotal: 16 * GiB, ramUsed: 20 * GiB }, T, osBusy), { load1: 9, freeBytes: 1 * GiB });
  assert.deepEqual(host({ ts: T, load: [-1], ramTotal: 16 * GiB, ramUsed: 4 * GiB }, T, osBusy), { load1: 9, freeBytes: 1 * GiB });
});

test('with /proc missing and no sample yet, the OS readings answer', () => {
  assert.deepEqual(host(null, T, osQuiet), { load1: 0.5, freeBytes: 12 * GiB });
});

test('a sample from the future is not trusted', () => {
  assert.deepEqual(host(sample(9, 12, T + 60_000), T, osQuiet), { load1: 0.5, freeBytes: 12 * GiB });
});

test('a direct developer spawn on a host without room is queued with the reason: the load, the memory, or both', () => {
  assert.equal(roomRefusal(room), null);
  assert.equal(roomRefusal({ load1: 6.2, freeBytes: 8 * 1024 ** 3 }), 'queued: load 6.2');
  assert.equal(roomRefusal({ load1: 1, freeBytes: 2 * 1024 ** 3 }), 'queued: 2.0 GB free');
  assert.equal(roomRefusal({ load1: 9, freeBytes: 1024 ** 3 }), 'queued: load 9.0, 1.0 GB free');
});

test('a restored queue goes ahead of new waiters, keeps its order, and skips names already queued', () => {
  clear();
  enqueueWaiter(waiter('new'));
  restoreQueue([waiter('r1'), waiter('r2'), waiter('new')]);
  assert.deepEqual(queuedWaiters().map((w) => w.name), ['r1', 'r2', 'new']);
  clear();
});

test('a restored queue respects the load guard: nothing starts on a busy host, and the head starts once it has room', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slotq-'));
  const file = join(dir, 'q.json');
  saveQueueFile(file, [waiter('r1'), waiter('r2')]);
  clear();
  restoreQueue(loadQueueFile(file, () => false).waiting);
  assert.deepEqual(grantSlots([], types, 3, 'm1', alive, loaded).granted, []);
  assert.deepEqual(queuedWaiters().map((w) => w.name), ['r1', 'r2']);
  const granted = grantSlots([], types, 3, 'm1', alive, room).granted.map((w) => w.name);
  assert.deepEqual(granted, ['r1', 'r2']);
  granted.forEach(releaseSlot);
});

test('the saved queue is written whole by rename; a failed save throws and leaves the old file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slotq-'));
  const file = join(dir, 'q.json');
  saveQueueFile(file, [waiter('a')]);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).map((w) => w.name), ['a']);
  assert.deepEqual(readdirSync(dir), ['q.json']);
  assert.throws(() => saveQueueFile(join(dir, 'missing', 'q.json'), [waiter('b')]));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).map((w) => w.name), ['a']);
});

// Cancelling a queued spawn (S-2134): who may, what state a name is in, and which waiter a peer's spawn duplicates.
test('a queued spawn is cancelled by its caller, the caller\'s ancestors, or the boss; anyone else is refused', () => {
  const ancestors = new Set(['parent-1', 'grandparent-1']);
  assert.equal(mayCancelWaiter('dev-owner', 'dev-owner', false, new Set()), true, 'the caller');
  assert.equal(mayCancelWaiter('dev-owner', 'parent-1', false, ancestors), true, 'the caller\'s parent');
  assert.equal(mayCancelWaiter('dev-owner', 'grandparent-1', false, ancestors), true, 'the caller\'s grandparent');
  assert.equal(mayCancelWaiter('dev-owner', 'cos-1', true, new Set()), true, 'the boss (chief of staff, assistant, human)');
  assert.equal(mayCancelWaiter('dev-owner', 'stranger', false, ancestors), false, 'an unrelated agent');
  assert.equal(mayCancelWaiter('dev-owner', 'dev-owner-child', false, new Set()), false, 'a child of the caller is not its parent');
  assert.equal(mayCancelWaiter('dev-owner', undefined, false, ancestors), false, 'no caller identity (OpenCode server)');
  assert.equal(mayCancelWaiter(undefined, 'parent-1', false, ancestors), false, 'a spawn with no known caller is the boss\'s alone');
  assert.equal(mayCancelWaiter(undefined, 'stranger', true, new Set()), true, 'the boss cancels it');
});

test('a name is queued, launching (granted a slot), or unknown; a launching spawn is not queued', () => {
  const queued = [waiter('dev-queued')];
  assert.equal(cancelState('dev-queued', queued, []), 'queued');
  assert.equal(cancelState('dev-granted', queued, ['dev-granted']), 'launching');
  assert.equal(cancelState('dev-granted', [], ['dev-granted']), 'launching', 'granted waiters leave the queue but still launch');
  assert.equal(cancelState('dev-missing', queued, []), 'unknown');
});

test('the duplicate check keys a spawn by the authenticated agent, never a `by` the agent names', () => {
  assert.equal(spawnerKey('agent-x', 'agent-c'), 'agent-x', 'an agent naming another agent as by is still keyed by itself');
  assert.equal(spawnerKey('agent-x', undefined), 'agent-x');
  assert.equal(spawnerKey(undefined, 'agent-c'), 'agent-c', 'the human or a peer names the caller');
  assert.equal(spawnerKey(undefined, undefined), undefined);
});

test('an agent that queues naming another agent is keyed by itself, and that other agent can\'t cancel it', () => {
  const key = spawnerKey('agent-x', 'agent-c');
  assert.equal(key, 'agent-x', 'the queued spawn is stored under the agent that sent it');
  assert.equal(mayCancelWaiter(key, 'agent-c', false, new Set()), false, 'the agent it named can\'t cancel it');
  assert.equal(mayCancelWaiter(key, 'agent-x', false, new Set()), true, 'the agent that queued it can');
});

test('a peer\'s spawn drops a queued one only when name and caller both match', () => {
  const waiting = [waiter('dev-x', { by: 'cos-1' }), waiter('dev-y', { by: 'cos-2' })];
  assert.equal(findDuplicate(waiting, 'dev-x', 'cos-1')?.name, 'dev-x');
  assert.equal(findDuplicate(waiting, 'dev-x', 'cos-2'), undefined, 'same name from another caller is not a duplicate');
  assert.equal(findDuplicate(waiting, 'dev-z', 'cos-1'), undefined, 'another name is not a duplicate');
  assert.equal(findDuplicate([], 'dev-x', 'cos-1'), undefined);
});

test('loading: no file is an empty queue, a corrupt file throws, a launched waiter is not queued again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slotq-'));
  const file = join(dir, 'q.json');
  assert.deepEqual(loadQueueFile(file, () => false), { waiting: [], started: [] });
  writeFileSync(file, '[{"name":"a"');
  assert.throws(() => loadQueueFile(file, () => false));
  saveQueueFile(file, [waiter('launched'), waiter('waiting')]);
  const r = loadQueueFile(file, (n) => n === 'launched');
  assert.deepEqual(r.waiting.map((w) => w.name), ['waiting']);
  assert.deepEqual(r.started.map((w) => w.name), ['launched']);
});

test('an incident waiter queues ahead of normal ones, like red-main (S-2406)', () => {
  clear();
  assert.equal(enqueueWaiter(waiter('n1')), 1);
  assert.equal(enqueueWaiter(waiter('i1', { urgent: 'incident' })), 1);
  assert.deepEqual(queuedWaiters().map((w) => w.name), ['i1', 'n1']);
  clear();
});

test('an incident spawn gets no jump unless its ITSA chain is marked, and an unreadable mark is no mark (S-2406)', () => {
  assert.equal(incidentRefusal('incident', true), null);
  assert.equal(incidentRefusal('red-main', false), null);
  assert.equal(incidentRefusal(undefined, false), null);
  assert.match(incidentRefusal('incident', false), /marked as an incident/);
  // The spawn's own ITSA, then its ancestors: one marked ancestor is enough, a marked child of an unmarked one is not.
  assert.equal(chainMarked([{ incident: 0 }, { incident: 1 }]), true);
  assert.equal(chainMarked([{ incident: 0 }, { incident: 0 }]), false);
  assert.equal(chainMarked([{}, { incident: 0 }]), false);
  assert.equal(chainMarked([]), false);
  // Only a stored 1 counts: any other value, a missing one, fails closed.
  for (const bad of [true, '1', null, undefined, 2]) assert.equal(chainMarked([{ incident: bad }]), false, String(bad));
});

// The ITSA home's answer to a spawn on another machine (S-2421): only a 200 with an explicit `marked: true` is a yes.
test('a home that does not clearly say yes refuses an incident spawn (S-2421)', async () => {
  const answers = (r) => homeSaysMarked(async () => r);
  assert.equal(await answers({ status: 200, data: { marked: true } }), true);
  assert.equal(await answers({ status: 200, data: { marked: false } }), false);
  // A reply without the explicit flag, or a malformed one, is no.
  assert.equal(await answers({ status: 200, data: {} }), false);
  assert.equal(await answers({ status: 200, data: { marked: 'yes' } }), false);
  assert.equal(await answers({ status: 200, data: { marked: 1 } }), false);
  assert.equal(await answers({ status: 200, data: null }), false);
  assert.equal(await answers({ status: 200, data: 'marked' }), false);
  assert.equal(await answers({ status: 200, data: undefined }), false);
  // A non-200 is no, even with a yes in the body.
  assert.equal(await answers({ status: 403, data: { marked: true } }), false);
  assert.equal(await answers({ status: 503, data: { marked: true } }), false);
  // An unreachable home, or a timeout, throws: no.
  assert.equal(await homeSaysMarked(async () => { throw new Error('the ITSA home is unreachable'); }), false);
  assert.equal(await homeSaysMarked(() => { throw new Error('sync failure'); }), false);
  assert.match(incidentRefusal('incident', false), /ITSA home did not answer yes/);
});

test('only the human or the chief of staff may set the incident mark (S-2406)', () => {
  assert.equal(mayMarkIncident('human', true, 'cos1'), true);
  assert.equal(mayMarkIncident('cos1', false, 'cos1'), true);
  // A manager on its own ITSA and a caller with no id are refused.
  assert.equal(mayMarkIncident('mgr1', false, 'cos1'), false);
  assert.equal(mayMarkIncident('mgr1', false, undefined), false);
  assert.equal(mayMarkIncident(undefined, false, undefined), false);
  assert.equal(mayMarkIncident(undefined, false, 'cos1'), false);
});

test('a revoked incident waiter drops its priority and keeps its arrival place among the normal waiters (S-2406)', () => {
  clear();
  enqueueWaiter(waiter('n1', { at: 1 }));
  enqueueWaiter(waiter('i1', { at: 2, urgent: 'incident', body: { urgent: 'incident', itsa: 'S-1' } }));
  enqueueWaiter(waiter('n2', { at: 3 }));
  assert.deepEqual(queuedWaiters().map((w) => w.name), ['i1', 'n1', 'n2']);
  // Still marked: nothing changes.
  assert.deepEqual(demoteRevoked(() => true), []);
  assert.deepEqual(queuedWaiters().map((w) => w.name), ['i1', 'n1', 'n2']);
  // Mark gone: i1 is a normal waiter again, behind n1 (which arrived first) and ahead of n2 (which arrived after it).
  const demoted = demoteRevoked(() => false);
  assert.deepEqual(demoted.map((w) => w.name), ['i1']);
  assert.deepEqual(queuedWaiters().map((w) => w.name), ['n1', 'i1', 'n2']);
  const i1 = queuedWaiters().find((w) => w.name === 'i1');
  assert.equal(i1.urgent, undefined);
  assert.equal('urgent' in i1.body, false);
  assert.equal(i1.body.itsa, 'S-1');
  clear();
});

// A queued spawn's notice (S-2720): an unreachable caller's machine is retried, then the fallback hears it; an unknown
// caller goes straight to the fallback; a delivered notice never reaches it.
test('deliverWaiterNotice retries an unreachable machine and then falls back', async () => {
  const { deliverWaiterNotice } = await import('../src/developer-cap.ts');
  let tries = 0;
  const why = [];
  assert.equal(await deliverWaiterNotice(async () => (++tries < 3 ? 'unreachable' : 'told'), async (w) => why.push(w), 5, 1), 'told');
  assert.equal(tries, 3);
  assert.deepEqual(why, []);
  tries = 0;
  assert.equal(await deliverWaiterNotice(async () => (tries++, 'unreachable'), async (w) => why.push(w), 2, 1), 'fallback');
  assert.equal(tries, 3);
  assert.match(why[0], /unreachable/);
  tries = 0;
  assert.equal(await deliverWaiterNotice(async () => (tries++, 'absent'), async (w) => why.push(w), 5, 1), 'fallback');
  assert.equal(tries, 1);
  assert.equal(await deliverWaiterNotice(async () => { throw new Error('x'); }, async (w) => why.push(w), 1, 1), 'fallback');
});
