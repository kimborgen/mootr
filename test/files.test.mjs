#!/usr/bin/env node
// The Files API's local half (S-1525): roots, `..` and symlink escape, the deny list, the type sniff,
// Range, and the 5 MB text cap. Throwaway HOME and STAM_HOME, no daemon: `node --test test/files.test.mjs`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tempHome, tempDir } from './tmphome.mjs';

const stamHome = tempHome('stam-files-');
const home = tempDir('stam-files-home-');
process.env.STAM_HOME = stamHome;
process.env.HOME = home;
const proj = join(home, 'projects');
const outside = join(home, 'elsewhere');
const worktrees = join(stamHome, 'worktrees');
const wt = join(worktrees, 'app-dev');
let files, roots, server, base;

before(async () => {
  files = await import('../src/files.ts');
  mkdirSync(join(proj, 'app', '.ssh'), { recursive: true });
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  mkdirSync(join(stamHome, 'attachments', 'm1'), { recursive: true });
  writeFileSync(join(proj, 'app', 'a.txt'), 'hello world');
  writeFileSync(join(proj, 'app', '.env'), 'SECRET=1');
  writeFileSync(join(proj, 'app', '.env.local'), 'SECRET=2');
  writeFileSync(join(proj, 'app', 'server.pem'), 'k');
  writeFileSync(join(proj, 'app', 'id.key'), 'k');
  writeFileSync(join(proj, 'app', '.ssh', 'id_rsa'), 'k');
  writeFileSync(join(proj, 'app', '.netrc'), 'k');
  writeFileSync(join(proj, 'app', '.git-credentials'), 'k');
  writeFileSync(join(proj, 'app', 'bin.dat'), Buffer.from([1, 2, 0, 3, 255]));
  writeFileSync(join(proj, 'app', 'noext'), 'plain text with no extension\n');
  writeFileSync(join(proj, 'app', 'fake.txt'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]));
  writeFileSync(join(proj, 'app', 'big.txt'), 'x'.repeat(files.TEXT_CAP + 100));
  writeFileSync(join(outside, 'secret.txt'), 'nope');
  writeFileSync(join(home, '.claude', '.credentials.json'), '{}');
  writeFileSync(join(stamHome, 'token'), 'tok');
  writeFileSync(join(stamHome, 'peer-token'), 'ptok');
  writeFileSync(join(stamHome, 'attachments', 'm1', 'doc.md'), '# doc');
  symlinkSync(outside, join(proj, 'app', 'out'));
  symlinkSync(join(outside, 'secret.txt'), join(proj, 'app', 'link.txt'));
  symlinkSync(join(proj, 'app', '.env'), join(proj, 'app', 'envlink.txt'));
  // A linked git worktree of the checkout, where the agents' trees live (S-2101).
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main', join(proj, 'app'));
  git('-C', join(proj, 'app'), 'add', '-A');
  git('-C', join(proj, 'app'), 'commit', '-q', '-m', 'one');
  mkdirSync(worktrees, { recursive: true });
  git('-C', join(proj, 'app'), 'worktree', 'add', '-q', '-b', 'dev', wt);
  writeFileSync(join(wt, 'wt.txt'), 'worktree file');
  writeFileSync(join(wt, '.env'), 'SECRET=WT');
  roots = files.realRoots([proj, join(stamHome, 'attachments'), worktrees]);
  server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    try {
      files.serve(req, res, files.resolveIn(u.searchParams.get('path'), roots), u.searchParams.get('all') === '1', roots);
    } catch (e) {
      res.writeHead(e.status ?? 500);
      res.end(String(e.message));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  server.unref();
});

const code = (p) => {
  try {
    files.resolveIn(p, roots);
    return 200;
  } catch (e) {
    return e.status;
  }
};
const get = (p, headers = {}, q = '') => fetch(`${base}/?path=${encodeURIComponent(p)}${q}`, { headers });

test('the default roots are ~/projects, the mail attachments and the worktrees', () => {
  assert.deepEqual(roots.map((r) => r.replace(/^.*\//, '')), ['projects', 'attachments', 'worktrees']);
  assert.equal(files.realRoots(['/nonexistent-root']).length, 0);
  assert.equal(files.realRoots([outside]).length, 1);
});

test('a root that is the home folder or contains it is dropped', () => {
  assert.equal(files.realRoots([home]).length, 0);
  assert.equal(files.realRoots([join(home, '..')]).length, 0);
  assert.equal(files.realRoots(['/']).length, 0);
  assert.equal(files.realRoots([proj]).length, 1);
});

test('a path inside a root resolves; one outside, relative, or with .. does not', () => {
  assert.equal(code(join(proj, 'app', 'a.txt')), 200);
  assert.equal(code(join(stamHome, 'attachments', 'm1', 'doc.md')), 200);
  assert.equal(code(outside), 403);
  assert.equal(code(`${proj}/app/../../elsewhere/secret.txt`), 403);
  assert.equal(code(`${proj}/../.claude/.credentials.json`), 403);
  assert.equal(code('app/a.txt'), 400);
  assert.equal(code(join(proj, 'missing')), 404);
});

test('a symlink out of a root is refused, to a folder or a file', () => {
  assert.equal(code(join(proj, 'app', 'out')), 403);
  assert.equal(code(join(proj, 'app', 'out', 'secret.txt')), 403);
  assert.equal(code(join(proj, 'app', 'link.txt')), 403);
});

test('the deny list holds inside a root, also through a link', () => {
  for (const n of ['.env', '.env.local', 'server.pem', 'id.key', '.ssh/id_rsa', '.netrc', '.git-credentials', 'envlink.txt']) assert.equal(code(join(proj, 'app', n)), 403, n);
  assert.equal(files.denied(join(home, '.claude', '.credentials.json')), true);
  assert.equal(files.denied(join(home, '.claude-work', 'x')), true);
  assert.equal(files.denied(join(home, '.codex', 'auth.json')), true);
  assert.equal(files.denied(join(home, '.CLAUDE', 'x')), true);
  assert.equal(files.denied(join(proj, 'app', '.ENV')), true);
  assert.equal(files.denied(join(proj, 'app', 'Server.PEM')), true);
  for (const p of ['.config/gh/hosts.yml', '.config/upctl.yaml', '.local/share/opencode/auth.json', '.aws/credentials', '.docker/config.json', '.npmrc', '.gnupg/pubring.kbx', '.bash_history', '.zsh_history']) assert.equal(files.denied(join(home, p)), true, p);
  assert.equal(files.denied(join(proj, 'app', 'id_ed25519')), true);
  assert.equal(files.denied(join(proj, 'app', 'id_rsa.pub')), false);
  assert.equal(files.denied(join(home, '.config', 'other', 'x')), false);
  assert.equal(files.denied(join(stamHome, 'token')), true);
  assert.equal(files.denied(join(stamHome, 'peer-token')), true);
  assert.equal(files.denied(join(stamHome, 'attachments', 'm1', 'doc.md')), false);
  assert.equal(files.denied(join(proj, 'app', 'a.txt')), false);
});

test('a file in a worktree reads, and the deny list still holds inside it', async () => {
  assert.equal(code(join(wt, 'wt.txt')), 200);
  assert.equal(await (await get(join(wt, 'wt.txt'))).text(), 'worktree file');
  assert.equal(code(join(wt, '.env')), 403);
  assert.equal(code(join(wt, 'server.pem')), 403);
  assert.equal(files.denied(join(wt, 'wt.txt')), false);
  assert.equal(files.denied(join(wt, '.env')), true);
  // Another folder in STAM_HOME (a token, say) stays shut.
  assert.equal(code(join(stamHome, 'token')), 403);
});

test('a symlink into or out of a worktree follows the same roots and deny rules', async () => {
  // A link from the checkout into a worktree file reads: its target is in a root.
  symlinkSync(join(wt, 'wt.txt'), join(proj, 'app', 'into-wt.txt'));
  assert.equal(code(join(proj, 'app', 'into-wt.txt')), 200);
  assert.equal(await (await get(join(proj, 'app', 'into-wt.txt'))).text(), 'worktree file');
  // A link in the worktree to the checkout's .env is denied at its target.
  symlinkSync(join(proj, 'app', '.env'), join(wt, 'wt-env-link.txt'));
  assert.equal(code(join(wt, 'wt-env-link.txt')), 403);
  // A link in the worktree to a STAM_HOME folder outside the roots (a token) stays shut.
  symlinkSync(join(stamHome, 'token'), join(wt, 'tokenlink'));
  assert.equal(code(join(wt, 'tokenlink')), 403);
});

test('a listing has name, kind, size and mtime, and leaves out denied entries', () => {
  const entries = files.listDir(files.resolveIn(join(proj, 'app'), roots));
  const names = entries.map((e) => e.name);
  assert.ok(names.includes('a.txt') && names.includes('out') && names.includes('bin.dat'));
  for (const n of ['.env', '.env.local', 'server.pem', 'id.key', '.netrc', '.git-credentials', '.ssh']) assert.ok(!names.includes(n), n);
  const a = entries.find((e) => e.name === 'a.txt');
  assert.equal(a.kind, 'file');
  assert.equal(a.size, 11);
  assert.ok(a.mtime > 0);
  assert.equal(entries.find((e) => e.name === 'out').kind, 'symlink');
  assert.deepEqual(files.listRoots(roots).roots.map((r) => r.name), ['projects', 'attachments', 'worktrees']);
});

test('a file is served with the safe headers and a type by extension and sniff', async () => {
  const r = await get(join(proj, 'app', 'a.txt'));
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'hello world');
  assert.equal(r.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.match(r.headers.get('content-security-policy'), /^default-src 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('cache-control'), 'private');
  assert.equal((await get(join(proj, 'app', 'noext'))).headers.get('content-type'), 'text/plain; charset=utf-8');
  const bin = await get(join(proj, 'app', 'bin.dat'));
  assert.equal(bin.headers.get('content-type'), 'application/octet-stream');
  assert.match(bin.headers.get('content-disposition'), /^attachment/);
  // A .txt holding PNG bytes isn't served as text.
  assert.equal((await get(join(proj, 'app', 'fake.txt'))).headers.get('content-type'), 'image/png');
});

test('Range gives 206 with the bytes asked for, and 416 past the end', async () => {
  const p = join(proj, 'app', 'a.txt');
  const r = await get(p, { range: 'bytes=0-4' });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 0-4/11');
  assert.equal(await r.text(), 'hello');
  assert.equal(await (await get(p, { range: 'bytes=-5' })).text(), 'world');
  assert.equal((await get(p, { range: 'bytes=50-' })).status, 416);
});

test('text over 5 MB is cut at 5 MB unless all=1; Range on it still works', async () => {
  const p = join(proj, 'app', 'big.txt');
  const cut = await get(p);
  assert.equal(cut.headers.get('x-stam-truncated'), '1');
  assert.equal((await cut.arrayBuffer()).byteLength, files.TEXT_CAP);
  const full = await get(p, {}, '&all=1');
  assert.equal(full.headers.get('x-stam-truncated'), null);
  assert.equal((await full.arrayBuffer()).byteLength, files.TEXT_CAP + 100);
  assert.equal((await (await get(p, { range: `bytes=${files.TEXT_CAP}-` })).arrayBuffer()).byteLength, 100);
});

test('a FIFO is refused with 400 and does not block', async () => {
  const fifo = join(proj, 'app', 'pipe');
  execFileSync('mkfifo', [fifo]);
  const r = await get(fifo);
  assert.equal(r.status, 400);
});
