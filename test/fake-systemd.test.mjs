#!/usr/bin/env node
// The shared fake systemctl and curl (test/fake-systemd.mjs, S-3382): one test per modelled behaviour, against a temp dir only.
// Run with `node --test test/fake-systemd.test.mjs`.
import './scrub-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmphome.mjs';
import { fakeSystemd } from './fake-systemd.mjs';

const work = tempDir('fake-systemd-test-');
let n = 0;
const DAEMON = '[Unit]\nDescription=d\n[Service]\nExecStart=/bin/d\n[Install]\nWantedBy=default.target\n';
const ALIASED = `${DAEMON}Alias=stamd.service\n`;
const ONESHOT = '[Service]\nType=oneshot\nExecStart=/bin/job\n';
const TIMER = '[Timer]\nOnCalendar=hourly\n[Install]\nWantedBy=timers.target\n';

function setup(files = {}) {
  const sd = fakeSystemd(join(work, `w${n++}`));
  for (const [f, body] of Object.entries(files)) writeFileSync(join(sd.units, f), body);
  return sd;
}
const isLink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const curl = (sd, path, args = ['-s', '-o', '/dev/null', '-w', '%{http_code}']) =>
  spawnSync(sd.curl, [...args, `http://127.0.0.1:7878${path}`], { env: { PATH: process.env.PATH, ...sd.env }, encoding: 'utf8', input: '' });

test('enable creates the wants symlink and each Alias= symlink; disable removes them', () => {
  const sd = setup({ 'mootrd.service': ALIASED });
  assert.equal(sd.run('enable', 'mootrd.service').status, 0);
  assert.ok(isLink(join(sd.units, 'default.target.wants/mootrd.service')));
  assert.equal(readlinkSync(join(sd.units, 'stamd.service')), 'mootrd.service', 'a relative alias link in the unit dir');
  assert.ok(sd.isEnabled('mootrd.service') && !sd.isEnabled('stamd.service'));
  assert.equal(sd.run('disable', 'mootrd.service').status, 0);
  assert.ok(!existsSync(join(sd.units, 'default.target.wants/mootrd.service')));
  assert.ok(!isLink(join(sd.units, 'stamd.service')), 'the alias goes with disable');
  assert.ok(!sd.isEnabled('mootrd.service'));
});

test('enable over an alias name held by a regular file, or a link to another unit, fails and changes nothing', () => {
  const sd = setup({ 'mootrd.service': ALIASED, 'stamd.service': DAEMON });
  const r = sd.run('enable', 'mootrd.service');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /stamd\.service already exists/);
  assert.ok(!sd.isEnabled('mootrd.service'));
  const sd2 = setup({ 'mootrd.service': ALIASED, 'other.service': DAEMON });
  spawnSync('ln', ['-s', 'other.service', join(sd2.units, 'stamd.service')]);
  assert.equal(sd2.run('enable', 'mootrd.service').status, 1);
});

test('an alias name resolves to its unit for start, stop, is-active and show', () => {
  const sd = setup({ 'mootrd.service': ALIASED });
  sd.enable('mootrd.service');
  assert.equal(sd.run('start', 'stamd.service').status, 0);
  assert.ok(sd.isActive('mootrd.service'));
  assert.equal(sd.run('is-active', 'stamd.service').stdout.trim(), 'active');
  assert.equal(sd.run('show', '-p', 'ActiveState', '--value', 'stamd.service').stdout.trim(), 'active');
  assert.equal(sd.run('is-enabled', 'stamd.service').stdout.trim(), 'alias');
  sd.run('stop', 'stamd.service');
  assert.equal(sd.state('mootrd.service'), 'inactive');
});

test('is-active and is-enabled exit codes match systemd', () => {
  const sd = setup({ 'a.service': DAEMON, 'static.service': ONESHOT });
  const code = (...a) => sd.run(...a).status;
  assert.equal(code('is-active', '--quiet', 'a.service'), 3, 'inactive');
  assert.equal(sd.run('is-active', '--quiet', 'a.service').stdout, '', '--quiet prints nothing');
  assert.equal(code('is-active', 'nope.service'), 4, 'unknown unit');
  assert.equal(code('is-enabled', 'a.service'), 1, 'disabled');
  assert.equal(code('is-enabled', 'static.service'), 0, 'static');
  assert.equal(sd.run('is-enabled', 'static.service').stdout.trim(), 'static');
  assert.equal(code('is-enabled', 'nope.service'), 4, 'not-found');
  assert.equal(sd.run('is-enabled', 'nope.service').stdout.trim(), 'not-found');
  assert.equal(code('enable', '--now', 'a.service'), 0);
  assert.equal(code('is-enabled', 'a.service'), 0);
  assert.equal(code('is-active', 'a.service'), 0);
  assert.equal(code('is-active', 'a'), 0, 'a name with no unit type is a service');
  assert.equal(code('enable', 'nope.service'), 1);
  assert.equal(code('disable', 'nope.service'), 1);
  assert.equal(code('start', 'nope.service'), 5);
  const r = sd.run('enable', 'static.service');
  assert.equal(r.status, 0);
  assert.match(r.stderr, /no installation config/);
});

test('a oneshot stays activating until the test marks it done, then is inactive', () => {
  const sd = setup({ 'job.service': ONESHOT });
  sd.start('job.service');
  assert.equal(sd.state('job.service'), 'activating');
  assert.equal(sd.run('is-active', 'job.service').status, 3, 'activating is not active');
  assert.equal(sd.state('job.service'), 'activating', 'it does not end by itself');
  sd.finish('job.service');
  assert.equal(sd.state('job.service'), 'inactive');
  // A run in flight that ends after a number of state queries.
  sd.running('job.service', 2);
  assert.equal(sd.run('show', '-p', 'ActiveState', '--value', 'job.service').stdout.trim(), 'activating');
  assert.equal(sd.run('show', '-p', 'ActiveState', '--value', 'job.service').stdout.trim(), 'inactive');
});

test('restart picks up the loaded unit; a changed unit file takes effect only after daemon-reload', () => {
  const sd = setup({ 'a.service': DAEMON });
  sd.start('a.service');
  assert.equal(sd.runningConfig('a.service'), DAEMON, 'a unit never loaded loads on first use');
  writeFileSync(join(sd.units, 'a.service'), DAEMON.replace('/bin/d', '/bin/d2'));
  const r = sd.run('restart', 'a.service');
  assert.equal(r.status, 0);
  assert.match(r.stderr, /changed on disk.*daemon-reload/);
  assert.equal(sd.runningConfig('a.service'), DAEMON, 'still the old config');
  sd.run('daemon-reload');
  sd.run('restart', 'a.service');
  assert.match(sd.runningConfig('a.service'), /\/bin\/d2/);
  sd.run('stop', 'a.service');
  assert.equal(sd.runningConfig('a.service'), null);
  // A unit file moved away stays loaded, and startable, until daemon-reload.
  renameSync(join(sd.units, 'a.service'), join(sd.dir, 'a.service.aside'));
  assert.equal(sd.run('start', 'a.service').status, 0);
  sd.run('stop', 'a.service');
  sd.run('daemon-reload');
  assert.equal(sd.run('start', 'a.service').status, 5);
});

test('the fake curl is down while the daemon is stopped or activating, and up once it is active', () => {
  const sd = setup({ 'mootrd.service': ALIASED });
  let r = curl(sd, '/api/health');
  assert.equal(r.status, 7, 'connection refused while stopped');
  assert.equal(r.stdout, '000');
  // Enabled, so stamd.service is an alias of mootrd.service: one daemon, counted once per request.
  sd.enable('mootrd.service');
  sd.slowStart('mootrd.service', 3);
  sd.start('mootrd.service');
  assert.equal(sd.state('mootrd.service'), 'activating');
  assert.equal(curl(sd, '/api/health').stdout, '000', 'down while activating');
  assert.equal(curl(sd, '/api/health').stdout, '000');
  r = curl(sd, '/api/health');
  assert.equal(r.stdout, '200', 'up once the start finished');
  assert.equal(sd.state('mootrd.service'), 'active');
  sd.run('stop', 'mootrd.service');
  assert.equal(curl(sd, '/api/health').stdout, '000', 'down again after stop');
});

test('the fake curl answers per path, marks an unhealthy unit 503, and keeps the -K stdin config', () => {
  const sd = setup({ 'mootrd.service': ALIASED });
  sd.start('mootrd.service');
  sd.http('/api/agents', { body: '[{"id":"a"}]' });
  sd.http('/api/health/db', { code: 500 });
  const r = spawnSync(sd.curl, ['-s', '-K', '-', '-w', '\\n%{http_code}', 'http://127.0.0.1:7878/api/agents'], {
    env: { PATH: process.env.PATH, ...sd.env }, encoding: 'utf8', input: 'header = "x"\n',
  });
  assert.equal(r.stdout, '[{"id":"a"}]\n200');
  assert.equal(curl(sd, '/api/health/db').stdout, '500');
  assert.equal(curl(sd, '/api/health').stdout, '200');
  sd.unhealthy('mootrd.service');
  assert.equal(curl(sd, '/api/health').stdout, '503');
  assert.match(spawnSync('cat', [join(sd.sc, 'curl-stdin')], { encoding: 'utf8' }).stdout, /header = "x"/);
  assert.match(spawnSync('cat', [join(sd.sc, 'curl-urls')], { encoding: 'utf8' }).stdout, /\/api\/agents/);
});

test('failOn, the log, log-extra.sh and on-call.sh', () => {
  const sd = setup({ 'a.service': DAEMON, 't.timer': TIMER });
  writeFileSync(join(sd.sc, 'log-extra.sh'), 'echo extra=1\n');
  writeFileSync(join(sd.sc, 'on-call.sh'), `[ "$cmd" = stop ] && touch "$FAKE_SC/stopped-$1"\n`);
  sd.failOn('enable t.timer');
  assert.equal(sd.run('enable', 't.timer').status, 1);
  assert.ok(!sd.isEnabled('t.timer'));
  sd.start('a.service');
  sd.run('stop', 'a.service');
  assert.ok(existsSync(join(sd.sc, 'stopped-a.service')));
  assert.deepEqual(sd.log().trim().split('\n'), ['enable t.timer extra=1', 'start a.service extra=1', 'stop a.service extra=1']);
  rmSync(join(sd.sc, 'fail'));
  assert.equal(sd.run('enable', 't.timer').status, 0);
  assert.ok(sd.isEnabled('t.timer') && existsSync(join(sd.units, 'timers.target.wants/t.timer')));
});

test('options before the verb are read as options: --user start starts, and --user is-active fails for an inactive or missing unit', () => {
  const sd = setup({ 'mootrd.service': DAEMON });
  assert.equal(sd.run('--user', 'is-active', '--quiet', 'mootrd.service').status, 3, 'inactive');
  assert.equal(sd.run('--user', 'is-active', '--quiet', 'missing.service').status, 4, 'missing');
  assert.equal(sd.run('--user', 'start', 'mootrd.service').status, 0);
  assert.ok(sd.isActive('mootrd.service'), 'started');
  assert.equal(sd.run('--user', 'is-active', '--quiet', 'mootrd.service').status, 0);
  assert.equal(sd.run('--user', 'show', '-p', 'ActiveState', '--value', 'mootrd.service').stdout.trim(), 'active');
});

test('an unmodelled verb or option, or no verb, fails instead of passing silently', () => {
  const sd = setup({ 'a.service': DAEMON });
  for (const args of [['frobnicate', 'a.service'], ['--user'], [], ['--system', 'start', 'a.service'], ['start', '--force', 'a.service']]) {
    const r = sd.run(...args);
    assert.equal(r.status, 1, JSON.stringify(args));
    assert.ok(r.stderr.length > 0, JSON.stringify(args));
  }
  assert.ok(!sd.isActive('a.service'));
});
