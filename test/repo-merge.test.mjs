#!/usr/bin/env node
// The generic merge (S-2202, scripts/repo-merge.mjs): merges only when every required status is success on the PR's
// current head (also when merge.command replaces the gh merge), reruns the gates when their status isn't against the
// current main, reads the config from main and never the PR, merges by the configured method or command, then deploys.
// Throwaway git repos and a fake gh reached only through STAM_GH. Run with `node --test test/repo-merge.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmphome.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const MERGE = join(ROOT, 'scripts/repo-merge.mjs');
const MERGE_OID = 'c0ffee0000000000000000000000000000000000';
// The file leaves merge, deploy, home and requiredStatuses to the defaults or a test's STAM_REPO_CONFIG.
// `mover` runs the test's MOVE_MAIN, so a gate can move main while it runs.
const CONFIG = { github: 'acme/widgets', gates: [{ name: 'always', command: 'test -f README' }, { name: 'strict', command: 'exit 5', when: 'strict/**' }, { name: 'mover', command: 'eval "${MOVE_MAIN:-true}"', when: 'mover/**' }] };

let work, origin, seed, clone, ghBin;
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

function commit(files, msg) {
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(dirname(join(seed, f)), { recursive: true });
    writeFileSync(join(seed, f), c);
  }
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', msg);
  return git(seed, 'rev-parse', 'HEAD');
}

function openPr(n, files) {
  git(seed, 'checkout', '-q', '-B', `pr-${n}`, 'origin/main');
  const head = commit(files, `pr ${n}`);
  git(seed, 'push', '-q', '-f', 'origin', `pr-${n}`);
  git(seed, 'checkout', '-q', 'main');
  return head;
}

before(() => {
  work = tempDir('stam-repo-merge-');
  origin = join(work, 'origin.git');
  seed = join(work, 'seed');
  clone = join(work, 'clone');
  git(work, 'init', '-q', '--bare', '-b', 'main', origin);
  git(work, 'init', '-q', '-b', 'main', seed);
  git(seed, 'remote', 'add', 'origin', origin);
  commit({ README: 'x\n', '.stam/repo.json': JSON.stringify(CONFIG) }, 'base');
  git(seed, 'push', '-q', 'origin', 'main');
  git(work, 'clone', '-q', origin, clone);
  // The fake gh: `pr view` serves pr-N.json (with mergeCommit), the statuses GET serves statuses.json, and every other
  // call is recorded in calls.jsonl. Not on PATH: only STAM_GH reaches it.
  ghBin = join(work, 'bin', 'fake-gh');
  mkdirSync(dirname(ghBin));
  writeFileSync(ghBin, `#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.env.FAKE_GH_DIR;
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'view') {
  // The second view (the gate rerun's) serves pr-N.view2.json when there is one, after running ON_VIEW2: a push
  // landing between the merge's check and the gate.
  appendFileSync(join(dir, 'views'), 'x');
  const second = readFileSync(join(dir, 'views'), 'utf8').length === 2 && existsSync(join(dir, \`pr-\${args[2]}.view2.json\`));
  if (second) execSync(process.env.ON_VIEW2);
  const pr = JSON.parse(readFileSync(join(dir, \`pr-\${args[2]}\${second ? '.view2' : ''}.json\`), 'utf8'));
  process.stdout.write(JSON.stringify({ ...pr, mergeCommit: { oid: '${MERGE_OID}' } }));
  process.exit(0);
}
if (args[0] === 'api' && /\\/commits\\/[0-9a-f]+\\/statuses$/.test(args[1])) {
  process.stdout.write(readFileSync(join(dir, 'statuses.json'), 'utf8'));
  process.exit(0);
}
appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ args }) + '\\n');
`);
  chmodSync(ghBin, 0o755);
});
after(() => rmSync(work, { recursive: true, force: true }));

const ok = (context, description = '') => ({ context, state: 'success', description });
const main = () => git(clone, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0];

// Runs the merge on PR N as the fake gh serves it. Returns the run and what gh was asked to do.
function merge(name, n, { head, baseRefName = 'main', state = 'OPEN', mergeable = 'MERGEABLE', statuses = [], config = null, env = {}, pr = {} }) {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `pr-${n}.json`), JSON.stringify({ state, mergeable, headRefName: `pr-${n}`, headRefOid: head, body: 'ITSA: S-1\nGates: auto\nDeploy: normal', baseRefName, ...pr }));
  writeFileSync(join(dir, 'statuses.json'), JSON.stringify(statuses));
  const r = spawnSync(process.execPath, [MERGE, String(n)], {
    env: { ...process.env, STAM_GH: ghBin, FAKE_GH_DIR: dir, STAM_GATE_REPO: clone, STAM_REPO_GATE_CACHE: join(dir, 'cache'), STAM_MACHINE: 'testbox', ...(config ? { STAM_REPO_CONFIG: JSON.stringify(config) } : {}), ...env },
    encoding: 'utf8',
  });
  const file = join(dir, 'calls.jsonl');
  const calls = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  return { ...r, dir, merges: calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'merge'), gateRuns: calls.filter((c) => c.args[0] === 'api') };
}

test('a PR without its required stam/review success is refused (exit 3), and nothing merges or runs', () => {
  const head = openPr(1, { a: '1\n' });
  const r = merge('no-review', 1, { head, statuses: [ok('stam/gates', `gates pass: always; base ${main()}`)] });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /stam\/review on [0-9a-f]{7} is missing, not success/);
  assert.equal(r.merges.length + r.gateRuns.length, 0);
});

test('the newest status per context counts: a later failure beats an earlier success', () => {
  const head = openPr(2, { a: '2\n' });
  const r = merge('stale-success', 2, { head, statuses: [{ context: 'stam/review', state: 'failure' }, ok('stam/review'), ok('stam/gates', `x; base ${main()}`)] });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /stam\/review on [0-9a-f]{7} is failure/);
});

test('review and gates on the current main: merges with the default method on the head, prints the merge sha', () => {
  const head = openPr(3, { a: '3\n' });
  const r = merge('merge', 3, { head, statuses: [ok('stam/review'), ok('stam/gates', `gates pass: always; base ${main()}`)] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), MERGE_OID);
  assert.equal(r.gateRuns.length, 0, 'the gates were not rerun');
  assert.deepEqual(r.merges.map((c) => c.args), [['pr', 'merge', '3', '--repo', 'acme/widgets', '--merge', '--match-head-commit', head]]);
});

test('gates against an old main run again: a pass merges by the configured method, a fail refuses', () => {
  const head = openPr(4, { a: '4\n' });
  const stale = [ok('stam/review'), ok('stam/gates', 'gates pass: always; base 0000000000000000000000000000000000000000')];
  const r = merge('rerun', 4, { head, statuses: stale, config: { merge: { method: 'squash' } } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.gateRuns.length, 1, 'repo-gate posted its status');
  assert.ok(r.gateRuns[0].args.includes(`description=gates pass: always; base ${main()}`));
  assert.deepEqual(r.merges[0].args.slice(5), ['--squash', '--match-head-commit', head]);

  const bad = openPr(5, { 'strict/x': '5\n' });
  const f = merge('rerun-fail', 5, { head: bad, statuses: stale });
  assert.equal(f.status, 3);
  assert.match(f.stderr, /gates failed on [0-9a-f]{7} against main [0-9a-f]{7}: gates fail: strict/);
  assert.equal(f.merges.length, 0);
});

test('main moving while the gates run stops the merge (exit 1) before any merge call; the merge pins the gated head', () => {
  const head = openPr(10, { 'mover/x': '10\n' });
  const stale = [ok('stam/review'), ok('stam/gates', 'gates pass: always; base 0000000000000000000000000000000000000000')];
  // The gate pushes a new commit to origin's main from the seed, as another merge landing would.
  const move = `git -C ${seed} checkout -q main && git -C ${seed} pull -q origin main && echo moved > ${join(seed, 'moved.txt')} && git -C ${seed} add -A && git -C ${seed} -c user.name=t -c user.email=t@t commit -q -m moved && git -C ${seed} push -q origin main`;
  const before = main();
  const r = merge('main-moved', 10, { head, statuses: stale, env: { MOVE_MAIN: move, STAM_REPO_GATE_ENV: 'MOVE_MAIN' } });
  assert.notEqual(main(), before, 'the gate moved main');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /main moved since the gates ran; run the merge again/);
  assert.equal(r.merges.length, 0);
  // Every gh merge names the head that was checked, so GitHub refuses it if the head moved since.
  const head2 = openPr(11, { a: '11\n' });
  const ok2 = merge('pinned', 11, { head: head2, statuses: [ok('stam/review'), ok('stam/gates', `x; base ${main()}`)] });
  assert.equal(ok2.status, 0, ok2.stderr);
  const args = ok2.merges[0].args;
  assert.equal(args[args.indexOf('--match-head-commit') + 1], head2);
});

test('a head pushed while the gates rerun stops the merge (exit 1): the gates ran on a head that was never checked', () => {
  const head = openPr(12, { a: '12\n' });
  git(seed, 'checkout', '-q', '-B', 'pr-12-next', head);
  const next = commit({ a: '12 next\n' }, 'pr 12 next');
  git(seed, 'checkout', '-q', 'main');
  const dir = join(work, 'head-moved');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pr-12.view2.json'), JSON.stringify({ state: 'OPEN', mergeable: 'MERGEABLE', headRefName: 'pr-12', headRefOid: next, body: 'ITSA: S-1\nGates: auto\nDeploy: normal', baseRefName: 'main' }));
  const stale = [ok('stam/review'), ok('stam/gates', 'gates pass: always; base 0000000000000000000000000000000000000000')];
  const r = merge('head-moved', 12, { head, statuses: stale, env: { ON_VIEW2: `git -C ${seed} push -q -f origin ${next}:refs/heads/pr-12` } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /pr-12 moved while the gates ran; run the merge again/);
  assert.equal(r.merges.length, 0);
});

test('merge.command replaces only the gh merge: it never runs without the required statuses, and gets the PR env', () => {
  const head = openPr(6, { a: '6\n' });
  const out = join(work, 'cmd-env');
  const config = { merge: { command: `printf '%s %s %s %s' "$STAM_PR" "$STAM_PR_HEAD" "$STAM_BASE_SHA" "$STAM_MERGE_METHOD" > ${out}` }, requiredStatuses: ['stam/review', 'ci'] };
  const gated = ok('stam/gates', `gates pass: always; base ${main()}`);
  const refused = merge('cmd-refused', 6, { head, config, statuses: [ok('stam/review'), gated] });
  assert.equal(refused.status, 3);
  assert.match(refused.stderr, /ci on [0-9a-f]{7} is missing/);
  assert.ok(!existsSync(out), 'merge.command did not run');

  const r = merge('cmd', 6, { head, config, statuses: [ok('stam/review'), ok('ci'), gated] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(out, 'utf8'), `6 ${head} ${main()} merge`);
  assert.equal(r.merges.length, 0, 'no gh pr merge beside the command');
});

test('deploy runs after the merge with the merge command\'s env and the merge sha; a failing deploy exits 4', () => {
  const head = openPr(7, { a: '7\n' });
  const out = join(work, 'deploy-env');
  const statuses = [ok('stam/review'), ok('stam/gates', `gates pass: always; base ${main()}`)];
  const r = merge('deploy', 7, { head, statuses, config: { merge: { method: 'rebase' }, deploy: `printf '%s %s %s %s' "$STAM_PR" "$STAM_PR_HEAD" "$STAM_MERGE_METHOD" "$STAM_MERGE_SHA" > ${out}` } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(out, 'utf8'), `7 ${head} rebase ${MERGE_OID}`);
  const f = merge('deploy-fail', 7, { head, statuses, config: { deploy: 'exit 9' } });
  assert.equal(f.status, 4);
  assert.match(f.stderr, new RegExp(`merged as ${MERGE_OID}, but deploy exited 9`));
  assert.equal(f.merges.length, 1);
});

test('the config is main\'s: a PR that drops its required statuses or aims at its own branch is still refused', () => {
  const head = openPr(8, { '.stam/repo.json': JSON.stringify({ ...CONFIG, requiredStatuses: [] }) });
  const r = merge('weaken', 8, { head, statuses: [ok('stam/gates', `gates pass: always; base ${main()}`)] });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /stam\/review on [0-9a-f]{7} is missing/);
  const aimed = merge('aimed', 8, { head, baseRefName: 'pr-8', statuses: [ok('stam/review')] });
  assert.equal(aimed.status, 3);
  assert.match(aimed.stderr, /its base is pr-8, not main/);
});

test('not open, conflicting, a fork, a moved head: exit 3; another home machine: exit 1; usage: exit 2', () => {
  const head = openPr(9, { a: '9\n' });
  const statuses = [ok('stam/review'), ok('stam/gates', `x; base ${main()}`)];
  assert.match(merge('closed', 9, { head, statuses, state: 'CLOSED' }).stderr, /PR #9 is CLOSED, not open/);
  assert.equal(merge('closed2', 9, { head, statuses, state: 'CLOSED' }).status, 3);
  assert.equal(merge('conflict', 9, { head, statuses, mergeable: 'CONFLICTING' }).status, 3);
  const fork = merge('fork', 9, { head, statuses, pr: { isCrossRepository: true, headRepositoryOwner: { login: 'someone' } } });
  assert.equal(fork.status, 3);
  assert.match(fork.stderr, /PR #9 is from a fork \(someone:pr-9\); fork PRs aren't supported/);
  const moved = merge('moved', 9, { head: '1111111111111111111111111111111111111111', statuses });
  assert.equal(moved.status, 3);
  assert.match(moved.stderr, /pr-9 moved since the check/);
  const away = merge('home', 9, { head, statuses, config: { home: 'elsewhere' } });
  assert.equal(away.status, 1);
  assert.match(away.stderr, /merges run on elsewhere, not testbox/);
  assert.equal(away.merges.length, 0);
  assert.equal(spawnSync(process.execPath, [MERGE, 'x'], { encoding: 'utf8' }).status, 2);
});
