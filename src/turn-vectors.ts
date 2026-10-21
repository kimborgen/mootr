// Agent turns in the embedding index (S-1460): the `turn` source, one vector per finished turn.
// A turn is a prompt (the human's or a mail's) and the agent's work until the next prompt; its text
// is the prompt, the names of the tools called, and the final reply. Tool inputs and results never
// go in. Turns come from the per-harness agent-view normalizers (agent-view.ts history), and only
// this daemon's own agents are indexed: a turn end queues the agent's finished turns, and the
// backfill reads the last settings.search.turnDays, newest agent first. The ref is AGENT_ID:TURN_ID, the
// id of the message that began the turn, so a re-read finds the same ref and the hash skips it.
// A Claude transcript is parsed in a worker thread (S-1580), never on the event loop: a whole one
// can be hundreds of MB, and one parse of 70 MB held the daemon for a second.
import { Worker } from 'node:worker_threads';
import * as db from './db.ts';
import { MACHINE } from './config.ts';
import { embedText } from './embed.ts';
import { history, withMail } from './agent-view.ts';
import type { ViewMessage } from './agent-view.ts';
import { unreadBytes } from './adapters/claude-view.ts';
import type { TailRequest, TailResult } from './turn-read-worker.ts';
import { settings } from './settings.ts';
import { enqueue, source } from './vectors.ts';
import { gzippedOnly } from './transcript-gz.ts';

// Messages read at a turn end: enough to hold the latest turns, however many tool calls they made.
const RECENT_MESSAGES = 120;
const PAGE = 200;
// How much of the prompt the embedding reads; the reply fills the rest of embedText's cap.
const PROMPT_CHARS = 500;
// Texts waiting for their batch. Bounded: the queue itself is capped, and an entry dropped here is
// found again by the backfill.
const MAX_TEXTS = 5000;
const texts = new Map<string, string>();

export interface Turn {
  ref: string;
  at: number;
  text: string;
}

const textOf = (m: ViewMessage) =>
  m.parts
    .map((p) => (p.type === 'text' ? p.text : p.type === 'mail' ? `${p.subject}\n${p.body}` : ''))
    .filter(Boolean)
    .join('\n');

// The finished turns of `messages` (oldest first): each group of messages from a prompt to the next.
// A prompt that opens a turn is one the human typed, or a mail from the human or the parent; other
// incoming mail arriving mid-turn, and the agent's own sent mail (whose body is a tool's input),
// are not part of it. `more` says the list has older messages, so a first group that didn't begin at
// a prompt is cut off and skipped; `open` says the agent is mid-turn, so the last group is unfinished.
export function turnsOf(agentId: string, messages: ViewMessage[], more: boolean, open: boolean, parentId?: string | null): Turn[] {
  const groups: ViewMessage[][] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      const mail = m.parts.find((p) => p.type === 'mail');
      if (mail?.type === 'mail' && (mail.to || (mail.from_id !== 'human' && mail.from_id !== parentId))) continue;
      groups.push([m]);
    } else if (groups.length) groups[groups.length - 1].push(m);
    else groups.push([m]);
  }
  if (more && groups.length && groups[0][0].role !== 'user') groups.shift();
  if (open) groups.pop();
  const out: Turn[] = [];
  for (const g of groups) {
    const prompt = g[0].role === 'user' ? textOf(g[0]) : '';
    const work = g.filter((m) => m.role === 'assistant');
    if (!work.length || work.some((m) => m.running)) continue;
    const tools = new Set<string>();
    for (const m of work) for (const p of m.parts) if (p.type === 'tool') tools.add(p.name);
    // The last text the agent wrote: after its last tool, it is the answer.
    const reply = work.flatMap((m) => m.parts).filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).pop() ?? '';
    const text = embedText(`${prompt.slice(0, PROMPT_CHARS)}${tools.size ? `\ntools: ${[...tools].join(' ')}` : ''}`, reply);
    if (!text.trim()) continue;
    out.push({ ref: `${agentId}:${g[0].id}`, at: g[0].at, text });
  }
  return out;
}

const RUNNING = new Set(['starting', 'working', 'blocked']);

// How much of a Claude transcript the worker reads, from its end: the backfill's covers the window
// of any but the busiest agents (whose older turns are skipped, and logged), a turn end's its latest
// turns. A transcript the view has parsed is read in place while it is this far behind.
const BACKFILL_TAIL = 64 << 20;
const STOP_TAIL = 8 << 20;
const IN_PLACE = 1 << 20;
// The worker's heap: a tail's parse fits well inside it, and a runaway parse fails the worker,
// not the daemon.
const WORKER_HEAP_MB = 1024;
// An idle worker is stopped after this, to give its memory back.
const WORKER_IDLE_MS = 60_000;
let idleMs_ = WORKER_IDLE_MS;
// One read may take this long; a hung worker is terminated, which fails the read and starts over.
const READ_TIMEOUT_MS = 120_000;
let readTimeoutMs = READ_TIMEOUT_MS;
let workerUrl = new URL('./turn-read-worker.ts', import.meta.url);

let worker: Worker | undefined;
let idle: NodeJS.Timeout | undefined;
let nextId = 0;
const waiting = new Map<number, { resolve: (r: TailResult) => void; reject: (e: Error) => void }>();
// Reads run one at a time: one parse holds one core at most.
let line: Promise<unknown> = Promise.resolve();

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(workerUrl, { resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB } });
  w.on('message', (r: TailResult) => {
    const p = waiting.get(r.id);
    waiting.delete(r.id);
    if (r.error) p?.reject(new Error(r.error));
    else p?.resolve(r);
  });
  // A worker that dies (out of memory, say) fails its waiting reads; the next read starts a new one.
  const dead = (e: Error) => {
    if (worker !== w) return;
    worker = undefined;
    for (const p of waiting.values()) p.reject(e);
    waiting.clear();
  };
  w.on('error', dead);
  w.on('exit', (code) => dead(new Error(`turn reader exited (${code})`)));
  return (worker = w);
}

function readTail(req: Omit<TailRequest, 'id'>): Promise<TailResult> {
  let timer: NodeJS.Timeout | undefined;
  const run = () =>
    new Promise<TailResult>((resolve, reject) => {
      clearTimeout(idle);
      const id = ++nextId;
      waiting.set(id, { resolve, reject });
      const w = getWorker();
      w.ref();
      // Terminating the worker makes its exit fail this read through `dead`.
      timer = setTimeout(() => void w.terminate(), readTimeoutMs);
      w.postMessage({ ...req, id });
    }).finally(() => {
      clearTimeout(timer);
      if (waiting.size) return;
      // An idle reader doesn't keep the process alive.
      worker?.unref();
      clearTimeout(idle);
      idle = setTimeout(() => {
        // Cleared first, so a read arriving while it stops starts a fresh worker.
        const w = worker;
        worker = undefined;
        void w?.terminate();
      }, idleMs_).unref();
    });
  const out = line.then(run, run);
  line = out.catch(() => {});
  return out;
}

// Agents whose transcript's window began before the tail read, logged once each.
const truncated = new Set<string>();

// The agent's messages since `since` (oldest first) with its mail, and whether older ones exist. A
// Claude transcript is read by the worker, unless the view has it parsed and nearly current; other
// harnesses page through their view. `bytes` is what the worker read.
async function readMessages(a: db.Agent, since: number, newestOnly: boolean): Promise<{ messages: ViewMessage[]; more: boolean; bytes: number }> {
  const file = a.transcript_path;
  if (a.harness === 'claude' && file && !(newestOnly && (unreadBytes(file) ?? Infinity) <= IN_PLACE)) {
    const tail = newestOnly ? STOP_TAIL : BACKFILL_TAIL;
    const r = await readTail({ file, since, tail });
    if (r.truncated && !newestOnly && !truncated.has(a.id)) {
      truncated.add(a.id);
      const first = new Date(r.messages![0].at).toISOString();
      console.warn(`turn index: ${a.name}'s transcript is ${r.size} bytes; read its last ${tail}, so its turns before ${first} aren't indexed`);
      db.addEvent(a.id, 'turn-index-truncated', { size: r.size, tail, first });
    }
    if (!r.messages!.length) return { messages: [], more: false, bytes: r.read! };
    return { messages: withMail(a, r.messages!, r.cut!), more: r.cut!, bytes: r.read! };
  }
  const pages: ViewMessage[][] = [];
  let before: string | undefined;
  let more = false;
  for (;;) {
    const page = await history(a, before, newestOnly ? RECENT_MESSAGES : PAGE);
    pages.push(page.messages);
    more = page.older !== null;
    before = page.older ?? undefined;
    if (newestOnly || !more || (page.messages[0]?.at ?? Infinity) < since) break;
  }
  return { messages: pages.reverse().flat(), more, bytes: 0 };
}

// The agent's finished turns since `since` (ms), newest first, and the bytes read for them; none
// when it has no view.
async function readTurns(a: db.Agent, since: number, newestOnly: boolean): Promise<{ turns: Turn[]; bytes: number }> {
  const cur = db.getAgent(a.id) ?? a;
  // A gzipped transcript (an archived agent's) is not read, as that would restore it: turns not yet embedded
  // stay out of turn search until the agent is restored.
  if (gzippedOnly(cur.transcript_path)) return { turns: [], bytes: 0 };
  const { messages, more, bytes } = await readMessages(cur, since, newestOnly);
  const turns = turnsOf(a.id, messages, more, RUNNING.has(cur.activity ?? ''), cur.parent_id)
    .filter((t) => t.at >= since)
    .reverse();
  return { turns, bytes };
}

// How much of a turn's text is kept as a suggestion's snippet.
export const SNIPPET_CHARS = 160;

const remember = (t: Turn) => {
  const flat = t.text.replace(/\s+/g, ' ').trim();
  db.putTurnSnippet(t.ref, t.at, flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS - 1)}…` : flat);
  if (texts.size >= MAX_TEXTS) texts.delete(texts.keys().next().value!);
  texts.set(t.ref, t.text);
};

// Queues the agent's latest finished turns (a turn end, off the hook's response path).
export function indexTurnsSoon(agentId: string): void {
  const a = db.getAgent(agentId);
  if (!a || a.machine !== MACHINE) return;
  const since = Date.now() - settings().search.turnDays * 86_400_000;
  // Off the hook's path: the query scans the old turns.
  setImmediate(() => {
    try {
      db.expireTurns(since);
    } catch (e) {
      console.error(`turn index: expiring old turns: ${e instanceof Error ? e.message : e}`);
    }
  });
  readTurns(a, since, true).then(
    ({ turns }) => {
      for (const t of turns) {
        remember(t);
        enqueue('turn', t.ref);
      }
    },
    () => {},
  );
}

// The backfill's cursor: agents not yet read (newest first), and turns read but not yet embedded.
let agents: db.Agent[] | undefined;
let ready: string[] = [];

// The backfill reads at most this many transcript bytes a minute, so a fresh start with many large
// transcripts spreads its parsing out instead of holding a core for minutes.
const BYTES_PER_MINUTE = 256 << 20;
let spent: { at: number; bytes: number }[] = [];
const YIELD_TURNS = 100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Waits until the last minute's reads are under the budget.
async function pace(): Promise<void> {
  for (;;) {
    const now = Date.now();
    spent = spent.filter((s) => s.at > now - 60_000);
    if (spent.reduce((n, s) => n + s.bytes, 0) < BYTES_PER_MINUTE) return;
    await sleep(spent[0].at + 60_000 - now);
  }
}

// Up to `limit` turn refs with no vector from `model`, newest agent first. Agents are read as the
// backfill needs them, so a page never reads the whole history. An agent with no view is skipped.
async function pendingTurns(model: string, limit: number): Promise<string[]> {
  const days = settings().search.turnDays;
  const since = Date.now() - days * 86_400_000;
  db.expireTurns(since);
  const indexed = (ref: string) => db.embeddingRow('turn', ref)?.model === model;
  let n = 0;
  const tick = async () => {
    if (++n % (YIELD_TURNS * 5) === 0) await new Promise((r) => setImmediate(r));
  };
  for (const r of [...texts.keys()]) {
    await tick();
    if (indexed(r)) texts.delete(r);
  }
  const kept: string[] = [];
  for (const r of ready) {
    await tick();
    if (!indexed(r) && texts.has(r)) kept.push(r);
  }
  ready = kept;
  while (ready.length < limit) {
    agents ??= db
      .listAgents()
      .filter((a) => a.machine === MACHINE && Date.parse(a.updated_at) >= since)
      .sort((x, y) => y.updated_at.localeCompare(x.updated_at));
    const a = agents.shift();
    if (!a) {
      agents = undefined;
      break;
    }
    await pace();
    try {
      const { turns, bytes } = await readTurns(a, since, false);
      spent.push({ at: Date.now(), bytes });
      for (const [i, t] of turns.entries()) {
        // Each turn is a database read and write: a busy agent's thousands yield now and then.
        if (i % YIELD_TURNS === YIELD_TURNS - 1) await new Promise((r) => setImmediate(r));
        if (indexed(t.ref)) continue;
        remember(t);
        ready.push(t.ref);
      }
    } catch {
      // No view yet, or the harness is down: a later backfill reads it.
    }
  }
  return ready.slice(0, limit);
}

source('turn', (ref) => texts.get(ref), pendingTurns);

// Test hooks.
export const _readTail = readTail;
export const _worker = (url?: URL, timeoutMs?: number, idleMs?: number) => {
  workerUrl = url ?? new URL('./turn-read-worker.ts', import.meta.url);
  readTimeoutMs = timeoutMs ?? READ_TIMEOUT_MS;
  idleMs_ = idleMs ?? WORKER_IDLE_MS;
};
export const _hasWorker = () => !!worker;
export const _pending = pendingTurns;
export const _forget = () => {
  texts.clear();
  agents = undefined;
  ready = [];
  spent = [];
  truncated.clear();
};