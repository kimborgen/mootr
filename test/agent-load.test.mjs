#!/usr/bin/env node
// Unit tests for the standing agents' load numbers (S-919, src/agent-load.ts): open ITSAs, median lead
// time over the last ten closed, context against the compaction threshold, workspace size.
// A throwaway STAM_HOME, fixed timestamps, no daemon: `node --test test/agent-load.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-agent-load-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `agent-load-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let db, load;
before(async () => {
  db = await import('../src/db.ts');
  load = await import('../src/agent-load.ts');
});
after(() => rmSync(home, { recursive: true, force: true }));

const T0 = Date.parse('2026-10-11T10:00:00.000Z');
const at = (min) => new Date(T0 + min * 60_000).toISOString();

function itsa(id, status, owner, createdMin, closedMin = null) {
  db.open()
    .prepare('INSERT INTO itsas (id, key, kind, title, status, owner, created_by, created_at, updated_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, id, 'issue', id, status, owner, 'W', at(createdMin), at(createdMin), closedMin == null ? null : at(closedMin));
}

test('open ITSAs count ready and active owners only; lead is the median of the last ten closed', () => {
  db.createAgent({ id: 'S1', name: 'spec', role: 'r', machine: 'x', harness: 'claude', model: 'm', effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  const a = db.getAgent('S1');
  itsa('a', 'in_progress', 'S1', 0);
  itsa('b', 'todo', 'S1', 0);
  itsa('c', 'in_review', 'S1', 0);
  itsa('d', 'backlog', 'S1', 0);
  itsa('e', 'in_progress', 'OTHER', 0);
  // Twelve closed with leads 1..12 minutes; the two oldest closes (leads 100 and 200 min) fall outside the last ten.
  itsa('old1', 'done', 'S1', 0, 100);
  itsa('old2', 'done', 'S1', 0, 200);
  for (let i = 1; i <= 10; i++) itsa(`z${i}`, 'done', 'S1', 1000, 1000 + i);
  const l = load.loadOf(a);
  assert.equal(l.open_itsas, 2);
  assert.equal(l.lead_n, 10);
  assert.equal(l.median_lead_s, 330); // median of 1..10 minutes = 5.5 min
});

test('canceled, duplicate and wont_do ITSAs are left out of the lead-time median', () => {
  db.createAgent({ id: 'S9', name: 'spec9', role: 'r', machine: 'x', harness: 'claude', model: 'm', effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  itsa('n1', 'done', 'S9', 0, 1);
  itsa('n2', 'done', 'S9', 0, 3);
  for (const st of ['canceled', 'duplicate', 'wont_do']) itsa(`x-${st}`, st, 'S9', 0, 500);
  const l = load.loadOf(db.getAgent('S9'));
  assert.equal(l.lead_n, 2);
  assert.equal(l.median_lead_s, 120);
});

test('no closed ITSA gives a null lead; context is a ratio of the enforcement threshold; workspace is sized', () => {
  db.createAgent({ id: 'S2', name: 'fresh', role: 'r', machine: 'x', harness: 'claude', model: 'm', effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  const ws = join(home, 'workspaces', 'fresh');
  mkdirSync(join(ws, 'notes'), { recursive: true });
  writeFileSync(join(ws, 'index.md'), '12345');
  writeFileSync(join(ws, 'notes', 'a.md'), '123');
  db.updateAgent('S2', { context_tokens: 250_000, personal_workspace: ws });
  const l = load.loadOf(db.getAgent('S2'));
  assert.equal(l.median_lead_s, null);
  assert.equal(l.lead_n, 0);
  assert.equal(l.context_threshold, 500_000);
  assert.equal(l.context_ratio, 0.5);
  assert.equal(l.workspace_bytes, 8);
  assert.equal(l.workspace_files, 2);
});

test('after a compaction the threshold is the growth floor when higher; no workspace gives nulls', () => {
  db.createAgent({ id: 'S3', name: 'big', role: 'r', machine: 'x', harness: 'claude', model: 'm', effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  db.updateAgent('S3', { tokens_after_compaction: 480_000, context_tokens: 600_000 });
  const l = load.loadOf(db.getAgent('S3'));
  assert.ok(l.context_threshold > 500_000);
  assert.equal(l.workspace_bytes, null);
  assert.equal(l.context_ratio, Math.round((600_000 / l.context_threshold) * 1000) / 1000);
});

test('the cache serves a second call within the TTL, refreshes after it, and skips archived agents', () => {
  const a = db.getAgent('S2');
  const first = load.cachedLoadOf(a, 1_000);
  db.updateAgent('S2', { context_tokens: 400_000 });
  assert.equal(load.cachedLoadOf(db.getAgent('S2'), 1_000 + load.LOAD_TTL_MS - 1), first);
  assert.equal(load.cachedLoadOf(db.getAgent('S2'), 1_000 + load.LOAD_TTL_MS).context_tokens, 400_000);
  db.updateAgent('S2', { lifecycle: 'archived' });
  assert.equal(load.cachedLoadOf(db.getAgent('S2'), 2_000_000), null);
});

test('workspace walk skips an unreadable folder and counts folders against the cap', () => {
  const ws = join(home, 'workspaces', 'many');
  mkdirSync(ws, { recursive: true });
  for (let i = 0; i < load.WORKSPACE_WALK_CAP + 10; i++) mkdirSync(join(ws, `d${i}`));
  const r = load.workspaceSize(ws);
  assert.equal(r.capped, true);
  assert.equal(r.files, 0);
  const small = join(home, 'workspaces', 'locked');
  mkdirSync(join(small, 'closed'), { recursive: true });
  writeFileSync(join(small, 'a.md'), '123');
  chmodSync(join(small, 'closed'), 0o000);
  try {
    assert.deepEqual(load.workspaceSize(small), { bytes: 3, files: 1, capped: false });
  } finally {
    chmodSync(join(small, 'closed'), 0o700);
  }
});
