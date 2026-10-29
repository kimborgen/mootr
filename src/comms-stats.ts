// Comms stats (S-3826, phase 0 of S-3819): counts of mail, asks and waits, for the human only
// (GET /api/stats/comms, `stam stats comms`). Counts only: no mail body, subject, permission action, reason,
// details, payload or ITSA text is read into the result, so nothing here can leak them. One read pass over the
// db, no writes. Mail is scanned by created_at (no index on it; mail_recipients is reached by its primary key),
// so the window is clamped to 1-30 days.
import { typeOf } from './agent-class.ts';
import * as db from './db.ts';
import { settings } from './settings.ts';

export const MAX_DAYS = 30;
export const DEFAULT_DAYS = 7;
const HUMAN = 'human';
const HUMAN_STATUSES = ['needs_input', 'needs_approval', 'needs_review', 'needs_test'];
const TOP_SENDERS = 5;
// Recipients whose top senders are listed.
const TOP_FOR = ['chief-of-staff', 'assistant', 'intake'];

export const clampDays = (raw: unknown): number => {
  if (raw == null || raw === '') return DEFAULT_DAYS;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) ? Math.min(MAX_DAYS, Math.max(1, n)) : DEFAULT_DAYS;
};

// The kind of a delivered mail, first match wins. Written as one expression so SQLite groups by it.
const KIND_SQL = `CASE
  WHEN m.notice = 1 THEN 'notice'
  WHEN m.permission_id IS NOT NULL THEN 'permission_ask'
  WHEN m.kind = 'comment' THEN 'itsa_comment'
  WHEN m.kind = 'update' THEN 'itsa_update'
  WHEN m.kind = 'ask' THEN 'itsa_ask'
  WHEN m.from_id = 'human' THEN 'from_human'
  WHEN m.from_id LIKE 'system:%' THEN 'system'
  ELSE 'agent' END`;

type Counts = Record<string, number>;
const bump = (c: Counts, k: string, by = 1) => void (c[k] = (c[k] ?? 0) + by);

const quantile = (sorted: number[], q: number): number | null =>
  sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] * 10) / 10 : null;
const minutes = (from: string, to: string): number | null => {
  const d = (Date.parse(to) - Date.parse(from)) / 60_000;
  return Number.isFinite(d) && d >= 0 ? d : null;
};
const ageMin = (since: string, now: number): number | null => {
  const d = (now - Date.parse(since)) / 60_000;
  return Number.isFinite(d) ? Math.max(0, Math.round(d)) : null;
};

// p50 and p90 of a list of minutes, with how many.
const spread = (mins: number[]) => {
  const s = [...mins].sort((a, b) => a - b);
  return { n: s.length, p50: quantile(s, 0.5), p90: quantile(s, 0.9) };
};

const decider = (by: string | null): string => (!by ? 'none' : by === HUMAN ? 'human' : /^(stam|system)/.test(by) ? 'stam' : 'delegate');

export function commsStats(daysRaw?: unknown, now = Date.now()) {
  const days = clampDays(daysRaw);
  const since = new Date(now - days * 86_400_000).toISOString();
  const d = db.open();
  const all = (sql: string, ...a: (string | number)[]) => d.prepare(sql).all(...a) as any[];
  const cosName = settings().chiefOfStaff ?? null;
  const names = new Map<string, { name: string; type: string }>();
  for (const a of db.listAgents()) names.set(a.id, { name: a.name, type: typeOf(a as any, cosName) });

  // Deliveries: one row per recipient, kind and sender, in the window.
  const rows = all(
    `SELECT r.agent_id AS rcpt, ${KIND_SQL} AS kind, m.from_id AS sender, COUNT(*) AS n
       FROM mail m JOIN mail_recipients r ON r.mail_id = m.id
      WHERE m.created_at >= ? GROUP BY r.agent_id, kind, m.from_id`,
    since,
  );
  const unread = new Map<string, number>(
    all(`SELECT agent_id, COUNT(*) AS n FROM mail_recipients WHERE read_at IS NULL GROUP BY agent_id`).map((r) => [r.agent_id, r.n]),
  );
  const label = (id: string) => (id === HUMAN ? HUMAN : (names.get(id)?.name ?? id));
  const per = new Map<string, { total: number; kinds: Counts; senders: Counts }>();
  const toHuman = { total: 0, bySender: {} as Counts, byKind: {} as Counts };
  for (const r of rows) {
    const p = per.get(r.rcpt) ?? { total: 0, kinds: {}, senders: {} };
    p.total += r.n;
    bump(p.kinds, r.kind, r.n);
    bump(p.senders, label(r.sender), r.n);
    per.set(r.rcpt, p);
    if (r.rcpt === HUMAN) {
      toHuman.total += r.n;
      bump(toHuman.bySender, label(r.sender), r.n);
      bump(toHuman.byKind, r.kind, r.n);
    }
  }
  const top = (c: Counts) => Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, TOP_SENDERS).map(([sender, n]) => ({ sender, n }));
  const deliveries = [...per.entries()]
    .map(([id, p]) => {
      const type = id === HUMAN ? HUMAN : (names.get(id)?.type ?? 'gone');
      return { id, name: label(id), type, total: p.total, unread: unread.get(id) ?? 0, kinds: p.kinds, ...(TOP_FOR.includes(type) ? { topSenders: top(p.senders) } : {}) };
    })
    .sort((a, b) => b.total - a.total);

  // Human threads in the window, and how many the human wrote in (any human mail in the thread).
  // Two plain passes, joined in memory: a correlated lookup per thread scanned every human mail each time.
  const humanThreads = new Set<string>(all(`SELECT DISTINCT COALESCE(m.thread_id, m.id) AS tid FROM mail m JOIN mail_recipients r ON r.mail_id = m.id WHERE m.created_at >= ? AND r.agent_id = 'human'`, since).map((x) => x.tid));
  const humanWrote = new Set<string>(all(`SELECT DISTINCT thread_id FROM mail WHERE from_id = 'human' AND thread_id IS NOT NULL`).map((x) => x.thread_id));
  const hc = { threads: humanThreads.size, replied: [...humanThreads].filter((t) => humanWrote.has(t)).length };

  // Permission requests: counts by kind, audience and status; minutes to decide; who decided.
  const reqs = all(
    `SELECT kind, audience, status, decided_by, created_at, decided_at FROM permission_requests WHERE created_at >= ?`,
    since,
  );
  const byKind: Record<string, { total: number; audience: Counts; status: Counts; decidedBy: Counts; mins: number[] }> = {};
  for (const q of reqs) {
    const k = (byKind[q.kind ?? 'request'] ??= { total: 0, audience: {}, status: {}, decidedBy: {}, mins: [] });
    k.total++;
    bump(k.audience, q.audience);
    bump(k.status, q.status);
    if (q.decided_at) {
      bump(k.decidedBy, decider(q.decided_by));
      const m = minutes(q.created_at, q.decided_at);
      if (m != null) k.mins.push(m);
    }
  }
  const permissions = Object.entries(byKind).map(([kind, k]) => {
    const s = k.mins.sort((a, b) => a - b);
    return { kind, total: k.total, audience: k.audience, status: k.status, decidedBy: k.decidedBy, decidedMinutes: { n: s.length, p50: quantile(s, 0.5), p90: quantile(s, 0.9) } };
  });

  // Open now. Titles and text stay out: keys, statuses and ages only.
  const pending = all(`SELECT kind, MIN(created_at) AS oldest, COUNT(*) AS n FROM permission_requests WHERE status = 'pending' GROUP BY kind`);
  const ph = HUMAN_STATUSES.map(() => '?').join(',');
  // Time in the status: the latest status event of the ITSA (itsa_events_itsa), else updated_at.
  const lastStatus = d.prepare("SELECT ts FROM itsa_events WHERE itsa_id = ? AND type = 'status' ORDER BY id DESC LIMIT 1");
  const itsas = all(`SELECT id, key, status, updated_at FROM itsas WHERE status IN (${ph})`, ...HUMAN_STATUSES)
    .map((i) => ({ ...i, since: (lastStatus.get(i.id) as { ts: string } | undefined)?.ts ?? i.updated_at }))
    .sort((a, b) => a.since.localeCompare(b.since));
  const decisions = (d.prepare('SELECT COUNT(*) AS n FROM decision_mails').get() as any).n;
  const deferred = (d.prepare('SELECT COUNT(*) AS n FROM thread_deferred').get() as any).n;

  // Waits on the human: how many are open, how many began in the window, and their mean age. `waits` holds only open
  // waits (a closed wait's row is deleted), so the closed ones are read from `answers`.
  const w = all(`SELECT since FROM waits WHERE kind = 'human'`);
  const wAges = w.map((x) => minutes(x.since, new Date(now).toISOString())).filter((x): x is number => x != null);
  const inWindow = w.filter((x) => x.since >= since).length;

  // Answer times (S-3828), from comms_events (indexed by created_at): waits on the human that closed, decision mails
  // that settled, delegate asks that went to the human. Outcomes, counts and durations; the option a decision chose
  // is counted (`withChoice`), never listed.
  const ev = all(`SELECT kind, outcome, label, duration_ms FROM comms_events WHERE created_at >= ?`, since);
  const mins = (e: { duration_ms: number | null }) => (e.duration_ms == null ? [] : [e.duration_ms / 60_000]);
  const waitEv = ev.filter((e) => e.kind === 'wait');
  const decEv = ev.filter((e) => e.kind === 'decision');
  const escEv = ev.filter((e) => e.kind === 'escalation');
  const outcomes = (xs: { outcome: string }[]) => {
    const c: Counts = {};
    for (const x of xs) bump(c, x.outcome);
    return c;
  };
  const answered = decEv.filter((e) => e.outcome === 'answered');

  return {
    days,
    since,
    at: new Date(now).toISOString(),
    deliveries,
    human: { received: toHuman, threads: { total: hc.threads ?? 0, repliedByHuman: hc.replied ?? 0 } },
    permissions,
    open: {
      pendingAsks: pending.map((p) => ({ kind: p.kind ?? 'request', n: p.n, oldestMinutes: ageMin(p.oldest, now) })),
      itsasInHumanStatus: itsas.map((i) => ({ key: i.key, status: i.status, inStatusMinutes: ageMin(i.since, now) })),
      decisionMails: decisions,
      threadsDeferred: deferred,
    },
    waitsOnHuman: {
      open: w.length,
      openedInWindow: inWindow,
      meanOpenMinutes: wAges.length ? Math.round((wAges.reduce((a, b) => a + b, 0) / wAges.length) * 10) / 10 : null,
    },
    answers: {
      waitsClosed: { total: waitEv.length, byOutcome: outcomes(waitEv), minutes: spread(waitEv.flatMap(mins)) },
      decisions: {
        total: decEv.length,
        answered: answered.length,
        deferred: decEv.filter((e) => e.outcome === 'deferred').length,
        byOutcome: outcomes(decEv),
        withChoice: answered.filter((e) => e.label).length,
        answeredMinutes: spread(answered.flatMap(mins)),
      },
      escalations: { total: escEv.length, minutesToEscalate: spread(escEv.flatMap(mins)) },
    },
  };
}
