#!/usr/bin/env node
// Unit tests for the `stage` field guard (S-924): a stage move the dev-change edges don't allow
// is refused when set through itsa.set. Throwaway STAM_HOME, no daemon, no network, no models.
// Run with `node --test test/process-stage.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-process-stage-');
process.env.STAM_HOME = home;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

let itsa, x, proc, processes;
before(async () => {
  proc = await import('../src/process.ts');
  const agentTypes = await import('../src/agent-types.ts');
  itsa = await import('../src/itsa.ts');
  (await import('../src/db.ts')).open();
  ({ processes } = proc.loadProcesses(join(import.meta.dirname, '..', 'processes'), { knownTypes: new Set(Object.keys(agentTypes.agentTypes())) }));
  itsa.guardChange(proc.stageGuard(() => processes), { fields: true });
  // A guard that did not opt in to field changes (retro-loop's gate is one) must not run on a field-only set.
  itsa.guardChange((cur) => {
    if (cur?.title === 'Probe') throw new Error('probe guard ran');
  });
  const options = ['route', 'plan', 'code', 'review', 'merge', 'deploy', 'hold', 'ask', 'done'].map((value) => ({ value }));
  await itsa.createField({ key: 'stage', label: 'Stage', type: 'choice', options }, 'human');
  x = await itsa.create({ title: 'X', kind: 'issue', by: 'human' });
});
after(() => rmSync(home, { recursive: true, force: true }));


const move = (to) => itsa.set(x.id, { fields: { stage: to } }, 'human');

test('stage can be set from empty, to a next node, to the same value, and cleared', async () => {
  await move('code');
  assert.equal((await itsa.get(x.id)).fields.stage, 'code');
  await move('code');
  await move('review');
  await move('merge');
  await move(null);
  assert.equal((await itsa.get(x.id)).fields.stage, undefined);
});

test('a stage move the edges do not allow is refused and nothing changes', async () => {
  await move('code');
  await assert.rejects(move('done'), /does not allow stage code -> done/);
  assert.equal((await itsa.get(x.id)).fields.stage, 'code');
});

test('an ITSA of a kind outside the process is not guarded', async () => {
  const p = await itsa.create({ title: 'P', kind: 'project', by: 'human' });
  await itsa.set(p.id, { fields: { stage: 'code' } }, 'human');
  await itsa.set(p.id, { fields: { stage: 'done' } }, 'human');
});

test('a backward move is allowed, a forward skip is not', async () => {
  await move('review');
  await move('merge');
  await move('code');
  await assert.rejects(move('merge'), /does not allow stage code -> merge/);
});

test('a guard that did not opt in is skipped on a field-only change, and still runs on a status change', async () => {
  const p = await itsa.create({ title: 'Probe', kind: 'issue', by: 'human' });
  await itsa.set(p.id, { fields: { stage: 'code' } }, 'human');
  assert.equal((await itsa.get(p.id)).fields.stage, 'code');
  await assert.rejects(itsa.set(p.id, { status: 'in_progress' }, 'human'), /probe guard ran/);
});

// ---- stage on close (S-1398) ----
test('closing sets stage to the process end node, in one change, and a named stage wins', async () => {
  itsa.setCloseStage((kind) => (kind === 'issue' ? proc.closeNodeOf(processes.find((q) => q.id === 'dev-change')) : null));
  assert.equal(proc.closeNodeOf(processes.find((q) => q.id === 'dev-change')), 'done');
  const c = await itsa.create({ title: 'Closing', kind: 'issue', by: 'human' });
  await itsa.set(c.id, { fields: { stage: 'review' } }, 'human');
  const { changes } = await itsa.set(c.id, { status: 'done' }, 'system:deploy');
  assert.deepEqual(changes.fields.to, { stage: 'done' });
  assert.equal((await itsa.get(c.id)).fields.stage, 'done');
  // A kind outside the process keeps its stage.
  const q = await itsa.create({ title: 'Q', kind: 'project', by: 'human' });
  await itsa.set(q.id, { fields: { stage: 'code' } }, 'human');
  await itsa.set(q.id, { status: 'done' }, 'human');
  assert.equal((await itsa.get(q.id)).fields.stage, 'code');
});

test('the guard allows the end node on close and still refuses review -> done while open', async () => {
  const c = await itsa.create({ title: 'Open', kind: 'issue', by: 'human' });
  await itsa.set(c.id, { fields: { stage: 'review' } }, 'human');
  await assert.rejects(itsa.set(c.id, { fields: { stage: 'done' } }, 'human'), /does not allow stage review -> done/);
  await itsa.set(c.id, { status: 'done', fields: { stage: 'done' } }, 'human');
  assert.equal((await itsa.get(c.id)).fields.stage, 'done');
  // Closed with a stale stage, set by hand afterwards: allowed.
  itsa.setCloseStage(null);
  const d = await itsa.create({ title: 'Stale', kind: 'issue', by: 'human' });
  await itsa.set(d.id, { fields: { stage: 'merge' } }, 'human');
  await itsa.set(d.id, { status: 'done' }, 'human');
  assert.equal((await itsa.get(d.id)).fields.stage, 'merge');
  await itsa.set(d.id, { fields: { stage: 'done' } }, 'human');
  assert.equal((await itsa.get(d.id)).fields.stage, 'done');
});

test('the backfill sets done on a closed ITSA with a stale stage, leaves open ones, and runs once', async () => {
  itsa.setCloseStage(null);
  const endOf = (kind) => (kind === 'issue' ? 'done' : null);
  const closed = await itsa.create({ title: 'Old closed', kind: 'issue', by: 'human' });
  await itsa.set(closed.id, { fields: { stage: 'review' } }, 'human');
  await itsa.set(closed.id, { status: 'done' }, 'human');
  const open = await itsa.create({ title: 'Still open', kind: 'issue', by: 'human' });
  await itsa.set(open.id, { fields: { stage: 'review' } }, 'human');
  const other = await itsa.create({ title: 'Other kind', kind: 'project', by: 'human' });
  await itsa.set(other.id, { fields: { stage: 'code' } }, 'human');
  await itsa.set(other.id, { status: 'done' }, 'human');
  const n = itsa.backfillClosedStage(endOf, ['issue', 'project']);
  assert.ok(n >= 1);
  assert.equal((await itsa.get(closed.id)).fields.stage, 'done');
  assert.equal((await itsa.get(open.id)).fields.stage, 'review');
  assert.equal((await itsa.get(other.id)).fields.stage, 'code');
  assert.equal(itsa.backfillClosedStage(endOf, ['issue']), null);
});
