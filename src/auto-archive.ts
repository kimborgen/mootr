// Archives the human's threads that someone else resolved (S-637; src/thread-resolved.ts says when).
// One pass looks at the human's inbox as their list shows it and archives each resolved thread
// here and on the peers, whose archive state is their own. It runs every 10 minutes, and soon after
// an event that can resolve a thread: an ITSA closed, a request settled, mail to or from the human
// (or the human reading it). A thread waits until nothing happened in it for QUIET_MS, so it never
// leaves the list under the human's eyes while they read or answer it. A later mail to the human
// brings it back (db.splitArchived). A thread the human unarchived stays until it has new mail for
// them (db.keptOpen).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as db from './db.ts';
import * as itsa from './itsa.ts';
import { STAM_HOME } from './config.ts';
import { threadResolved } from './thread-resolved.ts';
import { envVar } from './env.ts';

const HUMAN = 'human';
// Tests set STAM_AUTO_ARCHIVE_QUIET_MS, so they wait on state, not on minutes.
export const QUIET_MS = Number(envVar('AUTO_ARCHIVE_QUIET_MS') ?? 3 * 60_000);
export const EVERY_MS = 10 * 60_000;

export interface Sources {
  // The human's threads archive doesn't hide, among the newest `limit` and the hidden ones, merged from every daemon
  // and split by this daemon's archive state.
  inbox: (limit?: number) => Promise<Thread[]>;
  // Every thread archive hides from the human, by the same merge (S-4520: loaded only when the repair asks).
  archived: () => Promise<Thread[]>;
  // The ids of the decision mails still waiting on the human, on every daemon.
  openDecisions: () => Promise<Set<string>>;
  // The open waits on the human, on every daemon: the thread each names, or the request or mail it is tied to.
  humanWaits: () => Promise<HumanWait[]>;
  // Archives the thread on the peers too; `humanIds` are its mails to the human from others.
  tellPeers: (threadId: string, mailIds: string[], humanIds: string[]) => Promise<void>;
  // Whether every peer answers now. A pass judges a thread only with every peer's mail in view (S-637).
  peersReachable: () => Promise<boolean>;
}

type Thread = { thread_id: string; mails: db.ThreadMail[] };
type WaitThread = { thread_id: string; mails: { id: string; from_id: string; created_at: string; permission_id?: string | null; recipients?: { id: string }[] }[] };
// An open wait on the human: the thread it names, or the request or mail it is tied to, and the agent that declared it.
export type HumanWait = { thread: string | null; target: string | null; agent: string | null };

// The last thing that happened in the thread: its newest mail, or the human reading one.
function lastActivity(t: Thread): number {
  let at = 0;
  for (const m of t.mails) {
    at = Math.max(at, Date.parse(m.created_at) || 0);
    const r = m.recipients.find((x) => x.id === HUMAN)?.read_at;
    if (r) at = Math.max(at, Date.parse(r) || 0);
  }
  return at;
}

// When the thread was last touched by anything that can resolve it: its activity, a request in
// it settling, or one of its ITSAs closing.
function lastEvent(t: Thread): number {
  let at = lastActivity(t);
  for (const m of t.mails) {
    if (m.permission?.decided_at) at = Math.max(at, Date.parse(m.permission.decided_at) || 0);
    const id = m.itsa_id ?? m.about_itsa;
    const closed = id ? itsa.find(id)?.closed_at : null;
    if (closed) at = Math.max(at, Date.parse(closed) || 0);
  }
  return at;
}

// The automatic pass archives only threads touched since it was first switched on (kv, set once).
// The ones resolved before wait for the one-off sweep (`all`), which runs only after the chief of
// staff approves its dry run.
const SINCE_KEY = 'autoArchive.since';
export function since(): number {
  const d = db.open();
  const r = d.prepare('SELECT value FROM kv WHERE key = ?').get(SINCE_KEY) as { value: string } | undefined;
  if (r) return Number(r.value);
  const now = Date.now();
  d.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run(SINCE_KEY, String(now));
  return now;
}

// One pass. Returns the threads it archived, or with `dry` would archive, with their subjects.
// `counts`, when given, gets how many resolved-looking threads an agent's wait kept in the inbox.
export async function archiveResolved(src: Sources, opts: { now?: number; dry?: boolean; all?: boolean; counts?: { waits: number } } = {}): Promise<{ thread_id: string; subject: string }[]> {
  if (!(await src.peersReachable())) throw new Error('a peer does not answer, and auto-archive judges threads only with every peer in view');
  const now = opts.now ?? Date.now();
  const from = opts.all ? 0 : since();
  // `all` looks at the whole inbox; the regular pass at its newest threads.
  const [threads, open, waits] = await Promise.all([src.inbox(opts.all ? 1_000_000 : 200), src.openDecisions(), src.humanWaits()]);
  const ctx = {
    itsaClosedAt: (id: string) => {
      const x = itsa.find(id);
      return x ? (itsa.isClosedStatus(x.status) ? (x.closed_at ?? x.updated_at) : null) : undefined;
    },
    decisionOpen: (id: string) => open.has(id),
    humanWaited: (t: WaitThread) => humanWaited(t, waits),
  };
  const done: { thread_id: string; subject: string }[] = [];
  for (const t of threads) {
    if (now - lastActivity(t) < QUIET_MS || lastEvent(t) < from) continue;
    if (!threadResolved(t, ctx).resolved) {
      if (opts.counts && ctx.humanWaited(t) && threadResolved(t, { ...ctx, humanWaited: () => false }).resolved) opts.counts.waits++;
      continue;
    }
    // A thread the human unarchived stays until it has new mail to them; their own mail isn't news.
    const humanIds = t.mails.filter((m) => m.from_id !== HUMAN && m.recipients.some((r) => r.id === HUMAN)).map((m) => m.id);
    if (db.keptOpen(HUMAN, t.thread_id, humanIds)) continue;
    done.push({ thread_id: t.thread_id, subject: t.mails[0]?.subject ?? '' });
    if (opts.dry) continue;
    const ids = t.mails.map((m) => m.id);
    db.archiveThread(HUMAN, t.thread_id, ids);
    db.markAutoArchived(HUMAN, t.thread_id);
    await src.tellPeers(t.thread_id, ids, humanIds).catch((e) => console.error(`auto-archive: telling peers about ${t.thread_id}: ${e instanceof Error ? e.message : e}`));
  }
  if (done.length && !opts.dry) console.log(`auto-archive: archived ${done.length} resolved thread(s) for the human: ${done.map((d) => d.thread_id).join(', ')}`);
  return done;
}

// Whether an agent waits on the human for the thread (S-637): a wait naming it, or one tied to a
// request or mail in it. A wait that names neither (generic) holds only the threads its agent is in
// the middle of: the agent's is the last mail not from the human, or it has a mail to the human
// unanswered in the thread. A generic wait with no known agent holds every thread.
export function humanWaited(t: WaitThread, waits: HumanWait[]): boolean {
  return waits.some((w) => {
    if (w.thread === t.thread_id) return true;
    if (w.target && t.mails.some((m) => m.id === w.target || m.permission_id === w.target)) return true;
    if (w.thread || w.target) return false;
    return !w.agent || genericWaitHolds(t, w.agent);
  });
}

function genericWaitHolds(t: WaitThread, agent: string): boolean {
  const mails = [...t.mails].sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (mails.findLast((m) => m.from_id !== HUMAN)?.from_id === agent) return true;
  const lastHuman = mails.findLast((m) => m.from_id === HUMAN)?.created_at ?? '';
  return mails.some((m) => m.from_id === agent && m.created_at > lastHuman && !!m.recipients?.some((r) => r.id === HUMAN));
}

// Runs the pass every EVERY_MS, and once more QUIET_MS after the latest event that nudges it.
// The first start with this code runs one-time work (cos, S-637), once it sees every peer answer, so
// the inbox it judges is the merged one: first a repair, then one full pass over every thread in the
// inbox, before the cutoff too, archived by the same rule. The kv flag records it is done, so it never
// repeats. The repair undoes the archives the earlier rule made wrongly (a thread an agent waits on,
// or that ends in a question): it covers the threads auto-archive marked, and those its log lines name.
// The repair (#185) is done once `REPAIR_KEY` is set; the full pass is done once `FULL_KEY` is (S-637).
const REPAIR_KEY = 'autoArchive.fullPassDone2';
const FULL_KEY = 'autoArchive.fullPassDone3';
export const FULL_DELAY_MS = Number(envVar('AUTO_ARCHIVE_FULL_DELAY_MS') ?? 60_000);
function kvSet(key: string): boolean {
  return !!db.open().prepare('SELECT 1 AS n FROM kv WHERE key = ?').get(key);
}
function fullPassDone(): boolean {
  return kvSet(FULL_KEY);
}
function markKv(key: string): void {
  db.open().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run(key, new Date().toISOString());
}

// The threads the daemon log says auto-archive archived for the human, before they were marked (the
// marks are new): the log lines name their ids.
function loggedAutoArchived(): string[] {
  let text = '';
  try {
    text = readFileSync(join(STAM_HOME, 'daemon.log'), 'utf8');
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const m of text.matchAll(/^auto-archive: archived \d+ resolved thread\(s\) for the human: (.*)$/gm)) ids.push(...m[1].split(', '));
  return ids;
}

// Unarchives the human's threads that auto-archive archived and the rule now keeps: the human's own
// archives are never touched, since only auto-archive's marks and its logged ids are candidates.
export async function repair(src: Sources): Promise<string[]> {
  const candidates = new Set([...db.autoArchivedThreads(HUMAN), ...loggedAutoArchived()]);
  if (!candidates.size) return [];
  const archived = await src.archived();
  const [open, waits] = await Promise.all([src.openDecisions(), src.humanWaits()]);
  const ctx = {
    itsaClosedAt: (id: string) => {
      const x = itsa.find(id);
      return x ? (itsa.isClosedStatus(x.status) ? (x.closed_at ?? x.updated_at) : null) : undefined;
    },
    decisionOpen: (id: string) => open.has(id),
    humanWaited: (t: WaitThread) => humanWaited(t, waits),
  };
  const undone: string[] = [];
  for (const t of archived) {
    if (!candidates.has(t.thread_id) || threadResolved(t, ctx).resolved) continue;
    db.unarchiveThread(HUMAN, t.thread_id);
    db.forgetAutoArchived(HUMAN, t.thread_id);
    undone.push(t.thread_id);
  }
  // Threads the marks name but that no longer archive hold no mark either.
  for (const id of candidates) if (!archived.some((t) => t.thread_id === id)) db.forgetAutoArchived(HUMAN, id);
  console.log(`auto-archive repair: unarchived ${undone.length} threads${undone.length ? `: ${undone.join(', ')}` : ''}`);
  return undone;
}

export async function fullPass(src: Sources): Promise<number> {
  if (fullPassDone()) return 0;
  // The repair runs once, on the first start with it; a later full pass never repeats it.
  if (!kvSet(REPAIR_KEY)) {
    await repair(src);
    markKv(REPAIR_KEY);
  }
  const counts = { waits: 0 };
  const done = await archiveResolved(src, { all: true, counts });
  markKv(FULL_KEY);
  console.log(`auto-archive full pass: ${done.length} threads, ${counts.waits} kept by waits`);
  return done.length;
}

export function start(src: Sources): { nudge: () => void } {
  since();
  let running = false;
  // The one-time work waits for every peer to answer, and tries again every FULL_DELAY_MS until then.
  const fullSoon = () => {
    const t = setTimeout(async () => {
      if (fullPassDone()) return;
      if (!(await src.peersReachable().catch(() => false))) {
        console.log('auto-archive: the full pass waits for every peer to answer');
        return fullSoon();
      }
      running = true;
      fullPass(src)
        .catch((e) => console.error(`auto-archive full pass: ${e instanceof Error ? e.message : e}`))
        .finally(() => (running = false));
    }, FULL_DELAY_MS);
    t.unref?.();
  };
  if (!fullPassDone()) fullSoon();
  const run = () => {
    if (running) return;
    running = true;
    archiveResolved(src)
      .catch((e) => console.error(`auto-archive: ${e instanceof Error ? e.message : e}`))
      .finally(() => (running = false));
  };
  setInterval(run, EVERY_MS).unref?.();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const nudge = () => {
    clearTimeout(timer);
    timer = setTimeout(run, QUIET_MS + 5_000);
    timer.unref?.();
  };
  return { nudge };
}
