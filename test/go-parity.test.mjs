// scripts/go-parity.mjs (S-2253): the FREE list read from test/run.sh, a run's status, and the merge into parity.json.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmphome.mjs';
import { test } from 'node:test';
import { classify, commandOf, daemonCounts, freeTests, goHost, keptLog, looksLikeQuota, mergeParity, parityProblems, staleTests, statusOf, withMissing } from '../scripts/go-parity.mjs';

const META = { go_sha: 'g', ts_sha: 't', run_at: 'now' };

test('freeTests reads the FREE list, not LIGHT or SMOKE', () => {
  const sh = 'LIGHT="\na\nb"\nFREE="\nb\nc\nd\n"\nSMOKE="\ne\n"\n';
  assert.deepEqual(freeTests(sh), ['b', 'c', 'd']);
  const real = freeTests(readFileSync(new URL('../test/run.sh', import.meta.url), 'utf8'));
  assert.ok(real.includes('go-parity-unit') && real.length > 100);
});

test('mergeParity drops a stale name, so a run prunes a renamed or removed FREE test', () => {
  const doc = { tests: { a: { module: 'mail', status: 'pass' }, old: { module: 'mail', status: 'fail' } } };
  const out = mergeParity(doc, ['a', 'new'], {}, META);
  assert.deepEqual(out.tests, { a: { module: 'mail', status: 'pass' }, new: { module: 'unassigned', status: 'fail' } });
});

test('statusOf: exit 0 passes, a failure fails, and a SKIP row is skip', () => {
  assert.equal(statusOf('alpha', 0, 'alpha            PASS     1s\n'), 'pass');
  assert.equal(statusOf('alpha', 1, 'alpha            FAIL     0s\n'), 'fail');
  assert.equal(statusOf('alpha', 0, 'alpha            SKIP\n'), 'skip');
  assert.equal(statusOf('alpha', 0, 'alphabet         SKIP\n'), 'pass');
});

test('mergeParity: unseen names start as failing and unassigned; a result keeps the module; unrun tests keep their status', () => {
  const doc = { tests: { b: { module: 'mail', status: 'pass' }, c: { module: 'mail', status: 'pass' } } };
  const out = mergeParity(doc, ['a', 'b', 'c'], { b: 'fail' }, META);
  assert.deepEqual(out.tests, {
    a: { module: 'unassigned', status: 'fail' },
    b: { module: 'mail', status: 'fail' },
    c: { module: 'mail', status: 'pass' },
  });
  assert.deepEqual([out.go_sha, out.ts_sha, out.run_at], ['g', 't', 'now']);
});

test('withMissing: a FREE test the file lacks counts as fail in module unassigned', () => {
  const doc = { tests: { b: { module: 'mail', status: 'pass' } } };
  assert.deepEqual(withMissing(doc, ['a', 'b']), {
    a: { module: 'unassigned', status: 'fail' },
    b: { module: 'mail', status: 'pass' },
  });
});

test('parityProblems: a FREE test missing from the file is fine; a stale name is only a warning', () => {
  const text = (tests) => JSON.stringify({ go_sha: 'g', ts_sha: 't', run_at: 'now', tests }, null, 2);
  const entry = { module: 'unassigned', status: 'fail' };
  assert.deepEqual(parityProblems(text({ a: entry }), ['a', 'b']), []);
  assert.deepEqual(parityProblems(text({ a: entry, gone: entry }), ['a', 'b']), []);
  assert.deepEqual(staleTests(JSON.parse(text({ a: entry, gone: entry })), ['a', 'b']), ['gone']);
  assert.deepEqual(parityProblems(text({ a: { module: 'x', status: 'maybe' } }), ['a']), ['a has a bad status or module']);
  assert.deepEqual(parityProblems(text({ b: entry, a: entry }), ['a', 'b']), ['tests are not sorted by name']);
  assert.deepEqual(parityProblems(text({ a: entry }).replace('"tests": {', '"tests": {\n    "a": {"module": "unassigned", "status": "fail"},'), ['a']), ['a is listed twice']);
});

test('the committed parity.json has no stale, duplicate, unsorted or malformed entry', () => {
  const raw = readFileSync(new URL('../docs/migration/parity.json', import.meta.url), 'utf8');
  const free = freeTests(readFileSync(new URL('../test/run.sh', import.meta.url), 'utf8'));
  assert.deepEqual(parityProblems(raw, free), []);
});

const RUN_SH = '    foo-unit) echo "node --test test/foo.test.mjs" ;;\n    bar-flow) echo "sh test/e2e-bar-flow.sh" ;;\n';

test('commandOf reads the command table, else test/e2e-NAME.sh', () => {
  assert.equal(commandOf(RUN_SH, 'foo-unit'), 'node --test test/foo.test.mjs');
  assert.equal(commandOf(RUN_SH, 'plain'), 'sh test/e2e-plain.sh');
  assert.equal(commandOf(RUN_SH, 'foo'), 'sh test/e2e-foo.sh', 'a name that is the start of another is not a match');
});

test('classify: a node file is node and no daemon; a script is a daemon test only when a non-comment line starts one', () => {
  const scripts = {
    'test/e2e-bar-flow.sh': '# isolate is mentioned here\n. lib.sh\nisolate\n',
    'test/e2e-hand.sh': '. lib.sh\ndaemon_home a\ndaemon_up a\n',
    'test/e2e-comment.sh': '# daemon_up a (not now)\necho hi\n',
    'test/e2e-cli.sh': 'on a "$STAM" daemon start\n',
  };
  const read = (f) => { if (!(f in scripts)) throw new Error('no file'); return scripts[f]; };
  assert.deepEqual(classify(RUN_SH, 'foo-unit', read), { kind: 'node', daemon: false });
  assert.deepEqual(classify(RUN_SH, 'bar-flow', read), { kind: 'e2e', daemon: true });
  assert.deepEqual(classify(RUN_SH, 'hand', read), { kind: 'e2e', daemon: true });
  assert.deepEqual(classify(RUN_SH, 'comment', read), { kind: 'e2e', daemon: false });
  assert.deepEqual(classify(RUN_SH, 'cli', read), { kind: 'e2e', daemon: true });
  assert.deepEqual(classify(RUN_SH, 'missing', read), { kind: 'e2e', daemon: false });
});

test('classify reads the real test/run.sh: kill-hard starts a daemon, a node unit does not', () => {
  const root = new URL('../', import.meta.url);
  const runSh = readFileSync(new URL('test/run.sh', root), 'utf8');
  const read = (f) => readFileSync(new URL(f, root), 'utf8');
  assert.deepEqual(classify(runSh, 'kill-hard', read), { kind: 'e2e', daemon: true });
  assert.deepEqual(classify(runSh, 'go-parity-unit', read), { kind: 'node', daemon: false });
  assert.equal(classify(runSh, 'deploy', read).daemon, false, 'deploy runs a hermetic TS release, not the test daemon');
});

test('daemonCounts counts passes of the daemon tests; skips and the n/a ones apart', () => {
  const t = { a: { status: 'pass', daemon: true }, b: { status: 'fail', daemon: true }, c: { status: 'skip', daemon: true }, d: { status: 'pass', daemon: false }, e: { status: 'pass' } };
  assert.deepEqual(daemonCounts(t), { pass: 1, total: 3, skip: 1, na: 2 });
});

test('looksLikeQuota matches a full disk and not an ordinary failure', () => {
  assert.ok(looksLikeQuota('FAIL: ENOSPC: no space left on device, write'));
  assert.ok(looksLikeQuota('mktemp: failed to create directory: Disk quota exceeded'));
  assert.ok(!looksLikeQuota('FAIL: a request with no credential wasn\'t 401'));
});

test('mergeParity sets kind and daemon from the classes, and parityProblems accepts them and refuses a bad one', () => {
  const out = mergeParity(null, ['a', 'b'], { a: 'pass' }, META, { a: { kind: 'e2e', daemon: true }, b: { kind: 'node', daemon: false } });
  assert.deepEqual(out.tests.a, { module: 'unassigned', status: 'pass', kind: 'e2e', daemon: true });
  assert.deepEqual(out.tests.b, { module: 'unassigned', status: 'fail', kind: 'node', daemon: false });
  assert.deepEqual(parityProblems(JSON.stringify(out, null, 2), ['a', 'b']), []);
  const bad = JSON.stringify(out, null, 2).replace('"daemon": true', '"daemon": "yes"');
  assert.deepEqual(parityProblems(bad, ['a', 'b']), ['a has a bad kind or daemon']);
});

test('keptLog reads DIR/NAME.log from the folder run.sh names, whichever line names it', () => {
  const dir = tempDir('gp-log-');
  writeFileSync(join(dir, 'a.log'), 'FAIL: write: Disk quota exceeded\n');
  assert.match(keptLog(`logs kept for the failing tests: ${dir}\n`, 'a'), /quota exceeded/);
  assert.match(keptLog(`running: a (estimated spend $0.00; logs in ${dir})\n`, 'a'), /quota exceeded/);
  assert.equal(keptLog(`logs kept for the failing tests: ${dir}\n`, 'b'), '');
  assert.equal(keptLog('no folder named', 'a'), '');
});

// A copy of go-parity.mjs in its own folder, with a fake test/run.sh: `flaky` fails once, naming a kept log with a quota error
// (run.sh's own output shows no cause), then passes; `plain` fails every time with an ordinary error; `quiet` shows as SKIP.
// Each is a daemon e2e script (it mentions daemon_up).
function fakeRoot() {
  const root = tempDir('gp-root-');
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'test'));
  copyFileSync(new URL('../scripts/go-parity.mjs', import.meta.url).pathname, join(root, 'scripts/go-parity.mjs'));
  copyFileSync(new URL('../scripts/main-guard.mjs', import.meta.url).pathname, join(root, 'scripts/main-guard.mjs'));
  mkdirSync(join(root, 'src'));
  copyFileSync(new URL('../src/env.ts', import.meta.url).pathname, join(root, 'src/env.ts'));
  for (const n of ['flaky', 'plain', 'quiet']) writeFileSync(join(root, `test/e2e-${n}.sh`), 'daemon_up main\n');
  writeFileSync(join(root, 'test/run.sh'), `FREE="\nflaky\nplain\nquiet\n"\n\nn=$1
echo x >>"${root}/calls-$n"
if [ "$n" = flaky ] && [ "$(wc -l <"${root}/calls-flaky")" = 1 ]; then
  mkdir -p "${root}/logs"; echo 'mktemp: Disk quota exceeded' >"${root}/logs/flaky.log"
  echo "logs kept for the failing tests: ${root}/logs"; exit 1
fi
if [ "$n" = plain ]; then
  mkdir -p "${root}/logs"; echo 'FAIL: assertion' >"${root}/logs/plain.log"
  echo "logs kept for the failing tests: ${root}/logs"; exit 1
fi
[ "$n" = quiet ] && printf '%-16s %-5s\\n' quiet SKIP
exit 0
`);
  return root;
}

test('go-parity reruns a failure whose kept log shows a full disk, once; an ordinary failure runs once; SKIP rows are counted', () => {
  const root = fakeRoot();
  const file = join(root, 'out.json');
  const r = spawnSync(process.execPath, [join(root, 'scripts/go-parity.mjs'), '--file', file], { env: { ...process.env, STAM_GO_PARITY_ANYHOST: '1' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /retry flaky: the failure looks like a full disk/);
  const tests = JSON.parse(readFileSync(file, 'utf8')).tests;
  assert.deepEqual([tests.flaky.status, tests.plain.status, tests.quiet.status], ['pass', 'fail', 'skip']);
  assert.equal(readFileSync(join(root, 'calls-flaky'), 'utf8').split('\n').filter(Boolean).length, 2);
  assert.equal(readFileSync(join(root, 'calls-plain'), 'utf8').split('\n').filter(Boolean).length, 1);
  assert.match(r.stdout, /parity: 1 of 3 daemon e2e tests pass, 1 skipped, 0 n\/a/);
});

test('goHost: STAM_GO_PARITY_HOST names the Go host, else storage (S-2979)', () => {
  assert.equal(goHost({ STAM_GO_PARITY_HOST: 'box' }), 'box');
  assert.equal(goHost({}), 'storage');
});
