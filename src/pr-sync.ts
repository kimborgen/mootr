// Keeps GitHub PR heads in step with storage (S-667). A developer on storage pushes review fixes to
// storage's bare repo, which cannot reach GitHub; only the ITSA home can. Every minute the home's daemon
// compares storage's stam/* branches with the open PRs' GitHub heads and pushes the ones that moved.
// A branch is pushed only when storage's sha differs from the one last synced (pr-sync.json), so a fix
// a manager pushed straight to GitHub isn't overwritten by an unchanged storage ref. The push leases on
// the GitHub head just read, so a concurrent push (merge-pr.mjs, a manager) wins and the next tick retries.
// A branch seen for the first time is only recorded, never pushed: pr_open records the heads it pushes.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { STAM_HOME } from './config.ts';
import * as db from './db.ts';
import { isClosedStatus } from './itsa.ts';
import type { PrOpenConfig } from './pr-open.ts';
import { storageRemoteFallback } from './settings.ts';

const run = promisify(execFile);

export const syncStateFile = (): string => join(STAM_HOME, 'pr-sync.json');

export function readSyncState(file = syncStateFile()): Record<string, string> {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  } catch {
    return {};
  }
}

function writeSyncState(state: Record<string, string>, file: string): void {
  writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 1));
  renameSync(`${file}.tmp`, file);
}

// Records the sha pr_open just pushed, so the sync doesn't treat it as new.
export function noteSynced(branch: string, sha: string, file = syncStateFile()): void {
  writeSyncState({ ...readSyncState(file), [branch]: sha }, file);
}

async function git(cfg: PrOpenConfig, args: string[]): Promise<string> {
  try {
    return (await run('git', args, { cwd: cfg.repo, maxBuffer: 16 << 20, timeout: 120_000 })).stdout.trim();
  } catch (e: any) {
    throw new Error(`git ${args[0]} failed: ${String(e.stderr ?? e.message).trim()}`);
  }
}

export interface SyncResult {
  pushed: string[];
  failed: string[];
  // Left alone on purpose: GitHub's head moved off the last synced sha and storage doesn't contain it.
  skipped: string[];
}

export async function isAncestor(cfg: PrOpenConfig, a: string, b: string): Promise<boolean> {
  try {
    await run('git', ['merge-base', '--is-ancestor', a, b], { cwd: cfg.repo, timeout: 120_000 });
    return true;
  } catch (e: any) {
    if (e.code === 1) return false;
    throw e;
  }
}

// The conflict last logged per branch, as "GitHub sha:storage sha" (S-673): a conflict is logged once per
// pair, and again only when either sha moves. In memory: after a restart the first tick logs it once more.
const conflictLogged = new Map<string, string>();

export async function syncPrs(cfg: PrOpenConfig, log: (line: string) => void = console.log, file = syncStateFile()): Promise<SyncResult> {
  const result: SyncResult = { pushed: [], failed: [], skipped: [] };
  if (!cfg.github) return result;
  const storage = cfg.storage || storageRemoteFallback((await git(cfg, ['remote'])).split('\n'));
  if (!storage) return result;
  const onStorage = new Map<string, string>();
  for (const line of (await git(cfg, ['ls-remote', '--heads', storage, 'refs/heads/stam/*'])).split('\n')) {
    const [sha, ref] = line.split('\t');
    if (sha && ref) onStorage.set(ref.slice('refs/heads/'.length), sha);
  }
  if (!onStorage.size) return result;
  const out = (await run(cfg.gh, ['pr', 'list', '--repo', cfg.github, '--state', 'open', '--limit', '200', '--json', 'number,headRefName,headRefOid'], { maxBuffer: 16 << 20, timeout: 120_000 })).stdout;
  const open = JSON.parse(out) as { number: number; headRefName: string; headRefOid: string }[];
  const old = readSyncState(file);
  const state: Record<string, string> = {};
  for (const pr of open) {
    const branch = pr.headRefName;
    const sha = onStorage.get(branch);
    if (!sha) continue; // not a storage branch, or gone
    const seen = old[branch];
    if (sha === pr.headRefOid || seen === undefined || seen === sha) {
      state[branch] = sha === pr.headRefOid || seen === undefined ? sha : seen;
      conflictLogged.delete(branch);
      continue;
    }
    const mine = `refs/stam/pr-sync/${branch}`;
    const theirs = `refs/stam/pr-sync-gh/${branch}`;
    try {
      await git(cfg, ['fetch', '--no-tags', storage, `+refs/heads/${branch}:${mine}`]);
      // GitHub's head is ours to replace only when storage's branch contains it (storage is ahead), whatever the sync state says (S-1419):
      // a branch name reused by a new agent leaves storage on the old, merged head, and pr_open recorded the new PR's head as synced.
      await git(cfg, ['fetch', '--no-tags', cfg.origin, `+refs/heads/${branch}:${theirs}`]);
      const ok = await isAncestor(cfg, pr.headRefOid, sha);
      if (!ok) {
        state[branch] = seen;
        result.skipped.push(branch);
        const pair = `${pr.headRefOid}:${sha}`;
        if (conflictLogged.get(branch) !== pair) {
          conflictLogged.set(branch, pair);
          log(`pr-sync: #${pr.number} ${branch} conflict: GitHub head ${pr.headRefOid.slice(0, 8)} isn't behind storage's ${sha.slice(0, 8)}; not pushed`);
        }
        continue;
      }
      await git(cfg, ['push', `--force-with-lease=refs/heads/${branch}:${pr.headRefOid}`, cfg.origin, `${mine}:refs/heads/${branch}`]);
      state[branch] = sha;
      conflictLogged.delete(branch);
      result.pushed.push(branch);
      log(`pr-sync: #${pr.number} ${branch} ${pr.headRefOid.slice(0, 8)} -> ${sha.slice(0, 8)}`);
    } catch (e) {
      state[branch] = seen; // retry next tick
      result.failed.push(branch);
      log(`pr-sync: #${pr.number} ${branch} not synced: ${e instanceof Error ? e.message : e}`);
    } finally {
      for (const r of [mine, theirs]) await git(cfg, ['update-ref', '-d', r]).catch(() => {});
    }
  }
  // Merge at write time (S-675): a noteSynced that pr_open wrote since the read at the top of the tick is newer than this tick's view.
  // Read and write are synchronous, as noteSynced's are, so none lands between them.
  const latest = readSyncState(file);
  for (const [branch, sha] of Object.entries(latest)) if (sha !== old[branch]) state[branch] = sha;
  writeSyncState(state, file);
  // Conflicts of branches whose PR is no longer open are forgotten (S-675).
  const openBranches = new Set(open.map((p) => p.headRefName));
  for (const branch of conflictLogged.keys()) if (!openBranches.has(branch)) conflictLogged.delete(branch);
  return result;
}

// Whether any unclosed ITSA links a stam/* branch: with none, a tick has nothing to sync and runs no git or gh.
export function openBranchLinks(): boolean {
  const rows = db.open().prepare("SELECT DISTINCT i.status FROM itsa_links l JOIN itsas i ON i.id = l.itsa_id WHERE l.system = 'branch' AND l.external_id LIKE 'stam/%'").all() as { status: string }[];
  return rows.some((r) => !isClosedStatus(r.status));
}

// One sync at a time: a tick that finds one still running, or has no linked branch to sync, returns null.
let running: Promise<SyncResult> | null = null;
export function syncTick(cfg: PrOpenConfig, log?: (line: string) => void, file?: string, gate: () => boolean = openBranchLinks): Promise<SyncResult> | null {
  if (running || !gate()) return null;
  const p = syncPrs(cfg, log, file).finally(() => (running = null));
  running = p;
  return p;
}
