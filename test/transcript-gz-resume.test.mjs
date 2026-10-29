#!/usr/bin/env node
// Resuming an archived agent whose transcript was gzipped (S-2359): the .jsonl is back before the
// harness starts, a failed restore stops the resume with the .gz kept, and a resume that comes in
// while the janitor compresses waits for it and then restores. A fake harness on a throwaway
// STAM_HOME and tmux socket; no daemon, no model: `node --test test/transcript-gz-resume.test.mjs`.
import { test, before, after, beforeEach } from 'node:test';
import { killTmuxServer } from '../src/tmux-socket.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-transcript-gz-resume-');
const socket = `transcript-gz-resume-${process.pid}`;
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = socket;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [], chiefOfStaff: 'cos', humanMail: { when: 'necessary' }, cost: { subscriptionWarnPercent: [], accounts: {} } }));
writeFileSync(join(home, 'registry.json'), JSON.stringify({ presets: {} }));

let db, lifecycle, gz;
// What the fake harness saw at launch: whether the transcript file existed.
const seen = [];
const DAY = 24 * 3600 * 1000;
const body = '{"type":"user"}\n'.repeat(50);

before(async () => {
  db = await import('../src/db.ts');
  lifecycle = await import('../src/lifecycle.ts');
  gz = await import('../src/transcript-gz.ts');
  const { adapters } = await import('../src/adapters/index.ts');
  adapters.fake = {
    name: 'fake',
    pushPrompt: async () => true,
    launch: async (a) => {
      seen.push(existsSync(a.transcript_path));
      return { argv: ['sleep', '600'], env: {} };
    },
    afterLaunch: async (a) => db.updateAgent(a.id, { activity: 'idle', activity_detail: 'session startup' }),
    interrupt: async () => true,
    stop: async () => {},
  };
});
after(() => {
  killTmuxServer(socket);
  rmSync(home, { recursive: true, force: true });
});
beforeEach(() => {
  db.open().exec('DELETE FROM agents');
  seen.length = 0;
});

function archived(name) {
  const id = db.newAgentId();
  const cwd = join(home, 'work', name);
  mkdirSync(cwd, { recursive: true });
  const path = join(home, `${name}.jsonl`);
  db.createAgent({ id, name, role: 'dev', machine: 'test', harness: 'fake', model: null, effort: null, cwd, parent_id: null, session_id: 'sess' });
  db.updateAgent(id, { transcript_path: path, lifecycle: 'archived', activity: 'idle' });
  return { a: db.getAgent(id), path };
}

test('resume restores the gzipped transcript before the harness starts', async () => {
  const { a, path } = archived('good');
  writeFileSync(`${path}.gz`, gzipSync(body));
  assert.equal(await lifecycle.resume(a), 'resuming');
  assert.deepEqual(seen, [true]);
  assert.equal(readFileSync(path, 'utf8'), body);
  assert.ok(!existsSync(`${path}.gz`));
});

test('a failed restore stops the resume: no harness, the .gz stays', async () => {
  const { a, path } = archived('bad');
  writeFileSync(`${path}.gz`, 'not gzip data');
  await assert.rejects(lifecycle.resume(a));
  assert.deepEqual(seen, []);
  assert.ok(existsSync(`${path}.gz`) && !existsSync(path));
  assert.equal(db.getAgent(a.id).lifecycle, 'archived');
});

test('a resume during compression waits for it and loses no file', async () => {
  const { a, path } = archived('race');
  writeFileSync(path, body);
  utimesSync(path, new Date(Date.now() - 3 * DAY), new Date(Date.now() - 3 * DAY));
  let release;
  const gate = new Promise((r) => (release = r));
  let inside;
  const entered = new Promise((r) => (inside = r));
  let calls = 0;
  const agents = [db.getAgent(a.id)];
  const compress = gz.gzipTranscripts({
    agents,
    archivedAt: new Map([[a.id, Date.now() - 2 * DAY]]),
    current: (id) => db.getAgent(id),
    // The first call is the pre-check; the second runs under the lock, where it holds the gzip.
    complete: async () => {
      if (++calls === 2) {
        inside();
        await gate;
      }
      return true;
    },
  });
  await entered;
  const resumed = lifecycle.resume(db.getAgent(a.id));
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(seen, [], 'the resume has not started the harness while the gzip holds the lock');
  release();
  assert.equal((await compress).length, 1);
  assert.equal(await resumed, 'resuming');
  assert.deepEqual(seen, [true]);
  assert.equal(readFileSync(path, 'utf8'), body);
});

test('the janitor skips an agent that is no longer archived under the lock', async () => {
  const { a, path } = archived('woke');
  writeFileSync(path, body);
  utimesSync(path, new Date(Date.now() - 3 * DAY), new Date(Date.now() - 3 * DAY));
  const r = await gz.gzipTranscripts({
    agents: [db.getAgent(a.id)],
    archivedAt: new Map([[a.id, Date.now() - 2 * DAY]]),
    current: () => ({ ...db.getAgent(a.id), lifecycle: 'active' }),
    complete: async () => true,
  });
  assert.deepEqual(r, []);
  assert.ok(existsSync(path) && !existsSync(`${path}.gz`));
});
