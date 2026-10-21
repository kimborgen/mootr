#!/usr/bin/env node
// Old transcripts gzipped in place and read back (S-2359): the janitor's rules, the verified
// swap, the .gz fallback of resolveTranscript and the readers, and the compile-cache cap.
// Temp homes and fixture files only: `node --test test/transcript-gz.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-transcript-gz-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `transcript-gz-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(join(home, 'registry.json'), JSON.stringify({ prices: {} }));

const TMP = new URL('../tmp/', import.meta.url).pathname;
let base;
let gz;
const DAY = 24 * 3600 * 1000;
const NOW = Date.now();

before(async () => {
  mkdirSync(TMP, { recursive: true });
  base = mkdtempSync(join(TMP, 'transcript-gz-'));
  gz = await import('../src/transcript-gz.ts');
});
after(() => {
  rmSync(base, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const old = (p, days) => utimesSync(p, new Date(NOW - days * DAY), new Date(NOW - days * DAY));
const row = (i) => JSON.stringify({ type: 'user', message: { role: 'user', content: `prompt ${i}` }, timestamp: new Date(NOW).toISOString() }) + '\n';

const hooks = (agents, complete = async () => true) => ({ current: (id) => agents.find((a) => a.id === id), complete });

function fixture(name) {
  const p = join(base, `${name}.jsonl`);
  writeFileSync(p, Array.from({ length: 200 }, (_, i) => row(i)).join(''));
  return p;
}

test('gzips only archived agents older than a day, with an old file', async () => {
  const a = fixture('archived-old');
  const b = fixture('archived-recent');
  const c = fixture('active');
  const d = fixture('archived-fresh-file');
  const e = fixture('rest');
  for (const p of [a, b, c, e]) old(p, 3);
  const body = readFileSync(a, 'utf8');
  const agents = [
    { id: 'a', lifecycle: 'archived', transcript_path: a },
    { id: 'b', lifecycle: 'archived', transcript_path: b },
    { id: 'c', lifecycle: 'active', transcript_path: c },
    { id: 'd', lifecycle: 'archived', transcript_path: d },
    { id: 'e', lifecycle: 'shut_down', transcript_path: e },
    { id: 'f', lifecycle: 'archived', transcript_path: null },
  ];
  const archivedAt = new Map([['a', NOW - 2 * DAY], ['b', NOW - 3600_000], ['c', NOW - 2 * DAY], ['d', NOW - 2 * DAY], ['e', NOW - 2 * DAY]]);
  const dry = await gz.gzipTranscripts({ agents, archivedAt, ...hooks(agents), now: NOW, dryRun: true });
  assert.deepEqual(dry.map((x) => x.agent), ['a']);
  assert.ok(existsSync(a) && !existsSync(`${a}.gz`));
  const done = await gz.gzipTranscripts({ agents, archivedAt, ...hooks(agents), now: NOW });
  assert.deepEqual(done.map((x) => x.agent), ['a']);
  assert.ok(!existsSync(a) && existsSync(`${a}.gz`));
  assert.ok(done[0].gz_bytes < done[0].bytes);
  for (const p of [b, c, d, e]) assert.ok(existsSync(p) && !existsSync(`${p}.gz`), p);
  // The .gz holds the original bytes, and no temp file stays.
  const { gunzipSync } = await import('node:zlib');
  assert.equal(gunzipSync(readFileSync(`${a}.gz`)).toString('utf8'), body);
  assert.deepEqual((await import('node:fs')).readdirSync(base).filter((n) => n.includes('.tmp-')), []);
});

test('compile cache is trimmed only over the limit, and keeps recent folders', () => {
  const dir = join(base, 'ncc');
  for (const [name, days] of [['oldA', 3], ['oldB', 2], ['fresh', 0]]) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, 'f'), Buffer.alloc(1000));
    old(join(dir, name), days);
  }
  assert.deepEqual(gz.capCompileCache({ dir, limit: 10_000, now: NOW }).removed, []);
  const dry = gz.capCompileCache({ dir, limit: 1500, now: NOW, dryRun: true });
  assert.equal(dry.removed.length, 2);
  assert.ok(existsSync(join(dir, 'oldA')));
  const r = gz.capCompileCache({ dir, limit: 1500, now: NOW });
  assert.equal(r.removed.length, 2);
  assert.ok(!existsSync(join(dir, 'oldA')) && !existsSync(join(dir, 'oldB')) && existsSync(join(dir, 'fresh')));
  assert.deepEqual(gz.capCompileCache({ dir: join(base, 'missing'), now: NOW }).removed, []);
});

test('an agent with no archive event, or an unreadable archive time, is not gzipped', async () => {
  const times = gz.archiveTimes([
    { agent_id: 'ok', ts: new Date(NOW - 2 * DAY).toISOString() },
    { agent_id: 'bad', ts: 'garbage' },
    { agent_id: 'redo', ts: new Date(NOW - 2 * DAY).toISOString() },
    { agent_id: 'redo', ts: 'garbage' },
  ]);
  assert.deepEqual([...times.keys()], ['ok']);
  const p = fixture('noevent');
  old(p, 3);
  const agents = [{ id: 'noevent', lifecycle: 'archived', transcript_path: p }, { id: 'bad', lifecycle: 'archived', transcript_path: p }];
  assert.deepEqual(await gz.gzipTranscripts({ agents, archivedAt: times, ...hooks(agents), now: NOW }), []);
  assert.ok(existsSync(p));
});

test('stale gzip temp files are swept, fresh ones and other files stay', async () => {
  const p = fixture('crashed');
  const stale = `${p}.gz.tmp-123`;
  const fresh = `${p}.gz.tmp-456`;
  const other = join(base, 'crashed.jsonl.gz.keep');
  const staleRestore = `${p}.restore-789`;
  for (const f of [stale, fresh, other, staleRestore]) writeFileSync(f, 'x');
  old(stale, 1);
  old(staleRestore, 1);
  old(other, 1);
  const agents = [{ id: 'c', lifecycle: 'archived', transcript_path: p }];
  assert.deepEqual((await gz.sweepGzTemps({ agents, now: NOW, dryRun: true })).sort(), [stale, staleRestore].sort());
  assert.ok(existsSync(stale));
  assert.deepEqual((await gz.sweepGzTemps({ agents, now: NOW })).sort(), [stale, staleRestore].sort());
  assert.ok(!existsSync(stale) && !existsSync(staleRestore) && existsSync(fresh) && existsSync(other));
});


test('an agent whose ingest cursor is not at the end of the file is not gzipped', async () => {
  const p = fixture('partial');
  old(p, 3);
  const agents = [{ id: 'p', lifecycle: 'archived', transcript_path: p }];
  const archivedAt = new Map([['p', NOW - 2 * DAY]]);
  assert.deepEqual(await gz.gzipTranscripts({ agents, archivedAt, ...hooks(agents, async () => false), now: NOW }), []);
  assert.ok(existsSync(p) && !existsSync(`${p}.gz`));
  const sizes = [];
  const done = await gz.gzipTranscripts({ agents, archivedAt, ...hooks(agents, async (_a, size) => (sizes.push(size), true)), now: NOW });
  assert.equal(done.length, 1);
  assert.ok(sizes.every((n) => n === done[0].bytes), 'the cursor is checked against the file size');
});

test('restoreTranscript puts the .jsonl back and drops the .gz; a missing pair stays missing', async () => {
  const p = join(base, 'resume.jsonl');
  writeFileSync(`${p}.gz`, gzipSync(row(3)));
  assert.equal(gz.gzippedOnly(p), true);
  assert.equal(await gz.restoreTranscript('x', p), true);
  assert.equal(readFileSync(p, 'utf8'), row(3));
  assert.ok(!existsSync(`${p}.gz`));
  assert.equal(gz.gzippedOnly(p), false);
  assert.equal(await gz.restoreTranscript('x', p), true, 'already there');
  assert.equal(await gz.restoreTranscript('x', join(base, 'never.jsonl')), false);
  assert.equal(await gz.restoreTranscript('x', null), false);
});

test('restoreTranscript throws on a corrupt .gz, keeps it, and leaves no partial file', async () => {
  const p = join(base, 'corrupt.jsonl');
  writeFileSync(`${p}.gz`, 'not gzip data');
  await assert.rejects(gz.restoreTranscript('x', p));
  assert.ok(existsSync(`${p}.gz`) && !existsSync(p));
  assert.deepEqual(readdirSync(base).filter((n) => n.startsWith('corrupt.jsonl.restore-')), []);
});

test('the activity reader skips a gzipped-only transcript and reads a restored one', async () => {
  const act = await import('../src/activity.ts');
  const p = join(base, 'ingest.jsonl');
  const rows = JSON.stringify({ type: 'user', message: { role: 'user', content: 'a' }, timestamp: new Date(NOW - 3000).toISOString() }) + '\n' + JSON.stringify({ type: 'user', message: { role: 'user', content: 'b' }, timestamp: new Date(NOW - 2000).toISOString() }) + '\n';
  writeFileSync(`${p}.gz`, gzipSync(rows));
  const opts = { turnEnded: () => true };
  const agent = { transcript_path: p, harness: 'claude' };
  assert.equal(act.readerFor('claude').read(agent, null, opts), null);
  assert.equal(act.readerFor('codex').read({ ...agent, harness: 'codex' }, null, opts), null);
  await gz.restoreTranscript('i', p);
  const it = act.readerFor('claude').read(agent, null, opts);
  assert.ok(it);
  let n = 0;
  for await (const _ of it) n++;
  assert.ok(n > 0, 'the restored file is read');
});

test('the Claude view restores a gzipped transcript, and shows the error when that fails', async () => {
  const db = await import('../src/db.ts');
  await import('../src/adapters/index.ts');
  const { claudeView } = await import('../src/adapters/claude-view.ts');
  const fx = readFileSync(new URL('./fixtures/claude-view.jsonl', import.meta.url), 'utf8');
  const p = join(base, 'view.jsonl');
  writeFileSync(`${p}.gz`, gzipSync(fx));
  db.createAgent({ id: 'gzv', name: 'gzv', role: 'dev', machine: 'x', harness: 'claude', model: 'claude-haiku-5-5', effort: null, cwd: '/tmp/gzv', parent_id: null, session_id: 's' });
  db.updateAgent('gzv', { transcript_path: p, activity: 'idle' });
  const { messages } = await claudeView.page(db.getAgent('gzv'), { limit: 50 });
  assert.deepEqual(messages.map((m) => m.id), ['u1', 'a1', 'u4', 'a5']);
  assert.ok(!existsSync(`${p}.gz`));
  const bad = join(base, 'view-bad.jsonl');
  writeFileSync(`${bad}.gz`, 'junk');
  db.updateAgent('gzv', { transcript_path: bad });
  await assert.rejects(claudeView.page(db.getAgent('gzv'), { limit: 50 }));
});

const user = (text, ago) => JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: new Date(NOW - ago).toISOString() }) + '\n';
const assistant = (id, ago) => JSON.stringify({ type: 'assistant', message: { id, role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 5, output_tokens: 7 } }, timestamp: new Date(NOW - ago).toISOString() }) + '\n';

test('an archived transcript is gzipped after a final ingest, with a partial trailing turn, and its rows are read first', async () => {
  const db = await import('../src/db.ts');
  const act = await import('../src/activity.ts');
  // Two turns the cursor never saw, then a trailing prompt that never got an answer.
  const p = join(base, 'final.jsonl');
  writeFileSync(p, user('one', 9000) + assistant('m1', 8000) + user('two', 7000) + assistant('m2', 6000) + user('killed mid-turn', 5000));
  old(p, 3);
  db.createAgent({ id: 'fin', name: 'fin', role: 'dev', machine: 'x', harness: 'claude', model: 'claude-haiku-5-5', effort: null, cwd: '/tmp/fin', parent_id: null, session_id: 's' });
  db.updateAgent('fin', { transcript_path: p, lifecycle: 'archived' });
  const items = () => db.open().prepare("SELECT COUNT(*) AS n FROM activity_items WHERE agent_id = 'fin'").get().n;
  assert.equal(items(), 0);
  const agents = [db.getAgent('fin')];
  const done = await gz.gzipTranscripts({
    agents,
    archivedAt: new Map([['fin', NOW - 2 * DAY]]),
    current: (id) => db.getAgent(id),
    complete: (g) => act.ingestComplete(db.getAgent(g.id)),
    now: NOW,
  });
  assert.equal(done.length, 1);
  assert.ok(!existsSync(p) && existsSync(`${p}.gz`));
  assert.ok(items() > 0, 'the un-ingested turns were read before the file went');
});

test('a harness without a reader is not gzipped, and a failed ingest keeps the file', async () => {
  const db = await import('../src/db.ts');
  const act = await import('../src/activity.ts');
  const p = join(base, 'noreader.jsonl');
  writeFileSync(p, user('x', 5000));
  old(p, 3);
  db.createAgent({ id: 'nor', name: 'nor', role: 'dev', machine: 'x', harness: 'nonesuch', model: null, effort: null, cwd: '/tmp/nor', parent_id: null, session_id: 's' });
  db.updateAgent('nor', { transcript_path: p, lifecycle: 'archived' });
  assert.equal(await act.ingestComplete(db.getAgent('nor')), false);
  const agents = [db.getAgent('nor')];
  const done = await gz.gzipTranscripts({ agents, archivedAt: new Map([['nor', NOW - 2 * DAY]]), current: (id) => db.getAgent(id), complete: (g) => act.ingestComplete(db.getAgent(g.id)), now: NOW });
  assert.deepEqual(done, []);
  assert.ok(existsSync(p));
});

test('the turn index leaves a gzipped-only Codex agent alone', async () => {
  const db = await import('../src/db.ts');
  const { MACHINE } = await import('../src/config.ts');
  const tv = await import('../src/turn-vectors.ts');
  const p = join(base, 'rollout-index.jsonl');
  writeFileSync(`${p}.gz`, gzipSync(row(1)));
  db.createAgent({ id: 'cxi', name: 'cxi', role: 'dev', machine: MACHINE, harness: 'codex', model: null, effort: null, cwd: '/tmp/cxi', parent_id: null, session_id: 'thread-1' });
  db.updateAgent('cxi', { transcript_path: p, lifecycle: 'archived' });
  tv._forget();
  await tv._pending('stub', 10).catch(() => {});
  assert.ok(existsSync(`${p}.gz`) && !existsSync(p), 'the .gz is still there');
});

test('a final ingest keeps a notice that arrived mid-turn inside its turn', async () => {
  const db = await import('../src/db.ts');
  const act = await import('../src/activity.ts');
  const p = join(base, 'midnotice.jsonl');
  const part = JSON.stringify({ type: 'assistant', message: { id: 'p1', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: null, content: [{ type: 'text', text: 'working' }], usage: { input_tokens: 5, output_tokens: 7 } }, timestamp: new Date(NOW - 8000).toISOString() }) + '\n';
  const notice = JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: '<channel source="stam">mail</channel>' }, timestamp: new Date(NOW - 7000).toISOString() }) + '\n';
  writeFileSync(p, user('start', 9000) + part + notice + assistant('m9', 6000));
  db.createAgent({ id: 'mid', name: 'mid', role: 'dev', machine: 'x', harness: 'claude', model: 'claude-haiku-5-5', effort: null, cwd: '/tmp/mid', parent_id: null, session_id: 's' });
  db.updateAgent('mid', { transcript_path: p, lifecycle: 'archived' });
  assert.equal(await act.ingestComplete(db.getAgent('mid')), true);
  const rows = db.open().prepare("SELECT kind, turn FROM activity_items WHERE agent_id = 'mid'").all();
  assert.ok(rows.length > 0);
  assert.equal(rows.filter((r) => r.kind === 'gap').length, 0, 'no false gap');
  assert.equal(new Set(rows.map((r) => r.turn)).size, 1, 'one turn');
});
