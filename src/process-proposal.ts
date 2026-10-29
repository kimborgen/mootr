// Process change proposals (S-1084, step 5b of docs/proposals/S-866-process-designer.md): saving an
// edited process. `propose` checks the YAML with parseProcess, commits it to a new branch in a
// scratch worktree (never the live checkout's working tree), pushes the branch, opens a pull
// request, and files a `proposal` ITSA in needs_approval with the diff and the PR link. Nothing
// changes until your user approves it and the PR merges: Approve hands the PR to the normal review
// and merge path (the owner is told), and Request changes or a rejection closes the PR.
//
// Agents (5c, S-1085): the `process_propose` MCP tool reaches the same `propose` through the daemon's route with the
// calling agent as `by`. An agent's proposal stops at needs_approval and a PR; only the human's Approve (onProposalStatus)
// leads to a merge.
// git and gh come in as `deps`, so a test runs with fakes.
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { agentTypes } from './agent-types.ts';
import * as itsa from './itsa.ts';
import { shownText } from './itsa-human.ts';
import * as mail from './mail.ts';
import * as org from './org.ts';
import { NODE_ID, parseProcess } from './process.ts';
import { prOpenConfig, type PrOpenConfig } from './pr-open.ts';
import { PROPOSAL_KIND, lastAction, processProposalOf } from './retro-loop.ts';
import { envVar } from './env.ts';

const run = promisify(execFile);

// The key of the ITSA proposals file under (S-866, Visual process designer); a deployment that
// lacks it files them at the top level.
export const PARENT_REF = envVar('PROCESS_PROPOSAL_PARENT') || 'S-866';
// The gates a process change needs: the YAML loads and its tests pass.
const GATES = 'run process process-counts process-stage process-run';
const APPROVAL = 'needs_approval';
const SUMMARY_MAX = 2000;
// How many open process proposals one agent may have at once.
export const AGENT_OPEN_MAX = 3;
const NOT_MERGED = ['canceled', 'wont_do', 'duplicate'];

export class ProposalError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface Deps {
  // Runs git (in `cwd`, else the repo) and returns its stdout.
  git(args: string[], cwd?: string): Promise<string>;
  // Runs gh and returns its stdout.
  gh(args: string[]): Promise<string>;
}

export function realDeps(cfg: PrOpenConfig): Deps {
  return {
    async git(args, cwd) {
      try {
        return (await run('git', args, { cwd: cwd ?? cfg.repo, maxBuffer: 16 << 20, timeout: 120_000 })).stdout;
      } catch (e: any) {
        throw new Error(`git ${args[0]} failed: ${String(e.stderr ?? e.message).trim()}`);
      }
    },
    async gh(args) {
      try {
        return (await run(cfg.gh, args, { maxBuffer: 16 << 20, timeout: 120_000 })).stdout;
      } catch (e: any) {
        throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${String(e.stderr ?? e.message).trim()}`);
      }
    },
  };
}

export interface ProposalInput {
  // The process id: `processes/ID.yaml`.
  process: string;
  // The whole new file text.
  yaml: string;
  summary: string;
  // The file text the edit started from. `main`'s copy must still be this, or the save is refused (409): a
  // stale editor must not overwrite a newer file. Absent (an agent that edits blind), the check is skipped.
  base?: string | null;
  // Who proposes: an agent id or name, or the human.
  by?: string | null;
}

export interface Proposed {
  key: string;
  id: string;
  pr: { number: number; url: string };
  branch: string;
}

// The one-line title part of a summary.
const firstLine = (s: string): string => s.trim().split('\n')[0]!.slice(0, 72);

// Why the YAML can't be a process file, or null: parseProcess's own errors, against the registry's types.
export function checkYaml(id: string, yaml: string, loadedIds: string[] = []): string[] {
  const { process: def, errors } = parseProcess(yaml, { file: `${id}.yaml`, knownTypes: new Set(Object.keys(agentTypes())) });
  const out = errors.map((e) => e.replace(`${id}.yaml: `, ''));
  if (def && loadedIds.length) {
    for (const n of Object.values(def.nodes)) if (n.call && n.call !== id && !loadedIds.includes(n.call)) out.push(`node "${n.id}": call "${n.call}" is not a loaded process`);
  }
  return out;
}

// The body of the proposal ITSA: the process and PR on lines the hooks read, the summary, the diff.
export function proposalBody(id: string, summary: string, pr: string, diff: string, sha = ''): string {
  return [`Process proposal: ${id}`, `PR: ${pr}`, ...(sha ? [`Commit: ${sha}`] : []), '', summary.trim(), '', '```diff', diff.trimEnd(), '```', ''].join('\n');
}

// The process a proposal ITSA is for, or null when it isn't one of these.
export const proposalProcess = processProposalOf;

// One agent's proposals run one after another, so the cap below counts every earlier one (six at once would all
// see the same few open ones). The human's are not held.
const queues = new Map<string, Promise<unknown>>();
// The body is written by this system sender: the proposer, who created the ITSA, may not edit it (retro-loop's gate).
const WRITER = itsa.systemActor('process-proposal');

export function propose(input: ProposalInput, cfg: PrOpenConfig = prOpenConfig(), deps: Deps = realDeps(cfg), loadedIds: string[] = []): Promise<Proposed> {
  const by = input.by ?? null;
  if (!by || by === mail.HUMAN) return proposeNow(input, cfg, deps, loadedIds);
  const run = (queues.get(by) ?? Promise.resolve()).catch(() => {}).then(() => proposeNow(input, cfg, deps, loadedIds));
  const tail = run.catch(() => {});
  queues.set(by, tail);
  void tail.then(() => queues.get(by) === tail && queues.delete(by));
  return run;
}

async function proposeNow(input: ProposalInput, cfg: PrOpenConfig, deps: Deps, loadedIds: string[]): Promise<Proposed> {
  const id = String(input.process ?? '');
  if (!NODE_ID.test(id)) throw new ProposalError(`not a process id: ${id}`);
  const summary = String(input.summary ?? '').trim();
  if (!summary) throw new ProposalError('a proposal needs a summary: say what the change does and why');
  if (summary.length > SUMMARY_MAX) throw new ProposalError(`the summary is over ${SUMMARY_MAX} characters`);
  const yaml = String(input.yaml ?? '');
  const problems = checkYaml(id, yaml, loadedIds);
  if (problems.length) throw new ProposalError(`${id}.yaml doesn't validate:\n- ${problems.join('\n- ')}`);
  const by0 = input.by ?? null;
  if (by0 && by0 !== mail.HUMAN) {
    const open = (await itsa.list({ kind: PROPOSAL_KIND })).filter((x) => x.created_by === by0 && !itsa.isClosedStatus(x.status) && processProposalOf(x));
    if (open.length >= AGENT_OPEN_MAX) throw new ProposalError(`you already have ${open.length} open process proposals (${open.map((x) => x.key).join(', ')}): wait for your user to decide on them before proposing more`, 429);
  }
  if (!cfg.github) throw new ProposalError('no GitHub repo is set for pull requests (settings.itsa.prOpen.github)', 500);
  const by = input.by ?? null;
  const base = `${cfg.origin}/${cfg.base}`;
  const branch = `process/${id}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const file = `processes/${id}.yaml`;

  // The scratch worktree is where the commit is made: the live checkout's files and branch stay as they are.
  const tmp = mkdtempSync(join(tmpdir(), 'stam-process-proposal-'));
  const wt = join(tmp, 'wt');
  let added = false;
  let pushed = false;
  let sha = '';
  let created: itsa.Itsa | null = null;
  try {
    await deps.git(['fetch', '--no-tags', cfg.origin, `+refs/heads/${cfg.base}:refs/remotes/${cfg.origin}/${cfg.base}`]);
    await deps.git(['worktree', 'add', '-b', branch, wt, base]);
    added = true;
    const path = join(wt, file);
    const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (input.base !== undefined && input.base !== null && input.base !== (before ?? '')) {
      throw new ProposalError(`${file} on ${cfg.base} changed after you opened the editor, so saving would overwrite that change. Discard this edit, reload the process and edit it again.`, 409);
    }
    if (before === yaml) throw new ProposalError(`${file} is already this on ${cfg.base}: nothing to propose`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, yaml);
    await deps.git(['add', '--', file], wt);
    const diff = await deps.git(['diff', '--cached', '--no-color', '--', file], wt);

    const parent = itsa.find(PARENT_REF);
    const cos = org.chiefOfStaff();
    created = await itsa.create({
      kind: PROPOSAL_KIND,
      title: `${id} process change`,
      summary: firstLine(summary),
      body: proposalBody(id, summary, 'opening', diff),
      status: APPROVAL,
      parent: parent?.id ?? null,
      // The owner drives the PR through review and merge once the human approves.
      owner: cos?.id ?? null,
      by,
    });

    await deps.git(['-c', 'user.name=stam', '-c', 'user.email=stam@localhost', 'commit', '-q', '-m', `Change the ${id} process\n\n${summary}\n\nProposal ${created.key}`], wt);
    await deps.git(['push', cfg.origin, `${branch}:refs/heads/${branch}`], wt);
    pushed = true;
    sha = (await deps.git(['rev-parse', 'HEAD'], wt)).trim();

    const from = by && by !== mail.HUMAN ? `agent ${by}` : 'the editor';
    const prBody = [`ITSA: ${created.key}`, `Gates: ${GATES}`, 'Deploy: normal', '', `Process change proposed from ${from} (${created.key}): ${summary}`, '', 'Nothing changes until the proposal is approved and this PR merges.', '', '```diff', diff.trimEnd(), '```', ''].join('\n');
    const bodyFile = join(tmp, 'body.md');
    writeFileSync(bodyFile, prBody);
    const out = await deps.gh(['pr', 'create', '--repo', cfg.github, '--base', cfg.base, '--head', branch, '--title', `Change the ${id} process`, '--body-file', bodyFile]);
    const url = out.trim().split('\n').pop() ?? '';
    const m = /\/pull\/(\d+)$/.exec(url);
    if (!m) throw new Error(`gh pr create printed no PR url: ${out.trim()}`);
    const pr = { number: Number(m[1]), url };

    await itsa.addLink(created.id, { system: 'github', url: pr.url, external_id: String(pr.number) }, by);
    await itsa.addLink(created.id, { system: 'branch', external_id: branch, repo: cfg.repoName, url: '' }, by);
    const set = await itsa.set(created.id, { body: proposalBody(id, summary, `#${pr.number} ${pr.url}`, diff, sha) }, WRITER);
    // An agent's proposal was asked about with its opening body: the human is shown the final one,
    // whose revision a thread's Approve then carries (S-2998).
    if (by && by !== mail.HUMAN) {
      const shown = shownText(set.itsa);
      await itsa.post(created.id, { by: WRITER, to: [mail.HUMAN], body: `The proposal now links its PR. This is what you approve:\n\n${shown.text}` }, { shown });
    }
    return { key: created.key, id: created.id, pr, branch };
  } catch (e) {
    // Nothing half-made stays: the proposal is cancelled and the pushed branch deleted.
    if (created) await itsa.set(created.id, { status: 'canceled' }, by).catch(() => {});
    if (pushed) await deps.git(['push', cfg.origin, '--delete', branch]).catch(() => {});
    throw e;
  } finally {
    if (added) await deps.git(['worktree', 'remove', '--force', wt]).catch(() => {});
    // Delete the directory, then prune: prune frees only worktrees whose directory is gone, and a worktree that
    // failed to remove still holds its branch, which `branch -D` would refuse.
    rmSync(tmp, { recursive: true, force: true });
    await deps.git(['worktree', 'prune']).catch(() => {});
    await deps.git(['branch', '-D', branch]).catch(() => {});
  }
}

// ---- After the proposal is filed ----------------------------------------------------------

const prNumber = (x: itsa.Itsa): string | null => itsa.links(x.id).find((l) => l.system === 'github')?.external_id ?? null;

// Closes the proposal's PR, and its branch, with a comment saying why. Never throws: a PR that is
// already closed or gone is not a failure of the status change that asked.
export async function closeProposalPr(x: itsa.Itsa, why: string, cfg?: PrOpenConfig, deps?: Deps): Promise<boolean> {
  const n = prNumber(x);
  if (!n) return false;
  try {
    const c = cfg ?? prOpenConfig();
    if (!c.github) return false;
    await (deps ?? realDeps(c)).gh(['pr', 'close', n, '--repo', c.github, '--delete-branch', '--comment', why]);
    return true;
  } catch (e) {
    console.error(`process proposal ${x.key}: closing PR #${n}: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

// What a status change on a process proposal does. Approve tells the owner to take the PR through
// review and merge; Request changes, or a close that isn't done, closes the PR.
export async function onProposalStatus(x: itsa.Itsa, actor: string, from: string, cfg?: PrOpenConfig, deps?: Deps): Promise<void> {
  const id = proposalProcess(x);
  if (!id) return;
  const n = prNumber(x);
  if (from === APPROVAL && actor === mail.HUMAN) {
    const act = lastAction(x);
    if (act === 'approve' && x.owner && n) {
      const sha = /^Commit: ([0-9a-f]{7,40})$/m.exec((x.body ?? '').split(/\n\s*\n/)[0]!)?.[1];
      mail.queueNotice(x.owner, `${x.key} (the ${id} process change) is approved${sha ? ` at commit ${sha}` : ''}. Its PR #${n} goes through the normal path: a reviewer reads it (the \`pr_review\` tool), then you merge it with the \`pr_merge\` tool (PR ${n})${sha ? `; merge only if the PR head is still ${sha}, so a commit pushed after the approval isn't merged unseen` : ''}. The deploy watcher closes ${x.key} after the deploy.`);
      return;
    }
    if (act === 'changes') {
      // The PR and branch go, so the proposal ends with them: a new edit is a new proposal.
      await closeProposalPr(x, `Closed: changes were requested on ${x.key}. Edit the process again and save a new proposal.`, cfg, deps);
      await itsa.set(x.id, { status: 'canceled' }, mail.HUMAN);
      return;
    }
  }
  // Already closed by the Request changes above (its own cancel lands here).
  if (NOT_MERGED.includes(x.status) && lastAction(x) !== 'changes') await closeProposalPr(x, `Closed: ${x.key} was ${x.status.replace('_', ' ')}.`, cfg, deps);
}

export function watchProcessProposals(cfg?: PrOpenConfig, deps?: Deps): void {
  itsa.onStatus((x, actor, from) => {
    onProposalStatus(x, actor, from, cfg, deps).catch((e) => console.error(`process proposal ${x.key}: ${e instanceof Error ? e.message : e}`));
  });
}
