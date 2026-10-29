import './scrub-env.mjs';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { goBinDir, withGoBinArgv } from '../src/env.ts';

// S-3666: a harness's shell gets ~/.local/go/bin first on its PATH when the agent's HOME has that directory, so a bare `go` works.
const home = mkdtempSync(join(tmpdir(), 'stam-go-path-'));
const bin = join(home, '.local/go/bin');
after(() => rmSync(home, { recursive: true, force: true }));

// The PATH a shell running `argv` (through withGoBinArgv) sees, from a shell that starts with `path`.
function shellPath(argv, path) {
  const [file, ...args] = withGoBinArgv(argv, goBinDir(home));
  return execFileSync(file, args, { env: { PATH: path }, encoding: 'utf8' });
}
const printPath = ['sh', '-c', 'printf %s "$PATH"'];

test('goBinDir is the bin dir only when HOME has it as a directory', () => {
  assert.equal(goBinDir(undefined), undefined);
  assert.equal(goBinDir(''), undefined);
  const plain = mkdtempSync(join(tmpdir(), 'stam-go-path-plain-'));
  try {
    assert.equal(goBinDir(plain), undefined);
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
  mkdirSync(bin, { recursive: true });
  assert.equal(goBinDir(home), bin);
  const file = mkdtempSync(join(tmpdir(), 'stam-go-path-file-'));
  try {
    mkdirSync(join(file, '.local/go'), { recursive: true });
    writeFileSync(join(file, '.local/go/bin'), 'not a dir');
    assert.equal(goBinDir(file), undefined, 'a file is not the bin dir');
  } finally {
    rmSync(file, { recursive: true, force: true });
  }
});

test('argv without a bin dir is unchanged', () => {
  assert.deepEqual(withGoBinArgv(printPath, undefined), printPath);
});

test('the bin dir goes first on the shell PATH, and every other dir stays in order', () => {
  mkdirSync(bin, { recursive: true });
  assert.equal(shellPath(printPath, '/opt/marker:/usr/local/sbin:/usr/bin:/bin'), `${bin}:/opt/marker:/usr/local/sbin:/usr/bin:/bin`);
});

test('a bin dir already on the shell PATH is not added again', () => {
  mkdirSync(bin, { recursive: true });
  assert.equal(shellPath(printPath, `/usr/bin:${bin}:/bin`), `/usr/bin:${bin}:/bin`);
});
