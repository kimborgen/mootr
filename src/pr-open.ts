// The PR relay (S-514): `pr_open` opens a branch's pull request for an agent that has no gh, such as
// one on storage. It runs on the ITSA home, where gh is: it fetches the branch from storage into a
// scratch ref (or, with no storage remote, takes the checkout's local branch), pushes it to origin, and opens the PR, or replaces the body of the open PR for that
// head. With an ITSA it links the PR and the branch to it. The body is the one docs/pull-requests.md
// describes. Before any push it runs the merge gate's stories and export-overrides checks (S-1942).
// Names come from settings.itsa.prOpen, so a test can point them at throwaway repos.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { MACHINE } from './config.ts';
import { checkRangeAsync } from '../scripts/story-check.mjs';
import { CONFIG_PATH, parseRepoGates, readRepoConfig, type RepoConfig } from '../scripts/repo-config.mjs';
import * as itsa from './itsa.ts';
import { HUMAN } from './mail.ts';
import { processProposalOf } from './retro-loop.ts';
import { itsaRefusal, mayEditItsa } from './mail-visibility.ts';
import * as db from './db.ts';
import { branchScope, foreignRefusal, linkRefusal, localScope } from './branch-scope.ts';
import { peerByName, peerCall, type Via } from './peers.ts';
import { primaryRepoName, settings } from './settings.ts';
import { defaultGithubRepo, originRepo } from './github-repo.ts';
import { isAncestor, noteSynced, readSyncState } from './pr-sync.ts';
import { mirrorPrHead, storageRemote } from './pr-mirror.ts';
import { claudeSlug, claudeTmpBase } from './proctree.ts';
import { testOnlyEnv } from './test-env.ts';
import { isTestFile, REMOVED_SHOWN, testCaseTitles, type PredictedTest, type PrPrediction, type RemovedTests } from './pr-predict-format.ts';

const run = promisify(execFile);

export interface PrOpenInput {
  branch: string;
  title: string;
  body: string;
  // The ITSA the branch delivers (id or key): gets the PR and branch links.
  itsa?: string | null;
  // Who asks: an agent id or name, or the human.
  by?: string | null;
  // The head of the calling worktree, as the caller's daemon read it when it pushed the branch (S-3486): the ITSA home refuses when the
  // head it fetched differs. Unset when the caller has no worktree on the branch, or is on the home itself.
  head?: string | null;
}

export interface PrOpenConfig {
  // The name of the repo in settings.itsa.repos (the branch link's repo), and its path.
  repoName: string;
  repo: string;
  // The remote the branch is fetched from (storage's bare repo; '' = `storage` if the checkout has that remote, else push the local
  // branch), and the one it's pushed to.
  storage: string;
  origin: string;
  // The gh binary, and the GitHub repo (OWNER/NAME) PRs open in: settings, else parsed from origin.
  gh: string;
  github: string;
  // The branch a PR merges into; never pushed from.
  base: string;
  // The timeout of each git and tar call of the stories and overrides checks (default CHECK_GIT_MS); a test sets it small.
  checkTimeoutMs?: number;
  // Whether pr_open runs the LIGHT tests the gate adds itself (S-2480; default on). A test fixture with no test tree sets it false.
  runLight?: boolean;
  // The timeout of each LIGHT test pr_open runs itself, slot wait included (default LIGHT_TEST_MS, S-2480).
  lightTimeoutMs?: number;
  // The time all the LIGHT tests of a PR may take together (default LIGHT_TOTAL_MS): a test that starts after it is spent is refused.
  lightBudgetMs?: number;
  // Whether pr_open runs the leak scan (S-3383; default on). A test fixture with no export tree sets it false.
  leakGate?: boolean;
  // The time the leak scan may take (default LEAK_SCAN_MS).
  leakTimeoutMs?: number;
}

export interface PrOpened {
  number: number;
  url: string;
  // False when an open PR already had this head, and only its body changed.
  created: boolean;
  branch: string;
  head: string;
  // Set when GitHub's head was behind the branch and this run moved it (S-2267), or when GitHub's PR head still shows another sha after the push (S-3385).
  warning?: string;
  // The LIGHT tests that failed, timed out or were skipped: advisory, never a refusal, and also in the PR body.
  advisory?: string[];
}

// The first lines of the body, which merge-pr.mjs and the gates parse (docs/pull-requests.md).
const HEADER = ['ITSA:', 'Gates:', 'Deploy:'];
const BRANCH = /^[A-Za-z0-9._/-]+$/;
// How long the home call of pr_open may take: the fetch, push and gh of a slow storage (S-1332). The MCP client's
// own timeout (mcp.ts PR_OPEN_CALL_MS) must be longer, or the caller gives up while the PR is still being made.
export const PR_OPEN_PEER_MS = 240_000;

export function prOpenConfig(): PrOpenConfig {
  const s = settings();
  const { storage, origin, gh, github } = s.itsa.prOpen;
  const repoName = primaryRepoName(s.itsa);
  const repo = s.itsa.repos[repoName];
  if (!repo) throw new Error(`pr_open: no repo ${repoName} in settings.itsa.repos`);
  return { repoName, repo, storage, origin, gh, github: github || originRepo(repo, origin) || '', base: s.itsa.mainBranch };
}

// The merge gate's parser, loaded on first use: the public export drops scripts/gate.mjs (export/exclude.txt), and a
// static import would stop its daemon at start (S-2140). Only a config repo (S-2202) needs no gate: every other call refuses
// here, before anything is pushed, when the file is missing (S-1645). STAM_PR_OPEN_GATE replaces its path in a test home only.
const gatePath = (): string => testOnlyEnv('STAM_PR_OPEN_GATE') || fileURLToPath(new URL('../scripts/gate.mjs', import.meta.url));
async function gate(): Promise<typeof import('../scripts/gate.mjs')> {
  const path = gatePath();
  if (!existsSync(path)) throw new Error(`pr_open can't check this PR against the merge gate: ${path} is missing (the public export drops it). A repo with a .stam/repo.json on its main branch (S-2202) needs no gate; for any other repo, open the PR with \`gh pr create\`. Nothing was pushed.`);
  return import(pathToFileURL(path).href);
}

// The repo's merge flow (S-2202), and the branch its PRs target. The config is .stam/repo.json on the repo's trusted main
// branch as fetched now (never the PR's branch), under settings.itsa.repoConfig[NAME]. The trusted main is the one the
// scripts use: the setting's mainBranch, else origin's default branch. A config repo's PRs target its mainBranch; a repo
// with neither file nor setting (stam's own) gets config null and keeps cfg.base (itsa.mainBranch) and the private gate.mjs
// flow. A failed lookup, fetch or read throws, so a config repo's Gates line is never checked the other way.
export async function repoConfigOf(cfg: PrOpenConfig): Promise<{ config: RepoConfig | null; base: string }> {
  const fallback = settings().itsa.repoConfig[cfg.repoName] ?? null;
  const named = typeof fallback?.mainBranch === 'string' && fallback.mainBranch ? fallback.mainBranch : '';
  const head = named ? '' : /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(await git(cfg, ['ls-remote', '--symref', cfg.origin, 'HEAD']))?.[1] ?? '';
  const main = named || head || cfg.base;
  const ref = `refs/stam/pr-open-config/${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await git(cfg, ['fetch', '--no-tags', cfg.origin, `+refs/heads/${main}:${ref}`]);
    const config = readRepoConfig(cfg.repo, ref, fallback);
    if (!config) return { config, base: cfg.base };
    if (config.mainBranch !== main) throw new Error(`${cfg.repoName}'s ${CONFIG_PATH} says mainBranch ${config.mainBranch}, but its main branch is ${main}: set settings.itsa.repoConfig.${cfg.repoName}.mainBranch or fix the file`);
    return { config, base: main };
  } finally {
    await git(cfg, ['update-ref', '-d', ref]).catch(() => {});
  }
}

// The largest body_file a pr_open call may send (S-2677): a PR body is text, so a bigger file is refused, not read.
export const BODY_FILE_MAX = 256 * 1024;

// The body of a pr_open call (S-2677): the inline `body`, or the text of `body_file`, which is read here, on the caller's
// own machine, before anything is sent. It is read only from the caller's worktree (its cwd) or its Claude scratch dir,
// so a file for another machine is never read, and no other agent's files are. The caller is the local agent `me`.
export function resolveBody<T extends PrOpenInput & { body_file?: string | null }>(input: T, me: { cwd: string; machine: string } | undefined): Omit<T, 'body_file'> {
  const { body_file: file, ...rest } = input;
  if (file == null) return rest;
  if (input.body != null) throw new Error('pass exactly one of body and body_file to pr_open, not both');
  if (!me || me.machine !== MACHINE) throw new Error('body_file is read on the machine the calling agent runs on: call pr_open from that agent, or pass the body text in body');
  const roots = [me.cwd, join(claudeTmpBase(), claudeSlug(me.cwd))].flatMap((r) => {
    try {
      return [realpathSync(r)];
    } catch {
      return [];
    }
  });
  let path: string;
  try {
    path = realpathSync(resolve(me.cwd, file));
  } catch {
    throw new Error(`body_file ${file} doesn't exist: pass the body text in body, or the path of a file in your worktree or scratch dir in body_file`);
  }
  if (!roots.some((r) => path.startsWith(r + '/'))) {
    throw new Error(`body_file ${file} is outside your worktree (${me.cwd}) and your scratch dir: pass the body text in body, or a file in one of those in body_file`);
  }
  const st = statSync(path);
  if (!st.isFile()) throw new Error(`body_file ${file} is not a file`);
  if (st.size > BODY_FILE_MAX) throw new Error(`body_file ${file} is ${st.size} bytes; a PR body may be at most ${BODY_FILE_MAX}`);
  return { ...rest, body: readFileSync(path, 'utf8') };
}

// Checks the input before anything is pushed. Returns the repo's config (null for the gate.mjs flow) and cfg with the base
// its PRs target.
function checkBranch(cfg: PrOpenConfig, name: unknown): string {
  const branch = String(name ?? '');
  if (!BRANCH.test(branch) || branch.startsWith('-') || branch.includes('..') || branch.endsWith('/') || branch.endsWith('.lock')) {
    throw new Error(`a branch name is letters, digits, . _ / and -, not starting with -: ${branch}`);
  }
  if (!cfg.github) throw new Error(`pr_open: no GitHub repo: set settings.itsa.prOpen.github, or give ${cfg.repoName}'s ${cfg.origin} remote a github.com url`);
  return branch;
}

async function checkInput(cfg: PrOpenConfig, input: PrOpenInput): Promise<{ repoConfig: RepoConfig | null; cfg: PrOpenConfig }> {
  const branch = checkBranch(cfg, input.branch);
  if (!String(input.title ?? '').trim() || /[\r\n]/.test(input.title)) throw new Error('a PR needs a one-line title');
  const text = String(input.body ?? '').trim();
  // A lone path, or nothing, is a call that meant body_file, or passed no body at all (S-2677).
  const lonePath = !text.includes('\n') && /^\S+$/.test(text) && /\/|\.(md|txt)$/.test(text);
  if (!text || lonePath) throw new Error('pass the body text in `body`, or the path in `body_file`');
  const lines = String(input.body ?? '').split('\n');
  HEADER.forEach((label, i) => {
    if (!lines[i]?.startsWith(label)) throw new Error(`the PR body starts with the lines ITSA:, Gates:, Deploy: (docs/pull-requests.md); line ${i + 1} must start with ${label}`);
  });
  const { config: repoConfig, base } = await repoConfigOf(cfg);
  if (branch === base) throw new Error(`pr_open won't open a PR from ${base}`);
  if (repoConfig) {
    // A config repo (S-2202): its branches carry the prefix, and the Gates line names its gates, as repo-gate.mjs reads them.
    if (!branch.startsWith(repoConfig.branchPrefix)) throw new Error(`${cfg.repoName}'s ${CONFIG_PATH} wants branches named ${repoConfig.branchPrefix}*: ${branch}`);
    try {
      parseRepoGates(input.body, repoConfig);
    } catch (e) {
      throw new Error(`Gates: ${e instanceof Error ? e.message : e}`);
    }
  } else {
    // The Gates line parses as merge-pr.mjs parses it, so an unknown token is refused here, not after review (S-1292).
    (await gate()).parseGates(input.body, await runNames({ ...cfg, base }));
  }
  return { repoConfig, cfg: { ...cfg, base } };
}

// The names test/run.sh runs, in any list, on main: a bare Gates token naming one is refused with the `run NAME` to write (S-2553).
async function runNames(cfg: PrOpenConfig): Promise<Set<string>> {
  const runSh = await git(cfg, ['show', `${cfg.base}:test/run.sh`]).catch(() => '');
  return new Set([...runTestNames(runSh), ...(await gate()).lightTests(runSh)]);
}

// A call that ran past its timeout (S-1942): pr_open refuses it, rather than passing or hanging.
const timedOut = (what: string, ms: number): Error => Object.assign(new Error(`${what} timed out after ${ms / 1000} s`), { timedOut: true });

// Runs git in the repo. A failure carries git's own message; with `timeout`, a call that runs past it is killed and
// rejects with timedOut set.
async function git(cfg: PrOpenConfig, args: string[], timeout?: number): Promise<string> {
  try {
    return (await run('git', args, { cwd: cfg.repo, maxBuffer: 16 << 20, timeout })).stdout.trim();
  } catch (e: any) {
    if (e.killed && timeout) throw timedOut(`git ${args[0]}`, timeout);
    throw new Error(`git ${args[0]} failed: ${String(e.stderr ?? e.message).trim()}`);
  }
}

// Runs gh, which needs no cwd: --repo names the PR's repo.
async function gh(cfg: PrOpenConfig, args: string[], timeout = 120_000): Promise<string> {
  try {
    return (await run(cfg.gh, args, { maxBuffer: 16 << 20, timeout })).stdout;
  } catch (e: any) {
    throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${String(e.stderr ?? e.message).trim()}`);
  }
}

const short = (sha: string): string => sha.slice(0, 8);

// What a push that replaces GitHub's head `current` with `head` says (S-2267). "Behind" only when `current` is an ancestor of
// `head`; a rebase or a rewind is "changed from A to B" (S-2390). Empty when the head is unchanged or GitHub had none.
export async function headNote(cfg: PrOpenConfig, branch: string, current: string, head: string): Promise<string> {
  if (!current || current === head) return '';
  const fastForward = await isAncestor(cfg, current, head).catch(() => false);
  const what = fastForward ? `was at ${short(current)}, behind ${short(head)}` : `changed from ${short(current)} to ${short(head)} (not a fast-forward)`;
  return `GitHub's ${branch} ${what}; pushed it to GitHub. Later pushes to ${branch} from storage reach only storage's bare repo, not GitHub: run pr_open again after each one.`;
}

// Whether the checkout has refs/heads/BRANCH, checked out or not (S-754, S-2316).
async function hasLocalBranch(cfg: PrOpenConfig, branch: string): Promise<boolean> {
  return (await git(cfg, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).catch(() => '')) !== '';
}

// Refuses to replace GitHub's head `current` with `head` (S-673) unless it's the head stam last pushed for the
// branch, or an ancestor of `head`: a fix a manager pushed straight to GitHub must not be overwritten. The
// head is fetched into `ref` (this run's own), so the check reads what GitHub holds now. With a storage remote, the refusal
// first copies GitHub's head there as gh/BRANCH (S-675), since a storage agent can't reach GitHub to merge it.
// Returns the head the run settles on: `current`, or `head` when the read of `current` lagged a push (S-3664).
export async function checkGithubHead(cfg: PrOpenConfig, branch: string, current: string, head: string, ref: string, storage = ''): Promise<string> {
  if (readSyncState()[branch] === current) return current;
  await git(cfg, ['fetch', '--no-tags', cfg.origin, `+refs/heads/${branch}:${ref}`]);
  const got = await git(cfg, ['rev-parse', '--verify', ref]);
  if (got !== current) {
    if (got === head) return head;
    throw new Error(`GitHub's ${branch} moved while pr_open checked it; run pr_open again`);
  }
  if (await isAncestor(cfg, current, head)) return current;
  // `-s ours` keeps your tree and drops GitHub's commit, so it is named only for a rebase whose diff is your own; a commit someone pushed is merged (S-673).
  const cause = `GitHub's head ${short(current)} isn't in your branch's history. If you rebased, and \`git diff ${current} HEAD\` shows only your own changes, \`git merge -s ours ${current}\` records the old head and keeps your tree, or merge origin/${cfg.base} instead of rebasing. If someone pushed a commit there, merge it: \`git merge ${current}\`.`;
  if (!storage) throw new Error(`${cause} Run git fetch origin +refs/heads/${branch}:refs/remotes/origin/${branch} && git merge --no-edit origin/${branch}, then pr_open again.`);
  const copy = `gh/${branch}`;
  const copied = await git(cfg, ['push', '--force', storage, `${ref}:refs/heads/${copy}`], 60_000).then(() => true, () => false);
  if (!copied) throw new Error(`${cause} Copying GitHub's head to storage as ${copy} failed: ask an agent that can reach GitHub to merge it, or retry pr_open.`);
  throw new Error(`${cause} Its head is on storage as ${copy}: run git fetch origin +refs/heads/${copy}:refs/remotes/origin/${copy} && git merge --no-edit origin/${copy}, push ${branch}, then pr_open again.`);
}

// GitHub's head of the branch as the checks began (`current`) must still be its head just before the push: the checks can take
// minutes, and a raw lease error would say nothing a developer can act on (S-3009).
// The read recheckGithubHead makes; a test swaps it to stage a stale read (S-3664).
export const recheckHooks = {
  read: async (cfg: PrOpenConfig, branch: string): Promise<string> => (await git(cfg, ['ls-remote', '--heads', cfg.origin, `refs/heads/${branch}`])).split('\t')[0] ?? '',
};

// Returns the head the push leases to. A read right after a push can lag GitHub, so a head that differs from `current` is read once
// more (S-3664): it refuses unless GitHub then holds `head`, this run's own commit, which a push can't clobber.
export async function recheckGithubHead(cfg: PrOpenConfig, branch: string, current: string, head: string): Promise<string> {
  if ((await recheckHooks.read(cfg, branch)) === current) return current;
  if (current && (await recheckHooks.read(cfg, branch)) === head) return head;
  throw new Error(`GitHub's ${branch} moved while pr_open checked it; run pr_open again`);
}

// The open PR whose head is the branch, or null.
async function openPrFor(cfg: PrOpenConfig, branch: string): Promise<{ number: number; url: string } | null> {
  const open = JSON.parse(await gh(cfg, ['pr', 'list', '--repo', cfg.github, '--head', branch, '--state', 'open', '--json', 'number,url'])) as { number: number; url: string }[];
  return open[0] ?? null;
}

async function prView(cfg: PrOpenConfig, number: number, timeout?: number): Promise<{ body: string; head: string }> {
  const v = JSON.parse(await gh(cfg, ['pr', 'view', String(number), '--repo', cfg.github, '--json', 'body,headRefOid'], timeout)) as { body?: string; headRefOid?: string };
  return { body: v.body ?? '', head: v.headRefOid ?? '' };
}

// The header lines (ITSA:, Gates:, Deploy:) of a PR body: what a recovered PR's body is checked against.
const headerOf = (body: string): string => body.split('\n').slice(0, HEADER.length).join('\n');

// The names test/run.sh runs: its FREE and SMOKE lists, one name per line between `NAME="` and a closing `"` line.
export function runTestNames(runSh: string): Set<string> {
  const names = new Set<string>();
  for (const m of runSh.matchAll(/^(?:FREE|SMOKE)="\n([\s\S]*?)^"$/gm)) {
    for (const n of m[1].split('\n')) if (n.trim()) names.add(n.trim());
  }
  return names;
}

// The lists of test/run.sh (LIGHT, FREE, SMOKE) a name is in, so a refusal can say which list it lacks (S-2327).
export function runTestLists(runSh: string, name: string): string[] {
  return ['LIGHT', 'FREE', 'SMOKE'].filter((list) => {
    // LIGHT's closing quote follows its last name on one line, so the list ends at the first quote.
    const m = new RegExp(`^${list}="\\n([^"]*)"`, 'm').exec(runSh);
    return m ? m[1].split('\n').some((n) => n.trim() === name) : false;
  });
}

// Each `run NAME` in the Gates line names a test the PR's test/run.sh knows (S-1292): an unknown one fails the merge
// gate only after review, so it is refused here. The names are read from the head's run.sh (the tree the gate tests,
// so a PR that adds a test and its name passes), fetched into this checkout by openPr.
async function checkRunNames(cfg: PrOpenConfig, body: string, head: string): Promise<void> {
  const { parseGates, runTestName } = await gate();
  const names = parseGates(body).flatMap((g) => (g.argv[1] === 'test/run.sh' ? g.argv.slice(2) : []));
  if (names.length === 0) return;
  let runSh: string;
  try {
    runSh = await git(cfg, ['show', `${head}:test/run.sh`]);
  } catch (e) {
    throw new Error(`can't read test/run.sh at HEAD: ${e instanceof Error ? e.message : e}`);
  }
  const known = runTestNames(runSh);
  for (const name of names) {
    // run.sh picks the test by runTestName (its e2e- prefix stripped), so a name is checked the same way.
    const test = runTestName(name);
    if (known.has(test)) continue;
    const unit = known.has(`${test}-unit`) ? ` (did you mean ${test}-unit?)` : '';
    // A name in LIGHT alone is one run.sh refuses by name too: say which list it lacks (S-2327).
    const lists = runTestLists(runSh, test);
    const where = lists.length ? ` (it is in ${lists.join(', ')} but not in FREE or SMOKE, which run.sh runs by name)` : '';
    throw new Error(`Gates: no test ${name} in test/run.sh${where}${unit}`);
  }
}

// The merge gate's stories step and export-overrides step, run here before any push (S-1942), so a PR the gate would
// refuse is refused now. Stories: story-check.mjs over the PR's own changes, the diff from the merge base of origin's base
// branch (fetched into a scratch ref) and the head (S-1818, S-1964). Overrides (S-858): a shipped doc or template the branch
// changes needs its export/overrides port in the same branch, and the branch's own export/apply-overrides.mjs --check passes
// on its tree, archived out of git into the scratch dir. Both name what to fix; the overrides check runs only when the
// branch touches a tree the export ships, so the usual PR pays for the stories check alone.
// The time each git and tar call of the stories and overrides checks may take, and the overrides' --check (S-1942).
const CHECK_GIT_MS = 30_000;
const CHECK_CHECK_MS = 60_000;
// The time one LIGHT test may take, its slot wait included, and the time all of them may take together (S-2480): PrOpenConfig's
// lightTimeoutMs and lightBudgetMs. The total fits inside PR_OPEN_PEER_MS with room for the push and gh, and the MCP client waits
// longer still (mcp.ts PR_OPEN_CALL_MS).
const LIGHT_TEST_MS = 60_000;
export const LIGHT_TOTAL_MS = 120_000;
// The shipped trees: a branch that changes one of them runs the overrides check.
const SHIPPED_DIRS = ['docs', 'export', 'templates', 'blocks', 'registry'];
const SHIPPED_TREE = new RegExp(`^(${SHIPPED_DIRS.join('|')})/`);
type Manifest = { docs?: Record<string, string>; templates?: Record<string, string> };
// The head's test/run.sh, or '' when the branch has none: a branch without the file names no test, so the prediction has nothing
// to add (S-2480 advisory). Only the missing file is tolerated; any other git error still throws, so the caller refuses.
async function headRunSh(cfg: PrOpenConfig, head: string, ms?: number): Promise<string> {
  const listed = await git(cfg, ['ls-tree', '--name-only', head, '--', 'test/run.sh'], ms);
  return listed ? git(cfg, ['show', `${head}:test/run.sh`], ms) : '';
}
// The gate's prediction for the head against the fetched base ref, and the LIGHT ones among it run: the one path pr_open and its dry run
// share, so they can't disagree. A prediction that fails throws (never an empty list), and so does one of the wrong shape.
async function predictWithLight(cfg: PrOpenConfig, head: string, baseRef: string, dir: string) {
  const ms = cfg.checkTimeoutMs ?? CHECK_GIT_MS;
  const predicted = await (await gate()).predictPr({ repo: cfg.repo, cache: dir, base: await git(cfg, ['rev-parse', '--verify', baseRef], ms), head, ms });
  if (!Array.isArray(predicted?.tests) || !Array.isArray(predicted?.changed)) throw new Error('the gate prediction returned no test list');
  const light = cfg.runLight === false ? new Map<string, string | null>() : await runLightTests(cfg, head, predicted.tests, dir);
  return { predicted, light };
}
// The test cases the branch removes from the test files it changes, against the merge-base (S-3665). A case is removed when its title
// is in the base's version of a file and missing from that file at the head, unless the title is new in some changed file (in its
// head titles but not its base titles): that is a move, or a rename that keeps its titles. Each file is judged on its own, so a
// generic title another file still has is still a removal. A file the diff deletes counts all its cases.
// Informational: it lists what the diff takes out, and never refuses.
export async function removedTestCases(cfg: PrOpenConfig, base: string, head: string, ms?: number): Promise<RemovedTests[]> {
  const mergeBase = await git(cfg, ['merge-base', base, head], ms);
  const changed = (await git(cfg, ['diff', '--name-only', '--no-renames', mergeBase, head], ms)).split('\n').filter(isTestFile);
  const headTitles = new Map<string, string[]>();
  const baseTitles = new Map<string, string[]>();
  const newTitles = new Set<string>();
  for (const path of changed) {
    const atHead = await fileAt(cfg, head, path, ms);
    const atBase = await fileAt(cfg, mergeBase, path, ms);
    const now = atHead === null ? [] : testCaseTitles(path, atHead);
    const was = atBase === null ? [] : testCaseTitles(path, atBase);
    headTitles.set(path, now);
    if (atBase !== null) baseTitles.set(path, was);
    for (const t of now) if (!was.includes(t)) newTitles.add(t);
  }
  const removed: RemovedTests[] = [];
  for (const [path, titles] of baseTitles) {
    const now = new Set(headTitles.get(path));
    const gone = titles.filter((t) => !now.has(t) && !newTitles.has(t));
    if (gone.length) removed.push({ path, count: gone.length, titles: gone.slice(0, REMOVED_SHOWN) });
  }
  return removed;
}
// A file's text at a revision, or null when the revision has no such file.
async function fileAt(cfg: PrOpenConfig, rev: string, path: string, ms?: number): Promise<string | null> {
  return git(cfg, ['show', `${rev}:${path}`], ms).catch(() => null);
}
// The leak scan (S-3383): scripts/leak-gate.mjs on the head's shipped tree (overrides applied), the way the merge gate runs it, so a
// leak is refused before the push instead of after review. Returns each finding line; fails closed: a scan that exits 2 or
// anything but 0 or 1, times out, is killed, or prints what can't be read throws, and never returns an empty list. STAM_PR_OPEN_LEAK
// replaces the script's path in a test home only.
const LEAK_SCAN_MS = 60_000;
async function leakProblems(cfg: PrOpenConfig, head: string): Promise<string[]> {
  if (cfg.leakGate === false) return [];
  const script = testOnlyEnv('STAM_PR_OPEN_LEAK') || fileURLToPath(new URL('../scripts/leak-gate.mjs', import.meta.url));
  const ms = cfg.leakTimeoutMs ?? LEAK_SCAN_MS;
  let out: string;
  let status = 0;
  try {
    out = (await run('node', [script, '--ref', head], { cwd: cfg.repo, maxBuffer: 16 << 20, timeout: ms })).stdout;
  } catch (e: any) {
    if (e.killed) throw timedOut('the leak scan', ms);
    if (typeof e.code !== 'number') throw new Error(`the leak scan could not run: ${String(e.stderr || e.message).trim()}`);
    status = e.code;
    out = String(e.stdout ?? '');
    if (status !== 1) throw new Error(`the leak scan could not run (exit ${status}): ${String(e.stderr || out).trim().split('\n').pop()}`);
  }
  const lines = out.split('\n').filter(Boolean);
  if (status === 0) {
    if (lines.at(-1) !== 'leak scan: clean') throw new Error('the leak scan printed no clean verdict; its output could not be read');
    return [];
  }
  const found = lines.filter((l) => !l.startsWith('scanning committed '));
  if (!found.length || !found.every((l) => /^\S.*  ".*"$/.test(l))) throw new Error('the leak scan failed with output that could not be read');
  return found.map((l) => `leak: ${l}`);
}

async function checkTree(cfg: PrOpenConfig, body: string, head: string, dir: string): Promise<string[]> {
  const baseRef = `refs/stam/pr-open-base/${basename(dir)}`;
  const problems: string[] = [];
  const advisory: string[] = [];
  try {
    const ms = cfg.checkTimeoutMs ?? CHECK_GIT_MS;
    await git(cfg, ['fetch', '--no-tags', cfg.origin, `+refs/heads/${cfg.base}:${baseRef}`], ms);
    // The gate's per-PR rules (S-830), and the tip's missing-story rule for the components this PR adds or changes:
    // the PR's own changes, not the structure of a base it is behind on (S-1942).
    for (const e of await checkRangeAsync(baseRef, head, { cwd: cfg.repo, body, mode: 'branch', timeoutMs: ms })) problems.push(`stories: ${e}`);
    const changed = (await git(cfg, ['diff', '--name-only', '--no-renames', `${baseRef}...${head}`], ms)).split('\n').filter(Boolean);
    // The leak scan of the head's shipped tree (S-3383), before the slower prediction.
    // A leak refuses at once: the checks after it read the same tree and would only bury it.
    const leaks = await leakProblems(cfg, head);
    if (leaks.length) throw new Error(`pr_open refuses: ${leaks.join('; ')}`);
    // The gate's own prediction for this diff, on main's rules (S-2480); the LIGHT ones among it run here, before the body is read.
    // The required set is the merge result's, as runPr reads it (predicted.changed and modes), not the branch's own diff.
    const { predicted, light } = await predictWithLight(cfg, head, baseRef, dir);
    // A LIGHT test that failed, timed out or was skipped is advisory: a test can still fail on the head, so it is noted, not refused. The body's NAME: PASS line is what counts.
    advisory.push(...[...light.values()].filter((p): p is string => p !== null));
    // S-3606: main's rules name a gate kind the gate script doesn't know: a warning here, a refusal at the merge.
    if (predicted.unknownKinds?.length && predicted.note) advisory.push(predicted.note);
    const runSh = await headRunSh(cfg, head, ms);
    problems.push(...(await gateAddedProblems(body, predicted.changed, { rows: predicted.rows, light, note: predicted.note, modes: predicted.modes, inRunSh: (name) => runTestLists(runSh, name).length > 0 })));
    if (changed.some((p) => SHIPPED_TREE.test(p))) problems.push(...(await overridesProblems(cfg, head, changed, dir)));
  } catch (e: any) {
    // A check that ran out of time is refused, never passed (S-1942): the caller runs pr_open again.
    if (e?.timedOut) throw new Error(`pr_open refuses: the stories and overrides check timed out (${e.message}); run pr_open again`);
    throw e;
  } finally {
    await git(cfg, ['update-ref', '-d', baseRef]).catch(() => {});
  }
  if (problems.length) throw new Error(`pr_open refuses: ${problems.join('; ')}`);
  return advisory;
}

// The tests the merge gate adds for these changed paths, each with the path and rule that matched: the one list both the refusal and the dry run (S-3287) read.
async function requiredTests(changed: string[], rows?: unknown[], modes: string[] = []): Promise<{ name: string; why: string }[]> {
  const gates = await gate();
  const names: string[] = gates.pathGateTests(changed, rows, modes);
  if (names.length === 0) return [];
  const { added } = gates.addPathGates([], changed, modes, rows);
  return names.map((name) => {
    const a = added.find((g: { gate: string }) => g.gate.split(' ').slice(1).includes(name));
    return { name, why: a ? a.reasons.map((r: { why: string; paths: string[] }) => `${r.why}: ${r.paths.slice(0, 3).join(', ')}${r.paths.length > 3 ? ', ...' : ''}`).join('; ') : '' };
  });
}

// The tests the merge gate adds for the branch's files (addPathGates, S-2250), each of which the body must report as run in one strict
// format, a token `NAME: PASS` (NAME may be in backticks, PASS may be PASSED, any case) in the free text below the header, several to a line
// separated by `,` or `;`. Nothing else counts (a Gates listing, `ran NAME`, counts, a bare mention, `blocks/foo.md` for `blocks`), and a
// `NAME: FAIL`, `NAME: SKIPPED` or `NAME: NOT RUN` token refuses it, quoting the line, as does a PASS followed by a count
// (`pass 118`) or on a line that counts failures (`fail 2`). Prose was tried and dropped after three review
// rounds of false passes and false refusals. #682 said "not run; the gate adds them" and failed merge-pr-unit in the train.
// S-2480: the tests are the merge gate's for main's rows (ROWS; this checkout's when none), and a LIGHT test pr_open ran itself counts as
// evidence when it passed (LIGHT, from runLightTests), so the body needs no line for it. The refusal lists every predicted test with the
// path and rule that matched, and every missing NAME: PASS line at once, and it names the rules' note when main's copy didn't load.
// `inRunSh` (S-2842) says whether the branch's own test/run.sh lists a name: one main's rules add that it doesn't is merged-in work to pull, not a missing line.
export async function gateAddedProblems(body: string, changed: string[], { rows, light = new Map(), note = null, modes = [], inRunSh = null }: { rows?: unknown[]; light?: Map<string, string | null>; note?: string | null; modes?: string[]; inRunSh?: ((name: string) => boolean) | null } = {}): Promise<string[]> {
  const tests = await requiredTests(changed, rows, modes);
  if (tests.length === 0) return [];
  const required = tests.map((t) => t.name);
  const why = (name: string): string => tests.find((t) => t.name === name)?.why ?? '';
  const text = body.split('\n').slice(HEADER.length);
  const bad: string[] = [];
  const absent = inRunSh ? required.filter((name) => !inRunSh(name)) : [];
  const absentLines = absent.map((name) => `${name} isn't in this branch's test/run.sh: merge origin/main first`);
  for (const name of required) {
    if (absent.includes(name)) continue;
    // A LIGHT test pr_open ran and passed is evidence. A failed, timed-out or skipped one is advisory and needs the body's NAME: PASS line.
    if (light.get(name) === null) continue;
    const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const token = new RegExp(`\`?(?<![\\w./-])${n}(?![\\w/-])\`?\\s*:\\s*(PASS(?:ED)?\\b(?!\\s*\\d)|FAIL(?:ED|S|ING)?\\b|SKIPPED\\b|NOT\\s+RUN\\b)`, 'gi');
    const verdicts = text.flatMap((l) => [...l.matchAll(token)].map((m) => ({ line: l, verdict: m[1].toUpperCase() })));
    // A PASS on a line that also counts failures (`fail 2`, `2 failures`) is not a pass.
    const failCount = /\bfail(?:ed|s|ures?)?\s*[:=]?\s*[1-9]|\b[1-9]\d*\s+fail/i;
    const notPass = verdicts.find((v) => !v.verdict.startsWith('PASS') || failCount.test(v.line));
    if (notPass) bad.push(`${name} (the body says: "${notPass.line.trim()}")`);
    else if (verdicts.length === 0) bad.push(`${name} (add the line \`${name}: PASS\`)`);
  }
  if (bad.length === 0) return absentLines;
  const predicted = required.map((name) => `${name} (${why(name)})`).join('; ');
  return [...absentLines, `the gate adds these tests for this branch's files: ${predicted}. The body doesn't report as \`NAME: PASS\`: ${bad.join('; ')}. Run each with scripts/test-slot.sh test/run.sh NAME and add its \`NAME: PASS\` line to the body (run pr_open with predict: true first to list them)${note ? `; ${note}` : ''}`];
}

// The export overrides problems of a branch (S-858): the ports its shipped edits lack, and the branch's own --check.
async function overridesProblems(cfg: PrOpenConfig, head: string, changed: string[], dir: string): Promise<string[]> {
  const tar = join(dir, 'tree.tar');
  const tree = join(dir, 'tree');
  const ms = cfg.checkTimeoutMs ?? CHECK_GIT_MS;
  // What --check reads, named by the head's own manifest and doc-patches.json, so a new patch target is archived with the
  // rest (S-1942): the export tree, the registry, each patched file, each shipped doc, and each template's text.
  const listed = JSON.parse(await git(cfg, ['show', `${head}:export/overrides/manifest.json`], ms)) as Manifest;
  const patched = Object.keys(JSON.parse(await git(cfg, ['show', `${head}:export/overrides/doc-patches.json`], ms)));
  const shipped = [...Object.keys(listed.docs ?? {}).map((n) => `docs/${n}`), ...Object.keys(listed.templates ?? {}).flatMap((n) => [`templates/${n}.md`, `blocks/${n}/`])];
  const files = (await git(cfg, ['ls-tree', '-r', '--name-only', head], ms)).split('\n');
  // The shrink rule (S-3909) also reads the source of every override file on disk, listed in the manifest or not.
  const overrideDocs = files.filter((p) => p.startsWith('export/overrides/docs/')).map((p) => `docs/${p.slice('export/overrides/docs/'.length)}`);
  const overrideTemplates = files.filter((p) => /^export\/overrides\/templates\/[^/]+\.md$/.test(p)).flatMap((p) => { const n = p.slice('export/overrides/templates/'.length, -3); return [`templates/${n}.md`, `blocks/${n}/`]; });
  const needed = files.filter((p) => p.startsWith('export/') || p === 'registry/defaults.json' || patched.includes(p) || [...shipped, ...overrideDocs, ...overrideTemplates].some((s) => p === s || (s.endsWith('/') && p.startsWith(s))));
  await git(cfg, ['archive', '--format=tar', '-o', tar, head, ...needed], ms);
  mkdirSync(tree);
  await run('tar', ['-x', '-f', tar, '-C', tree], { timeout: ms }).catch((e: any) => {
    throw e.killed ? timedOut('tar', ms) : e;
  });
  const manifest = JSON.parse(readFileSync(join(tree, 'export/overrides/manifest.json'), 'utf8')) as Manifest;
  const problems: string[] = [];
  for (const name of Object.keys(manifest.docs ?? {})) {
    const doc = `docs/${name}`;
    const port = `export/overrides/docs/${name}`;
    if (changed.includes(doc) && !changed.includes(port)) {
      problems.push(`${doc} is shipped and this branch edits it, but not its public version ${port}: port the edit there, commit it, then run node export/doc-shas.mjs to set the docs entry in export/overrides/manifest.json`);
    }
  }
  for (const name of Object.keys(manifest.templates ?? {})) {
    const port = `export/overrides/templates/${name}.md`;
    const edited = changed.find((p) => p === `templates/${name}.md` || p.startsWith(`blocks/${name}/`));
    if (edited && !changed.includes(port)) {
      problems.push(`${edited} is shipped and this branch edits it, but not its generic override ${port}: port the edit there and refresh export/overrides/manifest.json (node scripts/refresh-derived.mjs prints the block diff to port)`);
    }
  }
  try {
    await run(process.execPath, [join(tree, 'export/apply-overrides.mjs'), '--check', tree], { cwd: tree, timeout: CHECK_CHECK_MS });
  } catch (e: any) {
    if (e.killed) throw timedOut('export/apply-overrides.mjs --check', CHECK_CHECK_MS);
    problems.push(`export/apply-overrides.mjs --check fails on the branch: ${String(e.stderr ?? e.message).trim()}`);
  }
  return problems;
}

// S-2480: the LIGHT tests among the predicted ones, run by pr_open itself on the head's tree, so a body needn't report them. Each runs
// through the light test slot (scripts/test-slot.sh --light, S-1288) under `timeout`, one after another: a hung test is killed, and the
// slot with it, so the daemon never waits on one. The timeout wraps the test, not this process, so a daemon restart can't leave it
// holding the slot. The exit code is written only when the test returns: no result is a failure (fail closed). The tree gets this
// checkout's node_modules and web/node_modules, as `stam deps` links them, so a test that imports a package runs. Those are main's
// installed packages, so when the head's package-lock.json or web/package-lock.json differs from the checkout's, no LIGHT test runs
// and the body must report each one as NAME: PASS (the merge gate installs the PR's own packages, which these don't match). All of
// them share the budget: a test that starts after it is spent is skipped, never passed. Returns name -> null when it passed, or the
// reason it is advisory (failed, timed out or skipped): checkTree notes it in the result and the PR body, and it never refuses.
export async function runLightTests(cfg: PrOpenConfig, head: string, names: string[], dir: string): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (names.length === 0) return out;
  const ms = cfg.checkTimeoutMs ?? CHECK_GIT_MS;
  const light: string[] = (await gate()).lightTests(await headRunSh(cfg, head, ms));
  const mine = names.filter((n) => light.includes(n));
  if (mine.length === 0) return out;
  for (const lock of ['package-lock.json', 'web/package-lock.json']) {
    const checkout = existsSync(join(cfg.repo, lock)) ? readFileSync(join(cfg.repo, lock), 'utf8') : '';
    // The head's copy is compared only when git confirms it exists: any other error skips the run, so two missing files never compare equal.
    const confirmed = await git(cfg, ['cat-file', '-e', `${head}:${lock}`], ms).then(() => true, () => false);
    const theirs = confirmed ? await git(cfg, ['show', `${head}:${lock}`], ms).catch(() => null) : null;
    if (theirs !== checkout.trim()) return out;
  }
  const budget = cfg.lightBudgetMs ?? LIGHT_TOTAL_MS;
  const deadline = Date.now() + budget;
  // A detached worktree of the head, not an archive (S-2639): a test that asks git for its files needs the .git the archive lacks.
  // Pruned first, so a registration a daemon restart left behind doesn't linger; removed in the finally, on every path.
  const tree = join(dir, 'light');
  await git(cfg, ['worktree', 'prune'], ms).catch(() => {});
  await git(cfg, ['worktree', 'add', '--detach', tree, head], ms);
  try {
    for (const pkgs of LIGHT_LINKS) {
      if (!existsSync(join(cfg.repo, pkgs))) continue;
      mkdirSync(dirname(join(tree, pkgs)), { recursive: true });
      symlinkSync(join(cfg.repo, pkgs), join(tree, pkgs));
    }
    for (const name of mine) {
      const left = deadline - Date.now();
      if (left <= 0) {
        out.set(name, `${name} wasn't run: the LIGHT tests used their ${budget / 1000} s budget first: run pr_open again, or move a slow test out of LIGHT`);
        continue;
      }
      const testMs = Math.min(cfg.lightTimeoutMs ?? LIGHT_TEST_MS, left);
      const secs = testMs / 1000;
      const result = join(dir, `light-${name}.result`);
      const log = join(dir, `light-${name}.log`);
      // $1 is the test, $2 its log, $3 its exit code file. The shell is the one timeout kills.
      await run('timeout', ['-k', '5', String(secs), 'sh', '-c', 'exec >"$2" 2>&1; sh scripts/test-slot.sh --light sh test/run.sh "$1"; echo "$?" >"$3"', 'sh', name, log, result], { cwd: tree, timeout: testMs + 15_000 }).catch(() => {});
      const code = existsSync(result) ? readFileSync(result, 'utf8').trim() : '';
      if (code === '0') out.set(name, null);
      else if (code === '') out.set(name, `${name} gave no result (it timed out after ${secs} s or was killed): run pr_open again`);
      else {
        const tail = readFileSync(log, 'utf8').trimEnd().split('\n').slice(-5).join(' | ');
        out.set(name, `${name} failed (exit ${code}): ${tail}`);
      }
    }
  } finally {
    await removeLightTree(cfg, tree, ms);
  }
  return out;
}

// The checkout's packages the LIGHT tree links to (S-2480). Removed with the tree, the links first, so git never follows one into the checkout.
const LIGHT_LINKS = ['node_modules', 'web/node_modules'];
async function removeLightTree(cfg: PrOpenConfig, tree: string, ms: number): Promise<void> {
  for (const pkgs of LIGHT_LINKS) rmSync(join(tree, pkgs), { force: true });
  await git(cfg, ['worktree', 'remove', '--force', tree], ms).catch(() => {});
  rmSync(tree, { recursive: true, force: true });
  await git(cfg, ['worktree', 'prune'], ms).catch(() => {});
}

// S-3486: refuses when the head fetched for the branch is not the head of the caller's worktree, so a reused branch name (an old head on
// origin or storage, the new one only in the worktree) never opens or predicts the old head. Names both shas; no remote URL.
function checkWorktreeHead(branch: string, fetched: string, worktree?: string | null): void {
  if (!worktree || worktree === fetched) return;
  throw new Error(`${branch} is at ${fetched.slice(0, 8)} where pr_open fetched it, but your worktree's HEAD is ${worktree.slice(0, 8)}: the branch name is probably reused, with an old head already on the remote. Push your head to the remote (git push origin ${branch}) or use another branch name, then run pr_open again.`);
}

// Where the branch comes from, and the ref to read it at (fetched into `scratch` when it comes from storage).
// Without a storage remote the branch is the checkout's own local one.
// An unset storage setting ('') means the `storage` remote when the checkout has one, else the local branch;
// a named remote the checkout lacks is an error, not a silent local push.
// `local` (the caller works on this machine, whose worktrees share the checkout's refs) takes the local branch
// unless the storage setting names a remote: a developer on the home has no storage copy to fetch, or a stale one.
// An explicit storage wins whenever storage has the branch: the checkout's ref may be stale (a manager's B at A while
// the developer pushed B to storage), and force-with-lease would rewind GitHub to it (S-2390 review). The checkout's
// branch is the fallback only when storage lacks it (S-754, S-2316): storage may not have it yet.
async function resolveSource(cfg: PrOpenConfig, branch: string, local: boolean, scratch: string): Promise<{ storage: string; source: string }> {
  const storage = local && !cfg.storage ? '' : await storageRemote(cfg);
  if (!storage) return { storage, source: `refs/heads/${branch}` };
  const missing = await git(cfg, ['fetch', '--no-tags', storage, `+refs/heads/${branch}:${scratch}`]).then(
    () => false,
    (e: Error) => {
      if (!/couldn't find remote ref/.test(e.message)) throw e;
      return e.message;
    },
  );
  if (missing && local && (await hasLocalBranch(cfg, branch))) return { storage, source: `refs/heads/${branch}` };
  if (missing) throw new Error(`${missing}; ${branch} isn't on the ${storage} remote: run git push ${storage} ${branch} from its worktree, then pr_open again`);
  return { storage, source: scratch };
}

// Fetches the branch from storage (or, with `local`, takes the checkout's own branch), pushes it to origin, and opens or updates the PR, then mirrors its head to
// storage as refs/pull/N/head (S-1347; a failed mirror never fails the open). The mirror is for a branch that came from
// storage: a `local` open (a developer on the home) skips it unless the storage setting names a remote, so a stopped
// storage is never pushed to (S-1417). Touches no branch or working tree of the repo: the fetch lands in refs/stam/pr-open/BRANCH.
export async function openPr(cfg: PrOpenConfig, input: PrOpenInput, local = false): Promise<PrOpened> {
  const pr = await openOrUpdate(cfg, input, local);
  // Not awaited: the mirror never rejects, and a slow or stalled storage push must not hold the PR's reply.
  if (!local || cfg.storage) void mirrorPrHead(cfg, pr.number, pr.head);
  const lag = await headLagNote(cfg, pr);
  return lag ? { ...pr, warning: [pr.warning, lag].filter(Boolean).join(' ') } : pr;
}

// The wait before pr_open's second read of GitHub's PR head, and the sleep it runs in (a test replaces both).
export const headLag = { recheckMs: 5_000, sleep: (ms: number) => new Promise<void>((done) => setTimeout(done, ms)) };

// GitHub's PR head can lag a push by seconds or minutes (S-3385). Reads it after the push, and again after headLag.recheckMs, so a
// head that is only briefly behind adds no note; says so when the second read still isn't the sha pushed. Each read is capped at 15 s.
// Reports only: a failed read or a stale head never fails the PR or retries the push.
async function headLagNote(cfg: PrOpenConfig, pr: PrOpened): Promise<string> {
  const read = () => prView(cfg, pr.number, 15_000).then((v) => v.head, () => '');
  const first = await read();
  if (!first || first === pr.head) return '';
  await headLag.sleep(headLag.recheckMs);
  const shown = await read();
  if (!shown || shown === pr.head) return '';
  return `pushed ${short(pr.head)}; GitHub's PR head still shows ${short(shown)}, wait for synchronize.`;
}

// The dry run of pr_open (S-3287): what the real call would require of this branch's body, with nothing pushed, no PR opened and no
// body needed. It reads the branch the way openPr does (resolveSource) and runs the same prediction and LIGHT tests (predictWithLight),
// so the two can't disagree. Fail closed: a prediction or LIGHT run that fails, times out or returns the wrong shape throws; it never
// returns an empty "nothing required" list.
export async function predictOpen(given: PrOpenConfig, input: Pick<PrOpenInput, 'branch' | 'head'>, local = false): Promise<PrPrediction> {
  const branch = checkBranch(given, input.branch);
  const { config: repoConfig, base } = await repoConfigOf(given);
  const cfg = { ...given, base };
  if (branch === base) throw new Error(`pr_open won't open a PR from ${base}`);
  const dir = mkdtempSync(join(tmpdir(), 'stam-pr-predict-'));
  const baseRef = `refs/stam/pr-open-base/${basename(dir)}`;
  // Its own fetch ref, so a dry run never moves the ref a real open of the same branch resolves.
  const scratch = `refs/stam/pr-open-predict/${basename(dir)}`;
  try {
    const ms = cfg.checkTimeoutMs ?? CHECK_GIT_MS;
    const { source } = await resolveSource(cfg, branch, local, scratch);
    const head = await git(cfg, ['rev-parse', '--verify', source]);
    checkWorktreeHead(branch, head, input.head);
    if (repoConfig) return { branch, head, base, baseName: base, applies: false, tests: [], lines: [], note: null, message: `${cfg.repoName} has a ${CONFIG_PATH}: its gates are named on the Gates line, and its PR body carries no NAME: PASS lines.` };
    await git(cfg, ['fetch', '--no-tags', cfg.origin, `+refs/heads/${base}:${baseRef}`], ms);
    // The same refusal as a real open (S-3383): a leaking branch has no list to report.
    const leaks = await leakProblems(cfg, head);
    if (leaks.length) throw new Error(`pr_open predict refuses: ${leaks.join('; ')}`);
    const { predicted, light } = await predictWithLight(cfg, head, baseRef, dir);
    // Informational (S-3665): a failure to read the removals leaves the list empty; it never fails the prediction.
    const removed = await removedTestCases(cfg, baseRef, head, ms).catch(() => []);
    const runSh = await headRunSh(cfg, head, ms);
    const tests: PredictedTest[] = (await requiredTests(predicted.changed, predicted.rows, predicted.modes)).map(({ name, why }) => {
      if (runTestLists(runSh, name).length === 0) return { name, why, need: 'absent' };
      const ran = light.get(name);
      if (ran === null) return { name, why, need: 'passed' };
      return { name, why, need: 'body', ...(ran ? { advisory: ran } : {}) };
    });
    return { branch, head, base: await git(cfg, ['rev-parse', '--verify', baseRef], ms), baseName: base, applies: true, tests, lines: tests.filter((t) => t.need === 'body').map((t) => `${t.name}: PASS`), note: predicted.note ?? null, removed };
  } catch (e: any) {
    if (e?.timedOut) throw new Error(`pr_open predict failed: the prediction timed out (${e.message}); this is not an empty list, run it again`);
    throw e;
  } finally {
    await git(cfg, ['update-ref', '-d', baseRef]).catch(() => {});
    await git(cfg, ['update-ref', '-d', scratch]).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

// On the ITSA home: the same push rule as a real call (a branch that is another agent's refuses), then the dry run.
export async function predictHere(input: Pick<PrOpenInput, 'branch' | 'by' | 'head'>, via?: Via, cfg: PrOpenConfig = prOpenConfig()): Promise<PrPrediction> {
  if (via && !via.boss) {
    const why = await pushRefusal(via, String(input.branch ?? ''));
    if (why) throw new itsa.ForbiddenError(why);
  }
  const local = input.by ? db.getAgent(input.by)?.machine === MACHINE : false;
  return predictOpen(cfg, input, local);
}

// Runs on the ITSA home, as openPrRouted does: a dry run from storage reaches the home over the peer link.
export async function predictRouted(input: Pick<PrOpenInput, 'branch' | 'by' | 'head'>, via?: Via): Promise<PrPrediction> {
  const home = settings().itsa.home ?? MACHINE;
  if (home === MACHINE) return predictHere(input, via);
  const peer = peerByName(home);
  if (!peer) throw new Error(`ITSA home '${home}' is not a configured peer`);
  const sent = via && !via.boss ? { ...via, scope: localScope(via.agent, input.branch) } : via;
  const r = await peerCall(peer, 'POST', '/api/pr/predict', input, PR_OPEN_PEER_MS, input.by === HUMAN, sent);
  if (r.status === 403) throw new itsa.ForbiddenError(r.data?.error ?? `${home}: HTTP 403`);
  if (r.status !== 200) throw new Error(r.data?.error ?? `${home}: HTTP ${r.status}`);
  return r.data;
}

async function openOrUpdate(given: PrOpenConfig, input: PrOpenInput, local: boolean): Promise<PrOpened> {
  const { repoConfig, cfg } = await checkInput(given, input);
  const branch = input.branch;
  const title = input.title.trim();
  const dir = mkdtempSync(join(tmpdir(), 'stam-pr-open-'));
  // GitHub's head as this run checked it: named by the run's own temp dir, so runs don't share it.
  const ghRef = `refs/stam/pr-open-gh/${basename(dir)}`;
  try {
    const bodyFile = join(dir, 'body.md');
    const scratch = `refs/stam/pr-open/${branch}`;
    const { storage, source } = await resolveSource(cfg, branch, local, scratch);
    const head = await git(cfg, ['rev-parse', '--verify', source]);
    checkWorktreeHead(branch, head, input.head);
    // The lease expects origin's current sha (empty when the branch is new), so a push can't clobber a commit that landed on
    // origin since this read. Every refusal runs before the push (S-3009), so a refused pr_open leaves GitHub's branch as it was.
    let current = (await git(cfg, ['ls-remote', '--heads', cfg.origin, `refs/heads/${branch}`])).split('\t')[0] ?? '';
    if (current) current = await checkGithubHead(cfg, branch, current, head, ghRef, storage);
    // `run NAME`, the stories and the export overrides belong to the gate.mjs flow; a config repo's gates are checked in checkInput.
    let advisory: string[] = [];
    if (!repoConfig) {
      await checkRunNames(cfg, input.body, head);
      advisory = await checkTree(cfg, input.body, head, dir);
    }
    // The advisory LIGHT notes go below the body's own lines, so the PR says what didn't run; the header lines are unchanged.
    const prBody = advisory.length ? `${input.body.trimEnd()}\n\nLIGHT advisory (not a refusal):\n${advisory.map((a) => `- ${a}`).join('\n')}\n` : input.body;
    writeFileSync(bodyFile, prBody);
    current = await recheckGithubHead(cfg, branch, current, head);
    // The sha captured above, not the ref: another call's fetch into the scratch ref can't change what is pushed and reported.
    await git(cfg, ['push', `--force-with-lease=refs/heads/${branch}:${current}`, cfg.origin, `${head}:refs/heads/${branch}`]);

    // The sync (pr-sync.ts) treats this head as already on GitHub, and a later run may replace it (checkGithubHead).
    noteSynced(branch, head);
    // GitHub's head was behind the branch and this push moved it: say so, since later pushes need pr_open again (S-2267).
    const warning = await headNote(cfg, branch, current, head);
    const opened = (r: PrOpened): PrOpened => ({ ...r, ...(warning ? { warning } : {}), ...(advisory.length ? { advisory } : {}) });
    const open = await openPrFor(cfg, branch);
    if (open) {
      await gh(cfg, ['api', '-X', 'PATCH', `repos/${cfg.github}/pulls/${open.number}`, '-F', `body=@${bodyFile}`]);
      return opened({ number: open.number, url: open.url, created: false, branch, head });
    }
    let out: string;
    try {
      out = await gh(cfg, ['pr', 'create', '--repo', cfg.github, '--base', cfg.base, '--head', branch, '--title', title, '--body-file', bodyFile]);
    } catch (e) {
      // A create that timed out or failed may still have opened the PR (S-899). Report that PR, once its body
      // has the header lines; with no PR on the head, the create's failure stands.
      const made = await openPrFor(cfg, branch).catch(() => null);
      if (!made) throw e;
      if (headerOf((await prView(cfg, made.number)).body) !== headerOf(input.body)) {
        await gh(cfg, ['api', '-X', 'PATCH', `repos/${cfg.github}/pulls/${made.number}`, '-F', `body=@${bodyFile}`]);
      }
      console.error(`pr_open: create failed (${e instanceof Error ? e.message : e}), but PR #${made.number} is open on ${branch}: using it`);
      return opened({ number: made.number, url: made.url, created: true, branch, head });
    }
    const url = out.trim().split('\n').pop() ?? '';
    const m = /\/pull\/(\d+)$/.exec(url);
    if (!m) throw new Error(`gh pr create printed no PR url: ${out.trim()}`);
    return opened({ number: Number(m[1]), url, created: true, branch, head });
  } finally {
    await git(cfg, ['update-ref', '-d', ghRef]).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

// Links the PR and the branch to the ITSA, skipping links it already has (an update adds none).
async function linkPr(cfg: PrOpenConfig, pr: PrOpened, ref: string, by: string | null): Promise<void> {
  const have = itsa.links(ref);
  if (!have.some((l) => l.system === 'github' && l.external_id === String(pr.number))) {
    await itsa.addLink(ref, { system: 'github', url: pr.url, external_id: String(pr.number) }, by);
  }
  if (!have.some((l) => l.system === 'branch' && l.external_id === pr.branch)) {
    await itsa.addLink(ref, { system: 'branch', external_id: pr.branch, repo: cfg.repoName, url: '' }, by);
  }
}

// Records the digest of the instruction-file changes the pushed head makes on the ITSA's branch link (S-3833), which merge-pr's
// instruction gate binds your user's approval to. A failed read records nothing, and the gate then stays shut.
async function recordInstruction(cfg: PrOpenConfig, pr: PrOpened, ref: string): Promise<void> {
  const baseRef = `refs/stam/pr-open-instr/${randomBytes(4).toString('hex')}`;
  try {
    await git(cfg, ['fetch', '--no-tags', cfg.origin, `+refs/heads/${cfg.base}:${baseRef}`], 60_000);
    const digest = (await gate()).instructionDigest(cfg.repo, await git(cfg, ['rev-parse', '--verify', baseRef]), pr.head);
    itsa.recordPush(ref, pr.branch, pr.head, digest);
  } catch (e) {
    console.error(`pr_open: instruction digest not recorded: ${e instanceof Error ? e.message : e}`);
  } finally {
    await git(cfg, ['update-ref', '-d', baseRef]).catch(() => {});
  }
}

// Sets the ITSA's `stage` field to review (S-924) when the field exists. A refused move (the process
// edges don't allow it from the current stage) or a missing field never fails the PR.
async function markReview(ref: string, by: string | null): Promise<void> {
  if (!itsa.fields().some((f) => f.key === 'stage')) return;
  try {
    await itsa.set(ref, { fields: { stage: 'review' } }, by);
  } catch (e) {
    console.error(`pr_open: stage not set to review: ${e instanceof Error ? e.message : e}`);
  }
}

// Why an agent may not push a branch (S-581), or null when it may. Rule 1: a branch that is another
// agent's worktree branch, on either machine, is refused whatever its links. Rule 2: otherwise the branch
// is the caller's own tree's, or linked to an ITSA the caller owns or takes part in. The chief of staff
// and the assistant (via.boss) keep full rights, as on every ITSA route.
export async function pushRefusal(via: Via, branch: string): Promise<string | null> {
  if (via.boss) return null;
  const linked = db.open().prepare("SELECT itsa_id FROM itsa_links WHERE system = 'branch' AND external_id = ?").all(branch) as { itsa_id: string }[];
  // A process proposal's branch is fixed once filed (S-1085): the human approved that diff, so no agent pushes to it.
  if (linked.some((l) => itsa.find(l.itsa_id)?.kind === 'proposal' && processProposalOf(itsa.find(l.itsa_id)!))) return `${branch} is a process proposal's branch: nobody pushes to it after it is filed. Edit the process again and file a new proposal.`;
  const scope = await branchScope(via, branch);
  if (scope === 'tree') return null;
  if (scope === 'foreign') return foreignRefusal(via, branch, 'push');
  if (linked.some((l) => mayEditItsa(via.agent, l.itsa_id))) return null;
  const name = db.getAgent(via.agent)?.name ?? via.agent;
  const link = `itsa_link (itsa: the ITSA, system: "branch", external_id: "${branch}", repo: "${primaryRepoName(settings().itsa)}")`;
  return `${name} can't push ${branch}: it is not the branch of ${name}'s own worktree or a child's, and no ITSA ${name} owns or takes part in links it (rule 2). Run ${link} on an ITSA you own, then pr_open again.`;
}

// The push refusal, after linking the branch to ITSA `ref` when the caller owns that ITSA and rule 2 is all that refuses it (S-2269):
// the link is the one itsa_link makes, so a second branch in the caller's own worktree opens in one pr_open. A rule 1 refusal stays.
async function pushRefusalLinking(via: Via, branch: string, ref: string | null): Promise<string | null> {
  const why = await pushRefusal(via, branch);
  // Only the owner links: a participant, a creator or an ancestor's owner may change the ITSA but doesn't own the branch's link (S-2390).
  if (!why || !ref || !why.includes('rule 2') || itsa.must(ref).owner !== via.agent || (await linkRefusal(via, branch))) return why;
  await itsa.addLink(ref, { system: 'branch', external_id: branch, repo: primaryRepoName(settings().itsa), url: '' }, via.agent);
  return pushRefusal(via, branch);
}

// On the ITSA home: refuses an unknown ITSA or one the asker may not change before any push.
export async function openPrHere(input: PrOpenInput, via?: Via, cfg: PrOpenConfig = prOpenConfig()): Promise<PrOpened> {
  const ref = input.itsa ? itsa.must(input.itsa).id : null;
  if (ref && via && !via.boss && !mayEditItsa(via.agent, ref)) throw new itsa.ForbiddenError(itsaRefusal(via.agent, ref, 'change'));
  if (via && !via.boss) {
    const why = await pushRefusalLinking(via, String(input.branch ?? ''), ref);
    if (why) throw new itsa.ForbiddenError(why);
  }
  // A caller on this machine (the ITSA home) works in a worktree of this checkout, so its branch is a local ref.
  const local = input.by ? db.getAgent(input.by)?.machine === MACHINE : false;
  const pr = await openPr(cfg, input, local);
  if (ref) {
    await linkPr(cfg, pr, ref, input.by ?? null);
    await recordInstruction(cfg, pr, ref);
    await markReview(ref, input.by ?? null);
  }
  return pr;
}

// Runs on the ITSA home, wherever the call came from: this daemon when it's the home, else the home over
// the peer link (as itsa postRouted does), where the home's own route runs openPrHere.
export async function openPrRouted(input: PrOpenInput, via?: Via): Promise<PrOpened> {
  const home = settings().itsa.home ?? MACHINE;
  if (home === MACHINE) return openPrHere(input, via);
  const peer = peerByName(home);
  if (!peer) throw new Error(`ITSA home '${home}' is not a configured peer`);
  // This daemon knows the caller's agents: it answers who owns the branch among them, for the home to add its own (S-581).
  const sent = via && !via.boss ? { ...via, scope: localScope(via.agent, input.branch) } : via;
  const r = await peerCall(peer, 'POST', '/api/pr/open', input, PR_OPEN_PEER_MS, input.by === HUMAN, sent);
  if (r.status === 403) throw new itsa.ForbiddenError(r.data?.error ?? `${home}: HTTP 403`);
  if (r.status !== 200) throw new Error(r.data?.error ?? `${home}: HTTP ${r.status}`);
  return r.data;
}

// What a caller that timed out on pr_open finds on GitHub (S-1332): the open PR on the branch, its head, and whether
// the body it sent and the ITSA's PR and branch links are there. Read-only; a retry of pr_open is safe either way.
export interface PrStatusInput {
  branch: string;
  // The body and ITSA the caller sent: body_written and itsa_linked compare against them.
  body?: string | null;
  itsa?: string | null;
  by?: string | null;
}

export interface PrStatus {
  found: boolean;
  branch: string;
  number?: number;
  url?: string;
  head?: string;
  // Whether the PR's body is exactly the body asked about (null when none was asked about).
  body_written?: boolean | null;
  // Whether the ITSA has the PR and the branch linked (null when no ITSA was named).
  itsa_linked?: boolean | null;
}

export async function prStatusHere(input: PrStatusInput, via?: Via, cfg: PrOpenConfig = prOpenConfig()): Promise<PrStatus> {
  const branch = String(input.branch ?? '');
  if (!BRANCH.test(branch)) throw new Error(`a branch name is letters, digits, . _ / and -, not starting with -: ${branch}`);
  const ref = input.itsa ? itsa.must(input.itsa).id : null;
  // The same checks as openPrHere, before anything is read from GitHub: the ITSA, then the branch's owner (S-581).
  if (ref && via && !via.boss && !mayEditItsa(via.agent, ref)) throw new itsa.ForbiddenError(itsaRefusal(via.agent, ref, 'change'));
  if (via && !via.boss) {
    const why = await pushRefusal(via, branch);
    if (why) throw new itsa.ForbiddenError(why);
  }
  const open = await openPrFor(cfg, branch);
  if (!open) return { found: false, branch };
  const view = await prView(cfg, open.number);
  const links = ref ? itsa.links(ref) : [];
  return {
    found: true,
    branch,
    number: open.number,
    url: open.url,
    head: view.head,
    body_written: input.body == null ? null : view.body === input.body,
    itsa_linked: ref ? links.some((l) => l.system === 'github' && l.external_id === String(open.number)) && links.some((l) => l.system === 'branch' && l.external_id === branch) : null,
  };
}

// Runs on the ITSA home, as openPrRouted does (S-1332).
export async function prStatusRouted(input: PrStatusInput, via?: Via): Promise<PrStatus> {
  const home = settings().itsa.home ?? MACHINE;
  if (home === MACHINE) return prStatusHere(input, via);
  const peer = peerByName(home);
  if (!peer) throw new Error(`ITSA home '${home}' is not a configured peer`);
  const sent = via && !via.boss ? { ...via, scope: localScope(via.agent, input.branch) } : via;
  const r = await peerCall(peer, 'POST', '/api/pr/open-status', input, 30_000, input.by === HUMAN, sent);
  if (r.status === 403) throw new itsa.ForbiddenError(r.data?.error ?? `${home}: HTTP 403`);
  if (r.status !== 200) throw new Error(r.data?.error ?? `${home}: HTTP ${r.status}`);
  return r.data;
}

// The default GitHub repo for a bare PR number, resolved on the ITSA home (its settings and checkout), so a
// peer without a github origin gets the home's (S-614).
export async function githubRepoRouted(): Promise<string | null> {
  const home = settings().itsa.home ?? MACHINE;
  if (home === MACHINE) return defaultGithubRepo();
  const peer = peerByName(home);
  if (!peer) throw new Error(`ITSA home '${home}' is not a configured peer`);
  const r = await peerCall(peer, 'GET', '/api/pr/github-repo', undefined, 8000);
  if (r.status !== 200) throw new Error(r.data?.error ?? `${home}: HTTP ${r.status}`);
  return r.data.github ?? null;
}

// Asks the ITSA home for the full verdict (rule 1 and rule 2) before a push to this machine's origin (S-684):
// the ITSA links live there. Throws ForbiddenError on a refusal, and an error when the home can't be reached
// (fails closed). Like openPrRouted, this daemon sends its own answer for rule 1 (Via.scope).
async function pushCheckHome(branch: string, via: Via, itsaRef: string | null = null): Promise<void> {
  const home = settings().itsa.home ?? MACHINE;
  if (home === MACHINE) {
    await pushCheckHere(branch, via, itsaRef);
    return;
  }
  const peer = peerByName(home);
  if (!peer) throw new Error(`ITSA home '${home}' is not a configured peer`);
  const r = await peerCall(peer, 'POST', '/api/pr/push-check', { branch, by: via.agent, itsa: itsaRef }, 30_000, false, { ...via, scope: localScope(via.agent, branch) });
  if (r.status === 403) throw new itsa.ForbiddenError(r.data?.error ?? `${home}: HTTP 403`);
  if (r.status !== 200) throw new Error(`can't push ${branch} now: the ITSA home ${home} could not check its links (${r.data?.error ?? `HTTP ${r.status}`}). Try again when it is up.`);
}

// The home's side of pushCheckHome: runs pushRefusal in full for the forwarded caller.
export async function pushCheckHere(branch: string, via: Via, itsaRef: string | null = null): Promise<void> {
  const why = await pushRefusalLinking(via, branch, itsaRef ? itsa.must(itsaRef).id : null);
  if (why) throw new itsa.ForbiddenError(why);
}

// Before the call is routed to the ITSA home: pushes the agent's own branch from its worktree to its
// `origin` (storage's bare repo, on storage), so the home can fetch it (S-667). Does nothing on the ITSA
// home itself, where there is no storage hop, or when the cwd isn't a worktree on that branch. Refuses the
// base branch and a checkout that isn't a linked worktree (the repo's main checkout, the deploy checkout),
// and when `via` is given, a branch the ITSA home refuses (rules 1 and 2, asked before the push: S-684). The push is leased to the head this
// worktree last saw of origin's branch (pushOwnBranchHead, S-3495): its own rebased branch replaces its old head, another writer's push is refused.
export async function pushOwnBranch(cwd: string | null | undefined, branch: string, via?: Via, itsaRef: string | null = null): Promise<boolean> {
  return (await pushOwnBranchHead(cwd, branch, via, itsaRef)) !== null;
}

// The head of the calling worktree for pr_open and predict (S-3486): pushes it first where the ITSA home is another machine
// (pushOwnBranchHead), and on the home itself only reads it, since a storage setting that names a remote can still hand the home a stale
// copy of the branch. null when the cwd isn't a repo, is gone, or isn't on that branch; a worktree on that branch whose head can't be read throws.
export async function callerHead(cwd: string | null | undefined, branch: string, via?: Via, itsaRef: string | null = null): Promise<string | null> {
  if ((settings().itsa.home ?? MACHINE) !== MACHINE) return pushOwnBranchHead(cwd, branch, via, itsaRef);
  if (!cwd || !BRANCH.test(branch) || branch.startsWith('-')) return null;
  const g = async (args: string[]) => (await run('git', args, { cwd, maxBuffer: 16 << 20, timeout: 120_000 })).stdout.trim();
  // Not a repo, or gone: this home caller has no worktree to compare (the assistant or cos opening another's branch), so no head.
  let on: string;
  try {
    on = await g(['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {
    return null;
  }
  if (on !== branch) return null;
  try {
    return await g(['rev-parse', '--verify', 'HEAD^{commit}']);
  } catch (e: any) {
    throw new Error(`can't read the HEAD of ${branch} in the worktree: ${String(e.stderr ?? e.message).trim()}`);
  }
}

// Whether callerHead pushes the caller's worktree head to origin: only where the ITSA home is another machine (S-3740: predict says what it pushed).
export function callerPushes(): boolean {
  return (settings().itsa.home ?? MACHINE) !== MACHINE;
}

// The head a predict call pushed, for its output's push line (S-3740): the head callerHead returned, when the caller is on this
// machine and this machine is not the ITSA home (the only case callerHead pushes). null otherwise.
export function predictPushedHead(callerOnThisMachine: boolean, head: string | null): string | null {
  return callerOnThisMachine && callerPushes() && head ? head : null;
}

// Injected in tests (S-3495): runs between pushOwnBranchHead's read of the worktree's tracking ref and its push, so a test can move storage's ref in between.
export const pushOwnBranchHooks = { afterRead: async (_branch: string): Promise<void> => {} };

// pushOwnBranch, returning the worktree head it pushed (S-3486), or null where it pushes nothing. The head goes to the ITSA home, which refuses
// when the head it fetches differs. Fails closed: a head that can't be read throws; only "no worktree on that branch" returns null.
// The push is leased to what this worktree last saw of origin's branch, its own refs/remotes/origin/BRANCH (S-3495), empty when it has none:
// a push of its own rebased branch passes, since a successful push updates that ref, while another writer's push since the worktree last
// fetched or pushed is refused, never overwritten.
export async function pushOwnBranchHead(cwd: string | null | undefined, branch: string, via?: Via, itsaRef: string | null = null): Promise<string | null> {
  if ((settings().itsa.home ?? MACHINE) === MACHINE || !cwd || !BRANCH.test(branch) || branch.startsWith('-')) return null;
  if (branch === settings().itsa.mainBranch) throw new Error(`pr_open won't push or open a PR from ${branch}`);
  const g = async (args: string[]) => (await run('git', args, { cwd, maxBuffer: 16 << 20, timeout: 120_000 })).stdout.trim();
  try {
    if ((await g(['rev-parse', '--abbrev-ref', 'HEAD'])) !== branch) return null;
    // A linked worktree has its own git dir, apart from the common one; the main checkout does not.
    const [gitDir, common] = await Promise.all([g(['rev-parse', '--absolute-git-dir']), g(['rev-parse', '--path-format=absolute', '--git-common-dir'])]);
    if (gitDir === common) throw new Error(`${cwd} is a main checkout, not a linked worktree`);
    if (via && !via.boss) await pushCheckHome(branch, via, itsaRef);
    const head = await g(['rev-parse', '--verify', 'HEAD^{commit}']);
    // Empty (no tracking ref) means the worktree never saw origin's branch: the lease then requires origin to lack it.
    const seen = await g(['for-each-ref', '--format=%(objectname)', `refs/remotes/origin/${branch}`]);
    const known = seen ? `origin's ${branch} was ${seen.slice(0, 8)} when this worktree last fetched or pushed it` : `${branch} was not on origin when this worktree last fetched or pushed it`;
    const moved = new Error(`${known}, and another push moved it before this one: fetch ${branch} from origin, rebase onto it, then run pr_open again`);
    // A fetch moves the tracking ref without integrating what it fetched, so the lease counts only when this worktree has the seen head:
    // an ancestor of HEAD, or an old head of its own branch (the reflog keeps it after a rebase). A reflog read error throws.
    if (seen && !(await g(['merge-base', '--is-ancestor', seen, 'HEAD']).then(() => true, () => false))) {
      const own = (await g(['reflog', `refs/heads/${branch}`, '--format=%H'])).split('\n');
      if (!own.includes(seen)) throw moved;
    }
    await pushOwnBranchHooks.afterRead(branch);
    try {
      await g(['push', `--force-with-lease=refs/heads/${branch}:${seen}`, 'origin', `refs/heads/${branch}:refs/heads/${branch}`]);
    } catch (e: any) {
      if (!/stale info/.test(String(e.stderr ?? e.message))) throw e;
      throw moved;
    }
    return head;
  } catch (e: any) {
    if (e instanceof itsa.ForbiddenError) throw e;
    throw new Error(`pushing ${branch} to origin from the worktree failed: ${String(e.stderr ?? e.message).trim()}`);
  }
}
