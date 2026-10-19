#!/usr/bin/env node
// Unit tests for processCounts (S-869 step 2): the live ITSA counts GET /api/processes draws at
// each process node, by the node's `statuses`. The shipped processes are loaded for real, the
// rest are hand-built definitions. A throwaway STAM_HOME, no daemon, no network, no models, no
// sleeps. Run with `node --test test/process-counts.test.mjs`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-process-counts-');
process.env.STAM_HOME = home;
// Nothing here talks to a daemon; drop pointers to the live one anyway.
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

const HERE = import.meta.dirname;
const PROCESSES = join(HERE, '..', 'processes');

let proc, shipped;
before(async () => {
  proc = await import('../src/process.ts');
  const agentTypes = await import('../src/agent-types.ts');
  shipped = proc.loadProcesses(PROCESSES, { knownTypes: new Set(Object.keys(agentTypes.agentTypes())) });
});

// One ITSA as the daemon maps a listed one: its key, id, title, status, kind, and owner's name.
const itsa = (key, status, extra = {}) => ({ key, id: `id-${key}`, title: `Title ${key}`, status, owner: null, kind: null, ...extra });
const node = (id, statuses) => ({ id, kind: 'agent', lane: 'dev', statuses, boundary: [], triggers: [] });
const processDef = ({ id, nodes, appliesTo }) => ({ id, title: id, ...(appliesTo ? { appliesTo: { kind: appliesTo } } : {}), lanes: {}, nodes, edges: [] });

test('the shipped dev-change pipeline counts live ITSAs at its nodes', () => {
  assert.deepEqual(shipped.errors, []);
  const counts = proc.processCounts(shipped.processes, [
    itsa('S-1', 'in_progress', { kind: 'issue', owner: 'dev-x' }),
    itsa('S-2', 'blocked', { kind: 'issue' }),
    itsa('S-3', 'needs_approval', { kind: 'issue' }),
    itsa('S-4', 'done', { kind: 'issue' }),
    itsa('S-5', 'ready_to_merge', { kind: 'issue' }),
    itsa('S-6', 'in_progress', { kind: 'proposal' }),
  ]);
  // One entry per node that names statuses, in the file's order; the others get none.
  assert.deepEqual(Object.keys(counts['dev-change']), ['route', 'plan', 'code', 'review', 'merge', 'deploy', 'ask']);
  const dev = counts['dev-change'];
  assert.deepEqual(dev.code, { count: 2, itsas: [itsa('S-1', 'in_progress', { kind: 'issue', owner: 'dev-x' }), itsa('S-2', 'blocked', { kind: 'issue' })].map(({ kind: _k, ...x }) => x) });
  assert.deepEqual(dev.ask.itsas.map((x) => x.key), ['S-3'], 'a human status lands on the human node');
  assert.deepEqual(dev.merge.itsas.map((x) => x.key), ['S-5']);
  assert.deepEqual(dev.route, { count: 0, itsas: [] }, 'a node with no ITSA still has an entry');
  assert.deepEqual(dev.review, { count: 0, itsas: [] });
  assert.ok(!('done' in dev), 'the end node names no statuses, so it gets no entry');
  assert.ok(!('hold' in dev));
  // dev-change is kind issue, so the proposal does not count in it; retro-loop takes it.
  assert.equal(dev.code.count, 2);
  assert.deepEqual(Object.keys(counts['retro-loop']), ['approve', 'apply']);
  assert.equal(counts['retro-loop'].approve.count, 0);
  assert.deepEqual(counts['retro-loop'].apply.itsas.map((x) => x.key), ['S-6'], 'retro-loop is kind proposal');
});

test('an ITSA in a closed status counts nowhere, even at a node that names it', () => {
  const p = processDef({ id: 'x', nodes: { work: node('work', ['done', 'in_progress']) } });
  const counts = proc.processCounts([p], [itsa('S-1', 'done'), itsa('S-2', 'in_progress'), itsa('S-3', 'canceled')]);
  assert.equal(counts.x.work.count, 1);
  assert.deepEqual(counts.x.work.itsas.map((x) => x.key), ['S-2']);
});

test('appliesTo.kind limits which ITSAs count in a process', () => {
  const p = processDef({ id: 'y', appliesTo: ['issue'], nodes: { work: node('work', ['in_progress']) } });
  const counts = proc.processCounts([p], [
    itsa('S-1', 'in_progress', { kind: 'issue' }),
    itsa('S-2', 'in_progress', { kind: 'proposal' }),
    itsa('S-3', 'in_progress'),
  ]);
  assert.deepEqual(counts.y.work.itsas.map((x) => x.key), ['S-1']);
  assert.equal(counts.y.work.count, 1);
});

test('a node lists at most 50 ITSAs and still counts them all', () => {
  const many = Array.from({ length: 60 }, (_, i) => itsa(`S-${i + 1}`, 'in_progress'));
  const p = processDef({ id: 'z', nodes: { work: node('work', ['in_progress']) } });
  const counts = proc.processCounts([p], many);
  assert.equal(proc.COUNTS_CAP, 50);
  assert.equal(counts.z.work.count, 60);
  assert.equal(counts.z.work.itsas.length, proc.COUNTS_CAP);
  assert.deepEqual([counts.z.work.itsas[0].key, counts.z.work.itsas.at(-1).key], ['S-1', 'S-50']);
});

test('a listed ITSA carries key, id, title, status, and owner, and no kind', () => {
  const p = processDef({ id: 'w', nodes: { work: node('work', ['in_progress', 'blocked']) } });
  const counts = proc.processCounts([p], [itsa('S-9', 'blocked', { kind: 'issue', owner: 'rev-1' })]);
  assert.deepEqual(counts.w.work, { count: 1, itsas: [{ key: 'S-9', id: 'id-S-9', title: 'Title S-9', status: 'blocked', owner: 'rev-1' }] });
});

test('a node with several statuses lists them in that order, and a process may have no counts', () => {
  const p = processDef({ id: 'v', nodes: { start: node('start', []), work: node('work', ['in_progress', 'blocked']) } });
  const counts = proc.processCounts([p, processDef({ id: 'none', nodes: { start: node('start', []) } })], [
    itsa('S-2', 'blocked'),
    itsa('S-1', 'in_progress'),
  ]);
  assert.deepEqual(Object.keys(counts.v), ['work'], 'a node with no statuses gets no entry');
  assert.deepEqual(counts.v.work.itsas.map((x) => x.key), ['S-1', 'S-2']);
  assert.deepEqual(counts.none, {});
});

test('an ITSA counts at the node its stage names; without a usable stage its status decides (S-924)', () => {
  const counts = proc.processCounts(shipped.processes, [
    itsa('S-1', 'in_progress', { kind: 'issue', stage: 'review' }),
    itsa('S-2', 'in_progress', { kind: 'issue', stage: null }),
    itsa('S-3', 'in_progress', { kind: 'issue', stage: 'nonsense' }),
    itsa('S-4', 'in_progress', { kind: 'issue', stage: 'verdict' }),
    itsa('S-5', 'todo', { kind: 'issue', stage: 'hold' }),
  ]);
  const dev = counts['dev-change'];
  assert.deepEqual(dev.review.itsas.map((x) => x.key), ['S-1']);
  assert.deepEqual(dev.code.itsas.map((x) => x.key), ['S-2', 'S-3', 'S-4']);
  assert.deepEqual(dev.hold.itsas.map((x) => x.key), ['S-5']);
  assert.equal(dev.route.count, 0);
  assert.equal('stage' in dev.review.itsas[0], false);
});

test('stageRefusal allows the dev-change edges, through gateways, and empty or same values (S-924)', () => {
  const dev = shipped.processes.find((p) => p.id === 'dev-change');
  assert.equal(proc.stageRefusal(dev, null, 'code'), null);
  assert.equal(proc.stageRefusal(dev, 'code', null), null);
  assert.equal(proc.stageRefusal(dev, 'code', 'code'), null);
  assert.equal(proc.stageRefusal(dev, 'code', 'review'), null);
  assert.equal(proc.stageRefusal(dev, 'review', 'merge'), null, 'review reaches merge through the verdict gateway');
  assert.equal(proc.stageRefusal(dev, 'review', 'code'), null);
  assert.equal(proc.stageRefusal(dev, 'deploy', 'done'), null);
  assert.match(proc.stageRefusal(dev, 'code', 'done'), /does not allow stage code -> done/);
  assert.equal(proc.stageRefusal(dev, 'merge', 'code'), null, 'a backward move is allowed');
  assert.equal(proc.stageRefusal(dev, 'deploy', 'merge'), null, 'a rollback is allowed');
  assert.match(proc.stageRefusal(dev, 'plan', 'merge'), /plan -> merge/);
});
