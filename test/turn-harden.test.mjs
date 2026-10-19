#!/usr/bin/env node
// The turn index's worker and cache edges (S-1704): a read that hangs times out, a worker that
// crashes fails its read and the next starts a new one, a read during idle shutdown gets a fresh
// worker, the in-place branch, a partial first turn, and a failed flush drops the vector cache.
// Run with `node --test test/turn-harden.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmphome.mjs';

const home = tempDir('stam-turn-harden-');
process.env.STAM_HOME = home;
process.env.STAM_EMBEDDER = 'stub';
const db = await import('../src/db.ts');
const { MACHINE } = await import('../src/config.ts');
const T = await import('../src/turn-vectors.ts');
const V = await import('../src/vectors.ts');
const { history } = await import('../src/agent-view.ts');

const stub = new URL('./turn-worker-stubs.mjs', import.meta.url);
const req = (file) => T._readTail({ file, since: 0, tail: 1 << 20 });
const useStub = (timeout, idle) => T._worker(stub, timeout, idle);

test('a read that hangs times out, and the next read starts a new worker', async () => {
  useStub(100, undefined);
  await assert.rejects(req('hang'), /turn reader exited/);
  assert.ok(!T._hasWorker());
  assert.equal((await req('ok')).size, 0);
});

test('a worker that crashes fails its read, and the next read works', async () => {
  useStub(10_000, undefined);
  await assert.rejects(req('crash'), /boom/);
  assert.equal((await req('ok')).size, 0);
});

test('a read arriving as the idle worker stops gets a fresh worker', async () => {
  useStub(10_000, 20);
  await req('ok');
  await until(() => !T._hasWorker());
  assert.ok(!T._hasWorker(), 'the idle worker is cleared as it stops');
  assert.equal((await req('ok')).size, 0);
});

const line = (o) => JSON.stringify(o) + '\n';
const rows = (name, i, t) =>
  line({ type: 'user', uuid: `${name}-u${i}`, timestamp: new Date(t).toISOString(), message: { role: 'user', content: `prompt ${i}` } }) +
  line({ type: 'assistant', uuid: `${name}-a${i}`, timestamp: new Date(t + 1).toISOString(), message: { content: [{ type: 'text', text: `answer ${i}` }] } }) +
  line({ type: 'system', subtype: 'turn_duration', uuid: `${name}-s${i}`, timestamp: new Date(t + 2).toISOString() });

function agent(id, file) {
  db.createAgent({ id, name: id, role: 'developer', machine: MACHINE, harness: 'claude', model: null, effort: null, cwd: home, parent_id: null, session_id: null });
  db.updateAgent(id, { transcript_path: file, activity: 'idle' });
  return db.getAgent(id);
}
const until = async (f) => {
  for (let i = 0; i < 400 && !f(); i++) await new Promise((r) => setTimeout(r, 25));
};

test('a turn end reads a parsed, nearly current transcript in place', async () => {
  useStub(10_000, undefined);
  T._worker();
  const file = join(home, 'inplace.jsonl');
  writeFileSync(file, rows('ip', 0, Date.now() - 60_000));
  const a = agent('ip', file);
  await history(a); // parses and caches the transcript
  writeFileSync(file, rows('ip', 0, Date.now() - 60_000) + rows('ip', 1, Date.now() - 30_000));
  T.indexTurnsSoon('ip');
  await until(() => db.turnSnippet('ip:ip-u1'));
  assert.ok(db.turnSnippet('ip:ip-u1'), 'the new turn is indexed');
  assert.ok(!T._hasWorker(), 'no worker read it');
});

test('a first turn cut off by the tail is skipped, and an unfinished last one too', () => {
  const m = (id, role, at, text) => ({ id, role, at, parts: [{ type: 'text', text }] });
  const msgs = [m('x1', 'assistant', 1, 'tail of a cut turn'), m('u2', 'user', 2, 'p2'), m('x2', 'assistant', 3, 'a2'), m('u3', 'user', 4, 'p3'), m('x3', 'assistant', 5, 'a3')];
  assert.deepEqual(T.turnsOf('ag', msgs, true, true).map((t) => t.ref), ['ag:u2']);
  assert.deepEqual(T.turnsOf('ag', msgs, false, false).map((t) => t.ref), ['ag:x1', 'ag:u2', 'ag:u3']);
});

test('a failed flush drops the source cache', async () => {
  const model = (await import('../src/embed.ts')).currentModel();
  V.source('tst', (ref) => `text ${ref}`);
  db.open().exec("CREATE TRIGGER no_bad BEFORE INSERT ON embeddings WHEN NEW.ref = 'bad' BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  assert.equal(db.decodedEmbeddingsOf('tst', model).length, 0); // warms the cache
  // One batch: `good` is cached as it is put, then `bad` aborts the transaction.
  await assert.rejects(V._flush(['tst\0good', 'tst\0bad']), /disk full/);
  assert.ok(!db.embeddingRow('tst', 'good'), 'the transaction rolled back');
  assert.equal(db.decodedEmbeddingsOf('tst', model).length, 0, 'the cache has nothing the table lacks');
});
