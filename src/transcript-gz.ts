// Old transcripts, gzipped in place (S-2359). The janitor writes `X.jsonl.gz` beside the
// `X.jsonl` of an agent archived more than a day ago, verifies it, and removes the original.
// There is one way back: restoreTranscript gunzips the file to its recorded path and removes the
// `.gz`, so every reader that finds only a `.gz` restores first and then reads the `.jsonl` as
// before. Restore and gzip of one agent never overlap (transcriptLock). Only the paths a registry
// row names are touched, never a directory sweep.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { readdir, rename, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

export const GZ_AFTER_MS = 24 * 60 * 60 * 1000;
export const COMPILE_CACHE_LIMIT = 300 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

// One restore or gzip per agent at a time, in order.
const locks = new Map<string, Promise<unknown>>();
export function transcriptLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return run;
}

// An archived agent's transcript that is gzipped and gone from its path.
export const gzippedOnly = (path: string | null | undefined): boolean => Boolean(path) && !existsSync(path!) && existsSync(`${path}.gz`);

// Gunzips `gz` to `path` as a stream, through a temp name so a reader never sees half a file.
// Throws on any error (a full disk, a corrupt .gz) and leaves the .gz where it is.
async function gunzipFile(gz: string, path: string): Promise<void> {
  const tmp = `${path}.restore-${process.pid}`;
  try {
    await pipeline(createReadStream(gz), createGunzip(), createWriteStream(tmp));
    await rename(tmp, path);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

// Puts a gzipped transcript back at its recorded path, then removes the `.gz`. False when there
// is nothing to restore (no path, or neither file); true when the `.jsonl` is there. Throws when
// the restore fails; the `.gz` stays. `key` names the agent (its id) for the lock.
export async function restoreTranscript(key: string, path: string | null | undefined): Promise<boolean> {
  if (!path) return false;
  // Always through the lock: a gzip of this agent may be about to remove the .jsonl that exists now.
  return transcriptLock(key, async () => {
    if (existsSync(path)) return true;
    const gz = `${path}.gz`;
    if (!existsSync(gz)) return false;
    await gunzipFile(gz, path);
    await unlink(gz);
    return true;
  });
}

async function hashOf(stream: AsyncIterable<Buffer | string>): Promise<{ size: number; hash: string }> {
  const h = createHash('sha256');
  let size = 0;
  for await (const chunk of stream) {
    h.update(chunk);
    size += chunk.length;
  }
  return { size, hash: h.digest('hex') };
}

// When each agent was archived, from its `archive` events (last one wins). A time that doesn't
// parse leaves the agent out, so it is never treated as old.
export function archiveTimes(rows: { agent_id: string; ts: string }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const t = Date.parse(r.ts);
    if (Number.isFinite(t) && t > 0) out.set(r.agent_id, t);
    else out.delete(r.agent_id);
  }
  return out;
}

export interface GzAgent {
  id: string;
  lifecycle: string;
  transcript_path: string | null;
}
export interface GzAction {
  agent: string;
  path: string;
  bytes: number;
  gz_bytes?: number;
}

// Gzips the transcripts of agents archived at least GZ_AFTER_MS ago, when the file wasn't
// modified in that time either (a restored file read lately waits another day) and the agent's
// ingest cursor sits at the end of the file (`complete`, so no row is hidden that was never
// read). Under the agent's transcript lock it re-reads the agent (`current`) and checks it is
// still archived. The .gz is written aside, verified by gunzipping it and comparing size and
// sha256, and only then does the .jsonl go.
export async function gzipTranscripts(opts: {
  agents: GzAgent[];
  archivedAt: Map<string, number>;
  current: (id: string) => GzAgent | undefined;
  complete: (agent: GzAgent, size: number) => Promise<boolean>;
  now?: number;
  dryRun?: boolean;
}): Promise<GzAction[]> {
  const now = opts.now ?? Date.now();
  const done: GzAction[] = [];
  const old = (a: GzAgent) => {
    const at = opts.archivedAt.get(a.id);
    return a.lifecycle === 'archived' && at !== undefined && now - at >= GZ_AFTER_MS;
  };
  for (const a of opts.agents) {
    const path = a.transcript_path;
    if (!path || !path.endsWith('.jsonl') || !old(a)) continue;
    try {
      const st0 = await stat(path);
      if (!st0.isFile() || now - st0.mtimeMs < GZ_AFTER_MS) continue;
      if (!(await opts.complete(a, st0.size))) continue;
      if (opts.dryRun) {
        done.push({ agent: a.id, path, bytes: st0.size });
        continue;
      }
      const r = await transcriptLock(a.id, async (): Promise<GzAction | null> => {
        const cur = opts.current(a.id);
        if (!cur || !old(cur) || cur.transcript_path !== path) return null;
        const st = await stat(path);
        if (!st.isFile() || now - st.mtimeMs < GZ_AFTER_MS || st.size !== st0.size || !(await opts.complete(cur, st.size))) return null;
        const tmp = `${path}.gz.tmp-${process.pid}`;
        try {
          const src = await hashOf(createReadStream(path));
          await pipeline(createReadStream(path), createGzip(), createWriteStream(tmp));
          const back = await hashOf(createReadStream(tmp).pipe(createGunzip()));
          if (back.size !== src.size || back.hash !== src.hash || src.size !== st.size) return null;
          const again = await stat(path);
          if (again.mtimeMs !== st.mtimeMs || again.size !== st.size) return null;
          const gzSize = (await stat(tmp)).size;
          await rename(tmp, `${path}.gz`);
          await unlink(path);
          return { agent: a.id, path, bytes: st.size, gz_bytes: gzSize };
        } finally {
          await unlink(tmp).catch(() => {});
        }
      });
      if (r) done.push(r);
    } catch {
      // Missing file, unreadable, or already gzipped: skip.
    }
  }
  return done;
}

// Temp files a crashed gzip or restore left beside a transcript (`X.jsonl.gz.tmp-PID`, `X.jsonl.restore-PID`), older than an hour.
export async function sweepGzTemps(opts: { agents: GzAgent[]; now?: number; dryRun?: boolean }): Promise<string[]> {
  const now = opts.now ?? Date.now();
  const removed: string[] = [];
  for (const a of opts.agents) {
    const path = a.transcript_path;
    if (!path || !path.endsWith('.jsonl')) continue;
    const prefixes = [`${basename(path)}.gz.tmp-`, `${basename(path)}.restore-`];
    let names: string[];
    try {
      names = (await readdir(dirname(path))).filter((n) => prefixes.some((p) => n.startsWith(p)));
    } catch {
      continue;
    }
    for (const n of names) {
      const f = join(dirname(path), n);
      try {
        if (now - (await stat(f)).mtimeMs < 3600_000) continue;
        removed.push(f);
        if (!opts.dryRun) await unlink(f);
      } catch {}
    }
  }
  return removed;
}

const sizeOf = (p: string): number => {
  let total = 0;
  try {
    const st = statSync(p);
    if (!st.isDirectory()) return st.size;
    for (const e of readdirSync(p)) total += sizeOf(join(p, e));
  } catch {}
  return total;
};

// Node's compile cache: over the limit, removes the entries (folders) not modified in the last day.
export function capCompileCache(opts: { dir?: string; limit?: number; now?: number; dryRun?: boolean } = {}): { removed: string[]; bytes: number } {
  const dir = opts.dir ?? process.env.NODE_COMPILE_CACHE ?? join(tmpdir(), 'node-compile-cache');
  const limit = opts.limit ?? COMPILE_CACHE_LIMIT;
  const now = opts.now ?? Date.now();
  const removed: string[] = [];
  let bytes = 0;
  if (sizeOf(dir) <= limit) return { removed, bytes };
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    try {
      if (now - statSync(p).mtimeMs < DAY_MS) continue;
      bytes += sizeOf(p);
      removed.push(p);
      if (!opts.dryRun) rmSync(p, { recursive: true, force: true });
    } catch {}
  }
  return { removed, bytes };
}
