// The away digest (S-2821, the server half of S-20): what happened while the human was away, what waits on
// them, and what runs next. The web UI's presence heartbeat keeps `lastActiveAt`; a new activity after more than
// settings.digest.awayMinutes of none closes an away window {since, until} and stores it as the latest one.
// GET /api/digest returns that window with its content. Nothing here calls a model: every list is read from a
// source the rest of stam already keeps, so the digest and those views can't disagree:
//   merged    the merge records (pr-merge's done runs) and GitHub's merged events (ext_events)
//   closed    the ITSA status history (itsa_events)              archived  the archive events (events, type archive)
//   spawned   the agents' spawn events (events)                   spend     the cost accounting (usage_samples)
//   needs     the Waiting list's sources: itsa-human attention, waits.webWaitsByAgent, pending requests,
//             db.decisionMails, and the threads the human deferred (defer-split.ts, as db.splitDeferred reads them)
//   next      the ITSAs in an active or ready status, by rank; the agents working now
// The state is in kv, so a daemon restart keeps the window, lastActiveAt and dismissedAt. The lists hold titles
// and refs only, never mail bodies, permission details or wait text beyond a short label.
import * as db from './db.ts';
import { splitDeferredThreads } from './defer-split.ts';
import * as itsa from './itsa.ts';
import * as itsaHuman from './itsa-human.ts';
import { HUMAN } from './mail.ts';
import * as prMerge from './pr-merge.ts';
import { settings } from './settings.ts';
import * as waits from './waits.ts';

export interface Window {
  since: string;
  until: string;
}

// The latest window with its dismissal, one kv value so the two can't be read apart.
interface Stored extends Window {
  dismissedAt: string | null;
}

export interface Happened {
  merged: { pr: number; title: string; itsa?: string; at: string }[];
  closed: { itsa: string; title: string; at: string }[];
  spawned: { agent: string; at: string }[];
  archived: { agent: string; at: string }[];
  spend: { usd: number; byHarness: Record<string, number> };
  // How many each cut list left out (only the lists that were cut).
  more?: Partial<Record<'merged' | 'closed' | 'spawned' | 'archived', number>>;
}

export interface Need {
  kind: 'itsa' | 'permission' | 'agent' | 'decision';
  ref: string;
  title: string;
  since: string;
  new: boolean;
}

export interface Digest {
  window: Window | null;
  dismissedAt: string | null;
  happened: Happened;
  needs: Need[];
  // How many needs the list left out, when it was cut.
  needsMore?: number;
  next: {
    itsas: { key: string; title: string; status: string; owner?: string }[];
    working: { agent: string; itsa?: string }[];
    more?: Partial<Record<'itsas' | 'working', number>>;
  };
}

const LAST_ACTIVE = 'digest.lastActiveAt';
const WINDOW = 'digest.window';
export const CAP = 20;
const NEXT_ITSAS = 10;
const REQUEST_ID = /^p[0-9a-f]{6}$/;

function get<T>(key: string): T | null {
  const r = db.open().prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return r ? (JSON.parse(r.value) as T) : null;
}

function put(key: string, value: unknown): void {
  db.open().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}

// The human's activity. The read of lastActiveAt and the write that follows run in one transaction, so two tabs or
// devices reporting at once see one stored value: the second one finds the first's activity and opens no window.
export function presence(now: Date = new Date()): { window: Window | null } {
  const at = now.toISOString();
  return db.transaction(() => {
    const prev = get<string>(LAST_ACTIVE);
    let closed: Window | null = null;
    if (prev && now.getTime() - Date.parse(prev) > settings().digest.awayMinutes * 60_000) {
      closed = { since: prev, until: at };
      put(WINDOW, { ...closed, dismissedAt: null } satisfies Stored);
    }
    // A late report never moves the stored activity back.
    if (!prev || at > prev) put(LAST_ACTIVE, at);
    return { window: closed };
  });
}

// The human dismisses the window that ends at `until`. A stale or missing window is a no-op (dismissed false);
// the first dismissal's time stands.
export function dismiss(until: string, now: Date = new Date()): { dismissed: true; dismissedAt: string } | { dismissed: false } {
  return db.transaction(() => {
    const w = get<Stored>(WINDOW);
    if (!w || w.until !== until) return { dismissed: false };
    if (w.dismissedAt) return { dismissed: true, dismissedAt: w.dismissedAt };
    const dismissedAt = now.toISOString();
    put(WINDOW, { ...w, dismissedAt } satisfies Stored);
    return { dismissed: true, dismissedAt };
  });
}

// Keeps the first CAP items of a list, counting what was cut into `more` under the list's path.
function capped<T>(path: string, all: T[], more: Record<string, number>): T[] {
  if (all.length > CAP) more[path] = all.length - CAP;
  return all.slice(0, CAP);
}

const permTitle = (p: { kind: string }): string => (p.kind === 'input' ? 'A suggested input' : 'A permission request');

// The open requests that wait on the human.
function pendingPerms() {
  return db.listPermissionRequests('pending').filter((p) => p.audience === 'human');
}

// The threads the human deferred (Defer, S-1068), split as db.splitDeferred splits them: a thread is parked while
// every message sent to the human is one its deferral recorded.
function humanParked(): Set<string> {
  const d = db.open();
  const recorded = new Map<string, Set<string>>();
  for (const r of d.prepare('SELECT thread_id FROM thread_defer WHERE mailbox_id = ?').all(HUMAN) as { thread_id: string }[]) recorded.set(r.thread_id, new Set());
  for (const r of d.prepare('SELECT thread_id, mail_id FROM thread_defer_mail WHERE mailbox_id = ?').all(HUMAN) as { thread_id: string; mail_id: string }[]) {
    recorded.get(r.thread_id)?.add(r.mail_id);
  }
  const threads = [...recorded.keys()].map((thread_id) => ({ thread_id, mails: db.threadMail(thread_id) }));
  return new Set(splitDeferredThreads(HUMAN, threads, recorded).deferred.map((t) => t.thread_id));
}

type Row = Omit<Need, 'new'> & { parked: boolean };

// What waits on the human, as the Waiting list (web/src/itsa/WaitingList.tsx) builds it: the same rules, the same
// sources. A row whose thread the human deferred leaves the list, as the web's deferred rows do. Oldest first.
export function needs(since: string | null): Need[] {
  const parked = humanParked();
  const attention = itsaHuman.attention();
  const asks = new Set(attention.map((x) => x.ask_thread_id).filter(Boolean));
  const perms = pendingPerms();
  const permThread = (id: string) => db.permissionMail(id)?.thread_id;
  const pendingThreads = new Set(perms.map((p) => permThread(p.id)).filter(Boolean));
  // A decision mail is its thread's row; the latest one stands for a thread with several.
  const decided = new Map<string, db.DecisionRow>();
  for (const d of db.decisionMails()) {
    if (asks.has(d.thread_id) || pendingThreads.has(d.thread_id)) continue;
    const prev = decided.get(d.thread_id);
    if (!prev || d.created_at >= prev.created_at) decided.set(d.thread_id, d);
  }
  const rows: Row[] = attention.map((x) => ({
    kind: 'itsa',
    ref: x.key,
    title: x.title,
    since: x.since,
    parked: x.deferred || parked.has(x.ask_thread_id ?? ''),
  }));
  for (const d of decided.values()) {
    rows.push({ kind: 'decision', ref: d.mail_id, title: d.subject, since: d.created_at, parked: d.deferred || parked.has(d.thread_id) });
  }
  // An agent's wait folds into the row of its request or its thread, so each thing shows once.
  const asked = new Set<string>();
  for (const [agentId, ws] of waits.webWaitsByAgent()) {
    const a = db.getAgent(agentId);
    if (!a || a.lifecycle === 'archived') continue;
    for (const w of ws) {
      if (w.kind !== 'human') continue;
      const perm = w.target ? perms.find((p) => p.id === w.target) : undefined;
      if (perm) {
        if (asked.has(perm.id)) continue;
        asked.add(perm.id);
      } else if (w.source === 'declared' && REQUEST_ID.test(w.target ?? '')) continue;
      else if (w.thread && (asks.has(w.thread) || pendingThreads.has(w.thread) || decided.has(w.thread))) continue;
      const tid = (perm ? permThread(perm.id) : undefined) ?? w.thread ?? undefined;
      rows.push(
        perm
          ? { kind: 'permission', ref: perm.id, title: `${permTitle(perm)} from ${a.name}`, since: w.since, parked: !!tid && parked.has(tid) }
          : { kind: 'agent', ref: a.name, title: w.detail ?? 'Your reply', since: w.since, parked: !!tid && parked.has(tid) },
      );
    }
  }
  // A pending request whose agent has no wait row (the wait is cleared once it is answered).
  for (const p of perms) {
    if (asked.has(p.id)) continue;
    const tid = permThread(p.id);
    rows.push({ kind: 'permission', ref: p.id, title: `${permTitle(p)} from ${db.getAgent(p.agent_id)?.name ?? p.agent_id}`, since: p.created_at ?? '', parked: !!tid && parked.has(tid) });
  }
  return rows
    .filter((r) => !r.parked)
    .sort((a, b) => a.since.localeCompare(b.since) || a.kind.localeCompare(b.kind) || a.ref.localeCompare(b.ref))
    .map(({ parked: _parked, ...r }) => ({ ...r, new: !!since && r.since > since }));
}

// The merges that ended in the window: the merge records (pr-merge's done runs, which name the ITSA) and GitHub's
// merged events the daemon stored (ext_events, kept for the PRs something watches). One per PR, the record first.
function mergedIn(since: string, until: string): Happened['merged'] {
  const records = prMerge
    .mergedRuns()
    .filter((r) => !!r.ended && r.ended >= since && r.ended <= until)
    .map((r) => ({ pr: r.pr, title: (r.itsa ? itsa.find(r.itsa)?.title : undefined) ?? r.branch, ...(r.itsa ? { itsa: r.itsa } : {}), at: r.ended! }));
  const known = new Set(records.map((r) => r.pr));
  const events = (db.open().prepare(`SELECT subjects, summary, created_at FROM ext_events
    WHERE source = 'github' AND type = 'pull_request.merged' AND created_at >= ? AND created_at <= ?`).all(since, until) as { subjects: string; summary: string; created_at: string }[])
    .map((e) => {
      const pr = Number(JSON.parse(e.subjects).map((s: string) => s.match(/#(\d+)$/)?.[1]).find(Boolean));
      return { pr, title: e.summary.replace(/^PR #\d+ merged: /, ''), at: e.created_at };
    })
    .filter((e) => e.pr > 0 && !known.has(e.pr));
  return [...records, ...events].sort((a, b) => b.at.localeCompare(a.at) || b.pr - a.pr);
}

// The latest window's events, each list newest first. Times are ISO strings, so they compare as text.
function happenedIn(win: Window, more: Record<string, number>): Happened {
  const { since, until } = win;
  const d = db.open();
  const merged = mergedIn(since, until);
  // A close is a move from a non-closed status to a closed one, and counts only while the ITSA is still closed:
  // the latest close per ITSA.
  const moves = d.prepare(`SELECT e.itsa_id, e.ts, e.data, i.key, i.title, i.status FROM itsa_events e JOIN itsas i ON i.id = e.itsa_id
    WHERE e.type = 'status' AND e.ts >= ? AND e.ts <= ? ORDER BY e.ts DESC, e.id DESC`).all(since, until) as { itsa_id: string; ts: string; data: string | null; key: string; title: string; status: string }[];
  const seen = new Set<string>();
  const closed: Happened['closed'] = [];
  for (const r of moves) {
    const move = r.data ? (JSON.parse(r.data) as { from?: string; to?: string }) : {};
    if (seen.has(r.itsa_id) || !itsa.isClosedStatus(move.to) || itsa.isClosedStatus(move.from) || !itsa.isClosedStatus(r.status)) continue;
    seen.add(r.itsa_id);
    closed.push({ itsa: r.key, title: r.title, at: r.ts });
  }
  // A spawn is counted once per agent: the first (a later spawn is a recovery of the same agent's first prompt).
  const spawnRows = d.prepare(`SELECT e.agent_id, a.name AS agent, e.ts AS at FROM events e JOIN agents a ON a.id = e.agent_id
    WHERE e.type = 'spawn' AND e.ts >= ? AND e.ts <= ? ORDER BY e.ts ASC, e.id ASC`).all(since, until) as { agent_id: string; agent: string; at: string }[];
  const firstSpawn = new Map<string, { agent: string; at: string }>();
  for (const r of spawnRows) if (!firstSpawn.has(r.agent_id)) firstSpawn.set(r.agent_id, { agent: r.agent, at: r.at });
  const spawned = [...firstSpawn.values()].sort((a, b) => b.at.localeCompare(a.at) || a.agent.localeCompare(b.agent));
  const archived = (d.prepare(`SELECT a.name AS agent, e.ts AS at FROM events e JOIN agents a ON a.id = e.agent_id
    WHERE e.type = 'archive' AND e.ts >= ? AND e.ts <= ? ORDER BY e.ts DESC, e.id DESC`).all(since, until) as { agent: string; at: string }[]);
  const byHarness: Record<string, number> = {};
  for (const r of d.prepare('SELECT harness, SUM(cost_usd) AS usd FROM usage_samples WHERE bucket >= ? AND bucket < ? GROUP BY harness ORDER BY harness').all(since, until) as { harness: string; usd: number }[]) {
    byHarness[r.harness] = Math.round(r.usd * 100) / 100;
  }
  const usd = Math.round(Object.values(byHarness).reduce((s, v) => s + v, 0) * 100) / 100;
  return {
    merged: capped('happened.merged', merged, more),
    closed: capped('happened.closed', closed, more),
    spawned: capped('happened.spawned', spawned, more),
    archived: capped('happened.archived', archived, more),
    spend: { usd, byHarness },
  };
}

// The ITSAs in an active or ready status by rank (unranked last, then oldest, then key), and the agents working now.
function next(more: Record<string, number>): Digest['next'] {
  const names = itsa.statuses().filter((s) => s.category === 'active' || s.category === 'ready').map((s) => s.name);
  if (!names.length) return { itsas: [], working: [] };
  const rows = db.open().prepare(`SELECT key, title, status, owner, rank FROM itsas WHERE status IN (${names.map(() => '?').join(', ')})
    ORDER BY rank IS NULL, rank, created_at, key`).all(...names) as { key: string; title: string; status: string; owner: string | null; rank: number | null }[];
  // The first active ITSA each agent owns, for its row in the working list.
  const ownedKey = new Map<string, string>();
  for (const r of rows) if (r.owner && !ownedKey.has(r.owner)) ownedKey.set(r.owner, r.key);
  const itsas = rows.map((r) => {
    const owner = r.owner ? db.getAgent(r.owner)?.name : undefined;
    return { key: r.key, title: r.title, status: r.status, ...(owner ? { owner } : {}) };
  });
  if (itsas.length > NEXT_ITSAS) more['next.itsas'] = itsas.length - NEXT_ITSAS;
  const working = db.listLiveAgents()
    .filter((a) => a.activity === 'working')
    .map((a) => ({ agent: a.name, ...(ownedKey.has(a.id) ? { itsa: ownedKey.get(a.id)! } : {}) }))
    .sort((a, b) => a.agent.localeCompare(b.agent));
  return { itsas: itsas.slice(0, NEXT_ITSAS), working: capped('next.working', working, more) };
}

// The cut counts under one prefix (`happened`, `next`), keyed by the list's name.
function under(more: Record<string, number>, prefix: string): Record<string, number> {
  return Object.fromEntries(Object.entries(more).filter(([k]) => k.startsWith(prefix + '.')).map(([k, v]) => [k.slice(prefix.length + 1), v]));
}

// GET /api/digest: the latest away window with what happened in it, what waits on the human now, and what runs next.
export function digest(): Digest {
  const more: Record<string, number> = {};
  const w = get<Stored>(WINDOW);
  const win = w ? { since: w.since, until: w.until } : null;
  const happened: Happened = win
    ? happenedIn(win, more)
    : { merged: [], closed: [], spawned: [], archived: [], spend: { usd: 0, byHarness: {} } };
  const all = needs(win?.since ?? null);
  const needsList = capped('needs', all, more);
  const nextView = next(more);
  return {
    window: win,
    dismissedAt: w?.dismissedAt ?? null,
    happened: { ...happened, more: under(more, 'happened') },
    needs: needsList,
    ...(more.needs ? { needsMore: more.needs } : {}),
    next: { ...nextView, more: under(more, 'next') },
  };
}
