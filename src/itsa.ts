// ITSAs: stam's issue management. One nestable type, the ITSA (ITS-artifact): initiative,
// project, milestone, issue, and sub-issue are only a `kind` label, and any ITSA can hold
// any other, to any depth. Statuses come from settings.itsa.statuses (each in one of five
// fixed categories, some flagged as waiting on the human); readable keys like `S-42` from
// settings.itsa.keyPrefix and one counter. Every ITSA lives on one home daemon
// (settings.itsa.home); other daemons proxy to it. See docs/itsa-design.md.
import { randomBytes } from 'node:crypto';
import * as db from './db.ts';
import { settings } from './settings.ts';
import { basename } from 'node:path';
import { readFileSync } from 'node:fs';
import { HUMAN, humanMailBlock, sendMail, stamSender, type Attachment, type SentMail } from './mail.ts';
import { findAgentPeer, locateAgent, peerByName, peerCall, type Via } from './peers.ts';
import { itsaRefusal, mayPostItsa } from './mail-visibility.ts';
import { MACHINE } from './config.ts';
// Named apart from this file's own `events` (an ITSA's event log).
import * as streamEvents from './events.ts';

export type Category = 'backlog' | 'ready' | 'active' | 'review' | 'closed';
// Board columns and roll-up buckets, in order.
export const CATEGORIES: Category[] = ['backlog', 'ready', 'active', 'review', 'closed'];

export interface Status {
  name: string;
  category: Category;
  human: boolean;
}

export interface HumanAction {
  id: string;
  label: string;
  to: string;
  text: 'none' | 'optional' | 'required';
}

export interface Itsa {
  id: string;
  key: string;
  parent_id: string | null;
  kind: string | null;
  title: string;
  summary: string | null;
  body: string | null;
  status: string;
  owner: string | null;
  thread_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  // Its place in a board column, lower first; null sorts by creation time (web/src/itsa/Board.tsx).
  rank: number | null;
}

export interface ItsaLink {
  n: number;
  system: string;
  external_id: string | null;
  url: string;
  // A branch link's repo and recorded facts (S-40); null for other kinds.
  meta?: LinkMeta | null;
}

// A branch link's record (S-40): the repo it names (a name in settings.itsa.repos), and the
// review, tests, and screenshots recorded with `recordLink`.
export interface LinkMeta {
  repo?: string;
  review?: { verdict: string; by: string; summary: string | null; at: string };
  tests?: { passed: number; failed: number; skipped: number; command: string | null; at: string };
  screenshots?: { mail_id: string; name: string }[];
}
export const LINK_VERDICTS = ['approve', 'request_changes', 'comment'];
function parseMeta(raw: unknown): LinkMeta | null {
  if (!raw) return null;
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return v && typeof v === 'object' ? (v as LinkMeta) : null;
  } catch {
    return null;
  }
}
const linkOut = (r: { n: number; system: string; external_id: string | null; url: string; meta?: unknown }): ItsaLink =>
  ({ n: r.n, system: r.system, external_id: r.external_id, url: r.url, meta: parseMeta(r.meta) });

export type Rollup = Record<Category, number>;
export const emptyRollup = (): Rollup => ({ backlog: 0, ready: 0, active: 0, review: 0, closed: 0 });

export interface ItsaChild extends Itsa {
  rollup: Rollup;
}

// One ITSA as `get` returns it: the row, its participants and links, its chain of
// ancestors (root first), the roll-up of its direct children, and each child with the
// roll-up of its own children.
export interface ItsaView extends Itsa {
  participants: string[];
  links: ItsaLink[];
  parent_chain: { id: string; key: string; title: string; status: string }[];
  rollup: Rollup;
  children: ItsaChild[];
  // The latest activity (status, owner, and field changes), oldest first, for the web UI.
  events: ReturnType<typeof events>;
  // What the human can do to it now (empty unless its status waits on them).
  actions: HumanAction[];
  // Field values by field key (S-364).
  fields: Record<string, unknown>;
}

const now = () => new Date().toISOString();

// The editable status set from settings, keeping only the five known categories.
export function statuses(): Status[] {
  return settings()
    .itsa.statuses.filter((s) => CATEGORIES.includes(s.category as Category))
    .map((s) => ({ name: s.name, category: s.category as Category, human: Boolean(s.human) }));
}

export function statusOf(name: string): Status | undefined {
  return statuses().find((s) => s.name === name);
}

// Whether a status name is in the closed category: a closed ITSA hears no more events and
// keeps no link subscriptions (src/watch.ts).
export function isClosedStatus(status: string | null | undefined): boolean {
  return !!status && statusOf(status)?.category === 'closed';
}

// What the human can do to an ITSA in this status: none unless it waits on them. A human
// status the settings list no actions for gets Approve (to the first closed status) and
// Request changes (back to in_progress). Actions that move to an unknown status are left out.
export function actionsOf(status: string): HumanAction[] {
  const st = statusOf(status);
  if (!st?.human) return [];
  const listed = settings().itsa.actions[status];
  const fallback: HumanAction[] = [
    { id: 'approve', label: 'Approve', to: statuses().find((s) => s.category === 'closed')?.name ?? 'done', text: 'optional' },
    { id: 'changes', label: 'Request changes', to: 'in_progress', text: 'required' },
  ];
  return (listed ?? fallback).filter((a) => statusOf(a.to));
}

// New ITSAs start in `backlog` when it exists, else the first configured status.
function defaultStatus(): string {
  const all = statuses();
  return all.find((s) => s.name === 'backlog')?.name ?? all[0]?.name ?? 'backlog';
}

// An owner or participant: an agent id or name, or `human`, canonicalized to an id.
// Agents on another machine resolve through the peers, as mail resolves remote
// recipients, so the home daemon can store and edit an ITSA owned by a remote agent.
export async function person(ref: unknown): Promise<string | null> {
  if (ref === null || ref === undefined) return null;
  const s = String(ref).trim();
  if (!s) return null;
  if (s === HUMAN || s.toLowerCase() === 'the human') return HUMAN;
  const local = db.getAgent(s);
  if (local) return local.id;
  const found = await findAgentPeer(s);
  if (found) return found.agent.id;
  throw new Error(`no agent ${s} (pass an agent id or name, or 'human')`);
}

// `S-42`: one durable counter, independent of the display prefix. A prefix may contain a
// hyphen (`TEAM-S`), so the counter can't be read back from the keys themselves. On first
// use it seeds from any existing keys' numeric suffixes.
function nextKey(): string {
  const d = db.open();
  let row = d.prepare("SELECT value FROM itsa_counter WHERE name = 'key'").get() as { value: number } | undefined;
  if (!row) {
    let max = 0;
    for (const r of d.prepare('SELECT key FROM itsas').all() as { key: string }[]) {
      const m = /-(\d+)$/.exec(r.key);
      if (m) max = Math.max(max, Number(m[1]));
    }
    d.prepare("INSERT OR REPLACE INTO itsa_counter (name, value) VALUES ('key', ?)").run(max);
    row = { value: max };
  }
  const n = row.value + 1;
  d.prepare("UPDATE itsa_counter SET value = ? WHERE name = 'key'").run(n);
  return `${settings().itsa.keyPrefix}-${n}`;
}

// One whole mutation — row, participants, links, and events — commits together or not at
// all, so a value rejected mid-way (an unknown participant, a link with no url) leaves no
// partial write. Resume on the same synchronous connection; never nested here.
function tx<T>(fn: () => T): T {
  const d = db.open();
  d.exec('BEGIN');
  try {
    const out = fn();
    d.exec('COMMIT');
    return out;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

function newId(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  return 'i' + [...randomBytes(4)].map((b) => alphabet[b % alphabet.length]).join('');
}

export function find(ref: string): Itsa | undefined {
  return db.open().prepare('SELECT * FROM itsas WHERE id = ? OR key = ?').get(ref, ref) as Itsa | undefined;
}

// The id of the ITSA a key or id names, or null: looked up here when this daemon is the ITSA
// home, else asked of the home over the peer link (mail `itsa`, S-91).
export async function idOf(ref: string): Promise<string | null> {
  const home = settings().itsa.home ?? MACHINE;
  if (home === MACHINE) return find(ref)?.id ?? null;
  const peer = peerByName(home);
  if (!peer) throw new Error(`ITSA home '${home}' is not a configured peer`);
  const r = await peerCall(peer, 'GET', `/api/itsas/${encodeURIComponent(ref)}`);
  return r.status === 200 ? String(r.data?.id ?? '') || null : null;
}

export function must(ref: string): Itsa {
  const x = find(ref);
  if (!x) throw new Error(`no ITSA ${ref}`);
  return x;
}

export function participants(ref: string): string[] {
  const x = must(ref);
  return (db.open().prepare('SELECT agent_id FROM itsa_participants WHERE itsa_id = ? ORDER BY agent_id').all(x.id) as { agent_id: string }[]).map((r) => r.agent_id);
}

// The open ITSAs with a link of `system` to `url`, newest link first (the process runner finds a PR's ITSAs with it).
export function openItsasByLink(system: string, url: string): Itsa[] {
  const ids = db.open().prepare('SELECT itsa_id FROM itsa_links WHERE system = ? AND url = ? ORDER BY n DESC').all(system, url) as { itsa_id: string }[];
  return [...new Set(ids.map((r) => r.itsa_id))].map((id) => find(id)).filter((x): x is Itsa => !!x && !isClosedStatus(x.status));
}

export function links(ref: string): ItsaLink[] {
  const x = must(ref);
  return (db.open().prepare('SELECT n, system, external_id, url, meta FROM itsa_links WHERE itsa_id = ? ORDER BY n').all(x.id) as any[]).map(linkOut);
}

export function events(ref: string, limit = 200): { id: number; ts: string; actor: string | null; type: string; data: string | null }[] {
  const x = must(ref);
  return db
    .open()
    .prepare('SELECT id, ts, actor, type, data FROM itsa_events WHERE itsa_id = ? ORDER BY id DESC LIMIT ?')
    .all(x.id, limit)
    .reverse() as unknown as { id: number; ts: string; actor: string | null; type: string; data: string | null }[];
}

// When the ITSA last changed status: its latest status event, else its creation. `skip` counts
// back past that many status events (1: the change before the latest).
export function statusSince(x: Itsa, skip = 0): string {
  const e = db.open().prepare("SELECT ts FROM itsa_events WHERE itsa_id = ? AND type = 'status' ORDER BY id DESC LIMIT 1 OFFSET ?").get(x.id, skip) as { ts: string } | undefined;
  return e?.ts ?? x.created_at;
}

// Whether `by` left a comment or update on the ITSA since its last status change.
export function commentedSince(x: Itsa, by: string): boolean {
  if (!x.thread_id) return false;
  const since = statusSince(x);
  return db.threadMail(x.thread_id).some((m) => m.from_id === by && (m.kind === 'comment' || m.kind === 'update') && m.created_at >= since);
}

export function addEvent(itsaId: string, actor: string | null, type: string, data?: unknown): void {
  db.open()
    .prepare('INSERT INTO itsa_events (itsa_id, ts, actor, type, data) VALUES (?, ?, ?, ?, ?)')
    .run(itsaId, now(), actor, type, data === undefined ? null : JSON.stringify(data));
}

function setParticipants(itsaId: string, ids: string[]): void {
  const d = db.open();
  d.prepare('DELETE FROM itsa_participants WHERE itsa_id = ?').run(itsaId);
  const ins = d.prepare('INSERT OR IGNORE INTO itsa_participants (itsa_id, agent_id) VALUES (?, ?)');
  for (const a of ids) ins.run(itsaId, a);
}

export function ensureParticipant(itsaId: string, who: string): void {
  db.open().prepare('INSERT OR IGNORE INTO itsa_participants (itsa_id, agent_id) VALUES (?, ?)').run(itsaId, who);
}

// Counts of an ITSA's direct children by category, for its roll-up bar.
export function rollupOf(id: string): Rollup {
  const rows = db.open().prepare('SELECT status, COUNT(*) AS n FROM itsas WHERE parent_id = ? GROUP BY status').all(id) as { status: string; n: number }[];
  const out = emptyRollup();
  for (const r of rows) {
    const s = statusOf(r.status);
    if (s) out[s.category] += r.n;
  }
  return out;
}

interface NewLink {
  system?: string | null;
  external_id?: string | null;
  url: string;
  repo?: string | null;
}

// Normalizes a link and refuses a missing url, before any write (see create/set).
// A branch name git accepts here: no leading dash (it would read as an option), no '..'.
export const validBranch = (b: string) => /^[A-Za-z0-9._/-]+$/.test(b) && !b.startsWith('-') && !b.includes('..');
// A branch link needs its branch (external_id) and repo; its url is optional and stored empty.
function validateLink(l: NewLink): { system: string; external_id: string | null; url: string; meta: LinkMeta | null } {
  const system = String(l.system ?? '').trim() || 'url';
  const external_id = l.external_id ? String(l.external_id) : null;
  if (system === 'branch') {
    const repo = String(l.repo ?? '').trim();
    if (!external_id) throw new Error('a branch link needs its branch name (external_id)');
    if (!validBranch(external_id)) throw new Error(`a branch name is letters, digits, . _ / and -, not starting with -: ${external_id}`);
    if (!repo) throw new Error('a branch link needs its repo: a name from settings.itsa.repos');
    if (repo.startsWith('/') || repo.includes('\\')) throw new Error(`a branch link names its repo by a name in settings.itsa.repos, not a path: ${repo}`);
    if (!settings().itsa.repos[repo]) throw new Error(`unknown repo ${repo}: add it to settings.itsa.repos`);
    return { system, external_id, url: String(l.url ?? '').trim(), meta: { repo } };
  }
  const url = String(l.url ?? '').trim();
  if (!url) throw new Error('a link needs a url');
  return { system, external_id, url, meta: null };
}

function addLinkRow(itsaId: string, l: { system: string; external_id: string | null; url: string; meta: LinkMeta | null }): ItsaLink {
  const n = ((db.open().prepare('SELECT MAX(n) AS n FROM itsa_links WHERE itsa_id = ?').get(itsaId) as { n: number | null }).n ?? 0) + 1;
  const meta = l.meta ? JSON.stringify(l.meta) : null;
  db.open().prepare('INSERT INTO itsa_links (itsa_id, n, system, external_id, url, meta) VALUES (?, ?, ?, ?, ?, ?)').run(itsaId, n, l.system, l.external_id, l.url, meta);
  return { n, system: l.system, external_id: l.external_id, url: l.url, meta: l.meta };
}

// A refusal for who the caller is, not for what it sent: the HTTP layer answers 403.
export class ForbiddenError extends Error {}

export interface CreateInput {
  parent?: string | null;
  kind?: string | null;
  title: string;
  summary?: string | null;
  body?: string | null;
  status?: string;
  owner?: string | null;
  participants?: (string | null)[];
  links?: { system?: string | null; external_id?: string | null; url: string; repo?: string | null }[];
  // The mail thread the ITSA owns; `post` creates it with the first comment or update.
  thread_id?: string | null;
  // Field values by field key (S-364), validated as `set` does.
  fields?: Record<string, unknown>;
  // Who acts: an agent id or name, or the human.
  by?: string | null;
}

export async function create(input: CreateInput): Promise<Itsa> {
  // Validate and resolve everything first; nothing touches the database until all of it
  // passes, and then the whole insert runs in one transaction.
  const title = String(input.title ?? '').trim();
  if (!title) throw new Error('an ITSA needs a title');
  const status = input.status ? String(input.status) : defaultStatus();
  const st = statusOf(status);
  if (!st) throw new Error(`unknown status ${status}; statuses: ${statuses().map((s) => s.name).join(', ')}`);
  const owner = await person(input.owner);
  const by = (await person(input.by)) ?? HUMAN;
  const people = (await Promise.all((input.participants ?? []).map(person))).filter((p): p is string => !!p);
  if (owner) people.push(owner);
  const participants = [...new Set(people)];
  const links = (input.links ?? []).map((l) => validateLink(l));
  if (st.human && by !== HUMAN) {
    const blocked = await humanMailBlock(by);
    if (blocked) throw new Error(`${title} can't be created as ${status}: it would mail your user, and ${blocked.model} may not (Settings › Mail to you). Hand it to your parent${blocked.parent ? ` (${blocked.parent})` : ''} with itsa_post or send_mail; it decides.`);
  }
  const parent_id = input.parent ? must(String(input.parent)).id : null;
  runGuards(null, { kind: input.kind ? String(input.kind) : null, status: st.name, body: input.body, parent_id, created_by: by }, by);
  const id = newId();
  const t = now();
  let createdFields: { from: Record<string, unknown>; to: Record<string, unknown> } | null = null;
  const created = tx(() => {
    const key = nextKey();
    db.open()
      .prepare(
        `INSERT INTO itsas (id, key, parent_id, kind, title, summary, body, status, owner, thread_id, created_by, created_at, updated_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, key, parent_id,
        input.kind ? String(input.kind) : null,
        title,
        input.summary != null ? String(input.summary) : null,
        input.body != null ? String(input.body) : null,
        status, owner, input.thread_id ?? null, by, t, t,
        st.category === 'closed' ? t : null,
      );
    setParticipants(id, participants);
    for (const l of links) addLinkRow(id, l);
    addEvent(id, by, 'created', { key, title, status });
    if (input.fields !== undefined) {
      createdFields = applyFieldValues(id, input.fields, by);
      if (createdFields) addEvent(id, by, 'fields', createdFields);
    }
    return find(id)!;
  });
  for (const fn of observers) fn({ type: 'created', itsa: created, actor: by });
  const cf = createdFields as { from: Record<string, unknown>; to: Record<string, unknown> } | null;
  if (cf) for (const fn of observers) fn({ type: 'fields', itsa: created, actor: by, from: cf.from, to: cf.to });
  if (created.owner) for (const fn of observers) fn({ type: 'owner', itsa: created, actor: by, to: created.owner });
  // Created straight into a status counts as entering it (from '': it had none before).
  for (const fn of statusHandlers) fn(created, by, '');
  streamEvents.emitEvent('itsa.changed', itsaEvent(created));
  return created;
}

export interface ListFilters {
  // Direct children of this ITSA; 'root' or 'none' lists the roots.
  parent?: string;
  // The root itself and every ITSA below it.
  subtree?: string;
  status?: string;
  category?: string;
  owner?: string;
  participant?: string;
  kind?: string;
  text?: string;
}

export async function list(f: ListFilters = {}): Promise<ListedItsa[]> {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.parent !== undefined) {
    if (f.parent === 'root' || f.parent === 'none' || f.parent === '') where.push('parent_id IS NULL');
    else {
      where.push('parent_id = ?');
      args.push(must(f.parent).id);
    }
  }
  if (f.subtree !== undefined) {
    const root = must(f.subtree).id;
    where.push(`id IN (WITH RECURSIVE d(id) AS (SELECT id FROM itsas WHERE id = ? UNION ALL SELECT i.id FROM itsas i JOIN d ON i.parent_id = d.id) SELECT id FROM d)`);
    args.push(root);
  }
  if (f.status !== undefined) {
    where.push('status = ?');
    args.push(String(f.status));
  }
  if (f.category !== undefined) {
    const names = statuses().filter((s) => s.category === f.category).map((s) => s.name);
    if (!names.length) return [];
    where.push(`status IN (${names.map(() => '?').join(', ')})`);
    args.push(...names);
  }
  if (f.owner !== undefined) {
    const o = await person(f.owner);
    if (o) {
      where.push('owner = ?');
      args.push(o);
    }
  }
  if (f.participant !== undefined) {
    const p = await person(f.participant);
    if (p) {
      where.push('id IN (SELECT itsa_id FROM itsa_participants WHERE agent_id = ?)');
      args.push(p);
    }
  }
  if (f.kind !== undefined) {
    where.push('kind = ?');
    args.push(String(f.kind));
  }
  if (f.text !== undefined && String(f.text).trim()) {
    const like = `%${String(f.text).trim()}%`;
    where.push('(key LIKE ? OR title LIKE ? OR summary LIKE ? OR body LIKE ?)');
    args.push(like, like, like, like);
  }
  const sql = `SELECT * FROM itsas ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at`;
  return withCardFacts(db.open().prepare(sql).all(...args) as unknown as Itsa[]);
}

// What a board card and the Work page show beyond the row: its links, the health of the
// owner's latest update, and its participants. Three queries for the whole list, not three
// per ITSA.
export type ListedItsa = Itsa & { links: ItsaLink[]; health: string | null; participants: string[]; fields: Record<string, unknown> };
function withCardFacts(rows: Itsa[]): ListedItsa[] {
  if (!rows.length) return [];
  const d = db.open();
  const linksBy = new Map<string, ItsaLink[]>();
  for (const l of d.prepare('SELECT itsa_id, n, system, external_id, url, meta FROM itsa_links ORDER BY itsa_id, n').all() as any[]) {
    const { itsa_id, ...link } = l;
    linksBy.set(itsa_id, [...(linksBy.get(itsa_id) ?? []), linkOut(link)]);
  }
  const health = new Map<string, string>();
  for (const m of d.prepare("SELECT itsa_id, health FROM mail WHERE kind = 'update' AND itsa_id IS NOT NULL AND health IS NOT NULL ORDER BY created_at").all() as { itsa_id: string; health: string }[])
    health.set(m.itsa_id, m.health);
  const people = new Map<string, string[]>();
  for (const p of d.prepare('SELECT itsa_id, agent_id FROM itsa_participants ORDER BY itsa_id, agent_id').all() as { itsa_id: string; agent_id: string }[])
    people.set(p.itsa_id, [...(people.get(p.itsa_id) ?? []), p.agent_id]);
  const values = fieldValuesByItsa();
  return rows.map((x) => ({ ...x, links: linksBy.get(x.id) ?? [], health: health.get(x.id) ?? null, participants: people.get(x.id) ?? [], fields: values.get(x.id) ?? {} }));
}

// An ITSA's ancestors, its parent first, stopping at a loop.
export function ancestorsOf(x: Itsa): Itsa[] {
  const out: Itsa[] = [];
  const seen = new Set<string>([x.id]);
  for (let p = x.parent_id ? find(x.parent_id) : undefined; p && !seen.has(p.id); p = p.parent_id ? find(p.parent_id) : undefined) {
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

export function get(ref: string): ItsaView {
  const x = must(ref);
  const chain = ancestorsOf(x).reverse().map((p) => ({ id: p.id, key: p.key, title: p.title, status: p.status }));
  const kids = db.open().prepare('SELECT * FROM itsas WHERE parent_id = ? ORDER BY created_at').all(x.id) as unknown as Itsa[];
  return {
    ...x,
    participants: participants(x.id),
    links: links(x.id),
    parent_chain: chain,
    rollup: rollupOf(x.id),
    children: kids.map((c) => ({ ...c, rollup: rollupOf(c.id) })),
    events: events(x.id, 100),
    actions: actionsOf(x.status),
    fields: fieldValuesByItsa(x.id).get(x.id) ?? {},
  };
}

export interface SetInput {
  title?: string | null;
  summary?: string | null;
  body?: string | null;
  kind?: string | null;
  status?: string;
  owner?: string | null;
  // null (or '', 'none', 'root') makes it a root; a ref reparents it.
  parent?: string | null;
  participants?: (string | null)[];
  // Compare-and-set: refuse the whole change unless the current owner is this agent id (or
  // null). Checked inside the transaction that writes, so a concurrent change can't slip between.
  ifOwner?: string | null;
  // Compare-and-set on the status, like ifOwner: refuse unless the ITSA is in this status.
  ifStatus?: string;
  // Board order: a number, or null to fall back to creation order. Not an event.
  rank?: number | null;
  // The human action (itsa-human.ts) that made this status change, recorded as an `action` event
  // in the same transaction, since Approve and Request changes can move to the same status.
  action?: string;
  // Field values by field key (S-364); null clears one. Validated against the field's type.
  fields?: Record<string, unknown>;
}

// Changes any field, refusing a reparent that would create a cycle, and records each
// change in itsa_events. Returns the updated ITSA and what changed. Identity resolution
// (which may ask a peer) happens first; the row is then read and every change computed and
// committed inside one transaction, with no await in between, so a concurrent change can't
// be lost or make both write the same "from".
export async function set(ref: string, f: SetInput, by: string | null = null): Promise<{ itsa: Itsa; changes: Record<string, { from: unknown; to: unknown }> }> {
  // Resolve the actor, owner, and participants (each may live on a peer) before locking.
  const actor = isSystem(by) ? by : (await person(by)) ?? HUMAN;
  const owner = f.owner !== undefined ? await person(f.owner) : undefined;
  const resolvedParticipants = f.participants !== undefined ? [...new Set((await Promise.all((f.participants ?? []).map(person))).filter((p): p is string => !!p))] : undefined;

  // A move to a human status by an agent whose model may not mail the human is refused: its parent decides.
  const blockedMove = f.status !== undefined && actor !== HUMAN && !isSystem(actor) && statusOf(String(f.status))?.human ? await humanMailBlock(actor) : undefined;
  const out = tx(() => {
    const cur = must(ref);
    if (f.ifOwner !== undefined && cur.owner !== f.ifOwner) throw new Error(`owner changed: ${cur.key} is owned by ${cur.owner ?? 'nobody'}, not ${f.ifOwner ?? 'nobody'}`);
    if (f.ifStatus !== undefined && cur.status !== f.ifStatus) throw new Error(`status changed: ${cur.key} is ${cur.status} now, not ${f.ifStatus}`);
    // An agent whose model may not mail the human can't hand the ITSA to the human at all: its parent decides.
    if (blockedMove && String(f.status) !== cur.status) {
      const blocked = blockedMove;
      throw new Error(`${cur.key} can't move to ${f.status}: it would mail your user, and ${blocked.model} may not (Settings › Mail to you). Hand it to your parent${blocked.parent ? ` (${blocked.parent})` : ''} with itsa_post or send_mail; it decides.`);
    }
    // An agent that hands the ITSA to the human says what it did first: the mail carries that comment.
    if (f.status !== undefined && actor !== HUMAN && String(f.status) !== cur.status && statusOf(String(f.status))?.human && !commentedSince(cur, actor)) {
      throw new Error(`${cur.key} is moving to ${f.status}, which waits on your user: post a comment first with itsa_post (what you did and what you need), then set the status`);
    }
    const upd: Partial<Itsa> = {};
    const changes: Record<string, { from: unknown; to: unknown }> = {};

    if (f.title !== undefined) {
      const title = String(f.title ?? '').trim();
      if (!title) throw new Error('an ITSA needs a title');
      if (title !== cur.title) {
        upd.title = title;
        changes.title = { from: cur.title, to: title };
      }
    }
    if (f.summary !== undefined) {
      const summary = f.summary == null || String(f.summary) === '' ? null : String(f.summary);
      if (summary !== cur.summary) {
        upd.summary = summary;
        changes.summary = { from: cur.summary, to: summary };
      }
    }
    if (f.body !== undefined) {
      const body = f.body == null ? null : String(f.body);
      if (body !== cur.body) {
        upd.body = body;
        changes.body = { from: cur.body, to: body };
      }
    }
    if (f.kind !== undefined) {
      const kind = f.kind == null || String(f.kind) === '' ? null : String(f.kind);
      if (kind !== cur.kind) {
        upd.kind = kind;
        changes.kind = { from: cur.kind, to: kind };
      }
    }
    if (f.status !== undefined) {
      const st = statusOf(String(f.status));
      if (!st) throw new Error(`unknown status ${f.status}; statuses: ${statuses().map((s) => s.name).join(', ')}`);
      if (st.name !== cur.status) {
        upd.status = st.name;
        changes.status = { from: cur.status, to: st.name };
        // Closed tracks when it entered a closed status; leaving closed clears it.
        upd.closed_at = st.category === 'closed' ? (cur.closed_at ?? now()) : null;
      }
    }
    if (owner !== undefined && owner !== cur.owner) {
      upd.owner = owner;
      changes.owner = { from: cur.owner, to: owner };
    }
    if (f.rank !== undefined) {
      const rank = f.rank == null ? null : Number(f.rank);
      if (rank !== null && !Number.isFinite(rank)) throw new Error('rank must be a number');
      if (rank !== cur.rank) {
        upd.rank = rank;
        changes.rank = { from: cur.rank, to: rank };
      }
    }
    if (f.parent !== undefined) {
      let parentId: string | null = null;
      const raw = f.parent == null ? '' : String(f.parent);
      if (raw && raw !== 'none' && raw !== 'root') {
        const p = must(raw);
        if (p.id === cur.id) throw new Error('an ITSA cannot be its own parent');
        // Refuse a cycle: walk up from the new parent; it must not reach this ITSA.
        for (let n: Itsa | undefined = p, guard = new Set<string>(); n && !guard.has(n.id); n = n.parent_id ? find(n.parent_id) : undefined) {
          if (n.id === cur.id) throw new Error('reparenting would create a cycle');
          guard.add(n.id);
        }
        parentId = p.id;
      }
      if (parentId !== cur.parent_id) {
        upd.parent_id = parentId;
        changes.parent = { from: cur.parent_id, to: parentId };
      }
    }

    // Closing leaves the process at its end node (S-1398), in the same change as the status, unless the caller names a stage.
    let fieldValues = f.fields;
    if (changes.status && isClosedStatus(String(changes.status.to)) && !(fieldValues && 'stage' in fieldValues) && findField('stage')) {
      const end = closeStageOf?.(upd.kind !== undefined ? upd.kind : cur.kind);
      if (end) fieldValues = { ...(fieldValues ?? {}), stage: end };
    }
    if (fieldValues !== undefined) {
      const ch = applyFieldValues(cur.id, fieldValues, actor);
      if (ch) changes.fields = ch;
    }

    if (changes.kind || changes.status || changes.body || changes.parent || changes.fields) {
      const next = {
        kind: upd.kind !== undefined ? upd.kind : cur.kind,
        status: upd.status ?? cur.status,
        body: upd.body !== undefined ? upd.body : cur.body,
        parent_id: upd.parent_id !== undefined ? upd.parent_id : cur.parent_id,
        created_by: cur.created_by,
        ...(changes.fields ? { fields: changes.fields as { from: Record<string, unknown>; to: Record<string, unknown> } } : {}),
      };
      runGuards(cur, next, actor, !(changes.kind || changes.status || changes.body || changes.parent));
    }
    if (Object.keys(upd).length) {
      const keys = Object.keys(upd);
      db.open()
        .prepare(`UPDATE itsas SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...(keys.map((k) => (upd as Record<string, unknown>)[k] ?? null) as (string | number | null)[]), now(), cur.id);
    }

    const finalOwner = upd.owner !== undefined ? upd.owner : cur.owner;
    if (resolvedParticipants !== undefined) {
      const before = participants(cur.id);
      if (finalOwner && !resolvedParticipants.includes(finalOwner)) resolvedParticipants.push(finalOwner);
      if (JSON.stringify([...resolvedParticipants].sort()) !== JSON.stringify([...before].sort())) {
        setParticipants(cur.id, resolvedParticipants);
        changes.participants = { from: before, to: resolvedParticipants };
      }
    } else if (finalOwner) {
      ensureParticipant(cur.id, finalOwner);
    }

    // Reordering on a board isn't activity worth a line in the thread.
    for (const [field, ch] of Object.entries(changes)) if (field !== 'rank') addEvent(cur.id, actor, field, ch);
    if (f.action && changes.status) addEvent(cur.id, actor, 'action', { id: f.action, from: changes.status.from });
    return { itsa: find(cur.id)!, changes };
  });
  if (out.changes.status) {
    for (const fn of statusHandlers) fn(out.itsa, actor, String(out.changes.status.from));
    for (const fn of observers) fn({ type: 'status', itsa: out.itsa, actor, from: out.changes.status.from, to: out.changes.status.to });
  }
  if (out.changes.owner) for (const fn of observers) fn({ type: 'owner', itsa: out.itsa, actor, to: out.itsa.owner ?? null });
  // The text the search index reads (itsa-vectors.ts) changed.
  if (out.changes.title || out.changes.summary || out.changes.body) {
    for (const fn of observers) fn({ type: 'edit', itsa: out.itsa, actor });
  }
  if (out.changes.fields) {
    const { from, to } = out.changes.fields as { from: Record<string, unknown>; to: Record<string, unknown> };
    for (const fn of observers) fn({ type: 'fields', itsa: out.itsa, actor, from, to });
  }
  if (Object.keys(out.changes).length) streamEvents.emitEvent('itsa.changed', itsaEvent(out.itsa));
  return out;
}

// Adds one participant (an agent id or name, local or on a peer). Idempotent; records an
// event only when it actually adds, so the API and CLI can say what changed. A spawn with
// no `itsa` uses this to join its parent's open ITSA (itsa-owners.ts, step 10).
export async function addParticipant(ref: string, who: unknown, by: string | null = null): Promise<{ itsa: Itsa; added: boolean }> {
  const actor = (await person(by)) ?? HUMAN;
  const p = await person(who);
  if (!p) throw new Error('addParticipant needs a person (an agent id or name, or human)');
  return tx(() => {
    const x = must(ref);
    const before = participants(x.id);
    ensureParticipant(x.id, p);
    const added = !before.includes(p);
    if (added) addEvent(x.id, actor, 'participants', { from: before, to: [...before, p].sort() });
    return { itsa: find(x.id)!, added };
  });
}

// The agent ids in at least one open ITSA, as owner or participant, for the web tree's
// "not in any ITSA" mark. Not the whole set of participants: an ITSA whose status is closed
// is no longer a place to belong.
export function openAgentIds(): string[] {
  const closed = statuses().filter((s) => s.category === 'closed').map((s) => s.name);
  const notClosed = closed.length ? `status NOT IN (${closed.map(() => '?').join(', ')})` : '1';
  const rows = db
    .open()
    .prepare(
      `SELECT owner AS id FROM itsas WHERE owner IS NOT NULL AND ${notClosed}
       UNION
       SELECT agent_id AS id FROM itsa_participants WHERE itsa_id IN (SELECT id FROM itsas WHERE ${notClosed})`,
    )
    .all(...closed, ...closed) as { id: string }[];
  return rows.map((r) => r.id);
}

// Observers of committed changes, called after the transaction (decision steps, src/steps.ts).
export type ItsaChange =
  | { type: 'created'; itsa: Itsa; actor: string }
  | { type: 'status'; itsa: Itsa; actor: string; from: unknown; to: unknown }
  | { type: 'edit'; itsa: Itsa; actor: string }
  | { type: 'fields'; itsa: Itsa; actor: string; from: Record<string, unknown>; to: Record<string, unknown> }
  | { type: 'owner'; itsa: Itsa; actor: string; to: string | null }
  | { type: 'link'; itsa: Itsa; actor: string; action: 'added' | 'removed'; n: number };
const observers: ((c: ItsaChange) => void)[] = [];
export function onChange(fn: (c: ItsaChange) => void): void {
  observers.push(fn);
}

// Set by itsa-owners.ts and itsa-human.ts (which import this file) to tell a parent ITSA's
// owner and the human; `from` is the status it left ('' for an ITSA created in its status).
const statusHandlers: ((x: Itsa, actor: string, from: string) => void)[] = [];
export function onStatus(fn: (x: Itsa, actor: string, from: string) => void): void {
  if (!statusHandlers.includes(fn)) statusHandlers.push(fn);
}

// The actor a request names: `by`, which only a human request (x-stam-human) may set to the
// human, else the human for a human request, else null (the caller refuses it).
export function requestActor(by: unknown, human: boolean): string | null {
  if (by) {
    const b = String(by).trim();
    if (!human && (b === HUMAN || b.toLowerCase() === 'the human')) throw new Error('only your user acts as the human on an ITSA');
    if (isSystem(b)) throw new Error('a system sender is named with system, not by');
    return b;
  }
  return human ? HUMAN : null;
}

// A local script's ITSA actor (the deploy watcher, S-474): `system:NAME`, which no agent owns. The human's
// CLI sends it as `as_system` (stam itsa set --system NAME); see requestActor.
export function systemActor(name: unknown): string {
  const s = String(name ?? '');
  if (!/^[a-z][a-z-]{1,39}$/.test(s)) throw new Error(`bad system sender ${s}`);
  return `system:${s}`;
}
export const isSystem = (by: unknown): by is string => typeof by === 'string' && by.startsWith('system:');

// Checks run before a kind, status, body, or parent change commits, and before a create (with `cur` null): one
// that throws refuses it (retro-loop.ts: a proposal the human hasn't approved can't be applied).
// `next` is the ITSA as it would be after the change: its body, parent id, and creator, too.
export type ChangeGuard = (
  cur: Itsa | null,
  next: { kind: string | null; status: string; body?: string | null; parent_id?: string | null; created_by?: string | null; fields?: { from: Record<string, unknown>; to: Record<string, unknown> } },
  actor: string,
) => void;
const changeGuards: { fn: ChangeGuard; fields: boolean }[] = [];
// `fields: true` also runs the guard on a change that sets only field values (S-924); other guards keep
// running on kind, status, body, parent, and create changes alone.
export function guardChange(fn: ChangeGuard, opts: { fields?: boolean } = {}): void {
  if (!changeGuards.some((g) => g.fn === fn)) changeGuards.push({ fn, fields: opts.fields === true });
}
// The `stage` an ITSA of a kind takes when it closes (S-1398): the end node of its process, or null. The daemon sets it.
let closeStageOf: ((kind: string | null) => string | null) | null = null;
export function setCloseStage(fn: ((kind: string | null) => string | null) | null): void {
  closeStageOf = fn;
}

// One-off backfill (S-1398): every closed ITSA whose stage is set and isn't its process's end node gets the end node. Writes
// directly: no guard, no listener, no event, no mail. Runs once (recorded in `migrations`); returns the count, or null when
// it already ran. With no end node known for any kind it does nothing and is not recorded, so a later start can run it.
export function backfillClosedStage(endNodeOf: (kind: string | null) => string | null, kinds: (string | null)[]): number | null {
  const d = db.open();
  const name = 'closed-stage-done';
  if (d.prepare('SELECT 1 FROM migrations WHERE name = ?').get(name)) return null;
  const f = findField('stage');
  if (!f) return null;
  let n = 0;
  for (const kind of new Set(kinds)) {
    const end = endNodeOf(kind);
    if (!end) continue;
    const rows = d
      .prepare(
        `SELECT i.id, i.status, v.value FROM itsas i JOIN itsa_field_values v ON v.itsa_id = i.id AND v.field_id = ?
         WHERE i.kind IS ?`,
      )
      .all(f.id, kind) as { id: string; status: string; value: string }[];
    for (const r of rows) {
      if (!isClosedStatus(r.status)) continue;
      if (JSON.parse(r.value) === end) continue;
      const t = now();
      d.prepare('UPDATE itsa_field_values SET value = ?, updated_by = ?, updated_at = ? WHERE itsa_id = ? AND field_id = ?').run(JSON.stringify(end), 'system:migration', t, r.id, f.id);
      d.prepare('UPDATE itsas SET updated_at = ? WHERE id = ?').run(t, r.id);
      n++;
    }
  }
  d.prepare('INSERT INTO migrations (name, done_at) VALUES (?, ?)').run(name, new Date().toISOString());
  return n;
}

// A change a guard refused: the change is not allowed, unlike a failure to make it.
export class GuardRefusal extends Error {}
function runGuards(cur: Itsa | null, next: Parameters<ChangeGuard>[1], actor: string, fieldsOnly = false): void {
  for (const g of changeGuards) {
    if (fieldsOnly && !g.fields) continue;
    try {
      g.fn(cur, next, actor);
    } catch (e) {
      throw new GuardRefusal(e instanceof Error ? e.message : String(e));
    }
  }
}

export async function addLink(ref: string, link: NewLink, by: string | null = null): Promise<{ link: ItsaLink; itsa: Itsa }> {
  const actor = (await person(by)) ?? HUMAN;
  const l = validateLink(link);
  const out = tx(() => {
    const x = must(ref);
    const row = addLinkRow(x.id, l);
    addEvent(x.id, actor, 'link.added', row);
    return { link: row, itsa: find(x.id)! };
  });
  for (const fn of observers) fn({ type: 'link', itsa: out.itsa, actor, action: 'added', n: out.link.n });
  return out;
}

export async function removeLink(ref: string, n: number, by: string | null = null): Promise<Itsa> {
  const actor = (await person(by)) ?? HUMAN;
  const x = tx(() => {
    const itsa = must(ref);
    const r = db.open().prepare('DELETE FROM itsa_links WHERE itsa_id = ? AND n = ?').run(itsa.id, n);
    if (!r.changes) throw new Error(`no link ${n} on ${itsa.key}`);
    addEvent(itsa.id, actor, 'link.removed', { n });
    return find(itsa.id)!;
  });
  for (const fn of observers) fn({ type: 'link', itsa: x, actor, action: 'removed', n });
  return x;
}

// What an agent records on a branch link (S-40). Each field present replaces that part of the
// record; the recorder and the time are stamped here. Screenshots name attachments on mail
// that exists, so they can't point at nothing.
export interface LinkRecord {
  review?: { verdict: string; summary?: string | null };
  tests?: { passed?: number; failed?: number; skipped?: number; command?: string | null };
  screenshots?: { mail_id: string; name: string }[];
}
export function recordLink(ref: string, n: number, rec: LinkRecord, by: string | null = null): Promise<ItsaLink> {
  return (async () => {
    const actor = (await person(by)) ?? HUMAN;
    return tx(() => {
      const x = must(ref);
      const row = db.open().prepare('SELECT n, system, external_id, url, meta FROM itsa_links WHERE itsa_id = ? AND n = ?').get(x.id, n) as any;
      if (!row) throw new Error(`no link ${n} on ${x.key}`);
      if (row.system !== 'branch') throw new Error(`link ${n} on ${x.key} is a ${row.system} link, not a branch`);
      const meta: LinkMeta = { ...(parseMeta(row.meta) ?? {}) };
      const at = new Date().toISOString();
      const count = (v: unknown, what: string) => {
        const k = Number(v ?? 0);
        if (!Number.isInteger(k) || k < 0) throw new Error(`${what} must be a whole number, 0 or more`);
        return k;
      };
      if (rec.review !== undefined) {
        if (!LINK_VERDICTS.includes(rec.review.verdict)) throw new Error(`a review verdict is ${LINK_VERDICTS.join(', ')}`);
        meta.review = { verdict: rec.review.verdict, by: actor, summary: rec.review.summary ? String(rec.review.summary) : null, at };
      }
      if (rec.tests !== undefined) {
        const t = rec.tests;
        meta.tests = { passed: count(t.passed, 'passed'), failed: count(t.failed, 'failed'), skipped: count(t.skipped, 'skipped'), command: t.command ? String(t.command) : null, at };
      }
      if (rec.screenshots !== undefined) {
        if (!Array.isArray(rec.screenshots)) throw new Error('screenshots is a list of { mail_id, name }');
        meta.screenshots = rec.screenshots.map((s) => {
          if (!s?.mail_id || !s?.name) throw new Error('a screenshot names its mail_id and attachment name');
          if (!db.attachment(String(s.mail_id), String(s.name))) throw new Error(`no attachment ${s.name} on mail ${s.mail_id}`);
          return { mail_id: String(s.mail_id), name: String(s.name) };
        });
      }
      db.open().prepare('UPDATE itsa_links SET meta = ? WHERE itsa_id = ? AND n = ?').run(JSON.stringify(meta), x.id, n);
      return linkOut({ n, system: row.system, external_id: row.external_id, url: row.url, meta });
    });
  })();
}

export const HEALTHS = ['on_track', 'at_risk', 'off_track'];

export interface PostInput {
  // Who posts: an agent id or name (local or on a peer), or the human.
  by?: string | null;
  body: string;
  // `comment` (default) or `update`; an update needs a health.
  kind?: string | null;
  health?: string | null;
  // Recipients on top of the participants (ids or names).
  to?: string[];
  // The human's reply to decisions names only their askers: with it, the participants aren't added (S-2064). Honoured
  // from the human alone; `to` still adds whom the human names.
  only?: string[];
  // Those of `to` the sender didn't name (a reply's fan-out to the thread's people, mail.ts): each
  // is skipped like a gone participant rather than refused (S-603).
  inferred?: string[];
  subject?: string;
  attachments?: Attachment[];
  reply_to?: string;
  // A post stam makes on its own behalf (an event subscription): it stands in as sender
  // like mail.sendFromStam and is not added as a participant.
  from_stam?: boolean;
  // Event notices (S-511): the human is never a recipient, even as a participant; agents still get it.
  agents_only?: boolean;
  // The mail gate's override reason (S-983), for a post that reaches the human; see SendInput.override.
  override?: string;
}

// Whether a participant still gets an ITSA post. Dropped only when it is definitely gone:
// archived here or on the peer that answered, or unknown to every peer while all of them
// answered. A peer that is down or errors keeps the participant, so the send path or the
// outbox handles it (S-281), unless this daemon last saw it archived: the send path refuses
// those rather than queue them (S-603). A local agent costs no lookup.
async function deliverable(id: string): Promise<boolean> {
  if (id === HUMAN) return true;
  const local = db.getAgent(id);
  if (local) return local.lifecycle !== 'archived';
  const found = await locateAgent(id);
  if (typeof found === 'object') return found.agent.lifecycle !== 'archived';
  return found === 'unreachable' && db.peerAgentLifecycle(id) !== 'archived';
}

// An inferred recipient's id, or null when nobody has it any more: unlike person, a peer that
// doesn't answer doesn't refuse it when this daemon remembers it (S-603).
async function inferredPerson(ref: string): Promise<string | null> {
  if (ref === HUMAN || db.getAgent(ref)) return person(ref);
  return db.findPeerAgent(ref)?.id ?? (await person(ref).catch(() => null));
}

// True when `body` names this recipient as `@name` (or `@id`).
function mentions(body: string, names: string[]): boolean {
  return names.some((n) => n && new RegExp(`(^|[^\\w-])@${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i').test(body));
}

// Posts a comment or update into the ITSA's mail thread, creating the thread with the
// first post (subject `KEY Title`). Runs on the home daemon. Recipients are the
// participants minus the sender, plus any named in `to`; posting makes the sender a
// participant. The mail doesn't interrupt a working recipient unless it names them as
// `@name`, comes from the human, or comes from the ITSA's owner; the rest of it arrives
// with the idle batch. An agent's post reaches the human only when it names them in `to`.
//
// `opts.ask` posts stam's mail asking the human to act (kind `ask`): only the human gets it,
// and the sender doesn't become a participant.
export async function post(ref: string, input: PostInput, opts: { ask?: boolean } = {}): Promise<SentMail> {
  // Stam's own post stands in as an active agent (like mail.sendFromStam) and never joins
  // the ITSA as a participant; otherwise `by` is the agent or the human posting.
  const asStam = Boolean(input.from_stam);
  const by = asStam ? stamSender()?.id : isSystem(input.by) ? input.by : (await person(input.by)) ?? HUMAN;
  if (!by) throw new Error('no running agent to stand in as stam');
  const body = String(input.body ?? '');
  if (!body.trim()) throw new Error('a post needs a body');
  const kind = opts.ask ? 'ask' : input.kind ? String(input.kind) : 'comment';
  // Only stam's own ask (opts.ask) has kind ask: an agent's post naming it would skip the mail gate (S-983).
  if (kind !== 'comment' && kind !== 'update' && !(kind === 'ask' && opts.ask)) throw new Error(`unknown kind ${kind}; use comment or update`);
  let health: string | undefined;
  if (kind === 'update') {
    health = String(input.health ?? '');
    if (!HEALTHS.includes(health)) throw new Error(`an update needs a health: ${HEALTHS.join(', ')}`);
  } else if (input.health) throw new Error('only an update has a health');
  const guessed = new Set(input.inferred ?? []);
  const extra = (await Promise.all((input.to ?? []).filter((r) => !guessed.has(r)).map(person))).filter((p): p is string => !!p);
  // The sender of a remote agent's post is relayed: its id isn't in this registry.
  let remoteName: string | undefined;
  // A system sender (S-474) is no agent: it has no peer to look up, no mail block, and joins nothing.
  const sys = isSystem(by) ? by.slice('system:'.length) : undefined;
  if (by !== HUMAN && !sys && !db.getAgent(by)) remoteName = (await findAgentPeer(by))?.agent.name ?? by;

  const x = must(ref);
  // An agent whose model may not mail the human still comments in the thread; the human just isn't a recipient.
  const quiet = !asStam && !opts.ask && !sys && by !== HUMAN && Boolean(await humanMailBlock(by));
  // A participant that is gone (archived, forgotten, or unknown to every peer) is skipped: the post still lands for the rest (S-281).
  const live = [];
  const only = by === HUMAN ? input.only : undefined;
  for (const p of only ? [] : participants(x.id)) if (await deliverable(p)) live.push(p);
  // So is a recipient the sender didn't name, such as the web UI's reply to the thread's senders (S-603).
  for (const r of guessed) {
    const p = (input.to ?? []).includes(r) ? await inferredPerson(r) : null;
    if (p && (await deliverable(p))) live.push(p);
  }
  // An agent's comment never mails the human unless it names them: the move to a human status mails them once (itsa-human.ts).
  const toHuman = !input.agents_only && (asStam || opts.ask || by === HUMAN || extra.includes(HUMAN));
  const recipients = (opts.ask ? [HUMAN] : [...new Set([...live, ...extra])]).filter((p) => p !== by && !(quiet && p === HUMAN) && (p !== HUMAN || toHuman));
  const names = async (id: string) => (id === HUMAN ? [] : [id, db.getAgent(id)?.name ?? (await findAgentPeer(id))?.agent.name ?? '']);
  const everyone = by === HUMAN || by === x.owner;
  const interrupt: string[] = [];
  for (const r of recipients) if (everyone || mentions(body, await names(r))) interrupt.push(r);

  // Allocate the thread before sending, so two first posts can't start two threads.
  let threadId = x.thread_id;
  const first = !threadId;
  if (first) {
    threadId = db.newMailId();
    db.open().prepare('UPDATE itsas SET thread_id = ? WHERE id = ? AND thread_id IS NULL').run(threadId, x.id);
    threadId = must(x.id).thread_id!;
  }
  if (!asStam && !opts.ask && !sys) ensureParticipant(x.id, by);
  const root = `${x.key} ${x.title}`;
  // The thread stays once allocated, even if this delivery fails: some copies may already
  // be stored under it, and a second thread would orphan them.
  return sendMail({
    from: by,
    system: sys,
    to: recipients,
    // Only those named in `to` are refused when nobody can mail them; the rest are skipped (S-603).
    inferred: recipients.filter((p) => !extra.includes(p)),
    subject: input.subject || (first ? root : `Re: ${root}`),
    body,
    attachments: input.attachments,
    reply_to: input.reply_to,
    thread_id: threadId!,
    itsa_id: x.id,
    kind,
    health,
    interrupt,
    override: input.override,
    from_stam: asStam,
    ...(remoteName ? { forwarded: { from_name: remoteName }, relay: true } : {}),
  });
}

// `post` on this daemon when it is the ITSA home, else on the home over the peer link.
// Files named by path are read here and sent inline, since the home can't see this disk.
//
// `via` is the agent a reply in the thread comes from (mail.ts): it must be one the ITSA lets post
// (S-480), checked here at home, or by the home, which hears it as that agent's request.
export async function postRouted(ref: string, input: PostInput, via?: Via): Promise<SentMail> {
  const home = settings().itsa.home ?? MACHINE;
  if (home === MACHINE) {
    if (via && !via.boss && !mayPostItsa(via.agent, must(ref).id)) throw new ForbiddenError(itsaRefusal(via.agent, must(ref).id, 'post to'));
    return post(ref, input);
  }
  const peer = peerByName(home);
  if (!peer) throw new Error(`ITSA home '${home}' is not a configured peer`);
  const attachments = (input.attachments ?? []).map((a) => ({
    name: a.name ?? (a.path ? basename(a.path) : 'attachment.txt'),
    content_b64: a.content_b64 ?? (a.path ? readFileSync(a.path).toString('base64') : Buffer.from(a.content ?? '').toString('base64')),
  }));
  const r = await peerCall(peer, 'POST', `/api/itsas/${encodeURIComponent(ref)}/post`, { ...input, attachments }, 30_000, input.by === HUMAN, via);
  if (r.status === 403) throw new ForbiddenError(r.data?.error ?? `${home}: HTTP 403`);
  if (r.status !== 200) throw new Error(r.data?.error ?? `${home}: HTTP ${r.status}`);
  return r.data;
}

export interface ThreadEvent {
  type: 'event';
  ts: string;
  id: number;
  actor: string | null;
  event: string;
  text: string;
}

// One row per mail thread about an ITSA, for its view, newest activity first. The ITSA's own
// thread is left out (the view shows it). `unread` counts the messages the human hasn't read.
export interface AboutThread { thread_id: string; subject: string; participants: string[]; last_at: string; unread: number }
export function aboutThreads(groups: { thread_id: string; mails: db.ThreadMail[] }[], ownThread: string | null): AboutThread[] {
  return groups
    .filter((g) => g.mails.length && g.thread_id !== ownThread)
    .map(({ thread_id, mails }) => ({
      thread_id,
      subject: mails[0].subject,
      participants: [...new Set(mails.flatMap((m) => [m.from_id, ...m.recipients.map((r) => r.id)]))],
      last_at: mails.at(-1)!.created_at,
      unread: mails.filter((m) => m.recipients.some((r) => r.id === HUMAN && !r.read_at)).length,
    }))
    .sort((a, b) => b.last_at.localeCompare(a.last_at));
}

export type LinkedThread = db.LinkedThread;

// Linked threads (S-986) from this daemon and its peers as one list, newest first, at most `limit`. A thread on two
// daemons keeps its newest row and the larger count: a forwarded mail is stored on both.
export function mergeLinkedThreads(rows: db.LinkedThread[], limit: number): LinkedThread[] {
  const out = new Map<string, LinkedThread>();
  for (const r of rows) {
    const have = out.get(r.thread_id);
    if (!have) out.set(r.thread_id, { ...r });
    else {
      have.mails = Math.max(have.mails, r.mails);
      if (r.last_at > have.last_at) Object.assign(have, { ...r, mails: have.mails });
    }
  }
  return [...out.values()].sort((a, b) => b.last_at.localeCompare(a.last_at)).slice(0, limit);
}

// The ITSA's status and owner changes as one-line events, for showing in the thread.
// They are not mail: nobody is notified twice.
export function threadEvents(ref: string): ThreadEvent[] {
  const x = must(ref);
  const name = (id: unknown) => (id == null ? 'nobody' : id === HUMAN ? 'the human' : (db.getAgent(String(id))?.name ?? String(id)));
  const out: ThreadEvent[] = [];
  for (const e of events(x.id, 1000)) {
    if (e.type !== 'status' && e.type !== 'owner') continue;
    const d = e.data ? (JSON.parse(e.data) as { from: unknown; to: unknown }) : { from: null, to: null };
    const who = name(e.actor);
    const text = e.type === 'status' ? `${who} changed status from ${d.from} to ${d.to}` : `${who} changed owner from ${name(d.from)} to ${name(d.to)}`;
    out.push({ type: 'event', ts: e.ts, id: e.id, actor: e.actor, event: e.type, text });
  }
  return out;
}

// Mails of one thread, merged from the daemons that hold parts of it, plus the ITSA's
// events, by time. A mail stored on several daemons has one id (the sender's daemon
// forwards it), so copies fold by id and their recipients are joined.
export function mergeThread(mails: db.ThreadMail[], evts: ThreadEvent[]): ({ type: 'mail'; ts: string; mail: db.ThreadMail } | ThreadEvent)[] {
  const kept = db.foldMails(mails);
  return [...kept.map((mail) => ({ type: 'mail' as const, ts: mail.created_at, mail })), ...evts].sort((a, b) => a.ts.localeCompare(b.ts));
}

// ---- ITSA fields (S-364): shared column definitions and the values ITSAs hold ----

export const FIELD_TYPES = ['text', 'number', 'choice', 'link', 'date', 'check'] as const;
// The tone a choice option takes; the web maps each to a design token.
export const FIELD_TONES = ['ok', 'warn', 'bad', 'muted', 'accent'] as const;
export const FIELD_WIDTHS = ['s', 'm', 'l'] as const;
export const FIELD_ALIGNS = ['start', 'end'] as const;
export const FIELD_CARDS = ['chip', 'meta'] as const;

export interface FieldOption { value: string; label: string; tone: string | null }
export interface Field {
  id: string;
  key: string;
  label: string;
  type: (typeof FIELD_TYPES)[number];
  options: FieldOption[] | null;
  description: string | null;
  hint: string | null;
  width: (typeof FIELD_WIDTHS)[number];
  align: (typeof FIELD_ALIGNS)[number];
  card: (typeof FIELD_CARDS)[number];
  position: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

// Definition changes belong to no ITSA, so their events carry this pseudo id.
const FIELD_EVENTS = 'fields';

const fieldOut = (r: any): Field => ({ ...r, options: r.options ? JSON.parse(r.options) : null });

export function fields(): Field[] {
  return (db.open().prepare('SELECT * FROM itsa_fields ORDER BY position, created_at').all() as any[]).map(fieldOut);
}

export function findField(ref: string): Field | undefined {
  const r = db.open().prepare('SELECT * FROM itsa_fields WHERE id = ? OR key = ? ORDER BY id = ? DESC').get(ref, ref, ref);
  return r ? fieldOut(r) : undefined;
}

function mustField(ref: string): Field {
  const f = findField(String(ref));
  if (!f) throw new Error(`no field ${ref}`);
  return f;
}

// Whether the caller may define fields: the human always; while a chief of staff is set, only that
// agent; with none set, any agent. `by` is the verified actor (id or name), as for the other routes.
async function assertMayDefine(by: string | null | undefined): Promise<string> {
  const actor = (await person(by)) ?? HUMAN;
  if (actor === HUMAN) return actor;
  const cos = settings().chiefOfStaff;
  if (!cos) return actor;
  // The chief of staff may sit on another machine, so its name resolves through the peers.
  const cosId = await person(cos).catch(() => null);
  if (actor === cos || actor === cosId || by === cos) return actor;
  const who = db.getAgent(cos)?.name ?? cos;
  throw new ForbiddenError(`only the chief of staff (${who}) changes ITSA fields: mail ${who} to add, change, or remove a column`);
}

const oneOf = <T extends string>(list: readonly T[], v: unknown, what: string): T => {
  if (!list.includes(v as T)) throw new Error(`${what} must be one of: ${list.join(', ')}`);
  return v as T;
};

function checkOptions(raw: unknown): FieldOption[] {
  if (!Array.isArray(raw) || !raw.length) throw new Error('a choice field needs options: a list of { value, label, tone }');
  const seen = new Set<string>();
  return raw.map((o) => {
    const value = String(o?.value ?? '').trim();
    if (!value) throw new Error('every option needs a value');
    if (seen.has(value)) throw new Error(`duplicate option ${value}`);
    seen.add(value);
    const tone = o.tone == null || o.tone === '' ? null : oneOf(FIELD_TONES, o.tone, `option ${value}'s tone`);
    return { value, label: String(o.label ?? '').trim() || value, tone };
  });
}

// The stored form of a value for a field, or a thrown reason. null clears the value.
export function checkFieldValue(f: Pick<Field, 'key' | 'type' | 'options'>, v: unknown): unknown {
  if (v === null) return null;
  const bad = (why: string) => new Error(`field ${f.key} (${f.type}): ${why}`);
  switch (f.type) {
    case 'text':
      if (typeof v !== 'string') throw bad('expected a string');
      return v;
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) throw bad('expected a number');
      return v;
    case 'choice':
      if (typeof v !== 'string' || !f.options?.some((o) => o.value === v)) throw bad(`expected one of ${(f.options ?? []).map((o) => o.value).join(', ')}`);
      return v;
    case 'link': {
      let u: URL | undefined;
      try {
        u = typeof v === 'string' ? new URL(v) : undefined;
      } catch {}
      if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) throw bad('expected an http or https URL');
      return v;
    }
    case 'date':
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) !== v) throw bad('expected an ISO date (YYYY-MM-DD)');
      return v;
    case 'check':
      if (typeof v !== 'boolean') throw bad('expected true or false');
      return v;
  }
}

export interface FieldInput {
  key?: string;
  label?: string;
  type?: string;
  options?: unknown;
  description?: string | null;
  hint?: string | null;
  width?: string;
  align?: string;
  card?: string;
}

const optText = (v: unknown) => (v == null || String(v).trim() === '' ? null : String(v));

function checkKey(key: unknown, exceptId?: string): string {
  const k = String(key ?? '').trim();
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(k)) throw new Error('a field key is a slug: lowercase letters, digits, - and _, starting with a letter, up to 32 characters');
  const clash = db.open().prepare('SELECT id FROM itsa_fields WHERE key = ?').get(k) as { id: string } | undefined;
  if (clash && clash.id !== exceptId) throw new Error(`a field with key ${k} exists`);
  // A ref names an id before a key, so a key equal to another field's id would never be found.
  const asId = db.open().prepare('SELECT id FROM itsa_fields WHERE id = ?').get(k) as { id: string } | undefined;
  if (asId && asId.id !== exceptId) throw new Error(`key ${k} is another field's id`);
  return k;
}

export async function createField(input: FieldInput, by: string | null = null): Promise<Field> {
  const actor = await assertMayDefine(by);
  const label = String(input.label ?? '').trim();
  if (!label) throw new Error('a field needs a label');
  const type = oneOf(FIELD_TYPES, input.type, 'type');
  const options = type === 'choice' ? checkOptions(input.options) : null;
  if (type !== 'choice' && input.options != null) throw new Error('only a choice field has options');
  const width = input.width === undefined ? 'm' : oneOf(FIELD_WIDTHS, input.width, 'width');
  const align = input.align === undefined ? 'start' : oneOf(FIELD_ALIGNS, input.align, 'align');
  const card = input.card === undefined ? 'meta' : oneOf(FIELD_CARDS, input.card, 'card');
  return tx(() => {
    const d = db.open();
    const key = checkKey(input.key);
    const id = 'f' + newId().slice(1);
    const t = now();
    const position = ((d.prepare('SELECT MAX(position) AS m FROM itsa_fields').get() as { m: number | null }).m ?? -1) + 1;
    d.prepare('INSERT INTO itsa_fields (id, key, label, type, options, description, hint, width, align, card, position, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, key, label, type, options ? JSON.stringify(options) : null, optText(input.description), optText(input.hint), width, align, card, position, actor, t, t,
    );
    const created = mustField(id);
    addEvent(FIELD_EVENTS, actor, 'field_created', created);
    return created;
  });
}

// Changes any definition field but the id. A new type or option list must still hold every value
// already set; a key change must stay unique.
export async function updateField(ref: string, patch: FieldInput, by: string | null = null): Promise<Field> {
  const actor = await assertMayDefine(by);
  return tx(() => {
    const cur = mustField(ref);
    const next: Field = { ...cur };
    if (patch.key !== undefined) next.key = checkKey(patch.key, cur.id);
    if (patch.label !== undefined) {
      next.label = String(patch.label ?? '').trim();
      if (!next.label) throw new Error('a field needs a label');
    }
    if (patch.type !== undefined) next.type = oneOf(FIELD_TYPES, patch.type, 'type');
    if (patch.options !== undefined || next.type !== cur.type) {
      const raw = patch.options !== undefined ? patch.options : cur.options;
      if (next.type === 'choice') next.options = checkOptions(raw);
      else if (raw != null && patch.options !== undefined) throw new Error('only a choice field has options');
      else next.options = null;
    }
    if (patch.description !== undefined) next.description = optText(patch.description);
    if (patch.hint !== undefined) next.hint = optText(patch.hint);
    if (patch.width !== undefined) next.width = oneOf(FIELD_WIDTHS, patch.width, 'width');
    if (patch.align !== undefined) next.align = oneOf(FIELD_ALIGNS, patch.align, 'align');
    if (patch.card !== undefined) next.card = oneOf(FIELD_CARDS, patch.card, 'card');
    const d = db.open();
    if (next.type !== cur.type || JSON.stringify(next.options) !== JSON.stringify(cur.options)) {
      for (const r of d.prepare('SELECT itsa_id, value FROM itsa_field_values WHERE field_id = ?').all(cur.id) as { itsa_id: string; value: string }[]) {
        try {
          checkFieldValue(next, JSON.parse(r.value));
        } catch (e) {
          throw new Error(`${cur.key} can't change: ${must(r.itsa_id).key} holds a value it would refuse (${e instanceof Error ? e.message : e})`);
        }
      }
    }
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of ['key', 'label', 'type', 'options', 'description', 'hint', 'width', 'align', 'card'] as const)
      if (JSON.stringify(next[k]) !== JSON.stringify(cur[k])) changes[k] = { from: cur[k], to: next[k] };
    if (!Object.keys(changes).length) return cur;
    d.prepare('UPDATE itsa_fields SET key = ?, label = ?, type = ?, options = ?, description = ?, hint = ?, width = ?, align = ?, card = ?, updated_at = ? WHERE id = ?').run(
      next.key, next.label, next.type, next.options ? JSON.stringify(next.options) : null, next.description, next.hint, next.width, next.align, next.card, now(), cur.id,
    );
    addEvent(FIELD_EVENTS, actor, 'field_updated', { id: cur.id, key: cur.key, changes });
    return mustField(cur.id);
  });
}

// Deletes the definition and every value held for it.
export async function removeField(ref: string, by: string | null = null): Promise<{ removed: string; values: number }> {
  const actor = await assertMayDefine(by);
  return tx(() => {
    const cur = mustField(ref);
    const d = db.open();
    const values = Number(d.prepare('DELETE FROM itsa_field_values WHERE field_id = ?').run(cur.id).changes);
    d.prepare('DELETE FROM itsa_fields WHERE id = ?').run(cur.id);
    addEvent(FIELD_EVENTS, actor, 'field_removed', { id: cur.id, key: cur.key, values });
    return { removed: cur.key, values };
  });
}

// `order` lists field ids or keys, first to last; fields it leaves out follow in their old order.
export async function reorderFields(order: unknown, by: string | null = null): Promise<Field[]> {
  const actor = await assertMayDefine(by);
  if (!Array.isArray(order)) throw new Error('order is a list of field ids');
  return tx(() => {
    const all = fields();
    const ids = order.map((r) => mustField(String(r)).id);
    if (new Set(ids).size !== ids.length) throw new Error('order names a field twice');
    const sorted = [...ids, ...all.map((f) => f.id).filter((id) => !ids.includes(id))];
    const up = db.open().prepare('UPDATE itsa_fields SET position = ? WHERE id = ?');
    sorted.forEach((id, i) => up.run(i, id));
    addEvent(FIELD_EVENTS, actor, 'field_order', { from: all.map((f) => f.key), to: sorted.map((id) => all.find((f) => f.id === id)!.key) });
    return fields();
  });
}

// The values of one ITSA (or every ITSA), by itsa id then field key.
function fieldValuesByItsa(itsaId?: string): Map<string, Record<string, unknown>> {
  const rows = db
    .open()
    .prepare(`SELECT v.itsa_id, f.key, v.value FROM itsa_field_values v JOIN itsa_fields f ON f.id = v.field_id ${itsaId ? 'WHERE v.itsa_id = ?' : ''} ORDER BY f.position`)
    .all(...(itsaId ? [itsaId] : [])) as { itsa_id: string; key: string; value: string }[];
  const out = new Map<string, Record<string, unknown>>();
  for (const r of rows) out.set(r.itsa_id, { ...(out.get(r.itsa_id) ?? {}), [r.key]: JSON.parse(r.value) });
  return out;
}

// The payload for `itsa.changed` on the web's event stream (events.ts), so the system view's
// ITSA cards follow a create or an edit without refetching.
function itsaEvent(x: Itsa): Record<string, unknown> {
  return { id: x.id, key: x.key, status: x.status, owner: x.owner, fields: fieldValuesByItsa(x.id).get(x.id) ?? {} };
}

// Sets values by field key inside the caller's transaction; null clears. Returns what changed
// ({ from, to } per key), or null if nothing did.
function applyFieldValues(itsaId: string, values: Record<string, unknown>, actor: string): { from: Record<string, unknown>; to: Record<string, unknown> } | null {
  if (values === null || typeof values !== 'object' || Array.isArray(values)) throw new Error('fields is an object of field key to value');
  const d = db.open();
  const from: Record<string, unknown> = {};
  const to: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(values)) {
    const f = findField(key);
    if (!f) throw new Error(`no field ${key}; fields: ${fields().map((x) => x.key).join(', ') || 'none defined'}`);
    const v = checkFieldValue(f, raw);
    const row = d.prepare('SELECT value FROM itsa_field_values WHERE itsa_id = ? AND field_id = ?').get(itsaId, f.id) as { value: string } | undefined;
    const before = row ? JSON.parse(row.value) : null;
    if (JSON.stringify(before) === JSON.stringify(v)) continue;
    if (v === null) d.prepare('DELETE FROM itsa_field_values WHERE itsa_id = ? AND field_id = ?').run(itsaId, f.id);
    else d.prepare('INSERT OR REPLACE INTO itsa_field_values (itsa_id, field_id, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)').run(itsaId, f.id, JSON.stringify(v), actor, now());
    from[f.key] = before;
    to[f.key] = v;
  }
  if (!Object.keys(to).length) return null;
  d.prepare('UPDATE itsas SET updated_at = ? WHERE id = ?').run(now(), itsaId);
  return { from, to };
}
