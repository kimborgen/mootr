#!/usr/bin/env node
// Unit tests for process change proposals (S-1084): the YAML is checked with parseProcess, committed
// to a new branch in a scratch worktree (the checkout's own branch and files stay as they were),
// pushed to a throwaway local origin, and a proposal ITSA is filed in needs_approval with the diff
// and the PR link. gh is a fake; nothing reaches GitHub. Approve tells the owner, Request changes or
// a cancel closes the PR. Throwaway STAM_HOME, no daemon, no model.
// Run with `node --test test/process-proposal.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-process-proposal-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `process-proposal-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

const GOOD = `process: demo
title: Demo
lanes:
  human: { type: human }
  runner: { type: script }
nodes:
  begin:
    kind: start
    lane: human
    triggers:
      - { source: manual }
  work:
    kind: script
    lane: runner
    run: scripts/x.sh
  fin:
    kind: end
    lane: runner
    status: done
edges:
  - [begin, work]
  - [work, fin]
`;
const EDITED = GOOD.replace('run: scripts/x.sh', 'run: scripts/y.sh');

let db, itsa, human, mail, settings, pp, loop;
let tmp, origin, repo;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const calls = [];
// A fake gh: `pr create` answers a PR url, `pr close` is recorded, and `fail` makes create throw.
let fail = false;
const bodies = [];
const gh = async (args) => {
  calls.push(args);
  if (args.includes('--body-file')) bodies.push(readFileSync(args[args.indexOf('--body-file') + 1], 'utf8'));
  if (args[0] === 'pr' && args[1] === 'create') {
    if (fail) throw new Error('gh pr create failed: boom');
    return 'https://github.com/example/stam2/pull/7\n';
  }
  return '';
};
const cfg = () => ({ repoName: 'stam2', repo, storage: '', origin: 'origin', gh: 'gh', github: 'example/stam2', base: 'main' });
const deps = () => ({
  git: async (args, cwd) => {
    try {
      return execFileSync('git', args, { cwd: cwd ?? repo, encoding: 'utf8' });
    } catch (e) {
      throw new Error(`git ${args[0]} failed: ${e.stderr}`);
    }
  },
  gh,
});
const agent = (id, name) => db.createAgent({ id, name, role: 'dev', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: home, parent_id: null, session_id: null });
const tick = () => new Promise((r) => setTimeout(r, 80));

before(async () => {
  db = await import('../src/db.ts');
  itsa = await import('../src/itsa.ts');
  human = await import('../src/itsa-human.ts');
  mail = await import('../src/mail.ts');
  settings = await import('../src/settings.ts');
  pp = await import('../src/process-proposal.ts');
  loop = await import('../src/retro-loop.ts');
  settings.setSetting('search', { embedder: 'off' });
  db.open();
  agent('a2', 'cos');
  settings.setSetting('chiefOfStaff', 'cos');
  settings.setSetting('itsa', { ...settings.settings().itsa, repos: { stam2: process.cwd() } });
  // A local origin and a checkout of it with processes/demo.yaml on main.
  tmp = mkdtempSync(join(tmpdir(), 'stam-process-proposal-repo-'));
  origin = join(tmp, 'origin.git');
  repo = join(tmp, 'checkout');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, repo]);
  mkdirSync(join(repo, 'processes'));
  writeFileSync(join(repo, 'processes', 'demo.yaml'), GOOD);
  git(repo, 'checkout', '-q', '-B', 'main');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'seed');
  git(repo, 'push', '-q', 'origin', 'main');
  // The retro loop's own watcher runs too, as in the daemon: it must leave process proposals to process-proposal.
  loop.watchProposals();
  pp.watchProcessProposals(cfg(), deps());
});
after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

test('a file that does not validate is refused before anything is made', async () => {
  const n = itsa.list ? (await itsa.list({})).length : 0;
  calls.length = 0;
  await assert.rejects(pp.propose({ process: 'demo', yaml: GOOD.replace('kind: script', 'kind: gate'), summary: 'x', by: mail.HUMAN }, cfg(), deps()), /doesn't validate[\s\S]*unknown kind "gate"/);
  await assert.rejects(pp.propose({ process: 'demo', yaml: GOOD, summary: '  ', by: mail.HUMAN }, cfg(), deps()), /needs a summary/);
  await assert.rejects(pp.propose({ process: 'Bad Id', yaml: GOOD, summary: 'x', by: mail.HUMAN }, cfg(), deps()), /not a process id/);
  assert.equal((await itsa.list({})).length, n);
  assert.deepEqual(calls, []);
  assert.equal(git(repo, 'branch', '--list', 'process/*'), '');
});

test('a valid edit becomes a branch, a PR and a needs_approval proposal', async () => {
  calls.length = 0;
  const head = git(repo, 'rev-parse', 'HEAD');
  const r = await pp.propose({ process: 'demo', yaml: EDITED, base: GOOD, summary: 'Run y.sh instead of x.sh', by: mail.HUMAN }, cfg(), deps());
  assert.equal(r.pr.number, 7);
  // The branch is on origin with one commit that changes only the process file.
  assert.equal(git(origin, 'show', `${r.branch}:processes/demo.yaml`), EDITED.trim());
  assert.equal(git(origin, 'rev-list', '--count', `main..${r.branch}`), '1');
  assert.equal(git(origin, 'diff', '--name-only', `main...${r.branch}`), 'processes/demo.yaml');
  // The checkout is untouched: its branch, its head, its file, no leftover worktree or local branch.
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(readFileSync(join(repo, 'processes', 'demo.yaml'), 'utf8'), GOOD);
  assert.equal(git(repo, 'worktree', 'list').split('\n').length, 1);
  assert.equal(git(repo, 'branch', '--list', 'process/*'), '');
  // The PR body starts with the three lines merge-pr parses.
  const create = calls.find((a) => a[1] === 'create');
  const body = bodies.at(-1);
  assert.ok(create);
  assert.match(body, new RegExp(`^ITSA: ${r.key}\\nGates: run process[^\\n]*\\nDeploy: normal\\n`));
  assert.match(body, /\+\s+run: scripts\/y\.sh/);
  // The proposal ITSA waits for the human, with the diff, the PR link and the branch link.
  const x = itsa.must(r.id);
  assert.equal(x.kind, 'proposal');
  assert.equal(x.status, 'needs_approval');
  assert.equal(pp.proposalProcess(x), 'demo');
  assert.match(x.body, /PR: #7 https:\/\/github\.com\/example\/stam2\/pull\/7/);
  assert.match(x.body, /```diff[\s\S]*\+\s+run: scripts\/y\.sh/);
  assert.deepEqual(itsa.links(r.id).map((l) => `${l.system}:${l.external_id}`).sort(), [`branch:${r.branch}`, 'github:7']);
  assert.equal(x.owner, 'a2');
});

test('a stale editor is refused with 409 and nothing is made; the right base passes', async () => {
  const proposals = async () => (await itsa.list({})).filter((x) => x.kind === 'proposal').length;
  const n = await proposals();
  const branches = git(origin, 'branch', '--list', 'process/*').split('\n').filter(Boolean).length;
  calls.length = 0;
  await assert.rejects(
    pp.propose({ process: 'demo', yaml: EDITED.replace('y.sh', 'q.sh'), base: GOOD.replace('x.sh', 'older.sh'), summary: 'stale', by: mail.HUMAN }, cfg(), deps()),
    (e) => e.status === 409 && /changed after you opened the editor/.test(e.message),
  );
  assert.equal(await proposals(), n);
  assert.equal(git(origin, 'branch', '--list', 'process/*').split('\n').filter(Boolean).length, branches);
  assert.ok(!calls.some((c) => c[1] === 'create'), 'no PR was opened');
  assert.equal(git(repo, 'worktree', 'list').split('\n').length, 1);
  assert.equal(git(repo, 'branch', '--list', 'process/*'), '');
});

test('a file equal to main is refused, and a failed PR cancels the proposal and deletes the branch', async () => {
  await assert.rejects(pp.propose({ process: 'demo', yaml: GOOD, summary: 'nothing', by: mail.HUMAN }, cfg(), deps()), /nothing to propose/);
  assert.equal(git(origin, 'branch', '--list', 'process/*').split('\n').filter(Boolean).length, 1, 'only the first proposal\'s branch');
  fail = true;
  const before = (await itsa.list({})).filter((x) => x.kind === 'proposal').length;
  await assert.rejects(pp.propose({ process: 'demo', yaml: EDITED.replace('y.sh', 'z.sh'), summary: 'z', by: mail.HUMAN }, cfg(), deps()), /boom/);
  fail = false;
  const proposals = (await itsa.list({})).filter((x) => x.kind === 'proposal');
  assert.equal(proposals.length, before + 1);
  assert.equal(proposals.at(-1).status, 'canceled');
  assert.equal(git(origin, 'branch', '--list', 'process/*').split('\n').filter(Boolean).length, 1, 'the failed branch is gone from origin');
});

test('Approve tells the owner to merge the PR; Request changes closes it; a cancel closes it', async () => {
  const mk = async (name) => {
    const r = await pp.propose({ process: 'demo', yaml: EDITED.replace('y.sh', `${name}.sh`), summary: name, by: mail.HUMAN }, cfg(), deps());
    return r;
  };
  const a = await mk('approved');
  const before = mail.queuedNoticeCount('a2');
  await tick();
  calls.length = 0;
  await human.act(a.key, 'approve', '', itsa.get(a.key).rev);
  await tick();
  assert.equal(mail.queuedNoticeCount('a2'), before + 1, 'the owner gets exactly one notice: not the steward\'s as well');
  assert.ok(!calls.some((c) => c[1] === 'close'), 'approving closes nothing');

  const c = await mk('changes');
  calls.length = 0;
  await human.act(c.key, 'changes', 'Not like this.');
  await tick();
  const close = calls.find((x) => x[0] === 'pr' && x[1] === 'close');
  assert.ok(close, 'request changes closes the PR');
  assert.equal(close[2], '7');
  assert.ok(close.includes('--delete-branch'));
  assert.equal(itsa.must(c.id).status, 'canceled', 'the proposal ends with its PR');
  assert.equal(calls.filter((x) => x[1] === 'close').length, 1, 'the PR is closed once');

  const d = await mk('canceled');
  calls.length = 0;
  await itsa.set(d.id, { status: 'canceled' }, mail.HUMAN);
  await tick();
  assert.ok(calls.some((x) => x[1] === 'close'), 'a cancelled proposal closes its PR');
});

test('an agent\'s proposal records the agent, stops at needs_approval, and the agent cannot approve it (S-1085)', async () => {
  agent('a9', 'proposer');
  bodies.length = 0;
  const r = await pp.propose({ process: 'demo', yaml: EDITED.replace('y.sh', 'agent.sh'), base: GOOD, summary: 'From an agent', by: 'a9' }, cfg(), deps());
  const x = itsa.must(r.id);
  assert.equal(x.status, 'needs_approval');
  assert.equal(x.created_by, 'a9');
  assert.match(bodies.at(-1), /proposed from agent a9/);
  // Neither an agent's status change nor its own action counts as the human's Approve: no merge notice goes out.
  const before = mail.queuedNoticeCount('a2');
  await pp.onProposalStatus(x, 'a9', 'needs_approval', cfg(), deps());
  await tick();
  assert.equal(mail.queuedNoticeCount('a2'), before, 'only the human\'s Approve tells the owner to merge');
  // A validation error and a stale base come back as ProposalErrors with their statuses.
  await assert.rejects(pp.propose({ process: 'demo', yaml: GOOD.replace('kind: script', 'kind: gate'), summary: 'x', base: GOOD, by: 'a9' }, cfg(), deps()), (e) => e.status === 400 && /doesn't validate/.test(e.message));
  await assert.rejects(pp.propose({ process: 'demo', yaml: EDITED, summary: 'x', base: 'old text', by: 'a9' }, cfg(), deps()), (e) => e.status === 409);
});

test('the human\'s Approve names the commit to merge; an agent cannot move its proposal to merge; an agent holds at most 3 open proposals (S-1085)', async () => {
  agent('a8', 'proposer2');
  const mk = (n) => pp.propose({ process: 'demo', yaml: EDITED.replace('y.sh', `cap${n}.sh`), base: GOOD, summary: `cap ${n}`, by: 'a8' }, cfg(), deps());
  const first = await mk(1);
  const sha = git(origin, 'rev-parse', first.branch);
  assert.match(itsa.must(first.id).body, new RegExp(`^Commit: ${sha}$`, 'm'));
  // The gate itself: the agent that made the proposal can't move it to merge before the human approved.
  await assert.rejects(itsa.set(first.id, { status: 'ready_to_merge' }, 'a8'), /approved/);
  mail.inTurnNotice('a2');
  await human.act(first.key, 'approve', '', itsa.get(first.key).rev);
  await tick();
  const notice = mail.inTurnNotice('a2') ?? '';
  assert.match(notice, new RegExp(`merge only if the PR head is still ${sha}`));
  // Cap: the approved one is still open (not closed), so two more fill it and a fourth is refused with 429.
  await mk(2);
  await mk(3);
  const calls0 = calls.length;
  await assert.rejects(mk(4), (e) => e.status === 429 && /3 open process proposals/.test(e.message));
  assert.equal(calls.length, calls0, 'nothing was made');
  // Another agent is not held by it; closing one frees a slot.
  agent('a7', 'proposer3');
  await pp.propose({ process: 'demo', yaml: EDITED.replace('y.sh', 'other.sh'), base: GOOD, summary: 'other', by: 'a7' }, cfg(), deps());
  await itsa.set(first.id, { status: 'canceled' }, mail.HUMAN);
  await tick();
  await mk(5);
});

test('the proposer cannot rewrite the filed body or push to the branch; the Commit line is read from the header only (S-1085)', async () => {
  agent('a6', 'proposer4');
  const r = await pp.propose({ process: 'demo', yaml: EDITED.replace('y.sh', 'forge.sh'), base: GOOD, summary: 'forge', by: 'a6' }, cfg(), deps());
  const x = itsa.must(r.id);
  await assert.rejects(itsa.set(r.id, { body: x.body.replace(/^Commit: .*$/m, 'Commit: ' + 'a'.repeat(40)) }, 'a6'), /body is written by the system/);
  assert.equal(itsa.must(r.id).body, x.body);
  // The branch is linked to the proposal: an agent's push is refused, the chief of staff's is not.
  const prOpen = await import('../src/pr-open.ts');
  assert.match(await prOpen.pushRefusal({ agent: 'a6', boss: false }, r.branch), /process proposal's branch/);
  assert.equal(await prOpen.pushRefusal({ agent: 'a2', boss: true }, r.branch), null);
  // A Commit: line in the summary (after the header's blank line) is not the commit to merge.
  const forged = await pp.propose({ process: 'demo', yaml: EDITED.replace('y.sh', 'forge2.sh'), base: GOOD, summary: 'x\nCommit: ' + 'b'.repeat(40), by: mail.HUMAN }, cfg(), deps());
  mail.inTurnNotice('a2');
  await human.act(forged.key, 'approve', '', itsa.get(forged.key).rev);
  await tick();
  const sha = git(origin, 'rev-parse', forged.branch);
  assert.match(mail.inTurnNotice('a2') ?? '', new RegExp(`still ${sha}`));
  // With no Commit line in the header, one further down is not taken for it.
  const bare = await pp.propose({ process: 'demo', yaml: EDITED.replace('y.sh', 'forge3.sh'), base: GOOD, summary: 'x\nCommit: ' + 'c'.repeat(40), by: mail.HUMAN }, cfg(), deps());
  await itsa.set(bare.id, { body: itsa.must(bare.id).body.replace(/^Commit: .*\n/m, '') }, mail.HUMAN);
  mail.inTurnNotice('a2');
  await human.act(bare.key, 'approve', '', itsa.get(bare.key).rev);
  await tick();
  assert.doesNotMatch(mail.inTurnNotice('a2') ?? '', /merge only if/);
});

test('concurrent proposals from one agent respect the cap, and branches never collide (S-1085)', async () => {
  agent('a5', 'proposer5');
  // Slow fake deps, so the calls interleave at every await.
  const slow = deps();
  const slowDeps = { git: async (a, c) => (await new Promise((r) => setTimeout(r, 5)), slow.git(a, c)), gh: async (a) => (await new Promise((r) => setTimeout(r, 5)), slow.gh(a)) };
  const results = await Promise.allSettled([1, 2, 3, 4, 5, 6].map((n) => pp.propose({ process: 'demo', yaml: EDITED.replace('y.sh', `race${n}.sh`), base: GOOD, summary: `race ${n}`, by: 'a5' }, cfg(), slowDeps)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3, JSON.stringify(results.map((r) => r.status === 'rejected' ? r.reason.message : 'ok')));
  const open = (await itsa.list({ kind: 'proposal' })).filter((i) => i.created_by === 'a5' && !itsa.isClosedStatus(i.status));
  assert.equal(open.length, 3);
  // Two humans' proposals in the same millisecond get different branches.
  const realNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  try {
    const [p, q] = await Promise.all([1, 2].map((n) => pp.propose({ process: 'demo', yaml: EDITED.replace('y.sh', `same${n}.sh`), base: GOOD, summary: `same ${n}`, by: mail.HUMAN }, cfg(), deps())));
    assert.notEqual(p.branch, q.branch);
  } finally {
    Date.now = realNow;
  }
});
