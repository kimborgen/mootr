// The embedding index (S-141): one table keyed by source (mail first), an indexing queue that
// embeds in batches off the request path, a backfill for items with no vector from the current
// embedder, and brute-force cosine search over one source. The queue holds ids, not text: each
// source has a resolver that reads an item's text from the db when its batch is embedded. A full
// queue drops new ids, and the backfill picks them up later. Background work never rejects: a
// failure is logged and the work waits for a later backfill.
import { createHash } from 'node:crypto';
import * as db from './db.ts';
import { BATCH, currentModel, embed, embedText } from './embed.ts';

// The least pause between batches, so a backlog (a fresh install's backfill) doesn't spike the CPU.
const PAUSE_MS = 200;
const BACKFILL_PAGE = 200;
export const DEFAULT_QUEUE_CAP = 2000;
// Tests lower it to make overflow happen with a few mails (setQueueCap).
let queueCap = DEFAULT_QUEUE_CAP;
export function setQueueCap(n: number): void {
  queueCap = n;
}
// After a failed batch, retry the backfill after 1, 5, then 15 minutes, then an hour between tries
// for as long as mail is still unindexed. The embedder's own install retries follow the same
// schedule, so the install gets a new try each time this timer fires. A new mail starts over.
const RETRY_MS = [60_000, 300_000, 900_000, 3_600_000];
let retries = 0;
let retryTimer: NodeJS.Timeout | undefined;

// A source's text, read when it's embedded (undefined when the item is gone), and its pending refs:
// up to `limit` with no vector from `model` or a stale one, newest first. The backfill walks each
// source that has a `pending` (S-142).
interface Source {
  resolve: (ref: string) => string | undefined;
  pending?: Pending;
}
type Pending = (model: string, limit: number) => string[] | Promise<string[]>;
const sources = new Map<string, Source>();
export function source(name: string, resolve: (ref: string) => string | undefined, pending?: Pending): void {
  sources.set(name, { resolve, pending });
}
source(
  'mail',
  (id) => {
    const m = db.getMail(id);
    return m ? embedText(m.subject, m.body) : undefined;
  },
  (model, limit) => db.mailToEmbed(model, limit).map((r) => r.id),
);

// Queued items as `source\0ref`: a Set, so an item queued twice is one job.
const queue = new Set<string>();
let draining: Promise<void> | undefined;
// Set when an id was dropped for a full queue: the next empty queue runs a backfill to pick it up.
let overflowed = false;

export const hashOf = (text: string) => createHash('sha1').update(text).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const logError = (what: string, e: unknown) => console.error(`embedder: ${what}: ${e instanceof Error ? e.message : e}`);

// Queues an item for indexing. False when the queue is full: the backfill indexes it later.
export function enqueue(src: string, ref: string): boolean {
  if (!currentModel()) return true;
  const key = `${src}\0${ref}`;
  if (queue.has(key)) return true;
  if (queue.size >= queueCap) {
    overflowed = true;
    return false;
  }
  queue.add(key);
  drain().catch((e) => logError('indexing', e));
  return true;
}

// Forgets an item's vector, and any of its queued job.
export function remove(src: string, ref: string): void {
  queue.delete(`${src}\0${ref}`);
  db.deleteEmbedding(src, ref);
}

// Queues a stored mail for indexing (storeMail calls this after the mail is saved).
export function indexMail(id: string): void {
  // A new mail starts the backfill's retry schedule over (the install's schedule is its own).
  retries = 0;
  enqueue('mail', id);
}

// Schedules one backfill retry, unless the schedule is spent.
function scheduleRetry(): void {
  if (retryTimer) return;
  const wait = RETRY_MS[Math.min(retries, RETRY_MS.length - 1)];
  retries++;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void backfill();
  }, wait);
  retryTimer.unref();
}

// Works the queue a batch at a time until it's empty. An embedder that isn't ready drops what's
// queued: the backfill indexes it once the embedder is installed.
function drain(): Promise<void> {
  draining ??= (async () => {
    try {
      while (queue.size) {
        const keys = [...queue].slice(0, BATCH);
        for (const k of keys) queue.delete(k);
        const started = performance.now();
        const embedded = await flush(keys);
        const took = performance.now() - started;
        if (embedded < 0) {
          queue.clear();
          scheduleRetry();
          break;
        }
        if (embedded > 0) retries = 0;
        // Pause only after work that loaded the CPU, and for as long as the batch took (at least
        // PAUSE_MS): the backfill uses about half of one core, and nothing after items already indexed.
        if (queue.size && embedded > 0) await sleep(Math.max(PAUSE_MS, took));
      }
    } catch (e) {
      // A failed write (a full disk, say) drops this queue; the backfill retries it later.
      logError('indexing', e);
      queue.clear();
      scheduleRetry();
    } finally {
      draining = undefined;
      if (overflowed && !queue.size) {
        overflowed = false;
        void backfill();
      }
    }
  })();
  return draining;
}

// Embeds a batch of queued keys and stores the vectors. Returns how many were embedded, or -1 when
// the embedder isn't ready.
async function flush(keys: string[]): Promise<number> {
  const model = currentModel();
  if (!model) return -1;
  const jobs: { source: string; ref: string; text: string; hash: string }[] = [];
  for (const k of keys) {
    const [src, ref] = k.split('\0');
    const text = sources.get(src)?.resolve(ref);
    if (text === undefined) continue;
    jobs.push({ source: src, ref, text, hash: hashOf(text) });
  }
  // Text the index already has is skipped, and its vector marked current (the backfill's pending
  // list reads that time against an ITSA's update time).
  const todo = jobs.filter((j) => {
    const row = db.embeddingRow(j.source, j.ref);
    if (!(row && row.hash === j.hash && row.model === model)) return true;
    db.touchEmbedding(j.source, j.ref);
    return false;
  });
  if (!todo.length) return 0;
  const vecs = await embed(todo.map((j) => j.text));
  if (!vecs) return -1;
  // An item edited while its text was embedding has a stale vector: it's not stored, and it's queued
  // again (an edit dropped for a full queue is picked up here, not lost). A deleted item is skipped.
  const stale: { source: string; ref: string }[] = [];
  const fresh = todo.filter((j) => {
    const text = sources.get(j.source)?.resolve(j.ref);
    if (text === undefined) return false;
    if (hashOf(text) === j.hash) return true;
    stale.push(j);
    return false;
  });
  try {
    db.transaction(() => {
      fresh.forEach((j) => {
        const v = vecs[todo.indexOf(j)];
        db.putEmbedding({ source: j.source, ref: j.ref, model, dim: v.length, vec: new Uint8Array(v.buffer, v.byteOffset, v.byteLength), hash: j.hash });
      });
    });
  } catch (e) {
    // A rolled-back transaction (a full disk, say) leaves vectors in the cache the table lacks.
    for (const src of new Set(fresh.map((j) => j.source))) db.dropVectorCache(src);
    throw e;
  }
  for (const j of stale) enqueue(j.source, j.ref);
  return fresh.length;
}

// Test hook.
export const _flush = flush;

let backfilling = false;

// Queues every source's pending items with no vector from the current embedder (or a stale one),
// newest first, a page at a time, and waits for each page to index before the next. A page that
// doesn't index stops that source's backfill. Never rejects: a failure is logged, and the other
// sources still run.
export async function backfill(): Promise<void> {
  const model = currentModel();
  if (!model || backfilling) return;
  backfilling = true;
  try {
    for (const [name, src] of sources) {
      if (src.pending) await backfillSource(name, src.pending, model);
    }
  } finally {
    backfilling = false;
  }
}

async function backfillSource(name: string, pending: Pending, model: string): Promise<void> {
  try {
    for (;;) {
      const refs = await pending(model, BACKFILL_PAGE);
      if (!refs.length) return;
      for (const ref of refs) {
        // A full queue is worked off before the next id goes in.
        while (!enqueue(name, ref)) await drain();
      }
      await drain();
      const again = await pending(model, 1);
      if (again.length && again[0] === refs[0]) return;
    }
  } catch (e) {
    logError(`backfill ${name}`, e);
  }
}

// Cosine similarity of two vectors of the same length.
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export interface Near {
  ref: string;
  score: number;
}

// The items of `source` nearest to `q`, best first, at most k, and at least `min` when given. `refs`
// limits the search to some. Brute force over the db's cache of decoded vectors (S-1459).
export function nearest(src: string, q: Float32Array, refs: Set<string> | undefined, k: number, min = -Infinity): Near[] {
  const model = currentModel();
  if (!model) return [];
  let nq = 0;
  for (const x of q) nq += x * x;
  nq = Math.sqrt(nq);
  const out: Near[] = [];
  if (!nq) return out;
  for (const row of db.decodedEmbeddingsOf(src, model)) {
    if (refs && !refs.has(row.ref)) continue;
    const v = row.vec;
    if (v.length !== q.length || !row.norm) continue;
    let dot = 0;
    for (let i = 0; i < v.length; i++) dot += q[i] * v[i];
    const score = dot / (nq * row.norm);
    if (score >= min) out.push({ ref: row.ref, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, k);
}
