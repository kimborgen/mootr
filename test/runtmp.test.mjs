#!/usr/bin/env node
// Checks the run's own TMPDIR (S-2586): scripts/test-slot.sh makes one under the worktree when the caller set none,
// removes it when the command ends, keeps an explicit TMPDIR, and leaves a parent's folder alone in a nested call;
// a command that makes temp folders leaves nothing in the system /tmp. No daemon, no model.
// Run with `node --test test/runtmp.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, mkdirSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tempDir } from './tmphome.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const slot = join(root, 'scripts', 'test-slot.sh');
const slots = tempDir('stam-runtmp-slots-');

const run = (args, env = {}) => {
  const e = { ...process.env, STAM_TEST_SLOT_DIR: slots, STAM_TEST_SLOTS: '1', ...env };
  delete e.STAM_TEST_SLOT_HELD;
  delete e.STAM_TEST_NOSLOT;
  if (!('TMPDIR' in env)) delete e.TMPDIR;
  return spawnSync('sh', [slot, ...args], { encoding: 'utf8', env: e });
};

test('a run without TMPDIR gets one under the worktree and it is removed after', () => {
  const r = run(['sh', '-c', 'echo "$TMPDIR"; [ -d "$TMPDIR" ]']);
  assert.equal(r.status, 0, r.stderr);
  const dir = r.stdout.trim();
  assert.ok(dir.startsWith(join(root, '.tmp') + '/'), `${dir} is not under ${root}/.tmp`);
  assert.equal(existsSync(dir), false, `${dir} survived the run`);
});

test('the exit status passes through and the folder is removed', () => {
  const r = run(['sh', '-c', 'echo "$TMPDIR"; exit 3']);
  assert.equal(r.status, 3);
  assert.equal(existsSync(r.stdout.trim()), false);
});

test('an explicit TMPDIR is kept and not removed', () => {
  const mine = tempDir('stam-runtmp-mine-');
  const r = run(['sh', '-c', 'echo "$TMPDIR"'], { TMPDIR: mine });
  assert.equal(r.stdout.trim(), mine);
  assert.equal(existsSync(mine), true);
});

test('a nested call keeps the parent TMPDIR and does not delete it', () => {
  const inner = `${slot} sh -c 'echo "$TMPDIR"'`;
  const r = run(['sh', '-c', `echo "$TMPDIR"; ${`STAM_TEST_SLOT_DIR=${slots} STAM_TEST_SLOTS=1 sh ${inner}`}; [ -d "$TMPDIR" ] && echo alive`]);
  const [outer, nested, alive] = r.stdout.trim().split('\n');
  assert.equal(nested, outer, r.stderr);
  assert.equal(alive, 'alive');
  assert.equal(existsSync(outer), false);
});

test('temp folders a run makes leave no new entry in the system tmpdir', () => {
  mkdirSync(join(root, '.tmp'), { recursive: true });
  const probe = 'stam-runtmp-probe-';
  const entries = () => readdirSync('/tmp').filter((n) => n.startsWith(probe));
  const before = entries();
  const r = run(['node', '-e', `const fs=require('fs'),os=require('os'),p=require('path');fs.mkdtempSync(p.join(os.tmpdir(),${JSON.stringify(probe)}));`]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(entries(), before);
});

test('the run folder leaves room for a unix socket path (108 bytes)', (t) => {
  // A sibling of the worktree can be deeper than any run folder could allow; only a normal-length root is judged.
  if (root.length > 70) return t.skip(`worktree path is ${root.length} bytes`);
  const r = run(['sh', '-c', 'echo "$TMPDIR"']);
  const dir = r.stdout.trim();
  assert.ok(dir.length + '/stam-sock-0000/agent.sock'.length < 108, `${dir} (${dir.length} bytes) is too long for a socket`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  test(`${sig} to the run stops the command, removes the folder and frees the slot`, async () => {
    const work = tempDir('stam-runtmp-sig-');
    const script = 'echo "$TMPDIR" >"$1/tmp"; echo $$ >"$1/pid"; exec sleep 60';
    const env = { ...process.env, STAM_TEST_SLOT_DIR: slots, STAM_TEST_SLOTS: '1' };
    delete env.TMPDIR; delete env.STAM_TEST_SLOT_HELD; delete env.STAM_TEST_NOSLOT;
    // setsid: the run leads its own group, as under a terminal, so the signal reaches the command too.
    const p = spawn('setsid', ['sh', slot, 'sh', '-c', script, 'x', work], { env, stdio: 'ignore' });
    const closed = new Promise((res) => p.on('close', res));
    for (let i = 0; i < 100 && !existsSync(join(work, 'pid')); i++) await new Promise((r) => setTimeout(r, 100));
    const dir = readFileSync(join(work, 'tmp'), 'utf8').trim();
    const pid = Number(readFileSync(join(work, 'pid'), 'utf8'));
    assert.equal(existsSync(dir), true);
    process.kill(-p.pid, sig);
    await closed;
    // flock, the run's parent, dies at once on SIGTERM; the shell below it finishes its cleanup a moment later.
    for (let i = 0; i < 100 && existsSync(dir); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(existsSync(dir), false, `${dir} survived ${sig}`);
    assert.throws(() => process.kill(pid, 0), 'the command outlived the run');
    const again = spawnSync('timeout', ['10', 'sh', slot, 'true'], { env, encoding: 'utf8' });
    assert.equal(again.status, 0, 'the slot was not freed');
  });
}
