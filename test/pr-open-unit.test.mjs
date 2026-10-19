#!/usr/bin/env node
// The PR relay (S-514, src/pr-open.ts) against throwaway git repos and a fake `gh`: a bare "storage"
// repo holds the branch, a bare "origin" takes the push, and a clone of origin names both as remotes.
// Covers the head mirror to storage's refs/pull/N/head (S-1347: pr_open and a GitHub PR event; a failing push still opens the PR).
// Covers opening a new PR, a new commit on storage pushed to origin and the open PR's body replaced,
// refused inputs (main, a body without its header, a branch storage lacks) before any gh call, and the
// ITSA links (github and branch) added once, with an unknown ITSA refused before anything is pushed.
// It also refuses a Gates line merge-pr would refuse (an unknown token, a `run NAME` test/run.sh doesn't know) before gh runs (S-1292),
// and a branch the merge gate's stories or export-overrides check would fail: a component with no story, a shipped doc edited without its port (S-1942, S-858).
// Nothing touches GitHub. Run with `node --test test/pr-open-unit.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { tempDir } from './tmphome.mjs';

const base = tempDir('stam-pr-open-test-');
const bin = join(base, 'bin');
const ghDir = join(base, 'gh');
const callsFile = join(ghDir, 'calls.jsonl');
process.env.STAM_HOME = join(base, 'home');
process.env.STAM_TMUX_SOCKET = `pr-open-test-${process.pid}`;
// Nothing here talks to a daemon; drop pointers to the live one anyway.
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

const BODY = 'ITSA: S-514\nGates: tsc; run pr-open-unit\nDeploy: normal\n\nWhat changed: the relay.\n';
const BODY2 = 'ITSA: S-514\nGates: tsc; run pr-open-unit\nDeploy: normal\n\nWhat changed: the relay, again.\n';

let openPr, openPrHere, prStatusHere, itsa, cfg, work, seed, featureSha, firstSha;

const git = (cwd, args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
const calls = () => (existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const clearCalls = () => rmSync(callsFile, { force: true });
const originSha = (branch) => git(work, ['ls-remote', 'origin', `refs/heads/${branch}`]).split('\t')[0];

// A fake gh: `pr list` serves list.json when the test wrote one, `pr create` prints the new PR's url,
// and every call is recorded (with the body it sends) in calls.jsonl under FAKE_GH_DIR. `pr view` serves view-body.txt
// as the body; with create-times-out present, `pr create` opens the PR (list.json) and then fails with a timeout (S-899).
function fakeGh() {
  mkdirSync(bin, { recursive: true });
  mkdirSync(ghDir, { recursive: true });
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = ${JSON.stringify(ghDir)};
const args = process.argv.slice(2);
const call = { args };
const bodyFile = args[args.indexOf('--body-file') + 1];
if (args.includes('--body-file')) call.body = readFileSync(bodyFile, 'utf8');
const field = args.find((a) => a.startsWith('body=@'));
if (field) call.body = readFileSync(field.slice('body=@'.length), 'utf8');
appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify(call) + '\\n');
if (args[0] === 'pr' && args[1] === 'list') {
  process.stdout.write(existsSync(join(dir, 'list.json')) ? readFileSync(join(dir, 'list.json'), 'utf8') : '[]');
} else if (args[0] === 'pr' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({ body: existsSync(join(dir, 'view-body.txt')) ? readFileSync(join(dir, 'view-body.txt'), 'utf8') : '', headRefOid: existsSync(join(dir, 'view-head.txt')) ? readFileSync(join(dir, 'view-head.txt'), 'utf8').trim() : '' }));
} else if (args[0] === 'pr' && args[1] === 'create' && existsSync(join(dir, 'create-times-out'))) {
  writeFileSync(join(dir, 'list.json'), JSON.stringify([{ number: 9, url: 'https://github.com/example/stam/pull/9' }]));
  process.stderr.write('The operation was aborted due to timeout\\n');
  process.exit(1);
} else if (args[0] === 'pr' && args[1] === 'create' && existsSync(join(dir, 'create-fails'))) {
  process.stderr.write('The operation was aborted due to timeout\\n');
  process.exit(1);
} else if (args[0] === 'pr' && args[1] === 'create') {
  process.stdout.write('https://github.com/example/stam/pull/7\\n');
}
`);
  chmodSync(join(bin, 'gh'), 0o755);
}

before(async () => {
  const d = join(base, 'repos');
  mkdirSync(d);
  git(d, ['init', '-q', '--bare', '-b', 'main', 'origin.git']);
  git(d, ['init', '-q', '--bare', '-b', 'main', 'storage.git']);
  // The seed makes main on origin and the feature branch on storage.
  seed = join(d, 'seed');
  mkdirSync(seed);
  git(seed, ['init', '-q', '-b', 'main']);
  writeFileSync(join(seed, 'a.txt'), 'one\n');
  // The real test/run.sh, so a `run NAME` in a Gates line is checked against the names it really runs (S-1292).
  mkdirSync(join(seed, 'test'));
  writeFileSync(join(seed, 'test/run.sh'), readFileSync(new URL('../test/run.sh', import.meta.url)));
  git(seed, ['add', '.']);
  git(seed, ['commit', '-q', '-m', 'main']);
  git(seed, ['push', '-q', join(d, 'origin.git'), 'main']);
  git(seed, ['checkout', '-q', '-b', 'feature/x']);
  writeFileSync(join(seed, 'a.txt'), 'two\n');
  git(seed, ['commit', '-qam', 'feature']);
  git(seed, ['push', '-q', join(d, 'storage.git'), 'feature/x']);
  featureSha = git(seed, ['rev-parse', 'HEAD']);
  // The stam2 checkout: origin is the GitHub stand-in, storage the remote the branch comes from.
  work = join(d, 'work');
  git(d, ['clone', '-q', join(d, 'origin.git'), 'work']);
  git(work, ['remote', 'add', 'storage', join(d, 'storage.git')]);
  fakeGh();

  // The module reads the ITSA store under STAM_HOME; the repo name is one the settings already know.
  const db = await import('../src/db.ts');
  itsa = await import('../src/itsa.ts');
  ({ openPr, openPrHere, prStatusHere } = await import('../src/pr-open.ts'));
  db.open();
  (await import('../src/settings.ts')).setSetting('itsa', { ...(await import('../src/settings.ts')).settings().itsa, repos: { stam2: work } });
  cfg = { repoName: 'stam2', repo: work, storage: 'storage', origin: 'origin', gh: join(bin, 'gh'), github: 'example/stam', base: 'main' };
});

after(() => rmSync(base, { recursive: true, force: true }));

test('opens a PR for a branch new to origin: pushes it, then gh pr create with the body', async () => {
  clearCalls();
  const r = await openPr(cfg, { branch: 'feature/x', title: 'S-514: relay', body: BODY });
  assert.deepEqual(r, { number: 7, url: 'https://github.com/example/stam/pull/7', created: true, branch: 'feature/x', head: featureSha });
  assert.equal(originSha('feature/x'), featureSha);
  const create = calls().find((c) => c.args[0] === 'pr' && c.args[1] === 'create');
  assert.ok(create, 'gh pr create ran');
  assert.deepEqual(create.args.slice(2, 10), ['--repo', 'example/stam', '--base', 'main', '--head', 'feature/x', '--title', 'S-514: relay']);
  assert.equal(create.args[10], '--body-file');
  assert.equal(create.body, BODY);
  firstSha = featureSha;
});

test('a new commit on storage reaches origin, and the open PR for the head gets the new body', async () => {
  // storage gets a new commit on the branch; the relay pushes it and PATCHes the PR it finds.
  writeFileSync(join(seed, 'a.txt'), 'three\n');
  git(seed, ['commit', '-qam', 'more']);
  git(seed, ['push', '-q', join(base, 'repos', 'storage.git'), 'feature/x']);
  const head = git(seed, ['rev-parse', 'HEAD']);
  writeFileSync(join(ghDir, 'list.json'), JSON.stringify([{ number: 5, url: 'https://github.com/example/stam/pull/5' }]));
  clearCalls();
  const r = await openPr(cfg, { branch: 'feature/x', title: 'S-514: relay', body: BODY2 });
  rmSync(join(ghDir, 'list.json'));
  assert.deepEqual(r, { number: 5, url: 'https://github.com/example/stam/pull/5', created: false, branch: 'feature/x', head });
  assert.equal(originSha('feature/x'), head);
  assert.notEqual(head, firstSha);
  const patch = calls().find((c) => c.args.includes('PATCH'));
  assert.deepEqual(patch.args.slice(0, 4), ['api', '-X', 'PATCH', 'repos/example/stam/pulls/5']);
  assert.equal(patch.body, BODY2);
  assert.equal(calls().some((c) => c.args[1] === 'create'), false, 'no second PR');
});

test('refuses main, a body without its header, and a branch storage lacks, before any gh call', async () => {
  clearCalls();
  await assert.rejects(openPr(cfg, { branch: 'main', title: 't', body: BODY }), /won't open a PR from main/);
  await assert.rejects(openPr(cfg, { branch: 'feature/x', title: 't', body: 'Just words.\n' }), /starts with the lines ITSA/);
  await assert.rejects(openPr(cfg, { branch: '-x', title: 't', body: BODY }), /branch name/);
  await assert.rejects(openPr(cfg, { branch: 'nope', title: 't', body: BODY }), /git fetch failed/);
  assert.equal(existsSync(callsFile), false, 'gh never ran');
});

test('refuses a Stories: unchanged line the stories gate would reject, before any gh call; accepts the forms it takes (S-914)', async () => {
  clearCalls();
  const withStories = (line) => `${BODY}\n${line}\n`;
  // A bare claim is refused when a component changed (the gate's rule too, S-1942): the stories check names the line.
  treeBranch('tree/bare', {
    'web/src/Pane.tsx': 'export const Pane = () => null\n',
    'web/src/Pane.stories.tsx': "export const stories = [{ code: ['web/src/Pane.tsx#Pane'] }]\n",
  });
  await assert.rejects(openPr(cfg, { branch: 'tree/bare', title: 't', body: withStories('Stories: unchanged') }), /pr_open refuses: stories: the Stories line "Stories: unchanged" needs a reason: write it as Stories: unchanged, REASON/);
  await assert.rejects(openPr(cfg, { branch: 'tree/bare', title: 't', body: withStories('- Stories: unchanged') }), /needs a reason/, 'a bullet counts too');
  assert.equal(existsSync(callsFile), false, 'gh never ran');
  // A PR that changes no component passes the stories step whatever its line says: it reaches the fetch.
  await assert.rejects(openPr(cfg, { branch: 'nope', title: 't', body: withStories('Stories: unchanged') }), /git fetch failed/, 'no component changed');
  // The accepted forms pass the check; this run then stops at the missing branch, which is the next check.
  await assert.rejects(openPr(cfg, { branch: 'nope', title: 't', body: withStories('Stories: unchanged for X, Y') }), /git fetch failed/);
  await assert.rejects(openPr(cfg, { branch: 'nope', title: 't', body: withStories('Stories: unchanged: a refactor') }), /git fetch failed/);
  await assert.rejects(openPr(cfg, { branch: 'nope', title: 't', body: withStories('Stories: mostly unchanged') }), /git fetch failed/, 'not an unchanged line, so nothing to refuse');
  await assert.rejects(openPr(cfg, { branch: 'nope', title: 't', body: withStories('Stories: Pane updated; unchanged for X, because a refactor') }), /git fetch failed/, 'names the updated stories (S-1964)');
  await assert.rejects(openPr(cfg, { branch: 'tree/bare', title: 't', body: withStories('Stories: Pane updated; unchanged') }), /Stories line "Stories: Pane updated; unchanged" needs a reason/);
});

test('refuses a Gates line that merge-pr would refuse: an unknown token, before any gh call (S-1292)', async () => {
  clearCalls();
  const withGates = (line) => `ITSA: S-514\n${line}\nDeploy: normal\n\nWhat changed: the relay.\n`;
  await assert.rejects(openPr(cfg, { branch: 'feature/x', title: 't', body: withGates('Gates: tsc; frobnicate') }), (e) => e.message === 'unknown gate: frobnicate');
  await assert.rejects(openPr(cfg, { branch: 'feature/x', title: 't', body: withGates('Gates: free text about the change') }), /unknown gate: free text about the change/);
  await assert.rejects(openPr(cfg, { branch: 'feature/x', title: 't', body: withGates('Gates: none; tsc') }), /Gates: none stands alone/);
  assert.equal(existsSync(callsFile), false, 'gh never ran');
});

test('refuses a run NAME that test/run.sh does not know, with the -unit hint only when NAME-unit exists (S-1292)', async () => {
  clearCalls();
  const withGates = (line) => `ITSA: S-514\n${line}\nDeploy: normal\n\nWhat changed: the relay.\n`;
  await assert.rejects(openPr(cfg, { branch: 'feature/x', title: 't', body: withGates('Gates: tsc; run pr-open') }), (e) => e.message === 'Gates: no test pr-open in test/run.sh (did you mean pr-open-unit?)');
  await assert.rejects(openPr(cfg, { branch: 'feature/x', title: 't', body: withGates('Gates: run nosuch-thing') }), (e) => e.message === 'Gates: no test nosuch-thing in test/run.sh');
  assert.equal(existsSync(callsFile), false, 'gh never ran');
});

test('accepts a Gates line of several tokens and run names test/run.sh knows (S-1292)', async () => {
  clearCalls();
  const body = 'ITSA: S-514\nGates: tsc; run pr-open-unit proctree-unit; flow ui-x\nDeploy: normal\n\nWhat changed: the relay.\n';
  const r = await openPr(cfg, { branch: 'feature/x', title: 'S-514: relay', body });
  assert.equal(r.branch, 'feature/x');
  assert.ok(calls().some((c) => c.args[0] === 'pr' && c.args[1] === 'create'), 'gh pr create ran');
});

test('checks run e2e-NAME by the name run.sh runs (its e2e- prefix stripped) (S-1292)', async () => {
  clearCalls();
  const withGates = (line) => `ITSA: S-514\n${line}\nDeploy: normal\n\nWhat changed: the relay.\n`;
  await assert.rejects(openPr(cfg, { branch: 'feature/x', title: 't', body: withGates('Gates: run e2e-nosuch') }), (e) => e.message === 'Gates: no test e2e-nosuch in test/run.sh');
  assert.equal(existsSync(callsFile), false, 'gh never ran');
  const r = await openPr(cfg, { branch: 'feature/x', title: 'S-514: relay', body: withGates('Gates: run e2e-pr-open-unit') });
  assert.equal(r.branch, 'feature/x');
  assert.ok(calls().some((c) => c.args[0] === 'pr' && c.args[1] === 'create'), 'gh pr create ran');
});

test('refuses a run NAME when the head has no readable test/run.sh, with its own message (S-1292)', async () => {
  const mainSha = git(seed, ['rev-parse', 'main']);
  git(seed, ['checkout', '-q', '-b', 'no-runsh', mainSha]);
  rmSync(join(seed, 'test'), { recursive: true, force: true });
  git(seed, ['commit', '-qam', 'drop run.sh']);
  git(seed, ['push', '-q', join(base, 'repos', 'storage.git'), 'no-runsh']);
  git(seed, ['checkout', '-q', 'feature/x']); // the later tests commit on seed's feature/x
  clearCalls();
  const body = 'ITSA: S-514\nGates: run pr-open-unit\nDeploy: normal\n\nWhat changed: the relay.\n';
  await assert.rejects(openPr(cfg, { branch: 'no-runsh', title: 't', body }), (e) => e.message.startsWith("can't read test/run.sh at HEAD"));
  assert.equal(existsSync(callsFile), false, 'gh never ran');
});

test('links the ITSA to the PR and the branch once; an unknown ITSA is refused before any push', async () => {
  const x = await itsa.create({ title: 'Relay', by: 'human' });
  clearCalls();
  const r = await openPrHere({ branch: 'feature/x', title: 'S-514: relay', body: BODY2, itsa: x.key, by: 'human' }, undefined, cfg);
  assert.equal(r.number, 7, 'the open PR list is empty again, so the relay creates');
  const links = itsa.links(x.key);
  assert.deepEqual(links.map((l) => [l.system, l.external_id]), [['github', '7'], ['branch', 'feature/x']]);
  assert.equal(links[1].meta?.repo, 'stam2');
  // A second run on the same head adds no link.
  await openPrHere({ branch: 'feature/x', title: 'S-514: relay', body: BODY2, itsa: x.key, by: 'human' }, undefined, cfg);
  assert.equal(itsa.links(x.key).length, 2);
  // An unknown ITSA: refused before gh or git see anything.
  clearCalls();
  const pushed = originSha('feature/x');
  await assert.rejects(openPrHere({ branch: 'feature/x', title: 't', body: BODY, itsa: 'S-999', by: 'human' }, undefined, cfg), /no ITSA/);
  assert.equal(existsSync(callsFile), false);
  assert.equal(originSha('feature/x'), pushed);
});

test('parses the GitHub repo from https and ssh origin urls', async () => {
  const { parseGithubRepo, originRepo } = await import('../src/github-repo.ts');
  for (const u of ['https://github.com/acme/tool.git', 'https://github.com/acme/tool', 'git@github.com:acme/tool.git', 'ssh://git@github.com/acme/tool.git', 'https://user@github.com/acme/tool/']) {
    assert.equal(parseGithubRepo(u), 'acme/tool', u);
  }
  assert.equal(parseGithubRepo('/home/user/projects/stam2.git'), null);
  assert.equal(parseGithubRepo('https://gitlab.com/acme/tool.git'), null);
  const d = join(base, 'origin-parse');
  mkdirSync(d);
  git(d, ['init', '-q']);
  assert.equal(originRepo(d), null, 'no origin');
  git(d, ['remote', 'add', 'origin', 'git@github.com:acme/tool.git']);
  assert.equal(originRepo(d), 'acme/tool');
});

test('with storage unset and no storage remote, pushes the checkout\'s local branch; a missing local branch is refused', async () => {
  const d = join(base, 'repos');
  const local = join(d, 'local');
  git(d, ['clone', '-q', join(d, 'origin.git'), 'local']);
  git(local, ['checkout', '-q', '-b', 'local/y']);
  writeFileSync(join(local, 'b.txt'), 'y\n');
  git(local, ['add', '.']);
  git(local, ['commit', '-qm', 'local work']);
  const sha = git(local, ['rev-parse', 'HEAD']);
  const lcfg = { ...cfg, repo: local, storage: '' }; // unset storage and no `storage` remote: push the local branch
  clearCalls();
  const r = await openPr(lcfg, { branch: 'local/y', title: 't', body: BODY });
  assert.equal(r.head, sha);
  assert.equal(git(local, ['ls-remote', 'origin', 'refs/heads/local/y']).split('\t')[0], sha);
  assert.ok(calls().some((c) => c.args[1] === 'create'));
  writeFileSync(join(local, 'b.txt'), 'z\n');
  git(local, ['commit', '-qam', 'more']);
  const r2 = await openPr(lcfg, { branch: 'local/y', title: 't', body: BODY });
  assert.equal(r2.head, git(local, ['rev-parse', 'HEAD']));
  await assert.rejects(openPr(lcfg, { branch: 'nope', title: 't', body: BODY }), /rev-parse failed/);
  // A storage remote the checkout lacks (a typo) is an error, not a quiet local push.
  await assert.rejects(openPr({ ...lcfg, storage: 'storge' }, { branch: 'local/y', title: 't', body: BODY }), /git fetch failed/);
});

test('refuses to open a PR when no GitHub repo is known', async () => {
  await assert.rejects(openPr({ ...cfg, github: '' }, { branch: 'feature/x', title: 't', body: BODY }), /no GitHub repo/);
});

test('unset storage uses the checkout\'s `storage` remote when it has one and a storage peer is configured', async () => {
  (await import('../src/settings.ts')).setSetting('peers', [{ name: 'storage', url: 'http://storage:7878', token: 't' }]);
  clearCalls();
  const r = await openPr({ ...cfg, storage: '' }, { branch: 'feature/x', title: 't', body: BODY });
  assert.equal(r.head, git(work, ['rev-parse', 'refs/stam/pr-open/feature/x']), 'fetched from storage into the scratch ref');
});

test('a caller on the home takes the local branch though the checkout has a storage remote; a named storage still wins', async () => {
  git(work, ['checkout', '-q', '-b', 'local/home']);
  writeFileSync(join(work, 'home.txt'), 'h\n');
  git(work, ['add', '.']);
  git(work, ['commit', '-qm', 'home-only work']);
  const sha = git(work, ['rev-parse', 'HEAD']);
  git(work, ['checkout', '-q', '-']);
  // Storage has no such branch. Callers are looked up in the agent registry, as the daemon's route gives `by`.
  const { MACHINE } = await import('../src/config.ts');
  const db = await import('../src/db.ts');
  const agent = (id, machine) => db.createAgent({ id, name: id, role: 'developer', machine, harness: 'claude', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  agent('homedev', MACHINE);
  agent('stordev', 'some-other-machine');
  const open = (by, c) => openPrHere({ branch: 'local/home', title: 't', body: BODY, by }, undefined, c);
  const unset = { ...cfg, storage: '' };
  await assert.rejects(open('stordev', unset), /git fetch failed/, 'a caller on another machine fetches from storage');
  clearCalls();
  const r = await open('homedev', unset);
  assert.equal(r.head, sha, 'a caller on the home takes the local branch');
  assert.equal(originSha('local/home'), sha);
  await assert.rejects(open('homedev', { ...cfg, storage: 'storage' }), /git fetch failed/, 'an explicit storage is fetched from for every caller');
});

// S-673: a re-run may replace GitHub's head only when it's the head stam last pushed, or its ancestor.
const repos = () => join(base, 'repos');
const origin = () => join(repos(), 'origin.git');
const headOf = (dir) => git(dir, ['rev-parse', 'HEAD']);

test('a re-run after a GitHub-only commit is refused, and GitHub is untouched', async () => {
  // GitHub's head is the one stam pushed last (the test above). Someone commits a fix there; storage moves on without it.
  const pushed = originSha('feature/x');
  const fixDir = join(repos(), 'gh-fix');
  git(repos(), ['clone', '-q', '-b', 'feature/x', origin(), 'gh-fix']);
  writeFileSync(join(fixDir, 'b.txt'), 'fix on GitHub\n');
  git(fixDir, ['add', '.']);
  git(fixDir, ['commit', '-qm', 'fix on GitHub']);
  git(fixDir, ['push', '-q', 'origin', 'feature/x']);
  const fix = headOf(fixDir);
  assert.notEqual(fix, pushed);
  writeFileSync(join(seed, 'a.txt'), 'storage moves on\n');
  git(seed, ['commit', '-qam', 'storage moves on']);
  git(seed, ['push', '-q', join(repos(), 'storage.git'), 'feature/x']);
  const head = headOf(seed);
  clearCalls();
  await assert.rejects(
    openPr(cfg, { branch: 'feature/x', title: 't', body: BODY }),
    (e) => {
      assert.match(e.message, new RegExp(`GitHub's feature/x is at ${fix.slice(0, 8)}, which isn't in your branch \\(${head.slice(0, 8)}\\)`));
      return true;
    },
  );
  assert.equal(originSha('feature/x'), fix, 'GitHub keeps its fix');
  assert.equal(existsSync(callsFile), false, 'gh never ran');
});

test('a fast-forward re-run pushes: the new head contains GitHub\'s head', async () => {
  // Storage takes GitHub's fix in with a merge, so GitHub's head is an ancestor of the new head.
  const fix = originSha('feature/x');
  git(seed, ['fetch', '-q', origin(), 'feature/x']);
  git(seed, ['merge', '-q', '--no-edit', fix]);
  git(seed, ['push', '-q', join(repos(), 'storage.git'), 'feature/x']);
  const head = headOf(seed);
  clearCalls();
  const r = await openPr(cfg, { branch: 'feature/x', title: 't', body: BODY2 });
  assert.equal(r.head, head);
  assert.equal(originSha('feature/x'), head);
  assert.equal(calls().some((c) => c.args[1] === 'create'), true, 'the open PR list is empty, so it was created');
});

test('a re-run may rewrite the head stam last pushed, though GitHub\'s head is not an ancestor', async () => {
  // Storage's branch is rewritten on the commit before the merge: stam's last push is GitHub's head, so the check allows it.
  const last = originSha('feature/x');
  git(seed, ['reset', '-q', '--hard', 'HEAD~1']);
  writeFileSync(join(seed, 'a.txt'), 'rewritten\n');
  git(seed, ['commit', '-qam', 'rewritten']);
  git(seed, ['push', '-q', '--force', join(repos(), 'storage.git'), 'feature/x']);
  const head = headOf(seed);
  const r = await openPr(cfg, { branch: 'feature/x', title: 't', body: BODY2 });
  assert.equal(r.head, head);
  assert.equal(originSha('feature/x'), head);
  assert.notEqual(last, head);
});

test('pr_open sets the ITSA stage to review when the field exists; a refused move still opens the PR (S-924)', async () => {
  const proc = await import('../src/process.ts');
  const agentTypes = await import('../src/agent-types.ts');
  const { processes } = proc.loadProcesses(join(import.meta.dirname, '..', 'processes'), { knownTypes: new Set(Object.keys(agentTypes.agentTypes())) });
  itsa.guardChange(proc.stageGuard(() => processes), { fields: true });
  const kinds = { kind: 'issue' };
  // No stage field yet: the PR opens and nothing is set.
  const a = await itsa.create({ title: 'No field', ...kinds, by: 'human' });
  await openPrHere({ branch: 'feature/x', title: 't', body: BODY2, itsa: a.key, by: 'human' }, undefined, cfg);
  await itsa.createField({ key: 'stage', label: 'Stage', type: 'choice', options: ['route', 'plan', 'code', 'review', 'merge', 'deploy', 'hold', 'ask', 'done'].map((value) => ({ value })) }, 'human');
  assert.equal((await itsa.get(a.key)).fields.stage, undefined);
  // From code, review is the next node.
  const b = await itsa.create({ title: 'From code', ...kinds, fields: { stage: 'code' }, by: 'human' });
  await openPrHere({ branch: 'feature/x', title: 't', body: BODY2, itsa: b.key, by: 'human' }, undefined, cfg);
  assert.equal((await itsa.get(b.key)).fields.stage, 'review');
  // From route, review skips nodes: the guard refuses, the PR still opens and is linked.
  const c = await itsa.create({ title: 'From route', ...kinds, fields: { stage: 'route' }, by: 'human' });
  const r = await openPrHere({ branch: 'feature/x', title: 't', body: BODY2, itsa: c.key, by: 'human' }, undefined, cfg);
  assert.equal(typeof r.number, 'number');
  assert.equal((await itsa.get(c.key)).fields.stage, 'route');
  assert.equal(itsa.links(c.key).some((l) => l.system === 'github'), true);
});

// S-899: a create that times out after GitHub opened the PR reports that PR, not a failure.
test('a create that times out after the PR opened returns that PR, with its body checked and the header kept', async () => {
  writeFileSync(join(ghDir, 'create-times-out'), '');
  writeFileSync(join(ghDir, 'view-body.txt'), BODY2);
  try {
    clearCalls();
    const r = await openPr(cfg, { branch: 'feature/x', title: 'S-514: relay', body: BODY2 });
    assert.deepEqual(r, { number: 9, url: 'https://github.com/example/stam/pull/9', created: true, branch: 'feature/x', head: git(seed, ['rev-parse', 'HEAD']) });
    assert.ok(calls().some((c) => c.args[1] === 'create'), 'the create ran and timed out');
    assert.equal(calls().some((c) => c.args.includes('PATCH')), false, 'the body already has its header: no PATCH');
    // A body without the header (an older run's) is replaced with the one this run sends.
    writeFileSync(join(ghDir, 'view-body.txt'), 'Something else\n');
    rmSync(join(ghDir, 'list.json'), { force: true });
    clearCalls();
    const r2 = await openPr(cfg, { branch: 'feature/x', title: 'S-514: relay', body: BODY2 });
    assert.equal(r2.number, 9);
    const patch = calls().find((c) => c.args.includes('PATCH'));
    assert.deepEqual(patch.args.slice(0, 4), ['api', '-X', 'PATCH', 'repos/example/stam/pulls/9']);
    assert.equal(patch.body, BODY2);
  } finally {
    rmSync(join(ghDir, 'create-times-out'), { force: true });
    rmSync(join(ghDir, 'view-body.txt'), { force: true });
    rmSync(join(ghDir, 'list.json'), { force: true });
  }
});

test("a create that fails with no PR open on the head reports the create's failure", async () => {
  writeFileSync(join(ghDir, 'create-fails'), '');
  try {
    clearCalls();
    await assert.rejects(openPr(cfg, { branch: 'feature/x', title: 'S-514: relay', body: BODY2 }), /aborted due to timeout/);
    assert.equal(calls().some((c) => c.args.includes('PATCH')), false, 'nothing to patch');
  } finally {
    rmSync(join(ghDir, 'create-fails'), { force: true });
  }
});

// A caller whose pr_open timed out asks what GitHub holds (S-1332): the open PR, its head, and whether the body and the
// ITSA's links were written. Nothing is created or changed here.
test('reports the open PR on the branch after a timeout: its head, whether the body and the ITSA links were written (S-1332)', async () => {
  const x = await itsa.create({ title: 'Status', by: 'human' });
  const y = await itsa.create({ title: 'Unlinked', by: 'human' });
  await itsa.addLink(x.key, { system: 'github', url: 'https://github.com/example/stam/pull/7', external_id: '7' }, 'human');
  await itsa.addLink(x.key, { system: 'branch', external_id: 'feature/x', repo: 'stam2', url: '' }, 'human');
  writeFileSync(join(ghDir, 'list.json'), JSON.stringify([{ number: 7, url: 'https://github.com/example/stam/pull/7' }]));
  writeFileSync(join(ghDir, 'view-body.txt'), BODY);
  writeFileSync(join(ghDir, 'view-head.txt'), featureSha);
  try {
    clearCalls();
    assert.deepEqual(await prStatusHere({ branch: 'feature/x', body: BODY, itsa: x.key }, undefined, cfg), {
      found: true, branch: 'feature/x', number: 7, url: 'https://github.com/example/stam/pull/7', head: featureSha, body_written: true, itsa_linked: true,
    });
    // A body other than the one asked about is reported as not written; an ITSA without the links says so.
    assert.deepEqual(await prStatusHere({ branch: 'feature/x', body: BODY2, itsa: y.key }, undefined, cfg), {
      found: true, branch: 'feature/x', number: 7, url: 'https://github.com/example/stam/pull/7', head: featureSha, body_written: false, itsa_linked: false,
    });
    // No body or ITSA asked about: those fields are null, not false.
    assert.deepEqual(await prStatusHere({ branch: 'feature/x' }, undefined, cfg), {
      found: true, branch: 'feature/x', number: 7, url: 'https://github.com/example/stam/pull/7', head: featureSha, body_written: null, itsa_linked: null,
    });
    assert.equal(calls().some((c) => c.args[1] === 'create' || c.args.includes('PATCH')), false, 'read only: no create, no PATCH');
    // No open PR on the head: found is false, so the caller knows to run pr_open again.
    rmSync(join(ghDir, 'list.json'));
    assert.deepEqual(await prStatusHere({ branch: 'feature/x', body: BODY, itsa: x.key }, undefined, cfg), { found: false, branch: 'feature/x' });
  } finally {
    rmSync(join(ghDir, 'view-body.txt'), { force: true });
    rmSync(join(ghDir, 'view-head.txt'), { force: true });
    rmSync(join(ghDir, 'list.json'), { force: true });
  }
});

// The MCP tool's timeout fallback (S-1332): a stubbed fetch stands in for the daemon. A timeout, local or
// from the home, asks what GitHub holds; any other error is thrown as it was.
async function prOpenTool(replies) {
  const { callTool } = await import('../src/mcp.ts');
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    seen.push(path);
    const r = replies[path];
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const r = await callTool('pr_open', { self: 'pr-open-test', branch: 'feature/x', title: 't', body: BODY });
    return { text: r.content[0].text, seen };
  } catch (e) {
    return { error: e, seen };
  } finally {
    globalThis.fetch = realFetch;
  }
}
const OPEN = '/api/pr/open';
const STATUS = '/api/pr/open-status';
const found = { found: true, branch: 'feature/x', number: 7, url: 'https://github.com/example/stam/pull/7', head: 'abc123', body_written: true, itsa_linked: null };

test('pr_open after a local timeout reports the PR on the branch, with its body written (S-1332)', async () => {
  const r = await prOpenTool({ [OPEN]: new DOMException('The operation was aborted due to timeout', 'TimeoutError'), [STATUS]: { body: found } });
  assert.deepEqual(r.seen, [OPEN, STATUS]);
  assert.match(r.text, /pr_open timed out \(The operation was aborted due to timeout\), but PR #7 is open on feature\/x: https:\/\/github.com\/example\/stam\/pull\/7/);
  assert.match(r.text, /head abc123; body written; ITSA link n\/a\./);
});

test('pr_open whose home timed out (HTTP 400 with the timeout text) gets the same report, with a body not written flagged (S-1332)', async () => {
  const r = await prOpenTool({ [OPEN]: { status: 400, body: { error: 'The operation was aborted due to timeout' } }, [STATUS]: { body: { ...found, body_written: false } } });
  assert.deepEqual(r.seen, [OPEN, STATUS]);
  assert.match(r.text, /PR #7 is open/);
  assert.match(r.text, /body NOT written: run pr_open again/);
});

test('pr_open after a timeout with no open PR on the branch says so and that a retry is safe (S-1332)', async () => {
  const r = await prOpenTool({ [OPEN]: new DOMException('The operation was aborted due to timeout', 'TimeoutError'), [STATUS]: { body: { found: false, branch: 'feature/x' } } });
  assert.match(r.text, /no open PR is on feature\/x yet\. pr_open is safe to run again/);
});

test('pr_open after a timeout whose status lookup fails says so, with the branch to check on GitHub (S-1332)', async () => {
  const r = await prOpenTool({ [OPEN]: new DOMException('The operation was aborted due to timeout', 'TimeoutError'), [STATUS]: { status: 500, body: { error: 'daemon down' } } });
  assert.equal(r.error, undefined, 'the timeout is reported, not thrown');
  assert.match(r.text, /pr_open timed out \(.*\), and the status lookup failed too \(daemon down\)\. Check GitHub for an open PR on feature\/x/);
});

test('pr_open refused with an ordinary error throws it, and does not look anything up (S-1332)', async () => {
  const r = await prOpenTool({ [OPEN]: { status: 400, body: { error: 'no ITSA S-9' } } });
  assert.equal(r.error?.message, 'no ITSA S-9');
  assert.deepEqual(r.seen, [OPEN], 'no status lookup on a refusal');
});
// S-1347: the head mirror. A PR's head lands on storage's bare repo as refs/pull/N/head; no branch there moves.
const storageDir = () => join(repos(), 'storage.git');
const storageRef = (ref) => git(storageDir(), ['rev-parse', '--verify', ref]);
const hasRef = (dir, ref) => {
  try {
    git(dir, ['rev-parse', '--verify', '-q', ref]);
    return true;
  } catch {
    return false;
  }
};
const branchesOf = (dir) => git(dir, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);

test('pr_open mirrors the head to storage as refs/pull/N/head, and no branch on storage moves (S-1347)', async () => {
  // The open PR for the head is #8 (the update path), so the mirror is for 8.
  writeFileSync(join(ghDir, 'list.json'), JSON.stringify([{ number: 8, url: 'https://github.com/example/stam/pull/8' }]));
  try {
    const head = git(storageDir(), ['rev-parse', 'refs/heads/feature/x']);
    const before = branchesOf(storageDir());
    clearCalls();
    const r = await openPr(cfg, { branch: 'feature/x', title: 't', body: BODY2 });
    assert.equal(r.number, 8);
    await waitUntil(() => hasRef(storageDir(), 'refs/pull/8/head'));
    assert.equal(storageRef('refs/pull/8/head'), head);
    assert.equal(branchesOf(storageDir()), before, 'refs/heads on storage are untouched');
  } finally {
    rmSync(join(ghDir, 'list.json'), { force: true });
  }
});

test('only a branch that came from storage is mirrored: a home caller skips it, a storage caller and a named storage mirror (S-1417)', async () => {
  const { MACHINE } = await import('../src/config.ts');
  const db = await import('../src/db.ts');
  const { mirrorsIdle } = await import('../src/pr-mirror.ts');
  const agent = (id, machine) => db.createAgent({ id, name: id, role: 'developer', machine, harness: 'claude', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  agent('mirrorhome', MACHINE);
  agent('mirrorstor', 'some-other-machine');
  const prList = (number) => writeFileSync(join(ghDir, 'list.json'), JSON.stringify([{ number, url: `https://github.com/example/stam/pull/${number}` }]));
  const open = (branch, by, c) => openPrHere({ branch, title: 't', body: BODY2, by }, undefined, c);
  try {
    // The home caller's branch is local/home (it exists only in the checkout): opened, and nothing pushed to storage.
    prList(31);
    const r = await open('local/home', 'mirrorhome', { ...cfg, storage: '' });
    assert.equal(r.number, 31);
    await mirrorsIdle();
    assert.equal(hasRef(storageDir(), 'refs/pull/31/head'), false, 'a home developer\'s PR is not mirrored');
    // A storage caller's branch came from storage: mirrored.
    prList(32);
    const s = await open('feature/x', 'mirrorstor', { ...cfg, storage: '' });
    await mirrorsIdle();
    assert.equal(storageRef('refs/pull/32/head'), s.head, 'a storage developer\'s PR is mirrored');
    // A storage the settings name is used for every caller, the mirror included.
    prList(33);
    const n = await open('feature/x', 'mirrorhome', { ...cfg, storage: 'storage' });
    await mirrorsIdle();
    assert.equal(storageRef('refs/pull/33/head'), n.head, 'a named storage mirrors for a home caller too');
  } finally {
    rmSync(join(ghDir, 'list.json'), { force: true });
  }
});

test('a failing mirror push does not fail pr_open: the PR is still returned (S-1347)', async () => {
  // storage refuses any ref under refs/pull/, as a rejected push would; the fetch and the PR still work.
  // The hook records each refused refs/pull push, so the test can tell the push ran and was refused.
  const attempts = join(base, 'refused-attempts.txt');
  rmSync(attempts, { force: true });
  const hook = join(storageDir(), 'hooks', 'pre-receive');
  writeFileSync(hook, `#!/bin/sh\nwhile read old new ref; do case "$ref" in refs/pull/*) echo "$ref" >> ${JSON.stringify(attempts)}; echo "no mirror here" >&2; exit 1;; esac; done\n`);
  chmodSync(hook, 0o755);
  writeFileSync(join(ghDir, 'list.json'), JSON.stringify([{ number: 11, url: 'https://github.com/example/stam/pull/11' }]));
  try {
    clearCalls();
    const r = await openPr(cfg, { branch: 'feature/x', title: 't', body: BODY2 });
    assert.equal(r.number, 11);
    assert.equal(r.url, 'https://github.com/example/stam/pull/11');
    const { mirrorsIdle } = await import('../src/pr-mirror.ts');
    await mirrorsIdle();
    assert.match(readFileSync(attempts, 'utf8'), /^refs\/pull\/11\/head$/m, 'the mirror push reached storage and was refused');
    assert.equal(hasRef(storageDir(), 'refs/pull/11/head'), false, 'the ref is absent');
    assert.ok(calls().some((c) => c.args.includes('PATCH')), 'the PR body was still replaced');
  } finally {
    rmSync(hook, { force: true });
    rmSync(join(ghDir, 'list.json'), { force: true });
  }
});

test('with no storage remote, the mirror is a no-op and pr_open still opens the PR (S-1347)', async () => {
  const d = join(base, 'repos');
  const local = join(d, 'local-nostorage');
  git(d, ['clone', '-q', join(d, 'origin.git'), 'local-nostorage']);
  git(local, ['checkout', '-q', '-b', 'local/z']);
  writeFileSync(join(local, 'c.txt'), 'z\n');
  git(local, ['add', '.']);
  git(local, ['commit', '-qm', 'local z']);
  clearCalls();
  const r = await openPr({ ...cfg, repo: local, storage: '' }, { branch: 'local/z', title: 't', body: BODY });
  assert.equal(r.branch, 'local/z');
  assert.equal(hasRef(join(d, 'origin.git'), `refs/pull/${r.number}/head`), false, 'nothing mirrored to origin');
});

test('a GitHub PR event mirrors that PR head, fetched from origin first; other subjects do nothing (S-1347)', async () => {
  const { mirrorPrFromEvent } = await import('../src/pr-mirror.ts');
  // A commit only GitHub has: on origin as PR 12's head, not on storage and not in the checkout.
  writeFileSync(join(seed, 'a.txt'), 'github only\n');
  git(seed, ['commit', '-qam', 'github only']);
  const sha = git(seed, ['rev-parse', 'HEAD']);
  git(seed, ['push', '-q', origin(), `${sha}:refs/pull/12/head`]);
  const hasObject = (dir, s) => {
    try {
      git(dir, ['cat-file', '-e', s]);
      return true;
    } catch {
      return false;
    }
  };
  assert.equal(hasObject(work, sha), false, 'the checkout lacks the commit');
  await mirrorPrFromEvent(cfg, 'github:example/stam#12');
  assert.equal(storageRef('refs/pull/12/head'), sha);
  assert.equal(scratchRefs(), '', 'the scratch ref is dropped');
  // Another repo's PR, and a subject that isn't a PR, are left alone.
  await mirrorPrFromEvent(cfg, 'github:someone/else#12');
  await mirrorPrFromEvent(cfg, 'github:example/stam');
  assert.equal(hasRef(storageDir(), 'refs/pull/13/head'), false);
});

test('a GitHub PR event whose head can\'t be fetched is logged, never thrown (S-1347)', async () => {
  const { mirrorPrFromEvent } = await import('../src/pr-mirror.ts');
  await mirrorPrFromEvent(cfg, 'github:example/stam#99');
  assert.equal(hasRef(storageDir(), 'refs/pull/99/head'), false);
  assert.equal(scratchRefs(), '', 'the scratch ref is dropped');
});

// S-1347 review: a bad number or sha is refused before any refspec, a stalled push gives up within its budget, and
// overlapping mirrors of one PR end on the newest head with no scratch ref left.
const scratchRefs = () => git(work, ['for-each-ref', '--format=%(refname)', 'refs/stam/pr-mirror']);

test('refuses a PR number or a head that is not a positive integer or a full sha, pushing nothing (S-1347)', async () => {
  const { checkMirror, mirrorPrHead } = await import('../src/pr-mirror.ts');
  for (const n of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 2]) assert.throws(() => checkMirror(n, featureSha), /positive integer/, String(n));
  for (const s of ['abc', 'g'.repeat(40), featureSha.slice(0, 39), `${featureSha}0`, featureSha.toUpperCase(), '']) {
    assert.throws(() => checkMirror(3, s), /40-character sha/, JSON.stringify(s));
  }
  checkMirror(3, featureSha);
  await mirrorPrHead(cfg, 0, featureSha);
  await mirrorPrHead(cfg, 16, 'nope');
  assert.equal(hasRef(storageDir(), 'refs/pull/0/head'), false);
  assert.equal(hasRef(storageDir(), 'refs/pull/16/head'), false);
});

test('overlapping mirrors of one PR end on the newest head, and leave no scratch ref (S-1347)', async () => {
  const { mirrorPrFromEvent, mirrorPrHead } = await import('../src/pr-mirror.ts');
  writeFileSync(join(seed, 'a.txt'), 'overlap\n');
  git(seed, ['commit', '-qam', 'overlap']);
  const sha = git(seed, ['rev-parse', 'HEAD']);
  git(seed, ['push', '-q', origin(), `${sha}:refs/pull/15/head`]);
  git(work, ['fetch', '-q', '--no-tags', origin(), '+refs/pull/15/head:refs/stam/t15']);
  // Three requests in one tick: the two events and the sha, which is the last, so the sha is what lands.
  await Promise.all([
    mirrorPrFromEvent(cfg, 'github:example/stam#15'),
    mirrorPrFromEvent(cfg, 'github:example/stam#15'),
    mirrorPrHead(cfg, 15, sha),
  ]);
  git(work, ['update-ref', '-d', 'refs/stam/t15']);
  assert.equal(storageRef('refs/pull/15/head'), sha);
  assert.equal(scratchRefs(), '');
});

test('a stalled storage push gives up within its budget and does not hold the caller (S-1347)', async () => {
  const { mirrorPrHead } = await import('../src/pr-mirror.ts');
  // A remote helper that hangs: the push runs until the budget kills it.
  const helpers = join(base, 'stall-bin');
  mkdirSync(helpers, { recursive: true });
  writeFileSync(join(helpers, 'git-remote-stall'), '#!/bin/sh\nexec sleep 5 2>/dev/null\n');
  chmodSync(join(helpers, 'git-remote-stall'), 0o755);
  git(work, ['remote', 'add', 'stall', 'stall::x']);
  const { PATH, STAM_MIRROR_TIMEOUT_MS } = process.env;
  process.env.PATH = `${helpers}:${PATH}`;
  process.env.STAM_MIRROR_TIMEOUT_MS = '300';
  try {
    const t0 = Date.now();
    await mirrorPrHead({ ...cfg, storage: 'stall' }, 17, featureSha);
    assert.ok(Date.now() - t0 < 3000, 'returned at the budget, not when the helper exits');
    assert.equal(hasRef(storageDir(), 'refs/pull/17/head'), false);
  } finally {
    process.env.PATH = PATH;
    if (STAM_MIRROR_TIMEOUT_MS === undefined) delete process.env.STAM_MIRROR_TIMEOUT_MS;
    else process.env.STAM_MIRROR_TIMEOUT_MS = STAM_MIRROR_TIMEOUT_MS;
    git(work, ['remote', 'remove', 'stall']);
  }
});

// S-1347 review round 2: latest wins, one deadline per job, and pr_open never waits on the mirror.
async function waitUntil(pred, tries = 200) {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail('the condition never held');
}

// A remote helper that hangs, so a git command using `name` runs until its job's deadline kills it.
function stallRemote(name) {
  const helpers = join(base, 'stall-bin');
  mkdirSync(helpers, { recursive: true });
  writeFileSync(join(helpers, `git-remote-${name}`), '#!/bin/sh\nexec sleep 5 2>/dev/null\n');
  chmodSync(join(helpers, `git-remote-${name}`), 0o755);
  git(work, ['remote', 'add', name, `${name}::x`]);
  return helpers;
}

test('a newer head requested while an older job is stalled still ends on the newer one (S-1347)', async () => {
  const { mirrorPrFromEvent } = await import('../src/pr-mirror.ts');
  writeFileSync(join(seed, 'a.txt'), 'newer head\n');
  git(seed, ['commit', '-qam', 'newer head']);
  const sha = git(seed, ['rev-parse', 'HEAD']);
  git(seed, ['push', '-q', origin(), `${sha}:refs/pull/16/head`]);
  const helpers = stallRemote('stallorigin');
  const { PATH, STAM_MIRROR_TIMEOUT_MS } = process.env;
  process.env.PATH = `${helpers}:${PATH}`;
  process.env.STAM_MIRROR_TIMEOUT_MS = '300';
  try {
    // The older job starts and its fetch from the stalled origin hangs; the newer request arrives meanwhile.
    const older = mirrorPrFromEvent({ ...cfg, origin: 'stallorigin' }, 'github:example/stam#16');
    await new Promise((r) => setImmediate(r));
    const newer = mirrorPrFromEvent(cfg, 'github:example/stam#16');
    await Promise.all([older, newer]);
    assert.equal(storageRef('refs/pull/16/head'), sha);
    assert.equal(scratchRefs(), '');
  } finally {
    process.env.PATH = PATH;
    if (STAM_MIRROR_TIMEOUT_MS === undefined) delete process.env.STAM_MIRROR_TIMEOUT_MS;
    else process.env.STAM_MIRROR_TIMEOUT_MS = STAM_MIRROR_TIMEOUT_MS;
    git(work, ['remote', 'remove', 'stallorigin']);
  }
});

test('a burst of requests for one PR runs one push, of the last sha (S-1347)', async () => {
  const { mirrorPrHead } = await import('../src/pr-mirror.ts');
  const shas = [];
  for (const t of ['burst 1', 'burst 2', 'burst 3']) {
    writeFileSync(join(seed, 'a.txt'), `${t}\n`);
    git(seed, ['commit', '-qam', t]);
    shas.push(git(seed, ['rev-parse', 'HEAD']));
  }
  // Each sha is an ancestor of the last, so fetching the seed's HEAD brings all three into the checkout.
  git(work, ['fetch', '-q', '--no-tags', seed, 'HEAD']);
  // The storage hook logs each ref it receives, so the test counts the pushes.
  const log = join(base, 'burst-pushes.txt');
  const hook = join(storageDir(), 'hooks', 'pre-receive');
  rmSync(log, { force: true });
  writeFileSync(hook, `#!/bin/sh\nwhile read old new ref; do echo "$ref $new" >> ${JSON.stringify(log)}; done\nexit 0\n`);
  chmodSync(hook, 0o755);
  try {
    await Promise.all(shas.map((s) => mirrorPrHead(cfg, 19, s)));
    const pushes = readFileSync(log, 'utf8').trim().split('\n').filter((l) => l.startsWith('refs/pull/19/head'));
    assert.deepEqual(pushes, [`refs/pull/19/head ${shas[2]}`]);
    assert.equal(storageRef('refs/pull/19/head'), shas[2]);
  } finally {
    rmSync(hook, { force: true });
  }
});

test('pr_open returns while its storage push is still held (S-1347)', async () => {
  const release = join(base, 'release-20');
  const done = join(base, 'hook-done-20');
  rmSync(release, { force: true });
  rmSync(done, { force: true });
  // The hook holds the refs/pull push until the test releases it, or gives up after about 5 s.
  const hook = join(storageDir(), 'hooks', 'pre-receive');
  writeFileSync(
    hook,
    `#!/bin/sh\nwhile read old new ref; do case "$ref" in refs/pull/*) n=0; while [ ! -e ${JSON.stringify(release)} ] && [ $n -lt 100 ]; do sleep 0.05; n=$((n+1)); done; touch ${JSON.stringify(done)};; esac; done\nexit 0\n`,
  );
  chmodSync(hook, 0o755);
  writeFileSync(join(ghDir, 'list.json'), JSON.stringify([{ number: 20, url: 'https://github.com/example/stam/pull/20' }]));
  try {
    const r = await openPr(cfg, { branch: 'feature/x', title: 't', body: BODY2 });
    assert.equal(r.number, 20);
    assert.equal(existsSync(done), false, 'pr_open returned before the held push finished');
    writeFileSync(release, '');
    await waitUntil(() => existsSync(done));
    await waitUntil(() => hasRef(storageDir(), 'refs/pull/20/head'));
  } finally {
    rmSync(hook, { force: true });
    rmSync(join(ghDir, 'list.json'), { force: true });
    rmSync(release, { force: true });
    rmSync(done, { force: true });
  }
});

test('a push that ignores TERM still lands no older head after a newer one (S-1347)', async () => {
  const { mirrorPrFromEvent, mirrorPrHead } = await import('../src/pr-mirror.ts');
  writeFileSync(join(seed, 'a.txt'), 'stubborn newer\n');
  git(seed, ['commit', '-qam', 'stubborn newer']);
  const newer = git(seed, ['rev-parse', 'HEAD']);
  git(seed, ['push', '-q', origin(), `${newer}:refs/pull/21/head`]);
  // A remote helper that ignores TERM for its whole run: only the group's KILL ends its push.
  const helpers = join(base, 'stubborn-bin');
  mkdirSync(helpers, { recursive: true });
  writeFileSync(join(helpers, 'git-remote-stubborn'), "#!/bin/sh\ntrap '' TERM\nsleep 3\n");
  chmodSync(join(helpers, 'git-remote-stubborn'), 0o755);
  git(work, ['remote', 'add', 'stubborn', 'stubborn::x']);
  const { PATH, STAM_MIRROR_TIMEOUT_MS } = process.env;
  process.env.PATH = `${helpers}:${PATH}`;
  process.env.STAM_MIRROR_TIMEOUT_MS = '300';
  try {
    // The older head's push starts and hangs past its deadline; the newer request arrives while it is still running.
    const older = mirrorPrHead({ ...cfg, storage: 'stubborn' }, 21, featureSha);
    await new Promise((r) => setImmediate(r));
    const later = mirrorPrFromEvent(cfg, 'github:example/stam#21');
    await Promise.all([older, later]);
    assert.equal(storageRef('refs/pull/21/head'), newer);
  } finally {
    process.env.PATH = PATH;
    if (STAM_MIRROR_TIMEOUT_MS === undefined) delete process.env.STAM_MIRROR_TIMEOUT_MS;
    else process.env.STAM_MIRROR_TIMEOUT_MS = STAM_MIRROR_TIMEOUT_MS;
    git(work, ['remote', 'remove', 'stubborn']);
  }
});

test('an older head whose push ignores TERM and lands after a newer head does not overwrite it (S-1347)', async () => {
  const { mirrorPrHead } = await import('../src/pr-mirror.ts');
  writeFileSync(join(seed, 'a.txt'), 'delayed newer\n');
  git(seed, ['commit', '-qam', 'delayed newer']);
  const newer = git(seed, ['rev-parse', 'HEAD']);
  git(work, ['fetch', '-q', '--no-tags', seed, 'HEAD']);
  // git, except that a push of the older head ignores TERM, sleeps past the deadline, and then really pushes: it
  // reaches storage after the newer head would have, unless the newer push waits for it.
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = join(base, 'delayed-bin');
  const started = join(base, 'delayed-started');
  const finished = join(base, 'delayed-finished');
  mkdirSync(bin, { recursive: true });
  rmSync(started, { force: true });
  rmSync(finished, { force: true });
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh\nREAL=${JSON.stringify(realGit)}\ncase "$1" in\npush) case "$3" in +${featureSha}:*) trap '' TERM; touch ${JSON.stringify(started)}; sleep 0.5; "$REAL" "$@"; rc=$?; touch ${JSON.stringify(finished)}; exit $rc;; esac;;\nesac\nexec "$REAL" "$@"\n`,
  );
  chmodSync(join(bin, 'git'), 0o755);
  const { PATH, STAM_MIRROR_TIMEOUT_MS } = process.env;
  process.env.PATH = `${bin}:${PATH}`;
  process.env.STAM_MIRROR_TIMEOUT_MS = '200';
  try {
    const older = mirrorPrHead(cfg, 22, featureSha);
    await waitUntil(() => existsSync(started));
    const later = mirrorPrHead(cfg, 22, newer);
    await Promise.all([older, later]);
    // The older push really runs to its end after the newer one has landed: wait for it, then check the ref.
    await waitUntil(() => existsSync(finished));
    assert.equal(storageRef('refs/pull/22/head'), newer);
  } finally {
    process.env.PATH = PATH;
    if (STAM_MIRROR_TIMEOUT_MS === undefined) delete process.env.STAM_MIRROR_TIMEOUT_MS;
    else process.env.STAM_MIRROR_TIMEOUT_MS = STAM_MIRROR_TIMEOUT_MS;
  }
});

// S-1389: a merge moves storage's refs/heads/main to GitHub's main, fast-forward only. Local bare repos only.
test('a merge moves storage main to GitHub main, fast-forward only; a non-fast-forward is refused (S-1389)', async () => {
  const { mirrorMain } = await import('../src/pr-mirror.ts');
  const originDir = join(repos(), 'origin.git');
  // Storage's main starts at GitHub's main, as after a deploy.
  const m1 = git(work, ['rev-parse', 'origin/main']);
  git(work, ['push', '-q', 'storage', `${m1}:refs/heads/main`]);
  // A PR merges on GitHub: origin's main moves on by one commit.
  git(seed, ['checkout', '-q', '--detach', m1]);
  writeFileSync(join(seed, 'merged.txt'), 'merged\n');
  git(seed, ['add', '.']);
  git(seed, ['commit', '-qm', 'merged']);
  const m2 = git(seed, ['rev-parse', 'HEAD']);
  git(seed, ['push', '-q', originDir, `${m2}:refs/heads/main`]);
  await mirrorMain(cfg);
  assert.equal(storageRef('refs/heads/main'), m2, 'storage main moved to GitHub main');
  assert.equal(git(work, ['for-each-ref', '--format=%(refname)', 'refs/stam/pr-mirror']), '', 'the scratch refs are gone');

  // Storage's main moves to a commit GitHub's main doesn't have (a sibling of m2) and GitHub's main moves to another.
  writeFileSync(join(seed, 'storage-only.txt'), 'storage\n');
  git(seed, ['add', '.']);
  git(seed, ['commit', '-qm', 'storage only']);
  const storageOnly = git(seed, ['rev-parse', 'HEAD']);
  git(seed, ['push', '-q', storageDir(), `${storageOnly}:refs/heads/main`]);
  git(seed, ['checkout', '-q', '--detach', m2]);
  writeFileSync(join(seed, 'github-only.txt'), 'github\n');
  git(seed, ['add', '.']);
  git(seed, ['commit', '-qm', 'github only']);
  const m3 = git(seed, ['rev-parse', 'HEAD']);
  git(seed, ['push', '-q', originDir, `${m3}:refs/heads/main`]);
  await mirrorMain(cfg);
  assert.equal(storageRef('refs/heads/main'), storageOnly, 'a diverged storage main is not overwritten');
  assert.equal(git(originDir, ['rev-parse', 'refs/heads/main']), m3, 'GitHub main is untouched');
});

// A branch cut from the seed's main (behind origin's main by now, so its merge base is older than main), with the files
// written and pushed to storage. The stories and export-overrides checks run on it (S-1942).
function treeBranch(name, files) {
  git(seed, ['checkout', '-q', '-B', name, 'main']);
  for (const [p, s] of Object.entries(files)) {
    mkdirSync(dirname(join(seed, p)), { recursive: true });
    writeFileSync(join(seed, p), s);
  }
  git(seed, ['add', '.']);
  git(seed, ['commit', '-qm', name]);
  git(seed, ['push', '-q', '-f', storageDir(), name]);
  return git(seed, ['rev-parse', 'HEAD']);
}

test('a PR that adds a component with no story is refused; adding its story makes it pass (S-1942)', async () => {
  treeBranch('tree/nostory', { 'web/src/Pane.tsx': 'export const Pane = () => null\n' });
  clearCalls();
  await assert.rejects(openPr(cfg, { branch: 'tree/nostory', title: 't', body: BODY }), /pr_open refuses: stories: web\/src\/Pane\.tsx: the component Pane has no story/);
  assert.equal(existsSync(callsFile), false, 'gh never ran');
  // The branch adds the story that lists Pane: the check passes and the PR opens.
  writeFileSync(join(seed, 'web/src/Pane.stories.tsx'), "export const stories = [{ code: ['web/src/Pane.tsx#Pane'] }]\n");
  git(seed, ['add', '.']);
  git(seed, ['commit', '-qm', 'Pane story']);
  git(seed, ['push', '-q', '-f', storageDir(), 'tree/nostory']);
  clearCalls();
  assert.equal((await openPr(cfg, { branch: 'tree/nostory', title: 't', body: BODY })).created, true);
  // A branch whose stories pass opens its PR, though it is cut from an older main (S-1818).
  treeBranch('tree/stories', {
    'web/src/Pane.tsx': 'export const Pane = () => null\n',
    'web/src/Pane.stories.tsx': "export const stories = [{ code: ['web/src/Pane.tsx#Pane'] }]\n",
  });
  clearCalls();
  const r = await openPr(cfg, { branch: 'tree/stories', title: 't', body: BODY });
  assert.equal(r.created, true);
  assert.equal(r.head, git(seed, ['rev-parse', 'HEAD']));
  assert.ok(calls().some((c) => c.args[1] === 'create'), 'gh pr create ran');
});

test('refuses a shipped doc edited without its export/overrides port, naming the file; the ported edit passes (S-858)', async () => {
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  const overrides = (docSha) => JSON.stringify({ templates: {}, types: {}, docs: { 'pull-requests.md': docSha } });
  const fixture = {
    'export/apply-overrides.mjs': readFileSync(new URL('../export/apply-overrides.mjs', import.meta.url), 'utf8'),
    'export/override-hashes.mjs': readFileSync(new URL('../export/override-hashes.mjs', import.meta.url), 'utf8'),
    // A patch targets a file outside docs/, as the real doc-patches.json does (processes/dev-change.yaml): --check reads it (S-1942).
    'export/overrides/doc-patches.json': JSON.stringify({ 'processes/x.yaml': [['old text', 'new text']] }),
    'processes/x.yaml': 'old text\n',
    'export/overrides/manifest.json': overrides(sha('v1 doc\n')),
    'registry/defaults.json': '{"types":{}}\n',
    'docs/pull-requests.md': 'v1 doc\n',
  };
  // The shipped doc and its manifest sha, but no public version: the branch edits a shipped doc without its port, refused.
  treeBranch('docs/edit', fixture);
  clearCalls();
  await assert.rejects(openPr(cfg, { branch: 'docs/edit', title: 't', body: BODY }), /docs\/pull-requests\.md is shipped and this branch edits it, but not its public version export\/overrides\/docs\/pull-requests\.md/);
  assert.equal(existsSync(callsFile), false, 'gh never ran');
  // The same branch with the port added, and the manifest sha of the doc it ships unchanged: passes, and opens the PR.
  mkdirSync(join(seed, 'export/overrides/docs'), { recursive: true });
  writeFileSync(join(seed, 'export/overrides/docs/pull-requests.md'), 'v1 public doc\n');
  git(seed, ['add', '.']);
  git(seed, ['commit', '-qm', 'port the doc']);
  git(seed, ['push', '-q', '-f', storageDir(), 'docs/edit']);
  clearCalls();
  const r = await openPr(cfg, { branch: 'docs/edit', title: 't', body: BODY });
  assert.equal(r.head, git(seed, ['rev-parse', 'HEAD']));
  assert.ok(calls().some((c) => c.args[1] === 'create'), 'gh pr create ran');
});

test('a branch that changes no component passes the stories step and opens its PR (S-1942)', async () => {
  git(seed, ['checkout', '-q', '-B', 'tree/plain', 'main']);
  writeFileSync(join(seed, 'a.txt'), 'plain\n');
  git(seed, ['commit', '-qam', 'plain']);
  git(seed, ['push', '-q', '-f', storageDir(), 'tree/plain']);
  clearCalls();
  const r = await openPr(cfg, { branch: 'tree/plain', title: 't', body: BODY });
  assert.equal(r.created, true);
  assert.equal(r.head, git(seed, ['rev-parse', 'HEAD']));
  assert.ok(calls().some((c) => c.args[1] === 'create'), 'gh pr create ran');
});

test('a shipped doc whose manifest sha is stale fails the branch\'s own --check, which pr_open refuses (S-858)', async () => {
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  treeBranch('docs/stale', {
    'export/apply-overrides.mjs': readFileSync(new URL('../export/apply-overrides.mjs', import.meta.url), 'utf8'),
    'export/override-hashes.mjs': readFileSync(new URL('../export/override-hashes.mjs', import.meta.url), 'utf8'),
    'export/overrides/doc-patches.json': '{}\n',
    'export/overrides/manifest.json': JSON.stringify({ templates: {}, types: {}, docs: { 'pull-requests.md': sha('not the doc\n') } }),
    'export/overrides/docs/pull-requests.md': 'v1 public doc\n',
    'registry/defaults.json': '{"types":{}}\n',
    'docs/pull-requests.md': 'v1 doc\n',
  });
  clearCalls();
  await assert.rejects(openPr(cfg, { branch: 'docs/stale', title: 't', body: BODY }), /pr_open refuses: export\/apply-overrides\.mjs --check fails on the branch/);
  assert.equal(existsSync(callsFile), false, 'gh never ran');
});

test('a check that runs out of time refuses before gh, and leaves no scratch ref or dir (S-1942)', async () => {
  const scratch = () => readdirSync(tmpdir()).filter((n) => n.startsWith('stam-pr-open-')).sort();
  const before = scratch();
  clearCalls();
  await assert.rejects(openPr({ ...cfg, checkTimeoutMs: 1 }, { branch: 'tree/plain', title: 't', body: BODY }), /pr_open refuses: the stories and overrides check timed out/);
  assert.equal(existsSync(callsFile), false, 'gh never ran');
  assert.equal(git(work, ['for-each-ref', '--format=%(refname)', 'refs/stam/pr-open-base']), '', 'the base ref is gone');
  assert.deepEqual(scratch(), before, 'the scratch dir is gone');
});
