#!/usr/bin/env node
// Unit test for S-759: a Codex resume of a thread whose first turn never ran. The app-server
// answers "no rollout found for thread id ...", so the adapter must not fail the resume
// forever: it starts a fresh thread on the same app-server and stores its id, so the caller
// can deliver the first prompt the spawn stored. A resume that does work is left a resume.
// Fake app-server on a unix socket (test/fake-codex/server.mjs); no model, no daemon:
// `node --test test/codex-no-rollout.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startFakeCodex } from './fake-codex/server.mjs';
import { tempHome, tempDirOutside } from './tmphome.mjs';

// The fake app-server listens on a socket under this home: a short folder, outside a deep TMPDIR (test/run.sh's).
process.env.STAM_HOME = tempHome('stam-nr-', tempDirOutside);process.env.STAM_TMUX_SOCKET = `codex-no-rollout-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let db, codex, config, fake;
const A = 'nr-agent';

before(async () => {
  db = await import('../src/db.ts');
  await import('../src/adapters/index.ts');
  codex = await import('../src/adapters/codex.ts');
  config = await import('../src/config.ts');
  db.createAgent({ id: A, name: 'nr', role: 'dev', machine: 'x', harness: 'codex', model: 'gpt-6.1-sol', effort: null, cwd: '/tmp/nr', parent_id: null, session_id: 'thr-stale' });
  db.updateAgent(A, { first_prompt: 'the original task' });
  mkdirSync(config.agentDir(A), { recursive: true });
  fake = await startFakeCodex(join(config.agentDir(A), 'codex.sock'), {
    responses: {
      // The one thread with no first turn of its own: nothing on disk to resume.
      'thread/resume': (p) => {
        if (p.threadId === 'thr-stale') throw new Error(`no rollout found for thread id ${p.threadId}`);
        return { thread: { id: p.threadId }, model: 'gpt-6.1-sol', approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' } };
      },
      'thread/start': () => ({ thread: { id: 'thr-fresh' } }),
    },
  });
});

after(async () => {
  await fake.close();
});

test('a resume with no rollout starts a fresh thread and stores its id', async () => {
  const r = await codex.openThread(db.getAgent(A), 'thr-stale');
  assert.deepEqual(r, { id: 'thr-fresh', fresh: true });
  assert.equal(db.getAgent(A).session_id, 'thr-fresh');
  const methods = fake.log.map((m) => m.method);
  assert.ok(methods.includes('thread/resume'), 'it tried the resume first');
  assert.equal(fake.log.find((m) => m.method === 'thread/resume').params.threadId, 'thr-stale');
  assert.ok(methods.includes('thread/start'), 'it started a fresh thread after the refusal');
  assert.equal(fake.log.find((m) => m.method === 'thread/start').params.cwd, '/tmp/nr');
});

test('a resume that works stays a resume', async () => {
  fake.log.length = 0;
  const r = await codex.openThread(db.getAgent(A), 'thr-fresh');
  assert.deepEqual(r, { id: 'thr-fresh', fresh: false });
  assert.deepEqual(fake.log.map((m) => m.method), ['thread/resume']);
  assert.equal(db.getAgent(A).session_id, 'thr-fresh');
});
