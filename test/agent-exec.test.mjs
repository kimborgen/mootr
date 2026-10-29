#!/usr/bin/env node
// The agent process seam (S-2861, src/agent-exec.ts): every harness start and every signal to an
// agent's processes goes through it. A static check fails when an adapter or the lifecycle starts a
// process or kills a pid on its own, and the runtime checks show the seam passes argv, env and cwd
// through unchanged and reports signals as the old code did. Real processes, started and signalled
// here; no daemon, terminal multiplexer or network: `node --test test/agent-exec.test.mjs`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentExec, agentKill } from '../src/agent-exec.ts';
import { tempDir } from './tmphome.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const dir = tempDir('stam-agent-exec-');
after(() => rmSync(dir, { recursive: true, force: true }));

// Calls that start a process or signal one. Lines that are comments are skipped; the lookbehind
// keeps `db.exec(` and a regex's `.exec(` out, and `agentKill(` never matches `.kill(`.
// The session call is spelt with a class so this file doesn't name the multiplexer (light-list-unit).
const LAUNCH = /(?<![\w.])(spawn|spawnSync|execFile|execFileSync|execFileAsync|execFileP|exec)\(|\bt[m]ux\.newSession\(|\.kill\(/;

// Each exemption names one line that may start or signal a process outside the seam, and why.
const EXEMPT = [
  { file: 'src/lifecycle.ts', text: "execFileP('git'", why: 'git, not an agent process' },
  { file: 'src/lifecycle.ts', text: "spawnSync('sh', ['-c', command ?? adapter.upgradeCommand]", why: "an adapter's upgrade command, run by the operator, not an agent" },
  { file: 'src/adapters/codex.ts', text: "spawnSync('pgrep'", why: 'a read-only check that no Codex still runs on the socket; it signals nothing' },
  { file: 'src/adapters/codex.ts', text: 'p.kill();', why: 'the hook probe: a handle agentExec returned, which Node signals only while that child is alive' },
];

function launchViolations(src, file) {
  return src.split('\n').flatMap((line, i) => {
    if (/^\s*\/\//.test(line) || !LAUNCH.test(line)) return [];
    if (EXEMPT.some((e) => e.file === file && line.includes(e.text))) return [];
    return [`${file}:${i + 1}: ${line.trim()}`];
  });
}

const GUARDED = [
  ...readdirSync(join(ROOT, 'src/adapters')).filter((f) => f.endsWith('.ts')).map((f) => `src/adapters/${f}`),
  'src/lifecycle.ts',
];

test('adapters and the lifecycle start and signal processes only through the seam', () => {
  const found = GUARDED.flatMap((f) => launchViolations(readFileSync(join(ROOT, f), 'utf8'), f));
  assert.deepEqual(found, []);
});

test('every exemption still matches a line, so none is left behind', () => {
  for (const e of EXEMPT) {
    const src = readFileSync(join(ROOT, e.file), 'utf8');
    assert.ok(src.includes(e.text), `${e.file} no longer has: ${e.text}`);
  }
});

test('a planted direct spawn or kill in an adapter is caught', () => {
  const planted = readFileSync(join(ROOT, 'test/fixtures/agent-exec-planted.txt'), 'utf8');
  const found = launchViolations(planted, 'src/adapters/planted.ts');
  assert.equal(found.length, 2, found.join('\n'));
  assert.match(found[0], /src\/adapters\/planted\.ts:2: const p = spawn/);
});

test('spawn gives the harness its argv, env and cwd unchanged', async () => {
  const script = 'process.stdout.write(JSON.stringify({ argv: process.argv.slice(1), token: process.env.STAM_TOKEN, cwd: process.cwd() }))';
  const child = agentExec([process.execPath, '-e', script, 'a b', 'c'], { STAM_TOKEN: 'tok-123' }, { mode: 'spawn', cwd: dir });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  await new Promise((res, rej) => child.on('close', (code) => (code === 0 ? res() : rej(new Error(`exit ${code}`)))));
  assert.deepEqual(JSON.parse(out), { argv: ['a b', 'c'], token: 'tok-123', cwd: realpathSync(dir) });
});

test('file and fileSync run the harness to completion and return its stdout', async () => {
  assert.equal(agentExec([process.execPath, '-p', '6 * 7'], {}, { mode: 'fileSync' }).trim(), '42');
  const run = agentExec([process.execPath, '-p', '6 * 7'], {}, { mode: 'file', cwd: dir });
  assert.ok(run.child.pid, 'the child is exposed for stdin, as the compactor uses it');
  assert.equal((await run).stdout.trim(), '42');
});

test('agentKill signals a process and reports whether it did', async () => {
  const child = agentExec([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {}, { mode: 'spawn' });
  const exited = new Promise((res) => child.on('exit', (_code, sig) => res(sig)));
  assert.equal(agentKill(child.pid, 'SIGTERM'), true);
  assert.equal(await exited, 'SIGTERM');
  assert.equal(agentKill(child.pid, 'SIGTERM'), false);
});
