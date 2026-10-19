// The PR relay (S-514): `pr_open` opens a branch's pull request for an agent that has no gh, such as
// one on storage. It runs on the ITSA home, where gh is: it fetches the branch from storage into a
// scratch ref (or, with no storage remote, takes the checkout's local branch), pushes it to origin, and opens the PR, or replaces the body of the open PR for that
// head. With an ITSA it links the PR and the branch to it. The body is the one docs/pull-requests.md
// describes. Before any push it runs the merge gate's stories and export-overrides checks (S-1942).
// Names come from settings.itsa.prOpen, so a test can point them at throwaway repos.
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { MACHINE } from './config.ts';
import { checkRangeAsync } from '../scripts/story-check.mjs';
import * as itsa from './itsa.ts';
import { HUMAN } from './mail.ts';
import { processProposalOf } from './retro-loop.ts';
import { itsaRefusal, mayEditItsa } from './mail-visibility.ts';
import * as db from './db.ts';
import { branchScope, foreignRefusal, localScope } from './branch-scope.ts';
import { peerByName, peerCall, type Via } from './peers.ts';
import { primaryRepoName, settings } from './settings.ts';
import { defaultGithubRepo, originRepo } from './github-repo.ts';
import { isAncestor, noteSynced, readSyncState } from './pr-sync.ts';
import { mirrorPrHead, storageRemote } from './pr-mirror.ts';

const run = promisify(execFile);

export interface PrOpenInput {
  branch: string;
  title: string;
  body: string;
  // The ITSA the branch delivers (id or key): gets the PR and branch links.
  itsa?: string | null;
  // Who asks: an agent id or name, or the human.
  by?: string | null;
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
}

export interface PrOpened {
  number: number;
  url: string;
  // False when an open PR already had this head, and only its body changed.
  created: boolean;
  branch: string;
  head: string;
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
// static import would stop its daemon at start (S-2140).
const gate = () => import('../scripts/gate.mjs');

async function checkInput(cfg: PrOpenConfig, input: PrOpenInput): Promise<void> {
  const branch = String(input.branch ?? '');
  if (!BRANCH.test(branch) || branch.startsWith('-') || branch.includes('..') || branch.endsWith('/') || branch.endsWith('.lock')) {
    throw new Error(`a branch name is letters, digits, . _ / and -, not starting with -: ${branch}`);
  }
  if (!cfg.github) throw new Error(`pr_open: no GitHub repo: set settings.itsa.prOpen.github, or give ${cfg.repoName}'s ${cfg.origin} remote a github.com url`);
  if (branch === cfg.base) throw new Error(`pr_open won't open a PR from ${cfg.base}`);
  if (!String(input.title ?? '').trim() || /[\r\n]/.test(input.title)) throw new Error('a PR needs a one-line title');
  const lines = String(input.body ?? '').split('\n');
  HEADER.forEach((label, i) => {
    if (!lines[i]?.startsWith(label)) throw new Error(`the PR body starts with the lines ITSA:, Gates:, Deploy: (docs/pull-requests.md); line ${i + 1} must start with ${label}`);
  });
  // The Gates line parses as merge-pr.mjs parses it, so an unknown token is refused here, not after review (S-1292).
  (await gate()).parseGates(input.body);
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
async function gh(cfg: PrOpenConfig, args: string[]): Promise<string> {
  try {
    return (await run(cfg.gh, args, { maxBuffer: 16 << 20, timeout: 120_000 })).stdout;
  } catch (e: any) {
    throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${String(e.stderr ?? e.message).trim()}`);
  }
}

const short = (sha: string): string => sha.slice(0, 8);

// Refuses to replace GitHub's head `current` with `head` (S-673) unless it's the head stam last pushed for the
// branch, or an ancestor of `head`: a fix a manager pushed straight to GitHub must not be overwritten. The
// head is fetched into `ref` (this run's own), so the check reads what GitHub holds now.
async function checkGithubHead(cfg: PrOpenConfig, branch: string, current: string, head: string, ref: string): Promise<void> {
  if (readSyncState()[branch] === current) return;
  await git(cfg, ['fetch', '--no-tags', cfg.origin, `+refs/heads/${branch}:${ref}`]);
  if ((await git(cfg, ['rev-parse', '--verify', ref])) !== current) throw new Error(`GitHub's ${branch} moved while pr_open checked it; run pr_open again`);
  if (await isAncestor(cfg, current, head)) return;
  throw new Error(`GitHub's ${branch} is at ${short(current)}, which isn't in your branch (${short(head)}); a fix may have been pushed there. Merge it first.`);
}

// The open PR whose head is the branch, or null.
async function openPrFor(cfg: PrOpenConfig, branch: string): Promise<{ number: number; url: string } | null> {
  const open = JSON.parse(await gh(cfg, ['pr', 'list', '--repo', cfg.github, '--head', branch, '--state', 'open', '--json', 'number,url'])) as { number: number; url: string }[];
  return open[0] ?? null;
}

async function prView(cfg: PrOpenConfig, number: number): Promise<{ body: string; head: string }> {
  const v = JSON.parse(await gh(cfg, ['pr', 'view', String(number), '--repo', cfg.github, '--json', 'body,headRefOid'])) as { body?: string; headRefOid?: string };
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
    throw new Error(`Gates: no test ${name} in test/run.sh${unit}`);
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
// The shipped trees: a branch that changes one of them runs the overrides check.
const SHIPPED_DIRS = ['docs', 'export', 'templates', 'blocks', 'registry'];
const SHIPPED_TREE = new RegExp(`^(${SHIPPED_DIRS.join('|')})/`);
type Manifest = { docs?: Record<string, string>; templates?: Record<string, string> };
async function checkTree(cfg: PrOpenConfig, body: string, head: string, dir: string): Promise<void> {
  const baseRef = `refs/stam/pr-open-base/${basename(dir)}`;
  const problems: string[] = [];
  try {
    const ms = cfg.checkTimeoutMs ?? CHECK_GIT_MS;
    await git(cfg, ['fetch', '--no-tags', cfg.origin, `+refs/heads/${cfg.base}:${baseRef}`], ms);
    // The gate's per-PR rules (S-830), and the tip's missing-story rule for the components this PR adds or changes:
    // the PR's own changes, not the structure of a base it is behind on (S-1942).
    for (const e of await checkRangeAsync(baseRef, head, { cwd: cfg.repo, body, mode: 'branch', timeoutMs: ms })) problems.push(`stories: ${e}`);
    const changed = (await git(cfg, ['diff', '--name-only', '--no-renames', `${baseRef}...${head}`], ms)).split('\n').filter(Boolean);
    if (changed.some((p) => SHIPPED_TREE.test(p))) problems.push(...(await overridesProblems(cfg, head, changed, dir)));
  } catch (e: any) {
    // A check that ran out of time is refused, never passed (S-1942): the caller runs pr_open again.
    if (e?.timedOut) throw new Error(`pr_open refuses: the stories and overrides check timed out (${e.message}); run pr_open again`);
    throw e;
  } finally {
    await git(cfg, ['update-ref', '-d', baseRef]).catch(() => {});
  }
  if (problems.length) throw new Error(`pr_open refuses: ${problems.join('; ')}`);
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
  const needed = (await git(cfg, ['ls-tree', '-r', '--name-only', head], ms)).split('\n').filter((p) => p.startsWith('export/') || p === 'registry/defaults.json' || patched.includes(p) || shipped.some((s) => p.startsWith(s)));
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
      problems.push(`${doc} is shipped and this branch edits it, but not its public version ${port}: port the edit there and set the sha256 of the new ${doc} under "docs" in export/overrides/manifest.json (sha256sum ${doc})`);
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

// Fetches the branch from storage (or, with `local`, takes the checkout's own branch), pushes it to origin, and opens or updates the PR, then mirrors its head to
// storage as refs/pull/N/head (S-1347; a failed mirror never fails the open). The mirror is for a branch that came from
// storage: a `local` open (a developer on the home) skips it unless the storage setting names a remote, so a stopped
// storage is never pushed to (S-1417). Touches no branch or working tree of the repo: the fetch lands in refs/stam/pr-open/BRANCH.
export async function openPr(cfg: PrOpenConfig, input: PrOpenInput, local = false): Promise<PrOpened> {
  const pr = await openOrUpdate(cfg, input, local);
  // Not awaited: the mirror never rejects, and a slow or stalled storage push must not hold the PR's reply.
  if (!local || cfg.storage) void mirrorPrHead(cfg, pr.number, pr.head);
  return pr;
}

async function openOrUpdate(cfg: PrOpenConfig, input: PrOpenInput, local: boolean): Promise<PrOpened> {
  await checkInput(cfg, input);
  const branch = input.branch;
  const title = input.title.trim();
  const dir = mkdtempSync(join(tmpdir(), 'stam-pr-open-'));
  // GitHub's head as this run checked it: named by the run's own temp dir, so runs don't share it.
  const ghRef = `refs/stam/pr-open-gh/${basename(dir)}`;
  try {
    const bodyFile = join(dir, 'body.md');
    writeFileSync(bodyFile, input.body);
    const scratch = `refs/stam/pr-open/${branch}`;
    // Without a storage remote the branch is the checkout's own local one.
    // An unset storage setting ('') means the `storage` remote when the checkout has one, else the local branch;
    // a named remote the checkout lacks is an error, not a silent local push.
    // `local` (the caller works on this machine, whose worktrees share the checkout's refs) takes the local branch
    // unless the storage setting names a remote: a developer on the home has no storage copy to fetch, or a stale one.
    const storage = local && !cfg.storage ? '' : await storageRemote(cfg);
    let source = scratch;
    if (storage) await git(cfg, ['fetch', '--no-tags', storage, `+refs/heads/${branch}:${scratch}`]);
    else source = `refs/heads/${branch}`;
    const head = await git(cfg, ['rev-parse', '--verify', source]);
    await checkRunNames(cfg, input.body, head);
    await checkTree(cfg, input.body, head, dir);
    // The lease expects origin's current sha (empty when the branch is new), so a push can't clobber
    // a commit that landed on origin since the check, nor one that landed since the fetch.
    const current = (await git(cfg, ['ls-remote', '--heads', cfg.origin, `refs/heads/${branch}`])).split('\t')[0] ?? '';
    if (current) await checkGithubHead(cfg, branch, current, head, ghRef);
    await git(cfg, ['push', `--force-with-lease=refs/heads/${branch}:${current}`, cfg.origin, `${source}:refs/heads/${branch}`]);

    // The sync (pr-sync.ts) treats this head as already on GitHub, and a later run may replace it (checkGithubHead).
    noteSynced(branch, head);
    const open = await openPrFor(cfg, branch);
    if (open) {
      await gh(cfg, ['api', '-X', 'PATCH', `repos/${cfg.github}/pulls/${open.number}`, '-F', `body=@${bodyFile}`]);
      return { number: open.number, url: open.url, created: false, branch, head };
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
      return { number: made.number, url: made.url, created: true, branch, head };
    }
    const url = out.trim().split('\n').pop() ?? '';
    const m = /\/pull\/(\d+)$/.exec(url);
    if (!m) throw new Error(`gh pr create printed no PR url: ${out.trim()}`);
    return { number: Number(m[1]), url, created: true, branch, head };
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
  return `${name} can't push ${branch}: it is not the branch of ${name}'s own worktree or a child's, and no ITSA ${name} owns or takes part in links it (itsa_link, system branch; rule 2).`;
}

// On the ITSA home: refuses an unknown ITSA or one the asker may not change before any push.
export async function openPrHere(input: PrOpenInput, via?: Via, cfg: PrOpenConfig = prOpenConfig()): Promise<PrOpened> {
  const ref = input.itsa ? itsa.must(input.itsa).id : null;
  if (ref && via && !via.boss && !mayEditItsa(via.agent, ref)) throw new itsa.ForbiddenError(itsaRefusal(via.agent, ref, 'change'));
  if (via && !via.boss) {
    const why = await pushRefusal(via, String(input.branch ?? ''));
    if (why) throw new itsa.ForbiddenError(why);
  }
  // A caller on this machine (the ITSA home) works in a worktree of this checkout, so its branch is a local ref.
  const local = input.by ? db.getAgent(input.by)?.machine === MACHINE : false;
  const pr = await openPr(cfg, input, local);
  if (ref) {
    await linkPr(cfg, pr, ref, input.by ?? null);
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
async function pushCheckHome(branch: string, via: Via): Promise<void> {
  const home = settings().itsa.home ?? MACHINE;
  if (home === MACHINE) {
    const why = await pushRefusal(via, branch);
    if (why) throw new itsa.ForbiddenError(why);
    return;
  }
  const peer = peerByName(home);
  if (!peer) throw new Error(`ITSA home '${home}' is not a configured peer`);
  const r = await peerCall(peer, 'POST', '/api/pr/push-check', { branch, by: via.agent }, 30_000, false, { ...via, scope: localScope(via.agent, branch) });
  if (r.status === 403) throw new itsa.ForbiddenError(r.data?.error ?? `${home}: HTTP 403`);
  if (r.status !== 200) throw new Error(`can't push ${branch} now: the ITSA home ${home} could not check its links (${r.data?.error ?? `HTTP ${r.status}`}). Try again when it is up.`);
}

// The home's side of pushCheckHome: runs pushRefusal in full for the forwarded caller.
export async function pushCheckHere(branch: string, via: Via): Promise<void> {
  const why = await pushRefusal(via, branch);
  if (why) throw new itsa.ForbiddenError(why);
}

// Before the call is routed to the ITSA home: pushes the agent's own branch from its worktree to its
// `origin` (storage's bare repo, on storage), so the home can fetch it (S-667). Does nothing on the ITSA
// home itself, where there is no storage hop, or when the cwd isn't a worktree on that branch. Refuses the
// base branch and a checkout that isn't a linked worktree (the repo's main checkout, the deploy checkout),
// and when `via` is given, a branch the ITSA home refuses (rules 1 and 2, asked before the push: S-684). The push is a plain fast-forward: a branch that
// diverged on origin is rejected, never overwritten.
export async function pushOwnBranch(cwd: string | null | undefined, branch: string, via?: Via): Promise<boolean> {
  if ((settings().itsa.home ?? MACHINE) === MACHINE || !cwd || !BRANCH.test(branch) || branch.startsWith('-')) return false;
  if (branch === settings().itsa.mainBranch) throw new Error(`pr_open won't push or open a PR from ${branch}`);
  const g = async (args: string[]) => (await run('git', args, { cwd, maxBuffer: 16 << 20, timeout: 120_000 })).stdout.trim();
  try {
    if ((await g(['rev-parse', '--abbrev-ref', 'HEAD'])) !== branch) return false;
    // A linked worktree has its own git dir, apart from the common one; the main checkout does not.
    const [gitDir, common] = await Promise.all([g(['rev-parse', '--absolute-git-dir']), g(['rev-parse', '--path-format=absolute', '--git-common-dir'])]);
    if (gitDir === common) throw new Error(`${cwd} is a main checkout, not a linked worktree`);
    if (via && !via.boss) await pushCheckHome(branch, via);
    await g(['push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`]);
    return true;
  } catch (e: any) {
    if (e instanceof itsa.ForbiddenError) throw e;
    throw new Error(`pushing ${branch} to origin from the worktree failed: ${String(e.stderr ?? e.message).trim()}`);
  }
}
