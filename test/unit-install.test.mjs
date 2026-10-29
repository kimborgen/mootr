#!/usr/bin/env node
// The mootrd unit and the mootr-* timer unit names (S-3349, P5 of S-2890): mootrd.service with Alias=stamd.service and both
// node variables, a stamd.service moved aside, and callers that start whichever of mootr-*/stam-* is installed. Nothing here
// calls the real systemctl: the stop is a fake, and the scripts get a unit dir of their own. One install runs against the shared
// fake systemd (test/fake-systemd.mjs), which models enable's wants and Alias= symlinks and what runs after a restart.
// Free: `node --test test/unit-install.test.mjs`.
import './scrub-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tempDir } from './tmphome.mjs';
import { fakeSystemd } from './fake-systemd.mjs';
import { installUnitFile, isRegularUnit, migrateUnit, serviceToInstall, unitText } from '../src/unit.ts';
import { installService } from '../src/service-install.ts';
import { defaultService } from '../src/default-home.ts';
import { releaseCapabilities } from '../src/deploy.ts';
import { hasUnit, homePath, installedUnit, unitScript, unitToInstall } from '../scripts/unit-names.mjs';

const ROOT = join(import.meta.dirname, '..');
const isRoot = process.getuid?.() === 0;
const opts = { dir: '/h/releases/current', node: '/n/node', path: '/p', env: '', log: '/h/daemon.log' };

test('a unit with an alias carries Alias=stamd.service, and both node variables', () => {
  const t = unitText({ ...opts, alias: 'stamd.service' });
  assert.match(t, /^Alias=stamd\.service$/m);
  assert.match(t, /^Environment="MOOTR_NODE=\/n\/node"$/m);
  assert.match(t, /^Environment="STAM_NODE=\/n\/node"$/m);
  assert.match(t, /^StandardOutput=append:\/h\/daemon\.log$/m);
  assert.ok(t.indexOf('[Install]') < t.indexOf('Alias='), 'the alias is in [Install]');
  assert.ok(!/^Alias=/m.test(unitText(opts)), 'no alias unless asked');
});

test('migrateUnit adds MOOTR_NODE to a unit that has only STAM_NODE, and leaves one with both alone', () => {
  const only = unitText(opts).replace(/^Environment="MOOTR_NODE=.*\n/m, '');
  assert.ok(!only.includes('MOOTR_NODE'));
  const next = migrateUnit(only, opts.dir);
  assert.match(next, /^Environment="MOOTR_NODE=\/n\/node"\nEnvironment="STAM_NODE=\/n\/node"$/m);
  assert.equal(migrateUnit(next, opts.dir), undefined);
});

test('migrateUnit copies an escaped STAM_NODE value verbatim into MOOTR_NODE: no second escaping of %, quotes or backslashes', () => {
  for (const node of ['/n/100%/node', '/n/q"uote/node', '/n/back\\slash/node']) {
    const t = unitText({ ...opts, node }).replace(/^Environment="MOOTR_NODE=.*\n/m, '');
    const next = migrateUnit(t, opts.dir);
    const line = (k) => next.split('\n').find((l) => l.startsWith(`Environment="${k}_NODE=`)).replace(/^Environment="[A-Z]+_NODE=/, '');
    assert.equal(line('MOOTR'), line('STAM'), node);
    assert.equal(migrateUnit(next, opts.dir), undefined);
  }
});

test('a live stamd.service is left alone without replace: nothing is staged, stopped or moved', () => {
  const dir = tempDir('ui-keep-');
  writeFileSync(join(dir, 'stamd.service'), 'OLD\n');
  const r = installUnitFile(dir, 'mootrd', 'NEW\n', { stop: () => assert.fail('stopped') });
  assert.equal(r, 'kept');
  assert.ok(!existsSync(join(dir, 'mootrd.service')), 'no mootrd.service with legacy-home paths is staged');
  assert.equal(readFileSync(join(dir, 'stamd.service'), 'utf8'), 'OLD\n');
  assert.ok(!existsSync(join(dir, 'stamd.service.pre-mootr')));
});

test('the default install refreshes stamd.service as stamd (no alias, no mootrd), and isRegularUnit tells the cases apart', () => {
  const dir = tempDir('ui-refresh-');
  assert.equal(isRegularUnit(dir, 'stamd'), false);
  writeFileSync(join(dir, 'stamd.service'), 'OLD\n');
  assert.equal(isRegularUnit(dir, 'stamd'), true);
  assert.equal(installUnitFile(dir, 'stamd', unitText(opts)), 'none');
  const t = readFileSync(join(dir, 'stamd.service'), 'utf8');
  assert.match(t, /^Environment="STAM_NODE=\/n\/node"$/m);
  assert.ok(!/^Alias=/m.test(t) && !existsSync(join(dir, 'mootrd.service')));
  assert.equal(defaultService(dir), 'stamd');
  const link = tempDir('ui-refresh-link-');
  symlinkSync('mootrd.service', join(link, 'stamd.service'));
  assert.equal(isRegularUnit(link, 'stamd'), false, 'an alias link is not the live unit file');
});

test('with replace, the daemon is stopped through the fake first, then mootrd.service is written and stamd.service moved aside', () => {
  const dir = tempDir('ui-aside-');
  writeFileSync(join(dir, 'stamd.service'), 'OLD\n');
  const stopped = [];
  const r = installUnitFile(dir, 'mootrd', 'NEW\n', { replace: true, stop: (s) => { stopped.push([s, existsSync(join(dir, 'mootrd.service'))]); return true; } });
  assert.equal(r, 'moved');
  assert.deepEqual(stopped, [['stamd', false]], 'the daemon is stopped before anything is written');
  assert.equal(readFileSync(join(dir, 'mootrd.service'), 'utf8'), 'NEW\n');
  assert.ok(!existsSync(join(dir, 'stamd.service')), 'no regular file is left for the alias to land on');
  assert.equal(readFileSync(join(dir, 'stamd.service.pre-mootr'), 'utf8'), 'OLD\n');
});

test('with no stamd.service, or an alias link to mootrd, nothing is stopped or moved, replace or not', () => {
  for (const replace of [false, true]) {
    const stop = () => assert.fail('stopped');
    const a = tempDir('ui-fresh-');
    assert.equal(installUnitFile(a, 'mootrd', 'NEW\n', { replace, stop }), 'none');
    const b = tempDir('ui-link-');
    symlinkSync('mootrd.service', join(b, 'stamd.service'));
    assert.equal(installUnitFile(b, 'mootrd', 'NEW\n', { replace, stop }), 'none');
    assert.equal(readlinkSync(join(b, 'stamd.service')), 'mootrd.service');
    const c = tempDir('ui-test-unit-');
    writeFileSync(join(c, 'stamd.service'), 'OLD\n');
    assert.equal(installUnitFile(c, 'stamd-test-x', 'T\n', { replace, stop }), 'none');
    assert.ok(lstatSync(join(c, 'stamd.service')).isFile(), 'another unit name leaves stamd.service alone');
  }
});

test('with replace, a failed or unreadable stop aborts: nothing is written or moved, and the error says so', () => {
  for (const stop of [() => false, () => undefined, () => { throw new Error('systemctl missing'); }]) {
    const dir = tempDir('ui-stopfail-');
    writeFileSync(join(dir, 'stamd.service'), 'OLD\n');
    assert.throws(() => installUnitFile(dir, 'mootrd', 'NEW\n', { replace: true, stop }), /couldn't stop stamd|systemctl missing/);
    assert.equal(readFileSync(join(dir, 'stamd.service'), 'utf8'), 'OLD\n');
    assert.ok(!existsSync(join(dir, 'mootrd.service')) && !existsSync(join(dir, 'stamd.service.pre-mootr')));
  }
});

test('with replace, a write that fails after the stop starts stamd again and rethrows', { skip: isRoot }, () => {
  const dir = tempDir('ui-restart-');
  writeFileSync(join(dir, 'stamd.service'), 'OLD\n');
  const started = [];
  const stop = () => { chmodSync(dir, 0o500); return true; };
  try {
    assert.throws(() => installUnitFile(dir, 'mootrd', 'NEW\n', { replace: true, stop, start: (s) => started.push(s) }));
  } finally {
    chmodSync(dir, 0o755);
  }
  assert.deepEqual(started, ['stamd']);
  assert.equal(readFileSync(join(dir, 'stamd.service'), 'utf8'), 'OLD\n');
});

test('an unreadable unit dir is an error, never "no stamd.service"', { skip: isRoot }, () => {
  const dir = tempDir('ui-eacces-');
  const sub = join(dir, 'units');
  mkdirSync(sub);
  writeFileSync(join(sub, 'stamd.service'), 'OLD\n');
  chmodSync(sub, 0o000);
  try {
    assert.throws(() => installUnitFile(sub, 'mootrd', 'NEW\n', { replace: true }), /can't inspect/);
    assert.throws(() => hasUnit(sub, 'mootr-full-suite'), /can't inspect/);
    assert.throws(() => installedUnit(sub, 'full-suite'), /can't inspect/);
  } finally {
    chmodSync(sub, 0o755);
  }
  assert.ok(!existsSync(join(sub, 'mootrd.service')), 'nothing was written');
});

test('callers pick mootr-NAME when installed, else stam-NAME; a machine with only stam-* units is unchanged', () => {
  const dir = tempDir('ui-pick-');
  assert.equal(installedUnit(dir, 'full-suite'), 'stam-full-suite');
  for (const n of ['deploy-watch', 'full-suite', 'go-parity', 'sweep-test-homes']) writeFileSync(join(dir, `stam-${n}.service`), '');
  for (const n of ['deploy-watch', 'full-suite', 'go-parity', 'sweep-test-homes']) assert.equal(installedUnit(dir, n), `stam-${n}`);
  writeFileSync(join(dir, 'mootr-full-suite.service'), '');
  assert.equal(installedUnit(dir, 'full-suite'), 'mootr-full-suite');
  assert.equal(installedUnit(dir, 'go-parity'), 'stam-go-parity', 'one unit moved, the others did not');
});

const legacy = '/u/.local/share/stam';
const mootr = '/u/.local/share/mootr';

test('--install names follow the home: stam-NAME under a real stam home, mootr-NAME under a mootr one', () => {
  const dir = tempDir('ui-name-');
  assert.equal(unitToInstall(dir, 'go-parity', legacy), 'stam-go-parity', 'a clean dir under the stam home still gets the legacy name');
  assert.equal(unitToInstall(dir, 'go-parity', mootr), 'mootr-go-parity');
  writeFileSync(join(dir, 'stam-go-parity.timer'), '');
  assert.equal(unitToInstall(dir, 'go-parity', mootr), 'stam-go-parity', 'a stam timer installed keeps its name, so the job never runs twice');
  writeFileSync(join(dir, 'mootr-go-parity.service'), '');
  assert.equal(unitToInstall(dir, 'go-parity', mootr), 'mootr-go-parity');
  assert.throws(() => unitToInstall(dir, 'go-parity', legacy), /finish the move/, 'a mootr unit beside the stam home is an unfinished move');
});

test('a mootr home maps the stam folder\'s script paths to its own, and a stam home leaves them', () => {
  assert.equal(homePath(`${legacy}/releases/abc/scripts/x.mjs`, mootr), `${mootr}/releases/abc/scripts/x.mjs`);
  assert.equal(homePath('/elsewhere/x.mjs', mootr), '/elsewhere/x.mjs');
  assert.equal(homePath(`${legacy}/releases/abc/x.mjs`, legacy), `${legacy}/releases/abc/x.mjs`);
});

test('a unit runs the home\'s releases/current, never a releases/<sha> path, and a checkout path stays', () => {
  const home = join(tempDir('ui-script-'), '.local', 'share', 'mootr');
  mkdirSync(home, { recursive: true });
  const sha = join(dirname(home), 'stam', 'releases', 'abc123', 'scripts', 'x.mjs');
  const want = join(home, 'releases', 'current', 'scripts', 'x.mjs');
  assert.equal(unitScript(home, 'scripts/x.mjs', sha), want, 'no current yet: the sha path becomes current, under the mootr home');
  mkdirSync(join(home, 'releases', 'current', 'scripts'), { recursive: true });
  writeFileSync(want, '');
  assert.equal(unitScript(home, 'scripts/x.mjs', sha), want);
  assert.equal(unitScript(legacy, 'scripts/x.mjs', `${legacy}/releases/abc123/scripts/x.mjs`), `${legacy}/releases/current/scripts/x.mjs`, 'a stam home pins nothing either');
  assert.equal(unitScript(legacy, 'scripts/x.mjs', '/work/stam2/scripts/x.mjs'), '/work/stam2/scripts/x.mjs', 'a checkout path is kept');
});

test('a stam path that is the post-move symlink to mootr is the mootr home: names, and the paths under it', () => {
  const share = join(tempDir('ui-link-home-'), '.local', 'share');
  mkdirSync(join(share, 'mootr', 'releases', 'current', 'scripts'), { recursive: true });
  symlinkSync('mootr', join(share, 'stam'));
  const dir = tempDir('ui-link-units-');
  assert.equal(unitToInstall(dir, 'full-suite', join(share, 'stam')), 'mootr-full-suite');
  writeFileSync(join(share, 'mootr', 'releases', 'current', 'scripts', 'x.mjs'), '');
  assert.equal(unitScript(join(share, 'stam'), 'scripts/x.mjs', '/x'), join(share, 'mootr', 'releases', 'current', 'scripts', 'x.mjs'));
  assert.equal(homePath(join(share, 'stam', 'releases', 'abc', 'x.mjs'), join(share, 'stam')), join(share, 'mootr', 'releases', 'abc', 'x.mjs'));
  assert.equal(unitToInstall(dir, 'full-suite', join(share, 'nothing-there', 'stam')), 'stam-full-suite', 'a home that doesn\'t exist is as named');
});

// The whole `stam daemon install` sequence, with a fake systemctl: nothing here runs the real one.
function install(over = {}) {
  const dir = join(tempDir('ui-svc-'), 'units');
  const calls = [];
  const logs = [];
  const deps = {
    unitDir: dir, home: mootr, replace: false,
    text: (service) => unitText({ ...opts, alias: service === 'mootrd' ? 'stamd.service' : undefined }),
    systemctl: (...a) => { calls.push(a); return true; },
    checkService: () => {}, linger: () => calls.push(['linger']), killPidFile: () => calls.push(['kill']),
    healthy: async () => true, log: (l) => logs.push(l),
    ...over,
  };
  return { dir, calls, logs, run: () => installService(deps) };
}

test('daemon install on a machine with a live regular stamd.service refreshes it as stamd and writes no mootrd.service', async () => {
  const t = install({ home: legacy });
  mkdirSync(t.dir, { recursive: true });
  writeFileSync(join(t.dir, 'stamd.service'), 'OLD\n');
  assert.equal(await t.run(), 'stamd');
  const text = readFileSync(join(t.dir, 'stamd.service'), 'utf8');
  assert.match(text, /^Environment="STAM_NODE=\/n\/node"$/m);
  assert.ok(!/^Alias=/m.test(text) && !existsSync(join(t.dir, 'mootrd.service')), 'no alias, and nothing staged');
  assert.deepEqual(t.calls.filter((c) => c[0] !== 'linger' && c[0] !== 'kill'), [['daemon-reload'], ['enable', 'stamd'], ['restart', 'stamd']]);
  assert.equal(defaultService(t.dir), 'stamd');
});

test('daemon install on a clean machine writes mootrd.service with the alias', async () => {
  const t = install();
  assert.equal(await t.run(), 'mootrd');
  assert.match(readFileSync(join(t.dir, 'mootrd.service'), 'utf8'), /^Alias=stamd\.service$/m);
  assert.deepEqual(t.calls.filter((c) => c[0] === 'enable' || c[0] === 'restart'), [['enable', 'mootrd'], ['restart', 'mootrd']]);
});

test('daemon install on a real stam home with an empty unit dir writes stamd.service: no alias, no mootrd.service', async () => {
  const t = install({ home: legacy });
  assert.equal(await t.run(), 'stamd');
  const text = readFileSync(join(t.dir, 'stamd.service'), 'utf8');
  assert.ok(!/^Alias=/m.test(text), 'no alias');
  assert.deepEqual(readdirSync(t.dir), ['stamd.service']);
  assert.deepEqual(t.calls.filter((c) => c[0] === 'enable' || c[0] === 'restart'), [['enable', 'stamd'], ['restart', 'stamd']]);
  assert.equal(serviceToInstall(t.dir, false, legacy), 'stamd');
  assert.equal(serviceToInstall(tempDir('ui-svc-clean-'), false, mootr), 'mootrd');
});

test('--replace-stamd refuses on a real stam home: nothing written, stopped or moved', async () => {
  const t = install({ home: legacy, replace: true });
  mkdirSync(t.dir, { recursive: true });
  writeFileSync(join(t.dir, 'stamd.service'), 'OLD\n');
  await assert.rejects(t.run(), /mootr-move\.sh/);
  assert.deepEqual(t.calls, []);
  assert.deepEqual(readdirSync(t.dir), ['stamd.service']);
  assert.equal(readFileSync(join(t.dir, 'stamd.service'), 'utf8'), 'OLD\n');
});

test('--replace-stamd on a mootr home stops stamd, writes mootrd.service with the alias and moves the old unit aside', async () => {
  const t = install({ replace: true });
  mkdirSync(t.dir, { recursive: true });
  writeFileSync(join(t.dir, 'stamd.service'), 'OLD\n');
  assert.equal(await t.run(), 'mootrd');
  assert.deepEqual(t.calls[0], ['stop', 'stamd']);
  assert.match(readFileSync(join(t.dir, 'mootrd.service'), 'utf8'), /^Alias=stamd\.service$/m);
  assert.equal(readFileSync(join(t.dir, 'stamd.service.pre-mootr'), 'utf8'), 'OLD\n');
  assert.ok(!existsSync(join(t.dir, 'stamd.service')));
});

test('a failed stop with --replace-stamd mutates nothing: no write, no move, and nothing runs after the stop', async () => {
  const t = install({ replace: true });
  t.calls.length = 0;
  mkdirSync(t.dir, { recursive: true });
  writeFileSync(join(t.dir, 'stamd.service'), 'OLD\n');
  const failing = install({ replace: true, unitDir: t.dir, systemctl: (...a) => { t.calls.push(a); return false; } });
  await assert.rejects(failing.run(), /couldn't stop stamd/);
  assert.deepEqual(t.calls, [['stop', 'stamd']], 'only the stop ran: no linger, kill, reload, enable or restart');
  assert.deepEqual(readdirSync(t.dir), ['stamd.service']);
  assert.equal(readFileSync(join(t.dir, 'stamd.service'), 'utf8'), 'OLD\n');
});

test('--replace-stamd against the shared fake systemd: stamd stopped, mootrd enabled with the stamd.service alias and running the new unit', async () => {
  const sd = fakeSystemd(tempDir('ui-svc-fake-'));
  writeFileSync(join(sd.units, 'stamd.service'), unitText(opts));
  sd.enable('stamd.service');
  sd.start('stamd.service');
  const t = install({
    replace: true,
    unitDir: sd.units,
    systemctl: (...a) => sd.run(...a).status === 0,
    healthy: async () => sd.isActive('mootrd.service'),
  });
  assert.equal(await t.run(), 'mootrd');
  assert.equal(sd.state('stamd.service'), 'inactive', 'the old stamd unit was stopped');
  assert.equal(readlinkSync(join(sd.units, 'stamd.service')), 'mootrd.service', 'enable made the alias over the moved-aside file');
  assert.ok(sd.isActive('mootrd.service') && sd.isEnabled('mootrd.service'));
  assert.match(sd.runningConfig('mootrd.service'), /^Alias=stamd\.service$/m, 'the restart runs the unit just written');
  assert.equal(sd.run('is-enabled', 'stamd.service').stdout.trim(), 'alias');
  assert.ok(t.logs.some((l) => /installed as a user service .* and running/.test(l)), t.logs.join('\n'));
});

test('a checkService error runs no systemctl and writes nothing', async () => {
  const t = install({ checkService: () => { throw new Error("can't inspect the unit dir"); } });
  await assert.rejects(t.run(), /can't inspect/);
  assert.deepEqual(t.calls, []);
  assert.equal(existsSync(t.dir), false, 'not even the unit dir was made');
});

test('an unreadable unit dir is an error for the install name too', { skip: isRoot }, () => {
  const sub = join(tempDir('ui-name-eacces-'), 'units');
  mkdirSync(sub);
  chmodSync(sub, 0o000);
  try {
    assert.throws(() => unitToInstall(sub, 'full-suite', mootr), /can't inspect/);
  } finally {
    chmodSync(sub, 0o755);
  }
});

test('the committed capabilities.json lists mootr-suite-names', () => {
  assert.ok(releaseCapabilities(ROOT).includes('mootr-suite-names'));
  assert.ok(releaseCapabilities(ROOT).includes('mootr-deploy-names'));
});
