#!/usr/bin/env node
// The PR view relay (S-3107, src/pr-view.ts) on the ITSA home, against a fake `gh` that is this test's own script: a good PR
// is shaped (title, head, body, files, checks and the stam/review status), an unknown PR is a 404, a `pr` that is not a number
// or OWNER/REPO#N, or names a repo outside settings.itsa.repos, is refused before gh runs, and a failing gh is a 502 whose
// message keeps any credential out. gh always runs with the fixed argument list below. Nothing touches GitHub. Run with
// `node --test test/pr-view-unit.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmphome.mjs';

const HEAD = '1234567890abcdef1234567890abcdef12345678';
const FIELDS = 'number,url,title,state,baseRefName,headRefName,headRefOid,body,files,statusCheckRollup';
const base = tempDir('stam-pr-view-');
const bin = join(base, 'bin');
const ghDir = join(base, 'gh');
const callsFile = join(ghDir, 'calls.jsonl');
const replyFile = join(ghDir, 'reply.json');
process.env.STAM_HOME = join(base, 'home');
// Nothing here talks to a daemon; drop pointers to the live one.
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

let viewHere, parsePr, PrViewError, VIEW_GH_MS, VIEW_PEER_MS;
const calls = () => (existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).args) : []);
const clearCalls = () => rmSync(callsFile, { force: true });
// What the next gh call prints and how it exits.
const reply = (r) => writeFileSync(replyFile, JSON.stringify(r));
const cfg = () => ({ repoName: 'stam2', repo: fx.repo, storage: '', origin: 'origin', gh: join(bin, 'gh'), github: 'example/stam', base: 'main' });

// Git fixtures, no network. A bare origin: main, then PR 42's head B and PR 43's head D (on B). main moves on to C after
// the branch point A, so origin/main's tip (C) is not the merge-base of B and main (A). storage is a bare repo that holds
// PR 43's head as B, a lagging mirror. repo is a clone of origin; repoS is a clone with a `storage` remote and a `broken` one.
const fx = {};
const sh = (cwd, args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
function fixtures() {
  const origin = join(base, 'origin.git');
  const work = join(base, 'work');
  const commit = (file, msg) => {
    writeFileSync(join(work, file), `${msg}\n`);
    sh(work, ['add', '.']);
    sh(work, ['commit', '-qm', msg]);
    return sh(work, ['rev-parse', 'HEAD']);
  };
  sh(base, ['init', '-q', '--bare', '-b', 'main', origin]);
  sh(base, ['init', '-q', '-b', 'main', work]);
  fx.A = commit('a.txt', 'A');
  sh(work, ['push', '-q', origin, 'main']);
  sh(work, ['checkout', '-q', '-b', 'feature']);
  fx.B = commit('b.txt', 'B');
  fx.D = commit('d.txt', 'D');
  sh(work, ['push', '-q', origin, `${fx.B}:refs/pull/42/head`, `${fx.D}:refs/pull/43/head`]);
  sh(work, ['checkout', '-q', 'main']);
  fx.C = commit('c.txt', 'C');
  sh(work, ['push', '-q', origin, 'main']);
  fx.storage = join(base, 'storage.git');
  sh(base, ['init', '-q', '--bare', fx.storage]);
  sh(work, ['push', '-q', fx.storage, `${fx.B}:refs/pull/43/head`]);
  fx.repo = join(base, 'repo');
  fx.repoS = join(base, 'repo-s');
  sh(base, ['clone', '-q', origin, fx.repo]);
  sh(base, ['clone', '-q', origin, fx.repoS]);
  sh(fx.repoS, ['remote', 'add', 'storage', fx.storage]);
  sh(fx.repoS, ['remote', 'add', 'broken', join(base, 'no-such.git')]);
}

const PR = {
  number: 42,
  url: 'https://github.com/example/stam/pull/42',
  title: 'Add the PR view',
  state: 'OPEN',
  baseRefName: 'main',
  headRefName: 'stam/dev-one',
  headRefOid: HEAD,
  body: 'ITSA: S-3107\nGates: unchanged\nDeploy: none\n\nRead it with pr_view.',
  files: [
    { path: 'src/pr-view.ts', additions: 150, deletions: 0 },
    { path: 'src/daemon.ts', additions: 12, deletions: 3 },
  ],
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', workflowName: 'CI' },
    { __typename: 'CheckRun', name: 'typecheck', status: 'IN_PROGRESS', conclusion: '', workflowName: 'CI' },
    { __typename: 'StatusContext', context: 'stam/review', state: 'SUCCESS', targetUrl: '' },
  ],
};

// A fake gh: every call is recorded in calls.jsonl; it prints the stdout and stderr of reply.json and exits with its code.
before(async () => {
  mkdirSync(bin, { recursive: true });
  mkdirSync(ghDir, { recursive: true });
  reply({ code: 0, stdout: JSON.stringify(PR), stderr: '' });
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
const dir = ${JSON.stringify(ghDir)};
const args = process.argv.slice(2);
appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ args }) + '\\n');
const r = JSON.parse(readFileSync(join(dir, 'reply.json'), 'utf8'));
if (r.stdout) writeSync(1, r.stdout);
if (r.stderr) writeSync(2, r.stderr);
process.exit(r.code);
`);
  chmodSync(join(bin, 'gh'), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  fixtures();
  ({ viewHere, parsePr, PrViewError, VIEW_GH_MS, VIEW_PEER_MS } = await import('../src/pr-view.ts'));
});
after(() => {
  rmSync(base, { recursive: true, force: true });
});

// Every call is refused with the status it names, and gh never ran.
async function refused(pr, status) {
  clearCalls();
  await assert.rejects(viewHere({ pr }, cfg()), (e) => e instanceof PrViewError && e.status === status, JSON.stringify(pr));
  assert.deepEqual(calls(), [], `gh never ran for ${JSON.stringify(pr)}`);
}

test('a good PR is read with one fixed gh call, and its title, head, body, files and checks come back shaped', async () => {
  clearCalls();
  reply({ code: 0, stdout: JSON.stringify(PR), stderr: '' });
  const v = await viewHere({ pr: 42 }, cfg());
  assert.deepEqual(calls(), [['pr', 'view', '42', '--repo', 'example/stam', '--json', FIELDS]]);
  assert.deepEqual(
    { number: v.number, repo: v.repo, title: v.title, state: v.state, base: v.base, head_branch: v.head_branch, head: v.head, url: v.url },
    { number: 42, repo: 'example/stam', title: 'Add the PR view', state: 'OPEN', base: 'main', head_branch: 'stam/dev-one', head: HEAD, url: PR.url },
  );
  assert.equal(v.body, PR.body);
  assert.deepEqual(v.files, [
    { path: 'src/pr-view.ts', additions: 150, deletions: 0 },
    { path: 'src/daemon.ts', additions: 12, deletions: 3 },
  ]);
  assert.deepEqual(v.checks, [
    { name: 'test', state: 'success' },
    { name: 'typecheck', state: 'in_progress' },
    { name: 'stam/review', state: 'success' },
  ]);
});

test('OWNER/REPO#N reads that repo, and a PR of a repo outside settings.itsa.repos is refused (403) before gh runs', async () => {
  clearCalls();
  reply({ code: 0, stdout: JSON.stringify(PR), stderr: '' });
  await viewHere({ pr: 'example/stam#42' }, cfg());
  assert.deepEqual(calls()[0].slice(0, 4), ['pr', 'view', '42', '--repo']);
  assert.equal(calls()[0][4], 'example/stam');
  await refused('other/repo#42', 403);
});

test('an unknown PR is refused (404), with gh\'s answer for it', async () => {
  clearCalls();
  reply({ code: 1, stdout: '', stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 999. (repository.pullRequest)\n' });
  await assert.rejects(viewHere({ pr: 999 }, cfg()), (e) => e instanceof PrViewError && e.status === 404 && e.message === 'PR #999 is not in example/stam');
  assert.equal(calls().length, 1, 'gh ran once');
});

test('a pr that is not a number or OWNER/REPO#N is refused (400) before gh runs: injection attempts included', async () => {
  for (const pr of ['42; rm -rf /', '$(touch /tmp/x)', '`id`', '4 2', '0', '-1', '042', '1e3', '42.0', '', '#42', 'example/stam#', 'example/stam#0', 'example/stam#1 --json x', '--repo=example/stam', 'a/b/c#1', '../../evil/repo#1', 'example/stam#1\n--json']) {
    await refused(pr, 400);
  }
});

test('a repo path that escapes the list is refused (403) before gh runs', async () => {
  for (const pr of ['../x#1', '-x/y#1', 'x..y/repo#1']) {
    await refused(pr, 403);
  }
});

test('a gh failure is a 502 with its last line, and no credential reaches the error or the log', async () => {
  clearCalls();
  reply({ code: 1, stdout: '', stderr: 'error connecting to api.github.com\nHTTP 401: Bad credentials (token ghp_abcdefSECRET123 github_pat_SECRET456_x) Authorization: Bearer SECRETBEARER\n' });
  await assert.rejects(viewHere({ pr: 42 }, cfg()), (e) => {
    assert.ok(e instanceof PrViewError, 'a PrViewError');
    assert.equal(e.status, 502);
    assert.match(e.message, /^gh couldn't read PR #42 in example\/stam: HTTP 401: Bad credentials/);
    assert.doesNotMatch(e.message, /ghp_|github_pat_|SECRET|Bearer/);
    assert.match(e.message, /\[redacted\]/);
    return true;
  });
  assert.equal(calls().length, 1, 'gh ran once');
});

test('gh printing no JSON is a 502, not a crash', async () => {
  reply({ code: 0, stdout: 'not json', stderr: '' });
  await assert.rejects(viewHere({ pr: 42 }, cfg()), (e) => e instanceof PrViewError && e.status === 502);
});

test('a bare number with no default repo is refused (400), before gh runs', async () => {
  clearCalls();
  await assert.rejects(viewHere({ pr: 42 }, { ...cfg(), github: '' }), (e) => e instanceof PrViewError && e.status === 400);
  assert.deepEqual(calls(), []);
});

test('parsePr takes a bare number into the default repo and checks OWNER/REPO#N against the list', () => {
  assert.deepEqual(parsePr('42', ['example/stam'], 'example/stam'), { repo: 'example/stam', number: 42 });
  assert.deepEqual(parsePr(' example/stam#7 ', ['example/stam'], ''), { repo: 'example/stam', number: 7 });
  assert.throws(() => parsePr('example/stam#7', ['other/repo'], 'example/stam'), (e) => e.status === 403);
});

test('the peer waits longer for the home than gh waits for the PR, so a slow read ends at the home first', () => {
  assert.ok(VIEW_PEER_MS > VIEW_GH_MS, `${VIEW_PEER_MS} > ${VIEW_GH_MS}`);
});

// S-3751: the merge-base is the PR's real base branch's, not origin/main's tip, and comes with one git diff for the PR.
test('merge_base is the merge-base with the PR base branch, not origin/main\'s tip, when main has moved past the branch point', async () => {
  clearCalls();
  reply({ code: 0, stdout: JSON.stringify({ ...PR, headRefOid: fx.B, baseRefName: 'main' }), stderr: '' });
  const v = await viewHere({ pr: 42 }, cfg());
  assert.equal(v.head, fx.B);
  assert.equal(v.merge_base, fx.A, 'the merge-base of B and main, not main\'s tip C');
  assert.notEqual(v.merge_base, fx.C);
  assert.equal(v.diff, `git diff ${fx.A} ${fx.B}`);
});

// An unreadable merge-base (a PR whose head is not on origin, or a base branch origin lacks) leaves both out; the view still succeeds.
test('an unreadable merge-base leaves merge_base and diff out, and the view still succeeds', async () => {
  for (const [number, baseRefName] of [[44, 'main'], [42, 'no-such-branch']]) {
    reply({ code: 0, stdout: JSON.stringify({ ...PR, number, headRefOid: fx.B, baseRefName }), stderr: '' });
    const v = await viewHere({ pr: number }, cfg());
    assert.equal(v.number, number);
    assert.equal(v.title, PR.title);
    assert.ok(!('merge_base' in v) && !('diff' in v), `PR #${number} into ${baseRefName}`);
  }
});

// S-3713: storage's refs/pull/43/head holds B, GitHub's head is D: the view refreshes it to D, and writes no branch.
test('a lagging storage mirror ref is refreshed to GitHub\'s head when the view runs, and no branch is written', async () => {
  reply({ code: 0, stdout: JSON.stringify({ ...PR, number: 43, headRefOid: fx.D, baseRefName: 'main' }), stderr: '' });
  const v = await viewHere({ pr: 43 }, { ...cfg(), repo: fx.repoS, storage: 'storage' });
  assert.equal(v.head, fx.D);
  assert.equal(sh(fx.storage, ['rev-parse', 'refs/pull/43/head']), fx.D);
  assert.equal(sh(fx.storage, ['for-each-ref', '--format=%(refname)', 'refs/heads']), '');
  assert.equal(sh(fx.repoS, ['for-each-ref', '--format=%(refname)', 'refs/stam']), '', 'the scratch refs are dropped');
});

test('a mirror that fails does not fail the view', async () => {
  reply({ code: 0, stdout: JSON.stringify({ ...PR, number: 43, headRefOid: fx.D, baseRefName: 'main' }), stderr: '' });
  const v = await viewHere({ pr: 43 }, { ...cfg(), repo: fx.repoS, storage: 'broken' });
  assert.equal(v.head, fx.D);
  assert.equal(v.merge_base, fx.A);
});
