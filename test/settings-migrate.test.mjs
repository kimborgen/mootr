#!/usr/bin/env node
// `stam settings migrate` (S-404, S-380 change 4). Throwaway STAM_HOMEs, no daemon:
// `node --test test/settings-migrate.test.mjs`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome, tempDir } from './tmphome.mjs';

const home = tempHome('stam-settings-migrate-');
after(() => rmSync(home, { recursive: true, force: true }));
process.env.STAM_HOME = home;
process.env.STAM_MACHINE = 'peer-under-test';
process.env.STAM_TMUX_SOCKET = `settings-migrate-test-${process.pid}`;
const file = join(home, 'settings.json');
const backup = `${file}.pre-S380`;
const s = await import('../src/settings.ts');
const { runMigrate } = await import('../src/settings-migrate.ts');
const save = (o) => { writeFileSync(file, typeof o === 'string' ? o : JSON.stringify(o)); s.settingsChanged(); };
const cache = (settings) => s.writeSharedCache(JSON.stringify({ rev: 1, settings }));
const disk = () => JSON.parse(readFileSync(file, 'utf8'));
const backups = () => readdirSync(home).filter((f) => f.startsWith('settings.json.pre-S380')).sort();
const clean = () => { for (const f of backups()) rmSync(join(home, f)); rmSync(join(home, 'settings.shared.json'), { force: true }); };

const peerFile = () => ({
  home: 'home-under-test', peers: [{ name: 'home-under-test', url: 'http://x' }],
  itsa: { home: 'home-under-test', repos: { stam2: '/r' }, keyPrefix: 'Z' }, // deep local key next to a shared sibling
  resourceWarn: { lastWarned: 'yesterday', threshold: 3 },
  retro: { lastDigest: '2026-10-12', steward: { enabled: false } },
  debug: { stallMs: 5 },
  context: { warnTokens: 5 }, // same
  cost: { mode: 'local' }, // differs
  extra: { apiToken: 'peer-secret', note: 'mine', list: [{ token: 'hunter2' }, 'x'] }, // only here
  mcpServers: { srv: { command: 'c', args: ['--api-key', 'sekret-two', '--token=sekret-three', '--header', 'X-Id: sekret-five', '-H', 'Authorization: Bearer sekret-six', 'Authorization: Bearer sekret-seven', 'MY_KEY=sekret-eight', 'plain'], env: { A: 'sekret-four' } } },
  tags: ['a', 'b'],
});
const homeCache = () => ({ context: { warnTokens: 5 }, cost: { mode: 'shared' }, tags: ['a', 'b'], onlyOnHome: { x: 1 } });
const LOCAL_ONLY = () => ({
  home: 'home-under-test', peers: peerFile().peers, itsa: { home: 'home-under-test', repos: { stam2: '/r' } },
  resourceWarn: { lastWarned: 'yesterday' }, retro: { lastDigest: '2026-10-12' }, debug: { stallMs: 5 },
});

test('the home has nothing to migrate', () => {
  save({});
  const r = runMigrate(true);
  assert.equal(r.code, 0);
  assert.match(r.text, /this is the settings home .*nothing to migrate/);
  assert.equal(backups().length, 0);
});

test('a peer with no cache exits non-zero', () => {
  save({ home: 'home-under-test' });
  const r = runMigrate(false);
  assert.equal(r.code, 1);
  assert.match(r.text, /no shared settings cached yet from home-under-test/);
});

test('invalid JSON exits non-zero with the parse error, even when the memo says home', () => {
  save({});
  s.settings();
  save('{ nope');
  cache(homeCache());
  const r = runMigrate(true);
  assert.equal(r.code, 1);
  assert.match(r.text, /not valid JSON/);
  assert.equal(readFileSync(file, 'utf8'), '{ nope');
  assert.equal(backups().length, 0);
  clean();
});

test('dry run reports same, differs, only here, home-only; redacts everywhere; writes nothing', () => {
  save(peerFile());
  cache(homeCache());
  const before = readFileSync(file, 'utf8');
  const r = runMigrate(false);
  assert.equal(r.code, 0);
  assert.deepEqual(r.result.same.sort(), ['context.warnTokens', 'tags']);
  assert.deepEqual(r.result.differs, [{ path: 'cost.mode', here: 'local', home: 'shared' }]);
  const only = Object.fromEntries(r.result.onlyHere.map((x) => [x.path, x.here]));
  assert.equal(only['extra.apiToken'], s.REDACTED);
  assert.equal(only['extra.note'], 'mine');
  assert.equal(only['itsa.keyPrefix'], 'Z');
  assert.deepEqual(only['extra.list'], [{ token: s.REDACTED }, 'x']);
  assert.deepEqual(only['mcpServers.srv.args'], ['--api-key', s.REDACTED, `--token=${s.REDACTED}`, '--header', s.REDACTED, '-H', s.REDACTED, `Authorization: ${s.REDACTED}`, `MY_KEY=${s.REDACTED}`, 'plain']);
  assert.equal(only['mcpServers.srv.env.A'], s.REDACTED);
  assert.deepEqual(r.result.onlyHome, ['onlyOnHome.x']);
  for (const secret of ['peer-secret', 'hunter2', 'sekret']) assert.ok(!r.text.includes(secret) && !JSON.stringify(r.result).includes(secret), secret);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(backups().length, 0);
});

test('--apply backs up, strips to exactly the local keys, effective settings agree with the home', () => {
  save(peerFile());
  cache(homeCache());
  const before = readFileSync(file, 'utf8');
  const r = runMigrate(true);
  assert.equal(r.code, 0);
  assert.equal(readFileSync(backup, 'utf8'), before);
  assert.deepEqual(disk(), LOCAL_ONLY());
  s.settingsChanged();
  const after = s.settings();
  assert.equal(after.cost.mode, 'shared');
  assert.equal(after.context.warnTokens, 5);
  assert.deepEqual(after.itsa.repos, { stam2: '/r' });
  assert.equal(after.retro.lastDigest, '2026-10-12');
});

test('a second apply with new content keeps the first backup and adds a timestamped one', () => {
  const first = readFileSync(backup, 'utf8');
  save({ ...LOCAL_ONLY(), context: { warnTokens: 9 } });
  const r = runMigrate(true);
  assert.equal(r.code, 0);
  assert.equal(readFileSync(backup, 'utf8'), first);
  const extra = backups().filter((f) => f !== 'settings.json.pre-S380');
  assert.equal(extra.length, 1);
  assert.match(r.result.applied.backup, /\.pre-S380\./);
  assert.equal(JSON.parse(readFileSync(join(home, extra[0]), 'utf8')).context.warnTokens, 9);
  assert.deepEqual(disk(), LOCAL_ONLY());
  // Nothing left to remove: no further backup.
  assert.match(runMigrate(true).text, /nothing to remove/);
  assert.equal(backups().length, 2);
  clean();
});

test('an identical existing backup is reused and reported as already there', () => {
  save(peerFile());
  cache(homeCache());
  writeFileSync(backup, readFileSync(file, 'utf8'));
  const r = runMigrate(true);
  assert.match(r.text, /backup already at .*pre-S380\n/);
  assert.equal(backups().length, 1);
  clean();
});

test('effective settings are identical after apply when the peer matches the home', () => {
  save({ home: 'home-under-test', context: { warnTokens: 5 }, itsa: { repos: { a: '/a' } } });
  cache({ context: { warnTokens: 5 } });
  const before = JSON.stringify(s.settings());
  runMigrate(true);
  s.settingsChanged();
  assert.equal(JSON.stringify(s.settings()), before);
  clean();
});

test('ensureSettings after apply does not re-add shared keys', () => {
  save(peerFile());
  cache(homeCache());
  runMigrate(true);
  s.ensureSettings();
  // It may add local-key defaults (retro.lastDigest, ...), never a shared one.
  const d = disk();
  assert.equal(d.itsa.keyPrefix, undefined);
  for (const k of ['context', 'cost', 'agentTypes', 'tags', 'extra']) assert.equal(k in d, false, k);
  clean();
});

test('the cli: --json prints the structured, redacted result; --apply exits 0; no cache exits 1', () => {
  const h = tempDir('stam-settings-migrate-cli-');
  try {
    const env = { ...process.env, STAM_HOME: h, STAM_MACHINE: 'peer-under-test' };
    const run = (...args) => spawnSync(process.execPath, ['--no-warnings', 'src/cli.ts', 'settings', 'migrate', ...args], { env, encoding: 'utf8' });
    writeFileSync(join(h, 'settings.json'), JSON.stringify(peerFile()));
    assert.equal(run('--json').status, 1);
    writeFileSync(join(h, 'settings.shared.json'), JSON.stringify({ rev: 1, settings: homeCache() }));
    const j = run('--json');
    assert.equal(j.status, 0, j.stderr);
    const out = JSON.parse(j.stdout);
    assert.equal(out.home, 'home-under-test');
    assert.deepEqual(out.differs, [{ path: 'cost.mode', here: 'local', home: 'shared' }]);
    assert.ok(!j.stdout.includes('peer-secret'));
    assert.equal(JSON.parse(readFileSync(join(h, 'settings.json'), 'utf8')).context.warnTokens, 5);
    const a = run('--apply');
    assert.equal(a.status, 0, a.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(h, 'settings.json'), 'utf8')), LOCAL_ONLY());
    writeFileSync(join(h, 'settings.json'), '{ bad');
    const bad = run('--apply');
    assert.equal(bad.status, 1);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});
