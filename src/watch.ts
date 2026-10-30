// External events: one daemon-side service for sources such as GitHub, Linear, and Slack.
// A source (a poller, built later) hands `ingest` a normalized event; the service stores it,
// matches every unexpired subscription, clears any open event wait it fits, and delivers. A
// subscription names a subscriber an agent, an ITSA, or the human, and a filter over source,
// subjects, types, and actors. Subject keys look like `github:OWNER/REPO#N`,
// `github:OWNER/REPO`, `linear:TEAM-123`, `linear:team:KEY`, `slack:CHANNEL`; a filter's
// subject and type patterns are globs, where `*` matches within one segment (up to the
// next `/`). Events within a subscription fold for a short window (`STAM_EVENT_FOLD_MS`,
// 20 s by default) into one delivery. An ITSA linked to a PR or issue (a URL subjectsForUrl
// maps to a subject key) is subscribed to it by stam, and hears in its thread. See
// docs/design.md.
import { randomBytes } from 'node:crypto';
import * as db from './db.ts';
import { render, withFailureRetro } from './templates.ts';
import { queueNotice, sendFromSystem, sendMail, HUMAN } from './mail.ts';
import { find as findItsa, participants as itsaParticipants, post as itsaPost, postRouted as itsaPostRouted, links as itsaLinks, isClosedStatus, onChange as onItsaChange } from './itsa.ts';
import { mayManageTree } from './cost-auth.ts';
import { chiefOfStaff } from './org.ts';
import { settings } from './settings.ts';
import { MACHINE } from './config.ts';
import { checkEvent as checkRequirementsOn } from './req-check.ts';
import { envVar } from './env.ts';

// 'process' is a start node of a process file (S-947, src/process-run.ts); only stam makes those.
export type SubscriberKind = 'agent' | 'itsa' | 'human' | 'process';

export interface EventFilter {
  source?: string;
  subjects?: string[];
  types?: string[];
  actors?: string[];
  exclude_actors?: string[];
  // Event types that end the subscription once one is delivered (watch_pr: a merge or close).
  ends_on?: string[];
  // An ISO time; a source-stamped event that happened before it is not delivered (watch_pr
  // stamps the moment the watch began, so a first relay never replays older changes).
  since?: string;
}

export interface ExtEvent {
  id: number;
  source: string;
  type: string;
  subjects: string[];
  actor: string | null;
  url: string | null;
  summary: string;
  payload: unknown;
  dedupe_key: string;
  created_at: string;
}

export interface Subscription {
  id: string;
  subscriber_kind: SubscriberKind;
  subscriber_id: string;
  filter: EventFilter;
  created_by: string;
  note: string | null;
  expires_at: number | null;
  last_mail_id: string | null;
  created_at: string;
}

// An event as a source posts it; subjects may be one key or a list.
export interface EventInput {
  source?: string;
  type?: string;
  subject?: string;
  subjects?: string[];
  actor?: string | null;
  url?: string | null;
  summary?: string;
  payload?: unknown;
  dedupe_key?: string;
}

const now = () => new Date().toISOString();
const KINDS: SubscriberKind[] = ['agent', 'itsa', 'human'];
// `created_by` for the subscriptions stam makes for itself, such as an ITSA's link ones. It
// is not an agent id, so no agent owns them and only they are reconciled automatically.
export const STAM = 'stam';

// One short random id, in the shape the rest of stam uses.
function newId(): string {
  return 'es-' + randomBytes(5).toString('hex');
}

// The fold window: events for one subscription closer than this go out together. A test
// sets STAM_EVENT_FOLD_MS small; 0 disables folding (each event delivers at once).
function foldMs(): number {
  const n = Number(envVar('EVENT_FOLD_MS'));
  return Number.isFinite(n) && n >= 0 ? n : 20_000;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A filter pattern: `*` matches any run of characters within one segment (no `/`). An exact
// pattern (no `*`) matches only itself. Broad patterns such as `github:example/*` match a
// repo and its issues; `github:example/stam#12` matches one pull request.
export function globMatch(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  return new RegExp(`^${pattern.split('*').map(escapeRe).join('[^/]*')}$`).test(value);
}

// The subject key a link's URL names, or null for one stam doesn't follow. A GitHub pull
// request or issue maps to `github:OWNER/REPO#N`; a Linear issue to `linear:TEAM-123`.
export function subjectsForUrl(url: string): string | null {
  const u = String(url ?? '').trim();
  const gh = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(?:pull|issues)\/(\d+)(?:[/?#].*)?$/.exec(u);
  if (gh) return `github:${gh[1]}/${gh[2]}#${gh[3]}`;
  const linear = /^https?:\/\/linear\.app\/[^/\s]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:[/?#].*)?$/.exec(u);
  if (linear) return `linear:${linear[1]}`;
  return null;
}

function withSubjects(input: EventInput): string[] {
  const out = [...(input.subjects ?? []), ...(input.subject ? [input.subject] : [])].map((s) => String(s)).filter(Boolean);
  return [...new Set(out)];
}

// Whether one event fits a subscription's filter. Every field is optional; a filter with no
// subjects matches any event, and one with subjects matches when any pattern fits any key.
export function matchesFilter(f: EventFilter, ev: Pick<ExtEvent, 'source' | 'type' | 'subjects' | 'actor'>): boolean {
  if (f.source && f.source !== ev.source) return false;
  // `issues` was split into `issues.<action>` (S-947): a filter on plain `issues` still fits them, and no other type widens.
  if (f.types?.length && !f.types.some((p) => globMatch(p, ev.type) || (p === 'issues' && ev.type.startsWith('issues.')))) return false;
  if (f.subjects?.length && !ev.subjects.some((s) => f.subjects!.some((p) => globMatch(p, s)))) return false;
  if (f.actors?.length && !f.actors.some((p) => globMatch(p, ev.actor ?? ''))) return false;
  if (f.exclude_actors?.length && ev.actor && f.exclude_actors.some((p) => globMatch(p, ev.actor!))) return false;
  return true;
}

// Stores an event and matches it. Returns whether it was new (a duplicate dedupe_key is
// dropped) and how many subscriptions it matched. Delivery of matched events is folded and
// therefore happens shortly after; `flush` forces it (for tests).
export function ingest(input: EventInput): { stored: boolean; event?: ExtEvent; matched: number } {
  const source = String(input.source ?? '').trim();
  const type = String(input.type ?? '').trim();
  if (!source) throw new Error('an event needs a source');
  if (!type) throw new Error('an event needs a type');
  const dedupe_key = String(input.dedupe_key ?? '').trim();
  if (!dedupe_key) throw new Error('an event needs a dedupe_key');
  const subjects = withSubjects(input);
  const summary = String(input.summary ?? `${source} ${type}`).trim();
  const created_at = now();
  const row = db
    .open()
    .prepare('INSERT OR IGNORE INTO ext_events (source, type, subjects, actor, url, summary, payload, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(source, type, JSON.stringify(subjects), input.actor ?? null, input.url ?? null, summary, input.payload === undefined ? null : JSON.stringify(input.payload), dedupe_key, created_at);
  if (Number(row.changes) === 0) return { stored: false, matched: 0 };
  const ev: ExtEvent = { id: Number(row.lastInsertRowid), source, type, subjects, actor: input.actor ?? null, url: input.url ?? null, summary, payload: input.payload, dedupe_key, created_at };
  let matched = 0;
  for (const sub of liveSubscriptions()) {
    if (!fitsSubscription(sub, ev)) continue;
    matched++;
    if (sub.subscriber_kind === 'process') {
      try {
        processStart?.(sub.subscriber_id, ev);
      } catch {
        // A runner failure must not break the source that posted the event.
      }
      continue;
    }
    const ends = sub.filter.ends_on?.some((p) => globMatch(p, ev.type)) ?? false;
    enqueue(sub, ev, ends);
    // An ending event is delivered from the queued copy: the row goes now, the delivery stays.
    // The queue is in memory, so a restart within the fold window loses that delivery.
    if (ends) db.open().prepare('DELETE FROM event_subscriptions WHERE id = ?').run(sub.id);
  }
  // A declared event wait clears on the first event that fits its filter; the agent gets the
  // event line as a notice (a prompt if idle). See src/waits.ts, declare.
  clearEventWaits(ev);
  // Requirement checks (src/req-check.ts) look at the stored event, async; off unless enabled.
  checkRequirementsOn(ev);
  return { stored: true, event: ev, matched };
}

type Row = Omit<Subscription, 'filter'> & { filter: string };
const parse = (r: Row): Subscription => ({ ...r, filter: JSON.parse(r.filter) as EventFilter });

// Unexpired subscriptions, deleting expired ones lazily as we go.
function liveSubscriptions(nowMs = Date.now()): Subscription[] {
  const d = db.open();
  d.prepare('DELETE FROM event_subscriptions WHERE expires_at IS NOT NULL AND expires_at <= ?').run(nowMs);
  return (d.prepare('SELECT * FROM event_subscriptions ORDER BY created_at').all() as unknown as Row[]).map(parse);
}

// The events stored, newest first, optionally only those carrying one subject key. The
// subject filter runs in SQL (before LIMIT), so an old event that matches is not crowded
// out by newer ones that don't.
export function events(o: { subject?: string; limit?: number } = {}): ExtEvent[] {
  const limit = Math.max(1, Math.min(500, Number(o.limit ?? 50) || 50));
  const d = db.open();
  const rows = (o.subject
    ? d.prepare('SELECT * FROM ext_events WHERE EXISTS (SELECT 1 FROM json_each(ext_events.subjects) WHERE value = ?) ORDER BY id DESC LIMIT ?').all(String(o.subject), limit)
    : d.prepare('SELECT * FROM ext_events ORDER BY id DESC LIMIT ?').all(limit)) as unknown as (Omit<ExtEvent, 'subjects' | 'payload'> & { subjects: string; payload: string | null })[];
  return rows.map((r) => ({ ...r, subjects: JSON.parse(r.subjects) as string[], payload: r.payload ? JSON.parse(r.payload) : null }));
}

// ---- subscriptions ----

export function sanitizeFilter(raw: unknown): EventFilter {
  const f = (raw ?? {}) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : v == null || v === '' ? [] : [String(v)]);
  const out: EventFilter = {};
  if (f.source != null && String(f.source).trim()) out.source = String(f.source).trim();
  for (const k of ['subjects', 'types', 'actors', 'exclude_actors', 'ends_on'] as const) {
    const l = list(f[k]);
    if (l.length) out[k] = l;
  }
  // A scalar, so not part of the list loop above.
  if (f.since != null && String(f.since).trim()) out.since = String(f.since).trim();
  return out;
}

// The time a source stamped on an event as when the change happened (payload.at), or null when
// it has none. The event's own created_at is when the poller ingested it, too late to tell an
// old change from a new one.
function eventAt(ev: ExtEvent): string | null {
  const at = (ev.payload as { at?: unknown } | null)?.at;
  return typeof at === 'string' && at ? at : null;
}

// The stam agent whose own PR review this event carries (payload.review_agent), or null. Every
// agent posts as one GitHub account, so pr-review.mjs's "Review (AGENT): " text is how the
// poller tells a watcher's own review comment and status from someone else's.
function reviewAgentOf(ev: ExtEvent): string | null {
  const a = (ev.payload as { review_agent?: unknown } | null)?.review_agent;
  return typeof a === 'string' && a ? a : null;
}

// Whether one event reaches one subscription, beyond its filter: not a change that happened
// before the watch began, and never the subscriber's own review. An ending type (a merge or
// close) is always delivered, since it is what ends the watch.
export function fitsSubscription(sub: Subscription, ev: ExtEvent): boolean {
  if (!matchesFilter(sub.filter, ev)) return false;
  const since = sub.filter.since;
  const ends = sub.filter.ends_on?.some((p) => globMatch(p, ev.type)) ?? false;
  if (since && !ends) {
    const at = eventAt(ev);
    if (at && at < since) return false;
  }
  if (sub.subscriber_kind === 'agent' && reviewAgentOf(ev) === sub.subscriber_id) return false;
  return true;
}

// Whether `by` may subscribe `subscriber` to events: the human anything; an agent itself, an
// agent in its tree (mayManageTree), or an ITSA it owns or takes part in. The human, the
// assistant, and the chief of staff may also subscribe the human.
export function maySubscribe(by: string, kind: SubscriberKind, id: string): boolean {
  if (by === HUMAN) return true;
  const actor = db.getAgent(by);
  if (!actor) return false;
  if (kind === 'human') return actor.kind === 'assistant' || chiefOfStaff()?.id === actor.id;
  if (kind === 'agent') {
    const target = db.getAgent(id);
    if (!target) return false;
    return target.id === actor.id || mayManageTree(actor.id, target);
  }
  if (kind === 'itsa') {
    const x = findItsa(id);
    if (!x) return false;
    return x.owner === actor.id || itsaParticipants(x.id).includes(actor.id);
  }
  return false;
}

export interface CreateInput {
  subscriber_kind: SubscriberKind;
  subscriber_id: string;
  filter?: unknown;
  note?: string;
  expires_at?: number | null;
  expires_in_minutes?: number;
  // The acting agent (id or name) or the human; the daemon resolves who that is.
  by?: string;
}

export function createSubscription(input: CreateInput): Subscription {
  const by = String(input.by ?? HUMAN);
  const kind = String(input.subscriber_kind ?? '') as SubscriberKind;
  if (!KINDS.includes(kind)) throw new Error(`subscriber_kind must be one of ${KINDS.join(', ')}`);
  // An agent may name itself or another by id or name; the human is a fixed id.
  let id = String(input.subscriber_id ?? '').trim();
  if (id.toLowerCase() === 'the human') id = HUMAN;
  if (kind === 'agent') {
    const a = db.getAgent(id);
    if (!a) throw new Error(`no agent ${id}`);
    id = a.id;
  } else if (kind === 'itsa') {
    const x = findItsa(id);
    if (!x) throw new Error(`no ITSA ${id}`);
    id = x.id;
  } else {
    id = HUMAN;
  }
  if (!maySubscribe(by, kind, id)) throw new Error(`${by === HUMAN ? 'the human' : (db.getAgent(by)?.name ?? by)} may not subscribe that ${kind}`);
  const expires_at = input.expires_at != null ? Number(input.expires_at) : input.expires_in_minutes != null ? Date.now() + Number(input.expires_in_minutes) * 60_000 : null;
  return insertSubscription({
    id: newId(),
    subscriber_kind: kind,
    subscriber_id: id,
    filter: sanitizeFilter(input.filter),
    created_by: by,
    note: input.note != null && String(input.note).trim() ? String(input.note).trim() : null,
    expires_at,
    last_mail_id: null,
    created_at: now(),
  });
}

// Stores one subscription row. Shared by createSubscription (an agent, an ITSA, or the human
// acting) and the link subscriptions stam makes for itself.
function insertSubscription(sub: Subscription): Subscription {
  db.open()
    .prepare('INSERT INTO event_subscriptions (id, subscriber_kind, subscriber_id, filter, created_by, note, expires_at, last_mail_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(sub.id, sub.subscriber_kind, sub.subscriber_id, JSON.stringify(sub.filter), sub.created_by, sub.note, sub.expires_at, null, sub.created_at);
  return sub;
}

export function find(id: string): Subscription | undefined {
  const r = db.open().prepare('SELECT * FROM event_subscriptions WHERE id = ?').get(id) as Row | undefined;
  return r ? parse(r) : undefined;
}

// The subscriptions `by` may see: the human sees all; an agent sees the ones it created or
// that name it as the subscriber.
export function listSubscriptions(by: string): Subscription[] {
  // The process start rows are stam's own and come back on the next reconcile, so they aren't listed.
  const rows = (db.open().prepare("SELECT * FROM event_subscriptions WHERE subscriber_kind != 'process' ORDER BY created_at").all() as unknown as Row[]).map(parse);
  if (by === HUMAN) return rows;
  const actor = db.getAgent(by);
  if (!actor) return [];
  return rows.filter((s) => s.created_by === actor.id || (s.subscriber_kind === 'agent' && s.subscriber_id === actor.id));
}

// The notes of the live subscriptions, for the auto-read sweep (src/notices.ts, S-717): a
// watch_pr relay stays unread only while a subscription with its note (`PR #N watch`) lives.
export function liveSubscriptionNotes(): Set<string> {
  const out = new Set<string>();
  for (const s of liveSubscriptions()) if (s.note) out.add(s.note);
  return out;
}

export function removeSubscription(id: string, by: string): Subscription {
  const s = find(id);
  if (!s) throw new Error(`no subscription ${id}`);
  const own = s.created_by === by || (s.subscriber_kind === 'agent' && s.subscriber_id === by);
  if (!own && !maySubscribe(by, s.subscriber_kind, s.subscriber_id)) throw new Error(`${by === HUMAN ? 'the human' : (db.getAgent(by)?.name ?? by)} may not remove that subscription`);
  dropSubscription(id);
  return s;
}

// Drops one subscription and any delivery it still has folded, with no permission check;
// used by removeSubscription and by the link reconciliation.
function dropSubscription(id: string): void {
  const pending = buffered.get(id);
  if (pending) {
    clearTimeout(pending.timer);
    buffered.delete(id);
  }
  db.open().prepare('DELETE FROM event_subscriptions WHERE id = ?').run(id);
}

// ---- subscriptions stam makes for an ITSA's links ----
//
// One subscription per ITSA and subject key, created as stam (created_by STAM), so an ITSA
// linked to a pull request or issue hears about it in its thread.

// The subject key a subscription watches, when it names one; the link ones always name one.
function subjectOf(sub: Subscription): string | null {
  return sub.filter.subjects?.[0] ?? null;
}

// An ITSA's subscriptions, whatever created them.
function itsaSubscriptions(itsaId: string): Subscription[] {
  return (db.open().prepare("SELECT * FROM event_subscriptions WHERE subscriber_kind = 'itsa' AND subscriber_id = ?").all(itsaId) as unknown as Row[]).map(parse);
}

// Makes an ITSA's link subscriptions match its links: one on the subject each link's URL
// names, while the ITSA is open; none while it is closed. Idempotent, so it also serves the
// one-time pass over existing links at daemon start. A subscription someone made by hand for
// the same subject is left alone; only stam's own are removed.
function syncItsa(itsaId: string): void {
  const x = findItsa(itsaId);
  if (!x) return;
  const desired = new Map<string, string>();
  if (!isClosedStatus(x.status)) {
    for (const l of itsaLinks(x.id)) {
      const s = subjectsForUrl(l.url);
      if (s && !desired.has(s)) desired.set(s, `linked ${s}`);
    }
  }
  const existing = itsaSubscriptions(x.id);
  for (const sub of existing) {
    const s = subjectOf(sub);
    if (sub.created_by === STAM && (s === null || !desired.has(s))) dropSubscription(sub.id);
  }
  const present = new Set(existing.map(subjectOf).filter((s): s is string => !!s));
  for (const [subject, note] of desired) {
    if (present.has(subject)) continue;
    insertSubscription({ id: newId(), subscriber_kind: 'itsa', subscriber_id: x.id, filter: { subjects: [subject] }, created_by: STAM, note, expires_at: null, last_mail_id: null, created_at: now() });
  }
}

// Reconciles every ITSA's link subscriptions once, at daemon start, so links that predate
// this change get theirs.
export function syncItsaSubscriptions(): void {
  for (const r of db.open().prepare('SELECT id FROM itsas').all() as unknown as { id: string }[]) syncItsa(r.id);
}

// Connects link changes to the reconciliation; called once at daemon start (src/daemon.ts).
export function watchItsa(): void {
  onItsaChange((c) => syncItsa(c.itsa.id));
}

// ---- subscriptions stam makes for a process's start nodes (S-947) ----
//
// One per trigger, subscriber `process:PROCESS:NODE`, created as stam. A matching event is handed to
// the handler the runner registers instead of being delivered as mail.

let processStart: ((subscriberId: string, ev: ExtEvent) => void) | undefined;
export function onProcessStart(fn: (subscriberId: string, ev: ExtEvent) => void): void {
  processStart = fn;
}

export interface StartSubscription {
  subscriber_id: string;
  filter: EventFilter;
  note: string;
}

// Makes stam's process subscriptions match `wanted`: idempotent, so it runs at daemon start and again
// whenever the process files change. A row whose subscriber and filter are no longer wanted is dropped.
export function syncProcessSubscriptions(wanted: StartSubscription[]): void {
  const key = (id: string, f: EventFilter) => `${id}\n${JSON.stringify(f)}`;
  const want = new Map(wanted.map((w) => [key(w.subscriber_id, w.filter), w]));
  const have = new Set<string>();
  const rows = db.open().prepare("SELECT * FROM event_subscriptions WHERE subscriber_kind = 'process' AND created_by = ?").all(STAM) as unknown as Row[];
  for (const sub of rows.map(parse)) {
    const k = key(sub.subscriber_id, sub.filter);
    if (want.has(k) && !have.has(k)) have.add(k);
    else dropSubscription(sub.id);
  }
  for (const [k, w] of want) {
    if (have.has(k)) continue;
    insertSubscription({ id: newId(), subscriber_kind: 'process', subscriber_id: w.subscriber_id, filter: w.filter, created_by: STAM, note: w.note, expires_at: null, last_mail_id: null, created_at: now() });
  }
}

// ---- event waits and polling demand ----

// The open event waits (src/waits.ts), whose filter is a subscription filter.
function openEventWaits(): db.Wait[] {
  return db.open().prepare("SELECT * FROM waits WHERE kind = 'event' AND agent_id IN (SELECT id FROM agents)").all() as unknown as db.Wait[];
}

function waitFilter(w: db.Wait): EventFilter {
  try {
    return sanitizeFilter((w.data ? JSON.parse(w.data) : {}).filter);
  } catch {
    return {};
  }
}

// Clears every open event wait the stored event fits, and gives its agent one notice with the
// event line. Called by ingest after storing a new event.
function clearEventWaits(ev: ExtEvent): void {
  for (const w of openEventWaits()) {
    if (!matchesFilter(waitFilter(w), ev)) continue;
    db.clearWait(w.id);
    queueNotice(w.agent_id, render('wait-event', { what: w.detail ?? 'an external event', event: eventLine(ev) }));
  }
}

// The distinct subject keys everything live watches: the subjects of unexpired subscriptions
// and of open event waits. The pollers (later changes) use it to know what to poll.
export function watchedSubjects(): string[] {
  const out = new Set<string>();
  // A start-node subscription is polled on the ITSA home daemon only: an instance is made there.
  const home = settings().itsa.home;
  const startsHere = !home || home === MACHINE;
  const gone = new Map<string, boolean>();
  for (const sub of liveSubscriptions()) {
    if (sub.subscriber_kind === 'process' && !startsHere) continue;
    if (sub.subscriber_kind === 'agent' && agentGone(sub.subscriber_id, gone)) continue;
    if (sub.subscriber_kind === 'itsa' && itsaOwnerGone(sub.subscriber_id, gone)) continue;
    // A glob (a verdict subscription's `github:OWNER/REPO#*`) names events to match, not a subject to poll.
    for (const s of sub.filter.subjects ?? []) if (sub.subscriber_kind !== 'process' || !s.includes('*')) out.add(s);
  }
  for (const w of openEventWaits()) {
    if (agentGone(w.agent_id, gone)) continue;
    for (const s of waitFilter(w).subjects ?? []) out.add(s);
  }
  return [...out].filter((s) => !prFinished(s));
}

// Whether an ITSA's link watches go unpolled (S-4356): its owner is an agent that is archived, shut down, or forgotten.
// An unowned ITSA, one the human owns, or one whose row can't be read keeps polling.
function itsaOwnerGone(itsaId: string, memo: Map<string, boolean>): boolean {
  let owner: string | null = null;
  try {
    const row = db.open().prepare('SELECT owner FROM itsas WHERE id = ?').get(itsaId) as { owner: string | null } | undefined;
    owner = row?.owner ?? null;
  } catch {
    return false;
  }
  if (!owner || owner === HUMAN) return false;
  return agentGone(owner, memo);
}

// Whether a pull request's final event is stored (S-4356): its watch state reads merged or closed, so nothing more is
// polled for it. A reopened PR is not seen again: the poll stopped at its close. A state that can't be read keeps polling.
function prFinished(subject: string): boolean {
  try {
    const row = db.getWatchState(subject);
    const state = row ? JSON.parse(row.state) : null;
    return state?.type === 'pr' && (state.state === 'merged' || state.state === 'closed');
  } catch {
    return false;
  }
}

// Whether an agent's watches go unpolled (S-4356): it is archived or shut down, here or on a peer the daemon knows the
// lifecycle of. An agent with no row here and no known lifecycle on a peer (a peer's agent this daemon hasn't heard of,
// or one forgotten) is not known to be gone, so its watch keeps polling. The subscriptions stay, so a resumed agent gets
// its watch back. A row that can't be read is not gone either.
function agentGone(id: string, memo: Map<string, boolean>): boolean {
  const known = memo.get(id);
  if (known !== undefined) return known;
  let gone = false;
  try {
    const local = db.open().prepare('SELECT lifecycle FROM agents WHERE id = ?').get(id) as { lifecycle: string } | undefined;
    const life = local ? local.lifecycle : (db.open().prepare('SELECT lifecycle FROM peer_agents WHERE id = ?').get(id) as { lifecycle: string | null } | undefined)?.lifecycle;
    gone = life === 'archived' || life === 'shut_down';
  } catch {
    gone = false;
  }
  memo.set(id, gone);
  return gone;
}

// ---- delivery, with bursts folded ----

interface Buffered {
  sub: Subscription;
  lines: string[];
  timer: NodeJS.Timeout;
  // An ending event is in the batch: the subscription is already gone.
  ended: boolean;
  // A failure event is in the batch: the agent's copy gets the failure retro reminder (S-726).
  failed: boolean;
}
const buffered = new Map<string, Buffered>();

// One line per event: its summary and where to look.
function eventLine(ev: ExtEvent): string {
  const where = [ev.actor ? `by ${ev.actor}` : '', ev.url ?? ''].filter(Boolean).join(' · ');
  return `- [${ev.source}] ${ev.type}: ${ev.summary}${where ? ` — ${where}` : ''}`;
}

// Whether an event is a failure the agent should record a retro about (S-726): a red check or
// gate on its pull request, a changes-requested review, or a deploy that stopped on it. The
// delivery carries only the event's type and one-line summary, so this reads those; the deploy
// stop is the watcher's comment on the PR. Add the reminder only to the agent's own delivery
// (`deliver`, subscriber_kind 'agent'), never to an ITSA's, where its manager hears it.
export function isFailureEvent(ev: Pick<ExtEvent, 'source' | 'type' | 'summary'>): boolean {
  if (ev.source !== 'github') return false;
  if (ev.type === 'checks.completed') return /checks failed/.test(ev.summary);
  if (ev.type === 'review.submitted') return /\(changes requested\)/.test(ev.summary);
  if (ev.type === 'comment.created') return /Deploy of \S+ stopped:/.test(ev.summary);
  return false;
}

function enqueue(sub: Subscription, ev: ExtEvent, ends = false): void {
  const line = eventLine(ev);
  const failed = isFailureEvent(ev);
  const current = buffered.get(sub.id);
  if (current) {
    current.lines.push(line);
    if (ends) current.ended = true;
    if (failed) current.failed = true;
    return;
  }
  const ms = foldMs();
  const timer = setTimeout(() => void flushOne(sub.id), ms);
  timer.unref?.();
  buffered.set(sub.id, { sub, lines: [line], timer, ended: ends, failed });
  if (ms === 0) void flushOne(sub.id);
}

async function flushOne(id: string): Promise<void> {
  const b = buffered.get(id);
  if (!b) return;
  clearTimeout(b.timer);
  buffered.delete(id);
  try {
    await deliver(b.sub, b.lines, b.ended, b.failed);
  } catch {
    // A delivery failure (a subscriber gone, a peer down) must not break the source that
    // posted the event.
  }
}

// Delivers every folded batch now, instead of waiting for its timer. Tests call this.
export async function flush(): Promise<void> {
  for (const id of [...buffered.keys()]) await flushOne(id);
}

// The batch's subject, from the subscription.
function subjectFor(sub: Subscription, n: number): string {
  const what = sub.note ?? sub.filter.source ?? 'external';
  return `[stam] ${n} ${what} event${n === 1 ? '' : 's'}`;
}

function bodyFor(intro: string, lines: string[]): string {
  return render('event-notice', { intro, events: lines.join('\n') });
}

async function deliver(sub: Subscription, lines: string[], ended = false, failed = false): Promise<void> {
  const n = lines.length;
  const subject = subjectFor(sub, n);
  if (sub.subscriber_kind === 'agent') {
    const intro = ended
      ? `New events for your subscription${sub.note ? ` (${sub.note})` : ''}. It ended with these, so there is nothing to unsubscribe.`
      : `New events for your subscription${sub.note ? ` (${sub.note})` : ''}. Manage it with \`list_subscriptions\` and \`unsubscribe ${sub.id}\`.`;
    // A failure in the batch marks it for a retro (S-726); only this agent's copy, not an ITSA's.
    const body = failed ? withFailureRetro(bodyFor(intro, lines)) : bodyFor(intro, lines);
    const a = db.getAgent(sub.subscriber_id);
    if (a && a.lifecycle === 'active' && a.activity === 'working') queueNotice(a.id, body);
    else await sendFromSystem('watch', [sub.subscriber_id], subject, body);
    return;
  }
  if (sub.subscriber_kind === 'human') {
    const body = bodyFor('You asked to hear about these events.', lines);
    // One thread per subscription: the first delivery starts it, later ones reply into it.
    const mail = await sendMail({ from: '', system: 'watch', to: [HUMAN], subject, body, reply_to: sub.last_mail_id ?? undefined, new_thread: !sub.last_mail_id });
    db.open().prepare('UPDATE event_subscriptions SET last_mail_id = ? WHERE id = ?').run(mail.id, sub.id);
    return;
  }
  // An ITSA: a quiet post into its thread, as stam, for its agents only (S-511). `by: HUMAN` on the
  // routed call only authorizes the peer request; the post itself is stam's.
  const body = bodyFor('Events you asked to hear about.', lines);
  const x = findItsa(sub.subscriber_id);
  if (!x) return;
  if (settings().itsa.home === MACHINE) await itsaPost(x.id, { from_stam: true, agents_only: true, body, kind: 'comment' });
  else await itsaPostRouted(x.id, { from_stam: true, by: HUMAN, agents_only: true, body, kind: 'comment' });
}
