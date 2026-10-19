#!/usr/bin/env node
// `stam prune` (src/deploy.ts prune, S-735) against a throwaway STAM_HOME with fake releases: keeps the five newest,
// `current`, `previous`, and any release a process runs from; removes the rest. Past a few pinned releases
// beyond those, it asks the daemon to reload the MCP server of each idle agent that pins one (only a harness
// with a reload — not Claude Code), and drops the compile-cache entries older than a day (S-756). No daemon,
// no network.
// Run with `node --test test/deploy-prune.test.mjs`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const home = mkdtempSync(join(tmpdir(), 'stam-prune-test-'));
const started = [];
after(() => {
  for (const p of started) try { process.kill(p, 'SIGKILL'); } catch {}
  rmSync(home, { recursive: true, force: true });
});

const R = join(home, 'releases');
mkdirSync(R, { recursive: true });
// Its own cache, so a test never sweeps the machine's (src/deploy.ts reads NODE_COMPILE_CACHE).
const CACHE = join(home, 'compile-cache');
const env = (extra = {}) => ({ ...process.env, STAM_HOME: home, NODE_COMPILE_CACHE: CACHE, ...extra });
// r01 is the oldest. r02 is `previous`, r03 has a process running from it, r12 is `current` (not the newest).
const names = Array.from({ length: 13 }, (_, i) => `r${String(i + 1).padStart(2, '0')}`);
names.forEach((n, i) => {
  mkdirSync(join(R, n, 'bin'), { recursive: true });
  writeFileSync(join(R, n, '.release.json'), JSON.stringify({ release: n, commit: n, subject: n, repo: '', built_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), deps: [] }));
});
symlinkSync('r12', join(R, 'current'));
symlinkSync('r02', join(R, 'previous'));

test('prune keeps the newest five, current, previous, and releases a process runs from', () => {
  const held = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3e5)', join(R, 'r03', 'bin', 'stam')], { stdio: 'ignore' });
  started.push(held.pid);
  const r = spawnSync(process.execPath, [join(ROOT, 'src/cli.ts'), 'prune'], { env: env(), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const kept = names.filter((n) => existsSync(join(R, n)));
  // newest five: r09-r13; plus current r12 (already in), previous r02, in use r03.
  assert.deepEqual(kept, ['r02', 'r03', 'r09', 'r10', 'r11', 'r12', 'r13']);
  assert.ok(existsSync(join(R, 'current', '.release.json')) && existsSync(join(R, 'previous', '.release.json')));
});

test('prune takes the deploy lock: it refuses while a deploy holds it', async () => {
  // This test process holds the deploy lock, as a running deploy would (S-1750).
  const { tryLock } = await import(join(ROOT, 'src/release-lock.ts'));
  const unlock = await tryLock(R);
  assert.ok(unlock);
  const r = spawnSync(process.execPath, [join(ROOT, 'src/cli.ts'), 'prune'], { env: env(), encoding: 'utf8' });
  await unlock();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, new RegExp(`another deploy is running \\(pid ${process.pid}\\)`));
});

test('prune drops a release once nothing runs from it', () => {
  for (const p of started) try { process.kill(p, 'SIGKILL'); } catch {}
  const p = spawnSync(process.execPath, [join(ROOT, 'src/cli.ts'), 'prune'], { env: env(), encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
  assert.equal(existsSync(join(R, 'r03')), false);
  assert.ok(existsSync(join(R, 'r02')), 'previous stays');
});

test('prune reloads idle agents that can reload, leaves busy and Claude ones, and sweeps the compile cache', async () => {
  // A cache entry older than a day goes; a fresh one stays. A version directory that is unreadable,
  // one that vanished, and one with a subdirectory are skipped rather than failing the prune; one
  // left empty is removed without recursing.
  mkdirSync(join(CACHE, 'v-test'), { recursive: true });
  writeFileSync(join(CACHE, 'v-test', 'old'), 'x');
  writeFileSync(join(CACHE, 'v-test', 'fresh'), 'x');
  mkdirSync(join(CACHE, 'v-empty'), { recursive: true });
  writeFileSync(join(CACHE, 'v-empty', 'old'), 'x');
  mkdirSync(join(CACHE, 'v-nested', 'sub'), { recursive: true });
  const unreadable = join(CACHE, 'v-unreadable');
  mkdirSync(unreadable, { recursive: true });
  writeFileSync(join(unreadable, 'entry'), 'x');
  chmodSync(unreadable, 0o000);
  symlinkSync(join(home, 'gone'), join(CACHE, 'v-vanished'));
  const twoDays = (Date.now() - 2 * 24 * 3600 * 1000) / 1000;
  for (const f of [join(CACHE, 'v-test', 'old'), join(CACHE, 'v-empty', 'old')]) utimesSync(f, twoDays, twoDays);

  // Four releases pinned beyond what prune keeps (past MAX_SPARE_PINS): three agents and a plain
  // process. Only the idle Codex agent is asked to reload; a busy one, and a Claude one (no reload
  // without a restart), are left alone.
  const pinned = [
    ['r04', 'idlecx'],
    ['r05', 'busycx'],
    ['r06', 'idlecl'],
    ['r07', undefined],
  ];
  const procs = pinned.map(([rel, id]) => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3e5)', join(R, rel, 'bin', 'stam')], { stdio: 'ignore', env: env(id ? { STAM_AGENT_ID: id } : {}) }));
  started.push(...procs.map((p) => p.pid));

  const seen = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push(`${req.method} ${req.url}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(req.method === 'GET'
        ? JSON.stringify([
          { id: 'idlecx', harness: 'codex', activity: 'idle', lifecycle: 'active' },
          { id: 'busycx', harness: 'codex', activity: 'working', lifecycle: 'active' },
          { id: 'idlecl', harness: 'claude', activity: 'idle', lifecycle: 'active' },
        ])
        : '{"result":"reconnect requested"}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  const child = spawn(process.execPath, [join(ROOT, 'src/cli.ts'), 'prune'], {
    env: env({ STAM_URL: `http://127.0.0.1:${server.address().port}`, STAM_TOKEN: 'test' }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (c) => (err += c));
  const code = await new Promise((r) => child.on('close', r));
  server.close();
  for (const p of procs) try { process.kill(p.pid, 'SIGKILL'); } catch {}
  chmodSync(unreadable, 0o700); // let the cleanup walk it

  assert.equal(code, 0, err);
  assert.deepEqual(seen.filter((s) => s.startsWith('POST')), ['POST /api/agents/idlecx/reconnect-mcp'], 'only the idle Codex agent is asked to reload');
  assert.equal(existsSync(join(CACHE, 'v-test', 'old')), false, 'the old cache entry goes');
  assert.equal(existsSync(join(CACHE, 'v-test', 'fresh')), true, 'the fresh cache entry stays');
  assert.equal(existsSync(join(CACHE, 'v-empty')), false, 'a version dir left empty is removed');
  assert.equal(existsSync(join(unreadable, 'entry')), true, 'an unreadable version dir is skipped, not failed');
  assert.ok(readdirSync(CACHE).includes('v-vanished'), 'a version dir that vanished is skipped, not failed');
  assert.equal(existsSync(join(CACHE, 'v-nested', 'sub')), true, 'a version dir with a subdirectory is left whole');
});

test('prune keeps deps keys a release names or a worktree used within the window (S-1044)', () => {
  const D = join(home, 'deps');
  const days = (n) => (Date.now() - n * 24 * 3600 * 1000) / 1000;
  // r99 is the newest release, so prune keeps it, and it names one key.
  mkdirSync(join(R, 'r99', 'bin'), { recursive: true });
  writeFileSync(join(R, 'r99', '.release.json'), JSON.stringify({ release: 'r99', commit: 'r99', subject: 'r99', repo: '', built_at: new Date().toISOString(), deps: ['named'] }));
  for (const name of ['named', 'recent', 'old', 'unused', 'filling.tmp-abc', 'orphan.tmp-xyz', 'named.damaged-123']) mkdirSync(join(D, name), { recursive: true });
  writeFileSync(join(D, 'recent', '.used'), 'x');
  writeFileSync(join(D, 'old', '.used'), 'x');
  utimesSync(join(D, 'recent', '.used'), days(1), days(1));
  utimesSync(join(D, 'old', '.used'), days(10), days(10));
  utimesSync(join(D, 'orphan.tmp-xyz'), days(2), days(2));
  const r = spawnSync(process.execPath, [join(ROOT, 'src/cli.ts'), 'prune'], { env: env(), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(D, 'named')), 'a key the newest release names stays');
  assert.ok(existsSync(join(D, 'recent')), 'a key used yesterday stays');
  assert.equal(existsSync(join(D, 'old')), false, 'a key used ten days ago goes');
  assert.equal(existsSync(join(D, 'unused')), false, 'a key never used goes');
  assert.ok(existsSync(join(D, 'filling.tmp-abc')), 'a fill in progress is left alone');
  assert.equal(existsSync(join(D, 'orphan.tmp-xyz')), false, 'a tmp folder from a stopped fill goes after a day');
  assert.equal(existsSync(join(D, 'named.damaged-123')), false, 'a cache moved aside as damaged goes at any age');
});
