#!/usr/bin/env node
// The default home and service name (S-3347, S-4335): a real ~/.local/share/stam, else mootr; stamd when
// stamd.service is a regular file, else mootrd when it exists. Every test sets an explicit HOME, never the live one.
// Free: `node --test test/default-home.test.mjs`.
import './scrub-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tempDir } from './tmphome.mjs';
import { DEFAULT_HOME_SH, defaultHome, defaultService, lockHome } from '../src/default-home.ts';
import { serviceRunsReleasesText } from '../src/deploy.ts';

const ROOT = join(import.meta.dirname, '..');
const isRoot = process.getuid?.() === 0;

function userHome(prefix) {
  const u = tempDir(prefix);
  mkdirSync(join(u, '.local', 'share'), { recursive: true });
  return u;
}
const share = (u, name) => join(u, '.local', 'share', name);

// One table of folder layouts, run against the Node function, the shell function and Go's config.DefaultHome (through
// TestDefaultHomeFromTable in go/internal/config/home_test.go). Each layout builds ~/.local/share under a throwaway HOME.
const LAYOUTS = [
  ['neither folder: a fresh install', () => {}, 'mootr'],
  ['only stam', (s) => mkdirSync(join(s, 'stam')), 'stam'],
  ['only mootr', (s) => mkdirSync(join(s, 'mootr')), 'mootr'],
  ['stam as a symlink to mootr', (s) => { mkdirSync(join(s, 'mootr')); symlinkSync('mootr', join(s, 'stam')); }, 'mootr'],
  ['both real folders: a stray mootr never takes over', (s) => { mkdirSync(join(s, 'mootr')); mkdirSync(join(s, 'stam')); }, 'stam'],
  ['a dangling mootr link', (s) => symlinkSync('nowhere', join(s, 'mootr')), 'mootr'],
  ['a dangling stam link, real mootr', (s) => { mkdirSync(join(s, 'mootr')); symlinkSync('nowhere', join(s, 'stam')); }, 'mootr'],
  ['a dangling stam link alone', (s) => symlinkSync('nowhere', join(s, 'stam')), 'mootr'],
  ['stam a symlink to a folder elsewhere', (s) => { mkdirSync(join(s, 'elsewhere')); symlinkSync('elsewhere', join(s, 'stam')); }, 'mootr'],
  ['stam a regular file', (s) => writeFileSync(join(s, 'stam'), ''), 'mootr'],
];
const layout = (name, build) => {
  const u = userHome(`dh-${name.replace(/\W+/g, '-').slice(0, 12)}-`);
  build(join(u, '.local', 'share'));
  return u;
};
const run = (u) => sh(u, `. "${ROOT}/scripts/default-home.sh"; default_home`);

for (const [name, build, want] of LAYOUTS) {
  test(`default home, ${name}: ${want} (Node)`, () => {
    const u = layout(name, build);
    assert.equal(defaultHome(u), share(u, want));
  });
  test(`default home, ${name}: ${want} (shell)`, () => {
    const u = layout(name, build);
    const r = run(u);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), share(u, want));
  });
}

// An unreadable ~/.local/share: lstat on the stam path fails with EACCES. Without the not-found check every
// implementation would answer mootr, moving an existing stam install it couldn't see.
const unreadable = (withMootr) => {
  const u = userHome('dh-eacces-');
  if (withMootr) mkdirSync(share(u, 'mootr'));
  chmodSync(join(u, '.local', 'share'), 0o000);
  return u;
};
const readable = (u) => chmodSync(join(u, '.local', 'share'), 0o755);

const goBin = spawnSync('go', ['version']).status === 0;
test('default home, every layout and an unreadable share folder (Go)', { skip: !goBin && 'no go on PATH' }, () => {
  const cases = LAYOUTS.map(([name, build, want]) => { const u = layout(name, build); return [name, u, share(u, want)]; });
  const bad = isRoot ? [] : [unreadable(false), unreadable(true)];
  try {
    for (const u of bad) cases.push(['unreadable share folder', u, '']);
    const r = spawnSync('go', ['test', '-count=1', '-run', '^TestDefaultHomeFromTable$', '-v', './internal/config/'], {
      cwd: join(ROOT, 'go'), env: { ...process.env, DEFAULT_HOME_CASES: JSON.stringify(cases) }, encoding: 'utf8', timeout: 300_000,
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /--- PASS: TestDefaultHomeFromTable/, 'the Go test ran, not skipped');
  } finally {
    bad.forEach(readable);
  }
});

test('an error other than not-found on the stam path is thrown, never mootr (Node and shell)', { skip: isRoot }, () => {
  for (const withMootr of [false, true]) {
    const u = unreadable(withMootr);
    try {
      assert.throws(() => defaultHome(u), /can't inspect/);
      const r = run(u);
      assert.notEqual(r.status, 0);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, /default home:/);
    } finally {
      readable(u);
    }
  }
});

test('both real folders warn once in Node and on every call in shell', () => {
  const u = layout('both warn', LAYOUTS[4][1]);
  assert.match(run(u).stderr, /both real folders/);
});

test('the service: stamd alone, a regular stamd beside a staged mootrd, an alias symlink to mootrd, mootrd alone', () => {
  const layout = (build) => { const d = tempDir('dh-unit-'); build(d); return defaultService(d); };
  assert.equal(layout(() => {}), 'stamd', 'no unit');
  assert.equal(layout((d) => writeFileSync(join(d, 'stamd.service'), '')), 'stamd', 'stamd only');
  assert.equal(layout((d) => { writeFileSync(join(d, 'stamd.service'), ''); writeFileSync(join(d, 'mootrd.service'), ''); }), 'stamd', 'a staged mootrd never takes over the live stamd');
  assert.equal(layout((d) => { writeFileSync(join(d, 'mootrd.service'), ''); symlinkSync('mootrd.service', join(d, 'stamd.service')); }), 'mootrd', 'after the move, stamd.service is the alias');
  assert.equal(layout((d) => writeFileSync(join(d, 'mootrd.service'), '')), 'mootrd', 'mootrd only');
  assert.equal(layout((d) => symlinkSync('nowhere', join(d, 'mootrd.service'))), 'stamd', 'a dangling mootrd link');
});

test('an unreadable unit dir is an error, not stamd', { skip: isRoot }, () => {
  const dir = tempDir('dh-unit-eacces-');
  const sub = join(dir, 'units');
  mkdirSync(sub);
  writeFileSync(join(sub, 'mootrd.service'), '');
  chmodSync(sub, 0o000);
  try {
    assert.throws(() => defaultService(sub), /can't inspect/);
  } finally {
    chmodSync(sub, 0o755);
  }
});

test('serviceRunsReleases accepts either home spelling', () => {
  const unit = (home) => `[Service]\nExecStart=${home}/releases/current/bin/stamd\n`;
  for (const [releases, text] of [
    ['/h/.local/share/stam/releases', unit('/h/.local/share/stam')],
    ['/h/.local/share/stam/releases', unit('/h/.local/share/mootr')],
    ['/h/.local/share/mootr/releases', unit('/h/.local/share/stam')],
    ['/h/.local/share/mootr/releases', unit('/h/.local/share/mootr')],
  ]) assert.equal(serviceRunsReleasesText(text, releases), true, `${releases} ${text}`);
  assert.equal(serviceRunsReleasesText(unit('/elsewhere/checkout'), '/h/.local/share/stam/releases'), false);
});

function sh(home, script, env = {}) {
  return spawnSync('sh', ['-c', script], { env: { PATH: process.env.PATH, HOME: home, ...env }, encoding: 'utf8' });
}

test('scripts/default-home.sh holds DEFAULT_HOME_SH', () => {
  assert.ok(readFileSync(join(ROOT, 'scripts/default-home.sh'), 'utf8').includes(DEFAULT_HOME_SH));
});

// These scripts aren't in the export: the tests that read them skip there.
const has = (f) => existsSync(join(ROOT, f));

test('the scripts that run over ssh inline the helper text verbatim', () => {
  for (const f of ['scripts/storage-checkout-guard.sh', 'scripts/ensure-deps.sh']) {
    if (!has(f)) continue;
    assert.ok(readFileSync(join(ROOT, f), 'utf8').includes(DEFAULT_HOME_SH), `${f} inlines default_home`);
  }
});

test('config.ts resolves mootr unless stam is a real folder, and an explicit home wins MOOTR_HOME first', () => {
  const read = (u, env = {}) => {
    const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `import { STAM_HOME, DEFAULT_STAM_HOME } from ${JSON.stringify(join(ROOT, 'src/config.ts'))}; console.log(STAM_HOME + '|' + DEFAULT_STAM_HOME)`],
      { env: { PATH: process.env.PATH, HOME: u, ...env }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim().split('|');
  };
  const fresh = userHome('dh-cfg-fresh-');
  assert.deepEqual(read(fresh), [share(fresh, 'mootr'), share(fresh, 'mootr')], 'a fresh install gets mootr');
  const pre = userHome('dh-cfg-pre-');
  mkdirSync(share(pre, 'stam'));
  assert.deepEqual(read(pre), [share(pre, 'stam'), share(pre, 'stam')]);
  const post = userHome('dh-cfg-post-');
  mkdirSync(share(post, 'mootr'));
  symlinkSync('mootr', share(post, 'stam'));
  assert.deepEqual(read(post), [share(post, 'mootr'), share(post, 'mootr')]);
  assert.equal(read(post, { STAM_HOME: '/explicit/stam' })[0], '/explicit/stam');
  assert.equal(read(post, { STAM_HOME: '/explicit/stam', MOOTR_HOME: '/explicit/mootr' })[0], '/explicit/mootr');
  const both = userHome('dh-cfg-both-');
  mkdirSync(share(both, 'stam'));
  mkdirSync(share(both, 'mootr'));
  assert.equal(read(both)[0], share(both, 'stam'), 'a stray mootr folder never takes over a real stam home');
  if (isRoot) return;
  // An explicit home never inspects the default: an EACCES there doesn't break it.
  const bad = userHome('dh-cfg-bad-');
  mkdirSync(share(bad, 'mootr'));
  chmodSync(join(bad, '.local', 'share'), 0o000);
  try {
    assert.equal(read(bad, { STAM_HOME: '/explicit/stam' })[0], '/explicit/stam');
  } finally {
    chmodSync(join(bad, '.local', 'share'), 0o755);
  }
});

test('the storage probe reads the mootr token when storage has a mootr folder, and the stam token before', { skip: !has('scripts/deploy-on-merge.mjs') }, async () => {
  const { config } = await import('../scripts/deploy-on-merge.mjs');
  const run = (setup) => {
    const dir = tempDir('dh-probe-');
    const home = join(dir, 'remote-home');
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    setup(home);
    writeFileSync(join(bin, 'curl'), `#!/bin/sh\ncat > "${dir}/curl-config"\nprintf '{}\\n200 0.01\\n'\n`);
    chmodSync(join(bin, 'curl'), 0o755);
    const b64 = /echo (\S+) \| base64/.exec(config({ STAM_HOME: dir }).cmd.storageHealth)[1];
    const script = Buffer.from(b64, 'base64').toString();
    const r = sh(home, script, { PATH: `${bin}:${process.env.PATH}` });
    assert.equal(r.status, 0, r.stderr);
    return readFileSync(join(dir, 'curl-config'), 'utf8');
  };
  const put = (home, name, token) => {
    mkdirSync(join(home, '.local/share', name), { recursive: true });
    writeFileSync(join(home, '.local/share', name, 'token'), token);
  };
  assert.match(run((h) => put(h, 'stam', 'OLD\n')), /Bearer OLD/);
  assert.match(run((h) => { put(h, 'mootr', 'NEW\n'); symlinkSync('mootr', join(h, '.local/share/stam')); }), /Bearer NEW/);
});

test('bin/stam-fast is valid shell', () => {
  assert.equal(spawnSync('sh', ['-n', join(ROOT, 'bin/stam-fast')]).status, 0);
});

test('a release takes its capabilities from the target tree, never from the CLI that builds it', async () => {
  const { releaseCapabilities } = await import('../src/deploy.ts');
  const older = tempDir('dh-cap-old-');
  assert.deepEqual(releaseCapabilities(older), [], 'an older ref has no capabilities.json, so a newer CLI writes no marker');
  const fixed = tempDir('dh-cap-new-');
  writeFileSync(join(fixed, 'capabilities.json'), '["mootr-deploy-names"]\n');
  assert.deepEqual(releaseCapabilities(fixed), ['mootr-deploy-names']);
  writeFileSync(join(older, 'capabilities.json'), 'not json');
  assert.deepEqual(releaseCapabilities(older), []);
  assert.deepEqual(JSON.parse(readFileSync(join(ROOT, 'capabilities.json'), 'utf8')), ['mootr-deploy-names', 'mootr-suite-names'], 'this tree is the fixed ref');
  assert.match(readFileSync(join(ROOT, 'src/deploy.ts'), 'utf8'), /capabilities: releaseCapabilities\(dir\),\n\s+\};\n\s+writeFileSync\(join\(dir, '\.release\.json'\)/);
});

// dash exits on a `.` of a missing file even behind `||` (S-3347 review): stam-fast under sh falls back to the node CLI.
test('bin/stam-fast under sh uses the default home, and a missing helper falls back to the node CLI', { skip: !has('bin/stam-fast') }, () => {
  const u = userHome('dh-fast-');
  mkdirSync(share(u, 'mootr'));
  writeFileSync(join(share(u, 'mootr'), 'token'), 'MOOTR-TOKEN\n');
  const bin = tempDir('dh-fast-bin-');
  writeFileSync(join(bin, 'curl'), `#!/bin/sh\necho "$@" > "${bin}/curl-argv"\nprintf '{}'\n`);
  chmodSync(join(bin, 'curl'), 0o755);
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: u, STAM_AGENT_ID: 'a1' };
  const r = spawnSync('sh', [join(ROOT, 'bin/stam-fast'), 'hook', 'claude'], { env, input: '{}', encoding: 'utf8', timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(join(bin, 'curl-argv'), 'utf8'), /Bearer MOOTR-TOKEN/);
  // A copy of stam-fast with no scripts/default-home.sh beside it: it must reach node_cli, not die inside `.`.
  const copy = tempDir('dh-fast-copy-');
  mkdirSync(join(copy, 'bin'));
  writeFileSync(join(copy, 'bin/stam-fast'), readFileSync(join(ROOT, 'bin/stam-fast'), 'utf8'));
  writeFileSync(join(copy, 'bin/node'), '#!/bin/sh\necho NODE-CLI\n');
  chmodSync(join(copy, 'bin/node'), 0o755);
  const r2 = spawnSync('sh', [join(copy, 'bin/stam-fast'), 'hook', 'claude'], { env: { ...env, PATH: `${join(copy, 'bin')}:${env.PATH}` }, input: '{}', encoding: 'utf8', timeout: 20_000 });
  assert.match(r2.stdout, /NODE-CLI/);
});

// The coordination locks older code still running also takes stay at the legacy stam path while it exists (a real folder or the
// post-move symlink), so old and new workers lock one file. On a mootr-only HOME they use mootr and never create a real stam
// entry, which would flip the home rule (S-3347 review).
test('gate.lock and full-suite.lock: legacy stam path when it exists, mootr on a mootr-only HOME, and no stam entry is made', { skip: !has('scripts/gate.mjs') || !has('scripts/full-suite.mjs') }, () => {
  const locks = (u) => {
    const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
      const { lockFile } = await import(${JSON.stringify(join(ROOT, 'scripts/gate.mjs'))});
      const { config } = await import(${JSON.stringify(join(ROOT, 'scripts/full-suite.mjs'))});
      const { lockHome } = await import(${JSON.stringify(join(ROOT, 'src/default-home.ts'))});
      console.log(JSON.stringify([lockFile({}), config({}).lock, lockHome()]));`], { env: { PATH: process.env.PATH, HOME: u }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const only = userHome('dh-lock-only-');
  mkdirSync(share(only, 'mootr'));
  const [gate, suite, home] = locks(only);
  assert.deepEqual([gate, suite, home], [join(share(only, 'mootr'), 'gate.lock'), join(share(only, 'mootr'), 'full-suite.lock'), share(only, 'mootr')]);
  // Taking a lock creates its folder: with the path in mootr, no stam entry appears and the home rule still says mootr.
  mkdirSync(dirname(gate), { recursive: true });
  mkdirSync(dirname(suite), { recursive: true });
  assert.equal(existsSync(share(only, 'stam')), false);
  assert.equal(defaultHome(only), share(only, 'mootr'));
  const moved = userHome('dh-lock-moved-');
  mkdirSync(share(moved, 'mootr'));
  symlinkSync('mootr', share(moved, 'stam'));
  assert.deepEqual(locks(moved), [join(share(moved, 'stam'), 'gate.lock'), join(share(moved, 'stam'), 'full-suite.lock'), share(moved, 'stam')]);
  const before = userHome('dh-lock-before-');
  mkdirSync(share(before, 'stam'));
  assert.equal(locks(before)[0], join(share(before, 'stam'), 'gate.lock'));
  // Any entry named stam counts: both folders real, a regular file, and a dangling link all keep the lock at the stam path.
  const both = userHome('dh-lock-both-');
  mkdirSync(share(both, 'stam'));
  mkdirSync(share(both, 'mootr'));
  assert.equal(lockHome(both), share(both, 'stam'));
  const file = userHome('dh-lock-file-');
  mkdirSync(share(file, 'mootr'));
  writeFileSync(share(file, 'stam'), '');
  assert.equal(lockHome(file), share(file, 'stam'));
  const dangling = userHome('dh-lock-dangling-');
  mkdirSync(share(dangling, 'mootr'));
  symlinkSync('gone', share(dangling, 'stam'));
  assert.equal(lockHome(dangling), share(dangling, 'stam'));
});

test('daemon start, stop and restart fail on an unreadable unit dir, not fall into the unmanaged daemon path', { skip: isRoot }, () => {
  const u = userHome('dh-cli-');
  const systemd = join(u, '.config', 'systemd');
  mkdirSync(join(systemd, 'user'), { recursive: true });
  chmodSync(systemd, 0o000);
  try {
    for (const sub of ['start', 'stop', 'restart']) {
      const r = spawnSync(process.execPath, ['--no-warnings', join(ROOT, 'src/cli.ts'), 'daemon', sub], { env: { PATH: process.env.PATH, HOME: u }, encoding: 'utf8', timeout: 20_000 });
      assert.notEqual(r.status, 0, `${sub}: ${r.stdout}`);
      assert.match(r.stderr, /can't inspect/, sub);
    }
    assert.equal(existsSync(join(u, '.local', 'share', 'stam', 'daemon.pid')), false);
  } finally {
    chmodSync(systemd, 0o755);
  }
});

test('activate leaves current and previous unchanged when the service can\'t be inspected', { skip: isRoot }, () => {
  const u = userHome('dh-act-');
  const home = join(u, 'data');
  mkdirSync(join(home, 'releases', 'aaa'), { recursive: true });
  mkdirSync(join(home, 'releases', 'bbb'));
  mkdirSync(join(home, 'releases', 'ccc'));
  symlinkSync('aaa', join(home, 'releases', 'current'));
  symlinkSync('ccc', join(home, 'releases', 'previous'));
  const systemd = join(u, '.config', 'systemd');
  mkdirSync(join(systemd, 'user'), { recursive: true });
  chmodSync(systemd, 0o000);
  try {
    const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
      const d = await import(${JSON.stringify(join(ROOT, 'src/deploy.ts'))});
      try { await d.activate('bbb'); console.log('no error'); } catch (e) { console.log(e.message); }`], { env: { PATH: process.env.PATH, HOME: u, STAM_HOME: home }, encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /can't inspect/);
    assert.equal(readlinkSync(join(home, 'releases', 'current')), 'aaa');
    assert.equal(readlinkSync(join(home, 'releases', 'previous')), 'ccc');
  } finally {
    chmodSync(systemd, 0o755);
  }
});

test('an unreadable unit dir doesn\'t crash the import of deploy.ts, and checkService fails closed', { skip: isRoot }, () => {
  const u = userHome('dh-svc-');
  const units = join(u, '.config', 'systemd', 'user');
  mkdirSync(units, { recursive: true });
  writeFileSync(join(units, 'mootrd.service'), '');
  chmodSync(join(u, '.config', 'systemd'), 0o000);
  try {
    const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
      const d = await import(${JSON.stringify(join(ROOT, 'src/deploy.ts'))});
      let msg = 'no error';
      try { d.checkService(); } catch (e) { msg = e.message; }
      console.log(d.SERVICE + '|' + msg);`], { env: { PATH: process.env.PATH, HOME: u, STAM_HOME: join(u, 'home') }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^stamd\|can't inspect/);
  } finally {
    chmodSync(join(u, '.config', 'systemd'), 0o755);
  }
});
