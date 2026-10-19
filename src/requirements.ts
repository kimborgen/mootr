// Requirements: an optional tree of requirements (S-461), in the spirit
// of space-system engineering. A requirement is a statement with a rationale, a verification
// method, a scope, a severity, and a mode (observe/inform/enforce) that decides what a
// conformity check does. Fully optional: off unless settings.requirements.enabled is true.
//
// Storage, HTTP API, and CLI live here. The check engine (src/req-check.ts) asks the decision
// model per requirement and stores a verdict per subject through cachedVerdict/recordVerdict.
//
// Tables (created lazily, like src/steps.ts table(), so nothing exists while off):
//   requirements   the tree: a readable key (R-1, ... from a counter, prefix in settings),
//                  parent, a free `level` label, title/text/rationale/source, a JSON
//                  verification list, a JSON scope, severity, mode, threshold, status, owner,
//                  and a version bumped when text or scope changes.
//   req_links      a requirement's links: a target kind (itsa, file, test, mail, url,
//                  requirement) and a role (implements, verifies, allocated_to, refines,
//                  conflicts_with).
//   req_verdicts   one conformity verdict per (requirement version, subject, model); a unique
//                  index makes the row a cache. Subjects are `mail:ID`, `itsa:KEY`,
//                  `branch:REPO/NAME@SHA`, `tool:NAME`, `event:ID`, or `text:HASH`.
//   req_waivers    a waiver on a verdict (false_positive or accepted_deviation), with why and by.
//
// Like an ITSA, a requirement lives on the ITSA home daemon (settings.itsa.home); the daemon
// proxies /api/requirements there. Approving a draft into `in_force` is gated by
// settings.requirements.approval: only the human, the chief of staff (or the human), or
// anyone. An agent never approves its own draft unless the setting is `any`.
import { randomBytes } from 'node:crypto';
import * as db from './db.ts';
import { settings } from './settings.ts';
import { HUMAN, tellAnywhere } from './mail.ts';
import * as itsa from './itsa.ts';
import { person } from './itsa.ts';
import { render } from './templates.ts';

export const STATUSES = ['draft', 'in_force', 'suspended', 'obsolete'] as const;
export const SEVERITIES = ['info', 'minor', 'major', 'critical'] as const;
export const MODES = ['observe', 'inform', 'enforce'] as const;
export const VERIFICATION_METHODS = ['decision', 'test', 'pattern', 'review', 'human'] as const;
export const TARGET_KINDS = ['itsa', 'file', 'test', 'mail', 'url', 'requirement'] as const;
export const LINK_ROLES = ['implements', 'verifies', 'allocated_to', 'refines', 'conflicts_with'] as const;
export const VERDICTS = ['conforms', 'violates', 'na', 'unsure'] as const;
export const WAIVER_KINDS = ['false_positive', 'accepted_deviation'] as const;

export type Status = (typeof STATUSES)[number];
export type Severity = (typeof SEVERITIES)[number];
export type Mode = (typeof MODES)[number];
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];
export type TargetKind = (typeof TARGET_KINDS)[number];
export type LinkRole = (typeof LINK_ROLES)[number];
export type Verdict = (typeof VERDICTS)[number];
export type WaiverKind = (typeof WAIVER_KINDS)[number];

// One verification method with optional detail (a command, a glob, a question).
export interface Verification {
  method: VerificationMethod;
  detail?: string;
}

// What a requirement applies to. Every field is optional; a missing field filters nothing.
export interface Scope {
  subjects?: string[];
  paths?: string[];
  repos?: string[];
  roles?: string[];
  agents?: string[];
  itsa?: string[];
  tools?: string[];
  sources?: string[];
  // External event types, as globs (`pull_request.*`).
  types?: string[];
}
const SCOPE_KEYS = ['subjects', 'paths', 'repos', 'roles', 'agents', 'itsa', 'tools', 'sources', 'types'] as const;

export interface Requirement {
  id: string;
  key: string;
  parent_id: string | null;
  level: string | null;
  title: string;
  text: string | null;
  rationale: string | null;
  source: string | null;
  verification: Verification[] | null;
  scope: Scope | null;
  severity: Severity;
  mode: Mode;
  threshold: number;
  status: Status;
  owner: string | null;
  version: number;
  // Counts every edit, so an approval can name exactly the draft that was shown (version moves
  // only with the text or scope, and updated_at can repeat within a millisecond).
  rev: number;
  created_by: string;
  // Who last changed the text or scope (the creator until then; null on a row from before this).
  text_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReqLink {
  id: number;
  target_kind: TargetKind;
  target: string;
  role: LinkRole;
}

export interface ReqVerdict {
  id: number;
  req_version: number;
  subject: string;
  subject_hash: string;
  model: string;
  verdict: Verdict;
  p_conforms: number | null;
  p_violates: number | null;
  p_na: number | null;
  action: string | null;
  cost: number | null;
  ts: string;
  // The latest waiver on this verdict, if any: a waived verdict stays here, marked.
  waiver?: { kind: WaiverKind; reason: string | null; by: string | null; ts: string } | null;
  // The subject said readably, and what it opens (see describeSubject); set by `verdicts`.
  label?: string;
  open?: SubjectInfo['open'];
}

// A subject as a person reads it: a mail's subject (opening its thread), an ITSA's key and title
// (opening the ITSA), a branch's name, a tool's name, an event's summary, or the start of a
// pasted text, never `text:<hash>`.
export interface SubjectInfo {
  label: string;
  open?: { kind: 'thread' | 'itsa'; id: string };
}

// How well a requirement's flags hold up: over its last `window` `violates` verdicts at the
// current version, how many were waived as false positives.
export interface Precision {
  window: number;
  violates: number;
  false_positives: number;
  accepted_deviations: number;
  // false_positives / violates, or null with no violates verdict yet.
  rate: number | null;
  // Above this rate the requirement drops to observe.
  max_rate: number;
}

// What `get` returns: the row, its ancestors (root first), its direct children, its links, and
// the last verdicts on it.
export interface RequirementView extends Requirement {
  parent_chain: { id: string; key: string; title: string; status: Status }[];
  children: Requirement[];
  links: ReqLink[];
  verdicts: ReqVerdict[];
  precision: Precision;
}

// A refusal for who the caller is, not what it sent; the HTTP layer answers 403.
export class ForbiddenError extends Error {}

// Returned by every entry point while settings.requirements.enabled is false, so nothing reads
// or creates a table. The HTTP layer answers 404 with this message.
export const OFF_MESSAGE = 'requirements are off (settings.requirements.enabled)';
export class RequirementsOffError extends Error {}

export function enabled(): boolean {
  return settings().requirements.enabled === true;
}

function assertEnabled(): void {
  if (!enabled()) throw new RequirementsOffError(OFF_MESSAGE);
}

const now = () => new Date().toISOString();

// The tables live here rather than in db.ts's schema, so nothing is created while requirements
// are off. A unique index on the verdict columns makes a verdict row the model's cache.
let ready = false;
function table(): void {
  if (ready) return;
  db.open().exec(`
    CREATE TABLE IF NOT EXISTS requirements (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      parent_id TEXT,
      level TEXT,
      title TEXT NOT NULL,
      text TEXT,
      rationale TEXT,
      source TEXT,
      verification TEXT,
      scope TEXT,
      severity TEXT NOT NULL DEFAULT 'minor',
      mode TEXT NOT NULL DEFAULT 'observe',
      threshold REAL NOT NULL DEFAULT 0.8,
      status TEXT NOT NULL DEFAULT 'draft',
      owner TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      rev INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL,
      text_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS requirements_parent ON requirements (parent_id, key);
    CREATE TABLE IF NOT EXISTS req_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      req_id TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS req_links_req ON req_links (req_id, id);
    CREATE TABLE IF NOT EXISTS req_verdicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      req_id TEXT NOT NULL,
      req_version INTEGER NOT NULL,
      subject TEXT NOT NULL,
      subject_hash TEXT NOT NULL,
      subject_label TEXT,
      model TEXT NOT NULL,
      verdict TEXT NOT NULL,
      p_conforms REAL,
      p_violates REAL,
      p_na REAL,
      action TEXT,
      cost REAL,
      ts TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS req_verdicts_cache ON req_verdicts (req_id, req_version, subject_hash, model);
    CREATE INDEX IF NOT EXISTS req_verdicts_req ON req_verdicts (req_id, id);
    CREATE TABLE IF NOT EXISTS req_waivers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      verdict_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      reason TEXT,
      by TEXT,
      ts TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS req_counter (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS req_waivers_verdict ON req_waivers (verdict_id, id);
  `);
  // A table made before `rev` or `text_by` existed gets the columns.
  const have = (db.open().prepare('PRAGMA table_info(requirements)').all() as { name: string }[]).map((c) => c.name);
  if (!have.includes('rev')) db.open().exec('ALTER TABLE requirements ADD COLUMN rev INTEGER NOT NULL DEFAULT 1');
  if (!have.includes('text_by')) db.open().exec('ALTER TABLE requirements ADD COLUMN text_by TEXT');
  // A verdict table made before `subject_label` existed gets it: what a pasted text began with.
  const vcols = (db.open().prepare('PRAGMA table_info(req_verdicts)').all() as { name: string }[]).map((c) => c.name);
  if (!vcols.includes('subject_label')) db.open().exec('ALTER TABLE req_verdicts ADD COLUMN subject_label TEXT');
  ready = true;
}

type Row = Omit<Requirement, 'verification' | 'scope'> & { verification: string | null; scope: string | null };

function parseJson<T>(v: string | null | undefined): T | null {
  if (v == null) return null;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
}

const parse = (r: Row): Requirement => ({ ...r, verification: parseJson<Verification[]>(r.verification), scope: parseJson<Scope>(r.scope) });
const parseLink = (r: any): ReqLink => ({ id: r.id, target_kind: r.target_kind, target: r.target, role: r.role });
const parseVerdict = (r: any): ReqVerdict => ({
  id: r.id,
  req_version: r.req_version,
  subject: r.subject,
  subject_hash: r.subject_hash,
  model: r.model,
  verdict: r.verdict,
  p_conforms: r.p_conforms,
  p_violates: r.p_violates,
  p_na: r.p_na,
  action: r.action,
  cost: r.cost,
  ts: r.ts,
});

// `R-42`: one durable counter, independent of the display prefix (a prefix may contain a
// hyphen, so it can't be read back from the keys). On first use it seeds from existing keys.
function nextKey(): string {
  const d = db.open();
  let row = d.prepare("SELECT value FROM req_counter WHERE name = 'key'").get() as { value: number } | undefined;
  if (!row) {
    let max = 0;
    for (const r of d.prepare('SELECT key FROM requirements').all() as { key: string }[]) {
      const m = /-(\d+)$/.exec(r.key);
      if (m) max = Math.max(max, Number(m[1]));
    }
    d.prepare("INSERT OR REPLACE INTO req_counter (name, value) VALUES ('key', ?)").run(max);
    row = { value: max };
  }
  const n = row.value + 1;
  d.prepare("UPDATE req_counter SET value = ? WHERE name = 'key'").run(n);
  return `${settings().requirements.keyPrefix}-${n}`;
}

function newId(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  return 'r' + [...randomBytes(4)].map((b) => alphabet[b % alphabet.length]).join('');
}

const oneOf = <T extends string>(list: readonly T[], v: unknown, what: string): T => {
  if (!list.includes(v as T)) throw new Error(`${what} must be one of: ${list.join(', ')}`);
  return v as T;
};

const textOrNull = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  const s = String(v);
  return s === '' ? null : s;
};
const trimmedOrNull = (v: unknown): string | null => {
  const s = textOrNull(v);
  return s === null ? null : s.trim() || null;
};

// A list of bare method names or `{ method, detail }` objects, all validated.
function normalizeVerification(raw: unknown): Verification[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) throw new Error('verification is a list of methods (decision, test, pattern, review, human)');
  return raw.map((item) => {
    const method = typeof item === 'string' ? item : String((item as any)?.method ?? (item as any)?.kind ?? '');
    const detail = typeof item === 'object' && item !== null && (item as any).detail != null ? String((item as any).detail) : undefined;
    return detail ? { method: oneOf(VERIFICATION_METHODS, method, 'a verification method'), detail } : { method: oneOf(VERIFICATION_METHODS, method, 'a verification method') };
  });
}

// An object of subject kinds, path globs, repos, roles, agent names, ITSA keys, tools, and
// event sources and types. Every present field is a list of non-empty strings.
function normalizeScope(raw: unknown): Scope | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('scope is an object of lists (subjects, paths, repos, roles, agents, itsa, tools, sources, types)');
  const out: Scope = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(SCOPE_KEYS as readonly string[]).includes(k)) throw new Error(`unknown scope field ${k}; scope fields: ${SCOPE_KEYS.join(', ')}`);
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && x)) throw new Error(`scope.${k} is a list of non-empty strings`);
    (out as any)[k] = v as string[];
  }
  return out;
}

// Severity sets the default action, so it always has a value; the mildest is `minor`.
const SEVERITY_DEFAULT: Severity = 'minor';
const severityOf = (v: unknown, fallback: Severity): Severity => (v === undefined || v === null || v === '' ? fallback : oneOf(SEVERITIES, v, 'severity'));

// --- Reads ---------------------------------------------------------------------------------

export interface ListFilters {
  // A direct parent (a key or id), or 'root'/'none'/'' for the roots.
  parent?: string;
  status?: string;
  text?: string;
  // Adds each requirement's latest verdict per subject at its current version.
  latest?: boolean;
}

// One subject's latest verdict at a requirement's current version, waived or not: what the web's
// tree counts and an ITSA's Requirements panel shows (GET /api/requirements?verdicts=latest).
export interface LatestVerdict {
  id: number;
  subject: string;
  verdict: Verdict;
  p_violates: number | null;
  waived: WaiverKind | null;
  ts: string;
}

export type ListedRequirement = Requirement & { links: ReqLink[]; latest?: LatestVerdict[] };

export function list(f: ListFilters = {}): ListedRequirement[] {
  assertEnabled();
  table();
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.parent !== undefined) {
    if (f.parent === 'root' || f.parent === 'none' || f.parent === '') where.push('parent_id IS NULL');
    else {
      where.push('parent_id = ?');
      args.push(must(f.parent).id);
    }
  }
  if (f.status !== undefined && f.status !== '') {
    where.push('status = ?');
    args.push(String(f.status));
  }
  if (f.text !== undefined && String(f.text).trim()) {
    const like = `%${String(f.text).trim()}%`;
    where.push('(key LIKE ? OR title LIKE ? OR text LIKE ? OR rationale LIKE ? OR source LIKE ?)');
    args.push(like, like, like, like, like);
  }
  const rows = db.open().prepare(`SELECT * FROM requirements ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at, key`).all(...args) as unknown as Row[];
  const links = new Map<string, ReqLink[]>();
  for (const l of db.open().prepare('SELECT req_id, id, target_kind, target, role FROM req_links ORDER BY req_id, id').all() as any[])
    links.set(l.req_id, [...(links.get(l.req_id) ?? []), parseLink(l)]);
  const latest = f.latest ? latestVerdicts() : null;
  return rows.map((r) => ({ ...parse(r), links: links.get(r.id) ?? [], ...(latest ? { latest: latest.get(r.id) ?? [] } : {}) }));
}

// Per requirement, the newest verdict on each subject at the requirement's current version, with
// the kind of its latest waiver; one query for the whole tree.
function latestVerdicts(): Map<string, LatestVerdict[]> {
  const rows = db
    .open()
    .prepare(
      `SELECT v.req_id, v.id, v.subject, v.verdict, v.p_violates, v.ts,
         (SELECT kind FROM req_waivers w WHERE w.verdict_id = v.id ORDER BY w.id DESC LIMIT 1) AS waived
       FROM req_verdicts v JOIN requirements r ON r.id = v.req_id AND v.req_version = r.version
       WHERE v.id = (SELECT MAX(id) FROM req_verdicts x WHERE x.req_id = v.req_id AND x.req_version = v.req_version AND x.subject = v.subject)
       ORDER BY v.id DESC`,
    )
    .all() as any[];
  const out = new Map<string, LatestVerdict[]>();
  for (const r of rows)
    out.set(r.req_id, [...(out.get(r.req_id) ?? []), { id: r.id, subject: r.subject, verdict: r.verdict, p_violates: r.p_violates, waived: r.waived ?? null, ts: r.ts }]);
  return out;
}

export function find(ref: string): Requirement | undefined {
  assertEnabled();
  table();
  const r = db.open().prepare('SELECT * FROM requirements WHERE id = ? OR key = ?').get(ref, ref) as Row | undefined;
  return r && parse(r);
}

export function must(ref: string): Requirement {
  const x = find(ref);
  if (!x) throw new Error(`no requirement ${ref}`);
  return x;
}

function parentChain(x: Requirement): { id: string; key: string; title: string; status: Status }[] {
  const chain: { id: string; key: string; title: string; status: Status }[] = [];
  const seen = new Set<string>([x.id]);
  for (let p = x.parent_id ? find(x.parent_id) : undefined; p && !seen.has(p.id); p = p.parent_id ? find(p.parent_id) : undefined) {
    seen.add(p.id);
    chain.unshift({ id: p.id, key: p.key, title: p.title, status: p.status });
  }
  return chain;
}

export function links(ref: string): ReqLink[] {
  const x = must(ref);
  return (db.open().prepare('SELECT id, target_kind, target, role FROM req_links WHERE req_id = ? ORDER BY id').all(x.id) as any[]).map(parseLink);
}

// The last n verdicts on a requirement (all its versions), newest first, each with its subject
// said readably. `include` adds an older verdict of this requirement (the matrix opens one).
export function verdicts(ref: string, n = 20, include?: number): ReqVerdict[] {
  const x = must(ref);
  const rows = db.open().prepare('SELECT * FROM req_verdicts WHERE req_id = ? ORDER BY id DESC LIMIT ?').all(x.id, n) as any[];
  if (include !== undefined && Number.isInteger(include) && !rows.some((r) => r.id === include)) {
    const extra = db.open().prepare('SELECT * FROM req_verdicts WHERE req_id = ? AND id = ?').get(x.id, include);
    if (extra) rows.push(extra);
  }
  const said = new Map<string, SubjectInfo>();
  const out = rows.map((r) => {
    const k = r.subject + '\0' + (r.subject_label ?? '');
    if (!said.has(k)) said.set(k, describeSubject(r.subject, r.subject_label ?? null));
    const info = said.get(k)!;
    return { ...parseVerdict(r), label: info.label, ...(info.open ? { open: info.open } : {}) };
  });
  if (!out.length) return out;
  const latest = new Map<number, NonNullable<ReqVerdict['waiver']>>();
  const ws = db.open().prepare(`SELECT verdict_id, kind, reason, by, ts FROM req_waivers WHERE verdict_id IN (${out.map(() => '?').join(',')}) ORDER BY id`).all(...out.map((v) => v.id)) as any[];
  for (const w of ws) latest.set(w.verdict_id, { kind: w.kind, reason: w.reason, by: w.by, ts: w.ts });
  return out.map((v) => ({ ...v, waiver: latest.get(v.id) ?? null }));
}

// See SubjectInfo. `stored` is the label kept with the verdict (a pasted text's start). A mail
// or ITSA this daemon doesn't hold is said by its id.
export function describeSubject(subject: string, stored: string | null): SubjectInfo {
  const i = subject.indexOf(':');
  const kind = i < 0 ? '' : subject.slice(0, i);
  const rest = i < 0 ? subject : subject.slice(i + 1);
  try {
    if (kind === 'mail') {
      const m = db.getMail(rest);
      return m ? { label: m.subject?.trim() || `mail ${rest}`, open: { kind: 'thread', id: m.thread_id ?? m.id } } : { label: `mail ${rest}` };
    }
    if (kind === 'itsa') {
      const it = itsa.find(rest);
      return it ? { label: `${it.key} ${it.title}`, open: { kind: 'itsa', id: it.id } } : { label: rest };
    }
    if (kind === 'branch') return { label: /^(?:[^/]+\/)?(.+?)(?:@[0-9a-f]{7,})?$/.exec(rest)?.[1] ?? rest };
    if (kind === 'tool') return { label: `tool ${rest}` };
    if (kind === 'event') {
      const e = db.open().prepare('SELECT source, summary FROM ext_events WHERE id = ?').get(Number(rest)) as { source: string; summary: string | null } | undefined;
      return { label: e?.summary?.trim() ? clip(e.summary) : `${e?.source ?? ''} event ${rest}`.trim() };
    }
    if (kind === 'text') return { label: stored?.trim() || 'pasted text' };
  } catch {
    // A missing table (no events yet) says the subject by its kind and id.
  }
  return { label: kind === 'text' ? 'pasted text' : subject };
}

// A text's first 60 characters on one line, with an ellipsis when it goes on.
export function clip(text: string, n = 60): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1).trimEnd() + '…' : one;
}

export const PRECISION_WINDOW = 20;
export const PRECISION_MAX_RATE = 0.3;

// The false-positive rate over the last PRECISION_WINDOW `violates` verdicts at the current
// version: a reworded requirement starts clean, since its old flags were about the old text.
export function precision(ref: string): Precision {
  const x = must(ref);
  const rows = db
    .open()
    .prepare(
      `SELECT (SELECT kind FROM req_waivers w WHERE w.verdict_id = v.id ORDER BY w.id DESC LIMIT 1) AS kind
       FROM req_verdicts v WHERE v.req_id = ? AND v.req_version = ? AND v.verdict = 'violates' ORDER BY v.id DESC LIMIT ?`,
    )
    .all(x.id, x.version, PRECISION_WINDOW) as { kind: WaiverKind | null }[];
  const fp = rows.filter((r) => r.kind === 'false_positive').length;
  return {
    window: PRECISION_WINDOW,
    violates: rows.length,
    false_positives: fp,
    accepted_deviations: rows.filter((r) => r.kind === 'accepted_deviation').length,
    rate: rows.length ? fp / rows.length : null,
    max_rate: PRECISION_MAX_RATE,
  };
}

// The kind of the latest waiver on a verdict, or null.
export function waiverKind(verdictId: number | null): WaiverKind | null {
  if (verdictId === null) return null;
  table();
  const r = db.open().prepare('SELECT kind FROM req_waivers WHERE verdict_id = ? ORDER BY id DESC LIMIT 1').get(verdictId) as { kind: WaiverKind } | undefined;
  return r?.kind ?? null;
}

// Whether a verdict of this requirement on this subject was waived (any version): the actor
// isn't told again for it.
export function waivedOn(reqId: string, subject: string): boolean {
  table();
  return !!db.open().prepare('SELECT 1 FROM req_verdicts v JOIN req_waivers w ON w.verdict_id = v.id WHERE v.req_id = ? AND v.subject = ? LIMIT 1').get(reqId, subject);
}

// `verdict` makes sure that verdict is in the list, however old (the matrix opens it).
export function get(ref: string, opts: { verdict?: number } = {}): RequirementView {
  const x = must(ref);
  const children = db.open().prepare('SELECT * FROM requirements WHERE parent_id = ? ORDER BY created_at, key').all(x.id) as unknown as Row[];
  return {
    ...x,
    parent_chain: parentChain(x),
    children: children.map(parse),
    links: links(x.id),
    verdicts: verdicts(x.id, 20, opts.verdict),
    precision: precision(x.id),
  };
}

// --- Writes --------------------------------------------------------------------------------

export interface CreateInput {
  parent?: string | null;
  level?: string | null;
  title?: unknown;
  text?: unknown;
  rationale?: unknown;
  source?: unknown;
  verification?: unknown;
  scope?: unknown;
  severity?: unknown;
  mode?: unknown;
  threshold?: unknown;
  status?: unknown;
  owner?: unknown;
  by?: string | null;
}

export interface SetInput {
  parent?: string | null;
  level?: string | null;
  title?: unknown;
  text?: unknown;
  rationale?: unknown;
  source?: unknown;
  verification?: unknown;
  scope?: unknown;
  severity?: unknown;
  mode?: unknown;
  threshold?: unknown;
  status?: unknown;
  owner?: unknown;
  // Refuse the change unless the requirement is at exactly this `rev`: an approval applies to the
  // draft that was shown, not to one edited since.
  ifRev?: number;
}

// Whether `actor` may move a requirement from draft to in_force. The human always may; an
// agent never approves its own draft unless approval is 'any'; 'cos' also allows the chief of
// staff (resolved locally or through the peers), 'any' allows anyone.
async function assertMayApprove(createdBy: string | null, actor: string, textBy: string | null = null): Promise<void> {
  if (actor === HUMAN) return;
  const approval = settings().requirements.approval;
  if (actor === createdBy || (textBy && actor === textBy)) {
    // Deliberate: `any` is the one setting that lets an agent approve its own draft.
    if (approval === 'any') return;
    throw new ForbiddenError(actor === createdBy ? `an agent may not approve its own draft (settings.requirements.approval is ${approval})` : `an agent may not approve text it last changed (settings.requirements.approval is ${approval})`);
  }
  if (approval === 'any') return;
  if (approval === 'cos') {
    const cos = settings().chiefOfStaff;
    const cosId = cos ? await person(cos).catch(() => null) : null;
    if (cos && (actor === cosId || actor === cos)) return;
    throw new ForbiddenError('only the chief of staff or the human approves a draft into in_force (settings.requirements.approval is cos)');
  }
  throw new ForbiddenError('only the human approves a draft into in_force (settings.requirements.approval is human)');
}

function validateParent(cur: Requirement | null, ref: unknown): string | null {
  const raw = ref == null ? '' : String(ref);
  if (!raw || raw === 'none' || raw === 'root') return null;
  const p = must(raw);
  if (cur) {
    if (p.id === cur.id) throw new Error('a requirement cannot be its own parent');
    for (let n: Requirement | undefined = p, guard = new Set<string>(); n && !guard.has(n.id); n = n.parent_id ? find(n.parent_id) : undefined) {
      if (n.id === cur.id) throw new Error('reparenting would create a cycle');
      guard.add(n.id);
    }
  }
  return p.id;
}

const ownerOf = async (v: unknown): Promise<string | null> => (v === undefined ? null : person(v));

// Checks a create input's fields without writing anything or needing requirements on: a batch
// checks every entry before it creates the first, and the seed file's test uses it. The parent
// and owner are resolved at create time, so they aren't checked here.
export function validate(input: CreateInput): void {
  if (!String(input.title ?? '').trim()) throw new Error('a requirement needs a title');
  if (!(input.status === undefined || input.status === null || input.status === '')) oneOf(STATUSES, input.status, 'status');
  if (!(input.mode === undefined || input.mode === null || input.mode === '')) oneOf(MODES, input.mode, 'mode');
  if (input.threshold !== undefined && input.threshold !== null) {
    const t = Number(input.threshold);
    if (!Number.isFinite(t) || t < 0 || t > 1) throw new Error('the threshold is a number from 0 to 1');
  }
  severityOf(input.severity, SEVERITY_DEFAULT);
  normalizeVerification(input.verification);
  normalizeScope(input.scope);
}

export async function create(input: CreateInput): Promise<Requirement> {
  assertEnabled();
  table();
  const title = String(input.title ?? '').trim();
  if (!title) throw new Error('a requirement needs a title');
  const status = input.status === undefined || input.status === null || input.status === '' ? 'draft' : oneOf(STATUSES, input.status, 'status');
  const mode = input.mode === undefined || input.mode === null || input.mode === '' ? settings().requirements.defaultMode : oneOf(MODES, input.mode, 'mode');
  const threshold = input.threshold === undefined || input.threshold === null ? settings().requirements.defaultThreshold : Number(input.threshold);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('the threshold is a number from 0 to 1');
  const severity = severityOf(input.severity, SEVERITY_DEFAULT);
  const verification = normalizeVerification(input.verification);
  const scope = normalizeScope(input.scope);
  const owner = await ownerOf(input.owner);
  const by = (await person(input.by)) ?? HUMAN;
  // Under `human` or `cos` approval an agent's requirement starts as a draft, whoever the agent is:
  // in force or suspended would skip the approval (and, for the chief of staff, the own-draft rule).
  if (by !== HUMAN && (status === 'in_force' || status === 'suspended') && settings().requirements.approval !== 'any') {
    throw new ForbiddenError(`an agent can't create a requirement as ${status} (settings.requirements.approval is ${settings().requirements.approval}): create a draft and get it approved`);
  }
  // Creating a requirement in force is the draft -> in_force move: the same gate applies.
  if (status === 'in_force') await assertMayApprove(null, by);
  const parentId = input.parent === undefined || input.parent === null || input.parent === '' ? null : validateParent(null, input.parent);
  const id = newId();
  const key = nextKey();
  const t = now();
  db.open()
    .prepare(
      `INSERT INTO requirements (id, key, parent_id, level, title, text, rationale, source, verification, scope, severity, mode, threshold, status, owner, version, created_by, text_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    )
    .run(
      id, key, parentId, trimmedOrNull(input.level), title, textOrNull(input.text), textOrNull(input.rationale), textOrNull(input.source),
      verification ? JSON.stringify(verification) : null, scope ? JSON.stringify(scope) : null, severity, mode, threshold, status, owner, by, by, t, t,
    );
  rebuildEnforcedTools();
  return must(id);
}

// One entry of a batch: a create input with an optional local `ref` that later entries name as
// their `parent` (a parent that isn't a local ref is an existing requirement's key).
export type BatchEntry = Omit<CreateInput, 'by'> & { ref?: string };
export const BATCH_MAX = 200;

// Creates a batch of drafts, parents first (`stam req seed`, POST /api/requirements/batch).
// Every entry is checked before the first is created, so a bad file creates nothing. Returns
// the drafts in creation order.
export async function createBatch(entries: unknown, by: string | null): Promise<Requirement[]> {
  assertEnabled();
  table();
  if (!Array.isArray(entries) || !entries.length) throw new Error('a batch is a non-empty list of requirements');
  if (entries.length > BATCH_MAX) throw new Error(`a batch holds at most ${BATCH_MAX} requirements`);
  const list = entries as BatchEntry[];
  const refs = new Map<string, number>();
  list.forEach((e, i) => {
    if (typeof e !== 'object' || e === null || Array.isArray(e)) throw new Error(`entry ${i + 1} is not an object`);
    try {
      validate(e);
    } catch (x) {
      throw new Error(`entry ${i + 1} (${String(e.title ?? '').trim() || 'no title'}): ${x instanceof Error ? x.message : x}`);
    }
    if (!(e.status === undefined || e.status === null || e.status === '' || e.status === 'draft')) throw new Error(`entry ${i + 1} (${e.title}): a batch creates drafts only`);
    if (e.ref !== undefined) {
      const r = String(e.ref);
      if (!r || refs.has(r)) throw new Error(`entry ${i + 1} (${e.title}): ref ${r || '(empty)'} is ${r ? 'used twice' : 'empty'}`);
      refs.set(r, i);
    }
  });
  for (const [i, e] of list.entries()) {
    const p = e.parent == null || e.parent === '' ? null : String(e.parent);
    if (p && !refs.has(p) && !find(p)) throw new Error(`entry ${i + 1} (${e.title}): no parent ${p} in the batch or the tree`);
  }
  // Parents first: a depth-first walk over local parent refs, refusing a cycle.
  const order: number[] = [];
  const state = new Map<number, 'walking' | 'done'>();
  const visit = (i: number): void => {
    if (state.get(i) === 'done') return;
    if (state.get(i) === 'walking') throw new Error(`entry ${i + 1} (${list[i].title}): the parent refs form a cycle`);
    state.set(i, 'walking');
    const p = list[i].parent == null ? undefined : refs.get(String(list[i].parent));
    if (p !== undefined) visit(p);
    state.set(i, 'done');
    order.push(i);
  };
  list.forEach((_, i) => visit(i));
  const keyOf = new Map<string, string>();
  const made: Requirement[] = [];
  for (const i of order) {
    const { ref, parent, ...rest } = list[i];
    const p = parent == null || parent === '' ? null : keyOf.get(String(parent)) ?? String(parent);
    const r = await create({ ...rest, parent: p, status: 'draft', by });
    if (ref !== undefined) keyOf.set(String(ref), r.key);
    made.push(r);
  }
  return made;
}

// The human's Approve on a batch: every listed draft moves to in_force only if each is still a
// draft at exactly the rev that was shown. One synchronous transaction, so no edit can land between
// the check and the writes: either every draft goes in force, or none does and the stale keys are
// returned. Only the batch ask's Approve calls it, as the human; the approval gate is theirs.
export function approveAtRevs(items: { key: string; rev: number }[]): { approved: string[] } | { stale: string[] } {
  assertEnabled();
  table();
  const d = db.open();
  const out = db.transaction(() => {
    const rows = items.map((i) => ({ ...i, row: d.prepare('SELECT id, status, rev FROM requirements WHERE key = ?').get(i.key) as { id: string; status: Status; rev: number } | undefined }));
    const stale = rows.filter((r) => !r.row || r.row.status !== 'draft' || r.row.rev !== r.rev).map((r) => r.key);
    if (stale.length) return { stale };
    const t = now();
    const st = d.prepare("UPDATE requirements SET status = 'in_force', rev = rev + 1, updated_at = ? WHERE id = ?");
    for (const r of rows) st.run(t, r.row!.id);
    return { approved: rows.map((r) => r.key) };
  });
  if ('approved' in out) {
    enforcedIndex = null;
    enforcedTools();
  }
  return out;
}

// A draft at the rev the human was shown. Plain statements, no transaction of its own (db.transaction
// doesn't nest): the caller checks and writes inside one, so no await falls between them.
export function assertDraftAtRev(key: string, rev: number): { id: string } {
  assertEnabled();
  table();
  const row = db.open().prepare('SELECT id, status, rev FROM requirements WHERE key = ?').get(key) as { id: string; status: Status; rev: number } | undefined;
  if (!row) throw new Error(`no requirement ${key}`);
  if (row.status !== 'draft') throw new Error(`${key} is ${row.status}, no longer a draft`);
  if (row.rev !== rev) throw new Error(`${key} changed since it was shown (rev ${row.rev}, shown at rev ${rev})`);
  return { id: row.id };
}

// Moves a draft at the shown rev to obsolete, inside the caller's transaction (see assertDraftAtRev).
export function obsoleteDraftAtRev(key: string, rev: number): void {
  const { id } = assertDraftAtRev(key, rev);
  db.open().prepare("UPDATE requirements SET status = 'obsolete', rev = rev + 1, updated_at = ? WHERE id = ?").run(now(), id);
  enforcedIndex = null;
}

export interface SetResult {
  requirement: Requirement;
  changes: Record<string, { from: unknown; to: unknown }>;
}

// The fields `set` edits, besides status and the revision guard.
const EDITABLE = ['title', 'text', 'rationale', 'source', 'parent', 'level', 'severity', 'mode', 'threshold', 'verification', 'scope', 'owner'] as const;

export async function set(ref: string, f: SetInput, by: string | null = null): Promise<SetResult> {
  assertEnabled();
  table();
  const actor = (await person(by)) ?? HUMAN;
  const cur = must(ref);
  const upd: Partial<Requirement> = {};
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const stringField = (name: keyof Requirement, v: unknown, transform: (v: unknown) => string | null) => {
    if (v === undefined) return;
    const next = transform(v);
    if (next !== cur[name]) {
      (upd as any)[name] = next;
      changes[name] = { from: cur[name], to: next };
    }
  };

  if (f.title !== undefined) {
    const title = String(f.title ?? '').trim();
    if (!title) throw new Error('a requirement needs a title');
    if (title !== cur.title) {
      upd.title = title;
      changes.title = { from: cur.title, to: title };
    }
  }
  stringField('level', f.level, trimmedOrNull);
  stringField('text', f.text, textOrNull);
  stringField('rationale', f.rationale, textOrNull);
  stringField('source', f.source, textOrNull);
  if (f.severity !== undefined) {
    const severity = severityOf(f.severity, SEVERITY_DEFAULT);
    if (severity !== cur.severity) {
      upd.severity = severity;
      changes.severity = { from: cur.severity, to: severity };
    }
  }
  if (f.mode !== undefined) {
    const mode = oneOf(MODES, f.mode, 'mode');
    if (mode !== cur.mode) {
      upd.mode = mode;
      changes.mode = { from: cur.mode, to: mode };
    }
  }
  if (f.threshold !== undefined) {
    const threshold = Number(f.threshold);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('the threshold is a number from 0 to 1');
    if (threshold !== cur.threshold) {
      upd.threshold = threshold;
      changes.threshold = { from: cur.threshold, to: threshold };
    }
  }
  if (f.status !== undefined) {
    const status = oneOf(STATUSES, f.status, 'status');
    if (status !== cur.status) {
      // Every move into in_force is approved, whatever status it comes from (a suspended or
      // obsolete one can't slip past the draft gate), and so is a create with status in_force.
      if (status === 'in_force') {
        await assertMayApprove(cur.created_by, actor, cur.text_by);
        // An agent approves the revision it read, and only that: it names it, and changes nothing else in the same call.
        if (actor !== HUMAN) {
          if (f.ifRev === undefined) throw new ForbiddenError(`an agent moves a requirement to in_force only by naming the revision it approves (if_rev, the rev shown in req_get and in the ask; ${cur.key} is at rev ${cur.rev})`);
          // Only the requirement's own fields count: the body also carries who is asking (`by`, `self`).
          if (EDITABLE.some((k) => (f as Record<string, unknown>)[k] !== undefined)) throw new ForbiddenError('an agent can not edit a requirement and approve it in one call: set status=in_force on its own, naming the rev');
        }
      }
      upd.status = status;
      changes.status = { from: cur.status, to: status };
    }
  }
  if (f.owner !== undefined) {
    const owner = await ownerOf(f.owner);
    if (owner !== cur.owner) {
      upd.owner = owner;
      changes.owner = { from: cur.owner, to: owner };
    }
  }
  if (f.parent !== undefined) {
    const parentId = validateParent(cur, f.parent);
    if (parentId !== cur.parent_id) {
      upd.parent_id = parentId;
      changes.parent = { from: cur.parent_id, to: parentId };
    }
  }
  if (f.verification !== undefined) {
    const verification = normalizeVerification(f.verification);
    if (JSON.stringify(verification) !== JSON.stringify(cur.verification)) {
      upd.verification = verification ?? undefined;
      changes.verification = { from: cur.verification, to: verification };
    }
  }
  if (f.scope !== undefined) {
    const scope = normalizeScope(f.scope);
    if (JSON.stringify(scope) !== JSON.stringify(cur.scope)) {
      upd.scope = scope ?? undefined;
      changes.scope = { from: cur.scope, to: scope };
    }
  }

  // Under `human` or `cos` approval an agent can't change the statement of a requirement that is in
  // force (or suspended): that would keep unapproved text in force, and sending it back to draft
  // would let an agent switch off a requirement it violates. A new draft that refines it goes
  // through approval instead.
  if ((changes.text || changes.scope) && actor !== HUMAN && settings().requirements.approval !== 'any' && (cur.status === 'in_force' || cur.status === 'suspended')) {
    throw new ForbiddenError(
      `an agent can't change the ${changes.text ? 'text' : 'scope'} of ${cur.key} while it is ${cur.status} (settings.requirements.approval is ${settings().requirements.approval}). Create a new draft with req_create, link it to ${cur.key} with role refines, and mail the owner (${cur.owner ?? 'your user'}).`,
    );
  }

  // Under `human` or `cos` approval an agent can't loosen a live rule either: mode, threshold, severity.
  // (The automatic demotion to observe is stam, not an agent, and writes the mode itself.)
  if ((changes.mode || changes.threshold || changes.severity) && actor !== HUMAN && settings().requirements.approval !== 'any' && (cur.status === 'in_force' || cur.status === 'suspended')) {
    throw new ForbiddenError(`an agent can't change the ${changes.mode ? 'mode' : changes.threshold ? 'threshold' : 'severity'} of ${cur.key} while it is ${cur.status} (settings.requirements.approval is ${settings().requirements.approval}). Ask the owner (${cur.owner ?? 'your user'}).`);
  }

  // The version moves when the statement itself or what it applies to changes.
  if (changes.text || changes.scope) {
    upd.text_by = actor;
    upd.version = cur.version + 1;
    changes.version = { from: cur.version, to: upd.version };
  }

  // Checked right before the write, with no wait in between, so no edit can slip in after it.
  if (f.ifRev !== undefined && must(cur.id).rev !== f.ifRev) throw new Error(`${cur.key} changed since it was shown (rev ${must(cur.id).rev}, not ${f.ifRev})`);
  if (Object.keys(upd).length) {
    const keys = Object.keys(upd);
    const cols = keys.map((k) => (k === 'parent_id' ? 'parent_id' : k === 'verification' ? 'verification' : k === 'scope' ? 'scope' : k));
    db.open()
      .prepare(`UPDATE requirements SET ${cols.map((c) => `${c} = ?`).join(', ')}, rev = rev + 1, updated_at = ? WHERE id = ?`)
      .run(...(keys.map((k) => {
        const v = (upd as Record<string, unknown>)[k];
        if (k === 'verification' || k === 'scope') return v == null ? null : JSON.stringify(v);
        return (v ?? null) as string | number | null;
      }) as (string | number | null)[]), now(), cur.id);
  }
  rebuildEnforcedTools();
  return { requirement: must(cur.id), changes };
}

// --- Crystal clear target validation -------------------------------------------------------

function normalizeLink(input: { target_kind?: unknown; target?: unknown; role?: unknown }): Omit<ReqLink, 'id'> {
  const target_kind = input.target_kind === undefined || input.target_kind === null || input.target_kind === '' ? 'url' : oneOf(TARGET_KINDS, input.target_kind, 'target kind');
  const target = String(input.target ?? '').trim();
  if (!target) throw new Error('a link needs a target');
  const role = input.role === undefined || input.role === null || input.role === '' ? 'implements' : oneOf(LINK_ROLES, input.role, 'link role');
  return { target_kind, target, role };
}

export function addLink(ref: string, input: { target_kind?: unknown; target?: unknown; role?: unknown }): ReqLink {
  assertEnabled();
  table();
  const x = must(ref);
  const l = normalizeLink(input);
  const r = db
    .open()
    .prepare('INSERT INTO req_links (req_id, target_kind, target, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(x.id, l.target_kind, l.target, l.role, now());
  return { id: Number(r.lastInsertRowid), ...l };
}

export function removeLink(ref: string, id: number): void {
  assertEnabled();
  table();
  const x = must(ref);
  const r = db.open().prepare('DELETE FROM req_links WHERE req_id = ? AND id = ?').run(x.id, id);
  if (!r.changes) throw new Error(`no link ${id} on ${x.key}`);
}

// --- Verdict cache (used by src/req-check.ts) -----------------------------------------------

// The stored verdict for this exact requirement version, subject content, and model, if any.
export function cachedVerdict(reqId: string, version: number, subjectHash: string, model: string): ReqVerdict | undefined {
  assertEnabled();
  table();
  const r = db.open().prepare('SELECT * FROM req_verdicts WHERE req_id = ? AND req_version = ? AND subject_hash = ? AND model = ?').get(reqId, version, subjectHash, model);
  return r ? parseVerdict(r) : undefined;
}

// `subject_label`: a pasted text's start, since its subject is only a hash.
export type NewVerdict = Omit<ReqVerdict, 'id' | 'ts'> & { req_id: string; subject_label?: string | null };

// Stores a verdict; a concurrent duplicate of the same cache key is ignored.
export function recordVerdict(v: NewVerdict): number | null {
  assertEnabled();
  table();
  const r = db
    .open()
    .prepare(
      `INSERT OR IGNORE INTO req_verdicts (req_id, req_version, subject, subject_hash, subject_label, model, verdict, p_conforms, p_violates, p_na, action, cost, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(v.req_id, v.req_version, v.subject, v.subject_hash, v.subject_label ?? null, v.model, v.verdict, v.p_conforms, v.p_violates, v.p_na, v.action, v.cost, now());
  return r.changes ? Number(r.lastInsertRowid) : cachedVerdict(v.req_id, v.req_version, v.subject_hash, v.model)?.id ?? null;
}

// One requirement's latest verdict on a subject, with what the merge queue needs to show it.
export interface ConformityLine {
  key: string;
  verdict: Verdict;
  p_violates: number | null;
  mode: Mode;
  severity: Severity;
}

// The latest verdict of each in-force requirement on a subject (`branch:REPO/NAME@SHA`), at its
// current version, unless waived; older versions, waived verdicts, and suspended or obsolete
// requirements stay in the table as history.
export function verdictsOn(subject: string): ConformityLine[] {
  assertEnabled();
  table();
  const rows = db
    .open()
    .prepare("SELECT v.req_id, v.verdict, v.p_violates, r.key, r.mode, r.severity, EXISTS (SELECT 1 FROM req_waivers w WHERE w.verdict_id = v.id) AS waived FROM req_verdicts v JOIN requirements r ON r.id = v.req_id WHERE v.subject = ? AND r.status = 'in_force' AND v.req_version = r.version ORDER BY v.id DESC")
    .all(subject) as any[];
  const seen = new Set<string>();
  const out: ConformityLine[] = [];
  for (const r of rows) {
    if (seen.has(r.req_id)) continue;
    seen.add(r.req_id);
    // A waived verdict stays in the table but no longer counts: not a line, not a hold.
    if (r.waived) continue;
    out.push({ key: r.key, verdict: r.verdict, p_violates: r.p_violates, mode: r.mode, severity: r.severity });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
}

// The tools that an in-force `enforce` requirement with a `decision` method names in its scope,
// kept in memory so a tool call that no requirement names does no database work. Dropped
// whenever a requirement is created or changed, and rebuilt then, so a call never pays for it.
let enforcedIndex: Set<string> | null = null;
export const enforcedToolsReady = (): boolean => enforcedIndex !== null;
// Forgets the index (tests: a cold start).
export function dropEnforcedTools(): void {
  enforcedIndex = null;
}
// Called after the index is rebuilt for a requirement change (the home pushes it to its peers).
const indexListeners: (() => void)[] = [];
export const onEnforcedToolsChange = (fn: () => void): void => void indexListeners.push(fn);
function rebuildEnforcedTools(): void {
  enforcedIndex = null;
  enforcedTools();
  for (const fn of indexListeners) {
    try {
      fn();
    } catch {}
  }
}
export function enforcedTools(): Set<string> {
  if (!enforcedIndex) {
    const tools = new Set<string>();
    for (const r of list({ status: 'in_force' }))
      if (r.mode === 'enforce' && (r.verification ?? []).some((v) => v.method === 'decision')) for (const t of r.scope?.tools ?? []) tools.add(t);
    enforcedIndex = tools;
  }
  return enforcedIndex;
}

// --- Waivers -------------------------------------------------------------------------------

export interface Waiver {
  id: number;
  verdict_id: number;
  kind: WaiverKind;
  reason: string | null;
  by: string | null;
  ts: string;
}

// Marks a verdict a false positive or an accepted deviation, with a reason. The verdict stays
// as it was; the waiver sits beside it.
export async function waive(input: { verdict_id?: unknown; kind?: unknown; reason?: unknown; by?: string | null }): Promise<Waiver> {
  assertEnabled();
  table();
  const id = Number(input.verdict_id);
  if (!Number.isInteger(id)) throw new Error('verdict_id is the number of a verdict (see req_get)');
  const kind = oneOf(WAIVER_KINDS, input.kind, 'kind');
  const reason = trimmedOrNull(input.reason);
  if (!reason) throw new Error('a waiver needs a reason');
  if (!db.open().prepare('SELECT 1 FROM req_verdicts WHERE id = ?').get(id)) throw new Error(`no verdict ${id}`);
  const by = (await person(input.by)) ?? HUMAN;
  const r = db.open().prepare('INSERT INTO req_waivers (verdict_id, kind, reason, by, ts) VALUES (?, ?, ?, ?, ?)').run(id, kind, reason, by, now());
  const reqId = (db.open().prepare('SELECT req_id FROM req_verdicts WHERE id = ?').get(id) as { req_id: string }).req_id;
  await demoteIfImprecise(reqId).catch((e) => db.addEvent('stam', 'req:error', { requirement: reqId, error: `precision: ${e instanceof Error ? e.message : String(e)}` }));
  return { id: Number(r.lastInsertRowid), verdict_id: id, kind, reason, by, ts: now() };
}

// Precision per requirement (false positives, S-461): when more than
// PRECISION_MAX_RATE of its last PRECISION_WINDOW flags were waived as false positives, it drops
// to `observe` (once it has settings.requirements.demoteMinFlags flags, default 5), a `req:demoted` event is logged, and its owner hears once to reword it. Only an
// in-force requirement that isn't observing already is demoted, so the notice comes once.
async function demoteIfImprecise(reqId: string): Promise<void> {
  const x = find(reqId);
  if (!x || x.status !== 'in_force' || x.mode === 'observe') return;
  const p = precision(x.id);
  // One waived flag out of one is too little evidence: wait for demoteMinFlags flags at this version.
  if (p.rate === null || p.violates < settings().requirements.demoteMinFlags || p.rate <= PRECISION_MAX_RATE) return;
  // A conditional write: of several waivers racing here, only the one whose update changes the row logs and tells.
  const changed = db.open().prepare("UPDATE requirements SET mode = 'observe', rev = rev + 1, updated_at = ? WHERE id = ? AND mode != 'observe' AND version = ? AND status = 'in_force'").run(now(), x.id, x.version).changes;
  if (!changed) return;
  rebuildEnforcedTools();
  db.addEvent('stam', 'req:demoted', { requirement: x.key, from: x.mode, rate: p.rate, false_positives: p.false_positives, violates: p.violates, window: p.window });
  const text = `${x.key} dropped to observe: ${p.false_positives} of its last ${p.violates} flags were waived as false positives (${Math.round(p.rate * 100)}%, limit ${Math.round(PRECISION_MAX_RATE * 100)}%). To reword it so the model flags only real violations, write a new draft with req_create and link it to this one with the role refines, or ask the human; a new text starts a new count.`;
  if (!x.owner) return;
  if (x.owner === HUMAN) {
    // The human hears in the requirement's own thread (the ITSA of its approval ask), or not at all: never separate mail.
    const ask = db.open().prepare("SELECT i.id FROM itsa_links l JOIN itsas i ON i.id = l.itsa_id WHERE l.system = 'requirement' AND l.external_id = ? ORDER BY i.created_at DESC LIMIT 1").get(x.key) as { id: string } | undefined;
    if (ask) await itsa.post(ask.id, { from_stam: true, body: text });
    return;
  }
  await tellAnywhere(x.owner, text);
}

// The template for an agent's instructions: empty while requirements are off.
export function prompt(): string {
  return enabled() ? render('requirements', {}).trim() : '';
}
