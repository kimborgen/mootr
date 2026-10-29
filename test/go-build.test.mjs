// go/build.sh (S-4076): each binary is built to a temp file and renamed into place, so a failed or half-done build never
// leaves a broken go/bin/stamd for a run starting a daemon from it. Runs against a stub `go` on PATH, so it needs no Go.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from './tmphome.mjs';

const BUILD = new URL('../go/build.sh', import.meta.url).pathname;

// A copy of go/build.sh in a fresh tree with an old go/bin/stamd and go/bin/stam, and a stub `go` (`go build -o OUT PKG`)
// running STUB with $out and $pkg set.
function setup(stub) {
  const root = tempDir('go-build-');
  mkdirSync(join(root, 'go/bin'), { recursive: true });
  copyFileSync(BUILD, join(root, 'go/build.sh'));
  writeFileSync(join(root, 'go', 'bin', 'stamd'), 'old stamd');
  writeFileSync(join(root, 'go', 'bin', 'stam'), 'old stam');
  mkdirSync(join(root, 'path'));
  writeFileSync(join(root, 'path/go'), `#!/bin/sh\nout=$3; pkg=$4\n${stub}`);
  chmodSync(join(root, 'path/go'), 0o755);
  return {
    script: join(root, 'go/build.sh'),
    env: { ...process.env, PATH: `${join(root, 'path')}:${process.env.PATH}` },
    bin: (n) => readFileSync(join(root, 'go/bin', n), 'utf8'),
    files: () => readdirSync(join(root, 'go/bin')).sort(),
  };
}

// A build whose stub writes PARTIAL to its -o file, then fails for the package FAILPKG and writes the others in full.
function tree(failPkg) {
  const t = setup(`printf 'PARTIAL' >"$out"\n[ "$pkg" = "${failPkg}" ] && exit 1\nprintf 'new %s' "\${pkg##*/}" >"$out"\n`);
  const r = spawnSync('sh', [t.script], { env: t.env, encoding: 'utf8' });
  return { r, bin: t.bin, files: t.files() };
}

test('a build renames each new binary into place and leaves no temp file', () => {
  const { r, bin, files } = tree('none');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(bin('stamd'), 'new stamd');
  assert.equal(bin('stam'), 'new stam');
  assert.deepEqual(files, ['stam', 'stamd']);
});

test('a failed build fails, keeps the old binaries whole, and leaves no temp file', () => {
  for (const pkg of ['./cmd/stamd', './cmd/stam']) {
    const { r, bin, files } = tree(pkg);
    assert.notEqual(r.status, 0, `${pkg}: the build should fail`);
    assert.equal(bin('stamd'), 'old stamd', pkg);
    assert.equal(bin('stam'), 'old stam', pkg);
    assert.deepEqual(files, ['stam', 'stamd'], pkg);
  }
});

test('a build cancelled by TERM, HUP or INT exits nonzero, keeps the old binaries whole, and leaves no temp file', async () => {
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) {
    // stamd builds in full; stam writes part of its file, says so, and hangs until the signal reaches the whole group, as when
    // test/run.sh times out or the nightly is cancelled.
    const t = setup(`[ "$pkg" = ./cmd/stamd ] && { printf 'new stamd' >"$out"; exit 0; }\nprintf 'PARTIAL' >"$out"\necho written\nexec sleep 600\n`);
    const child = spawn('sh', [t.script], { env: t.env, detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
    const done = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
    await new Promise((resolve) => child.stdout.on('data', (d) => String(d).includes('written') && resolve()));
    process.kill(-child.pid, sig);
    const { code, signal } = await done;
    assert.ok(code !== 0 || signal, `${sig}: the build should fail`);
    assert.equal(t.bin('stamd'), 'old stamd', sig);
    assert.equal(t.bin('stam'), 'old stam', sig);
    assert.deepEqual(t.files(), ['stam', 'stamd'], sig);
  }
});
