// The requirements check engine (conformity checks, S-461). Given a
// subject (a mail, an ITSA change, ...), it picks the in-force `decision` requirements whose scope
// matches (plain code, no model), reuses cached verdicts (requirement version + subject hash +
// model), asks the decision model once for all the rest (one `choice` question per requirement:
// conforms, violates, na), records a verdict per requirement, and acts by mode: `observe` only
// records; `inform` and `enforce` tell the actor who caused the subject, worded as an indication.
// Fully optional: nothing here reads a table or calls the model while
// settings.requirements.enabled is false. It never throws into a caller and fails open, logging
// a `req:error` event. Requirements live on the ITSA home daemon, so checks run only there; another
// daemon forwards its mail to the home (async) and asks it about a tool call (see "Subjects on a
// non-home daemon").
import { createHash } from 'node:crypto';
import * as db from './db.ts';
import { decide, type Question } from './decide.ts';
import { settings, humanMailAllows, onSettingsChange } from './settings.ts';
import { MACHINE } from './config.ts';
import { peerByName, peers, peerCall, peerNotify } from './peers.ts';
import { HUMAN, tellAnywhere, sendFromStam } from './mail.ts';
import { chiefOfStaff } from './org.ts';
import * as itsa from './itsa.ts';
import * as steps from './steps.ts';
import * as requirements from './requirements.ts';
import { branchDiff } from './itsa-queue.ts';
import type { ExtEvent } from './watch.ts';
import type { Requirement, Verdict, WaiverKind } from './requirements.ts';
import { envVar } from './env.ts';

export type SubjectKind = 'mail' | 'mail-to-human' | 'itsa' | 'branch' | 'tool' | 'event' | 'manual';

// What is checked. `content` is what the model reads; the other fields are facts the scope
// filter reads. `actorId` is the agent to tell about a violation (null: nobody).
export interface CheckSubject {
  kind: SubjectKind;
  // `mail:ID`, `itsa:KEY`, ...: stored on the verdict row.
  ref: string;
  // A readable label stored with the verdict when the ref can't be looked up (a pasted text).
  label?: string;
  content: unknown;
  actor: steps.Actor;
  actorId?: string | null;
  paths?: string[];
  repo?: string;
  // The ITSA's key and its ancestors' keys, for a scope on an ITSA subtree.
  itsa?: string[];
  tool?: string;
  source?: string;
  // An external event's type (`pull_request.opened`).
  type?: string;
  // A branch diff, per file: each requirement reads only the files its path globs match.
  files?: FileDiff[];
  // Record verdicts but tell nobody (a manual check, a tool call).
  silent?: boolean;
}

export interface FileDiff {
  path: string;
  text: string;
}

export interface CheckResult {
  // The stored verdict's number, for req_waive; null if it could not be stored.
  id: number | null;
  key: string;
  verdict: Verdict;
  p_conforms: number | null;
  p_violates: number | null;
  p_na: number | null;
  cached: boolean;
  // What was done about it: `none`, `notified`, or `recorded` (observe).
  action: string;
  // Set when the verdict was waived: it stays, marked, and nobody is told about it again.
  waived?: WaiverKind;
}

// The decision model's limits (measured, S-461): per question prompt, and
// the state plus all questions of one call. Tokens are estimated at 4 characters each.
export interface Limits {
  questionTokens: number;
  callTokens: number;
}
export const LIMITS: Limits = { questionTokens: 32_768, callTokens: 64_000 };
const tokens = (s: string) => Math.ceil(s.length / 4);

const CRITERIA = {
  conforms: 'The subject satisfies the requirement.',
  violates: 'The subject breaks the requirement.',
  na: 'The requirement does not apply to this subject.',
};
// P(violates) of at least this, and below the requirement's threshold, is `unsure`.
const UNSURE_FROM = 0.5;

// --- Scope filter ----------------------------------------------------------------------------

const globCache = new Map<string, RegExp>();
function globToRegExp(glob: string): RegExp {
  let re = globCache.get(glob);
  if (re) return re;
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          out += '(?:.*/)?';
        } else out += '.*';
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  re = new RegExp(`^${out}$`);
  globCache.set(glob, re);
  return re;
}
export const globMatch = (glob: string, path: string): boolean => globToRegExp(glob).test(path);

// Whether a requirement's scope applies to the subject. A missing scope field filters nothing; a
// present one needs the subject to carry the fact and match it.
export function inScope(req: Requirement, s: CheckSubject): boolean {
  const sc = req.scope;
  if (!sc) return true;
  if (sc.subjects?.length && !sc.subjects.includes(s.kind) && !(s.kind === 'mail-to-human' && sc.subjects.includes('mail'))) return false;
  if (sc.paths?.length && !(s.paths ?? []).some((p) => sc.paths!.some((g) => globMatch(g, p)))) return false;
  if (sc.repos?.length && !(s.repo && sc.repos.includes(s.repo))) return false;
  if (sc.roles?.length && !(s.actor.role && sc.roles.includes(s.actor.role))) return false;
  if (sc.agents?.length && !sc.agents.includes(s.actor.name)) return false;
  if (sc.itsa?.length && !(s.itsa ?? []).some((k) => sc.itsa!.includes(k))) return false;
  if (sc.tools?.length && !(s.tool && sc.tools.includes(s.tool))) return false;
  if (sc.sources?.length && !(s.source && sc.sources.includes(s.source))) return false;
  if (sc.types?.length && !(s.type && sc.types.some((g) => globMatch(g, s.type!)))) return false;
  return true;
}

const usesDecision = (r: Requirement) => (r.verification ?? []).some((v) => v.method === 'decision');

// --- Verdict from probabilities --------------------------------------------------------------

export function verdictOf(p: { conforms: number; violates: number; na: number }, threshold: number): Verdict {
  if (p.violates >= threshold) return 'violates';
  if (p.violates >= UNSURE_FROM) return 'unsure';
  if (p.na > p.conforms && p.na > p.violates) return 'na';
  return 'conforms';
}

// --- Cost cap --------------------------------------------------------------------------------

const today = () => new Date().toISOString().slice(0, 10);

// Today's spend on requirement checks, from the `decide` events (UTC day).
export function spentToday(): number {
  const r = db
    .open()
    .prepare("SELECT SUM(json_extract(data, '$.cost')) AS c FROM events WHERE type = 'decide' AND ts >= ? AND json_extract(data, '$.purpose') LIKE 'decide:req:%'")
    .get(`${today()}T00:00:00`) as { c: number | null };
  return Number(r.c) || 0;
}

// One notice a day when the cap stops checks: stam's own mail to the chief of staff when there is
// one, else to the human (held back by the human's mail settings like the other stam notices).
function capNotice(spent: number, cap: number): void {
  const since = `${today()}T00:00:00`;
  if (db.open().prepare("SELECT 1 FROM events WHERE type = 'req:cap' AND ts >= ?").get(since)) return;
  db.addEvent('stam', 'req:cap', { spent, cap });
  const body = `Requirement checks stopped for today: they spent $${spent.toFixed(4)} of the $${cap} daily cap (settings.requirements.dailyCapUsd). Verdicts already stored still count; nothing new is recorded until tomorrow or the cap is raised.`;
  const subject = '[stam] Requirement checks reached the daily cap';
  const cos = chiefOfStaff();
  if (cos) return void sendFromStam([cos.id], subject, body).catch(() => {});
  if (humanMailAllows('important')) void sendFromStam([HUMAN], subject, body).catch(() => {});
}

// --- The check -------------------------------------------------------------------------------

// `{ waived: kind }` for a stored verdict that was waived, else nothing.
const waivedField = (id: number | null): { waived?: WaiverKind } => {
  const kind = requirements.waiverKind(id);
  return kind ? { waived: kind } : {};
};

const hashOf = (state: unknown): string => createHash('sha256').update(typeof state === 'string' ? state : JSON.stringify(state)).digest('hex').slice(0, 32);

interface Asked {
  req: Requirement;
  p: { conforms: number; violates: number; na: number };
  cost: number;
}

// Splits a state too large for one question into text parts that fit.
function chunks(content: unknown, maxChars: number): unknown[] {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  if (text.length <= maxChars) return [content];
  const out: string[] = [];
  for (let at = 0; at < text.length; ) {
    let end = Math.min(text.length, at + maxChars);
    // Break at a line end when one is near, so a part reads as text.
    const nl = text.lastIndexOf('\n', end);
    if (end < text.length && nl > at + maxChars / 2) end = nl + 1;
    out.push(text.slice(at, end));
    at = end;
  }
  return out;
}

const questionFor = (r: Requirement): Question => ({
  type: 'choice',
  instructions: `Requirement: ${r.text ?? r.title}`,
  criteria: CRITERIA,
});

// Calls to the model go one at a time, so the daily cap is checked against spend that includes
// every earlier call (concurrent checks can't all pass it).
let gate: Promise<unknown> = Promise.resolve();
const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = gate.then(fn, fn);
  gate = next.catch(() => {});
  return next;
};

// Asks the model about `reqs` over one state part, in as few calls as the limits allow. Returns
// what it got; a requirement whose call failed or whose question can't fit the limits is missing
// from the result (the latter is logged as `req:error`).
async function askAll(kind: SubjectKind, state: Record<string, unknown>, reqs: Requirement[], limits: Limits, cap: number, timeoutMs?: number, preview = false): Promise<Asked[]> {
  const stateTokens = tokens(JSON.stringify(state));
  const qs: { req: Requirement; q: Question; t: number }[] = [];
  for (const r of reqs) {
    const q = questionFor(r);
    const t = tokens(JSON.stringify(q)) + 8;
    if (stateTokens + t > limits.questionTokens || stateTokens + t > limits.callTokens) {
      db.addEvent('stam', 'req:error', { requirement: r.key, error: `the question doesn't fit the model's limits (${stateTokens + t} tokens)` });
      continue;
    }
    qs.push({ req: r, q, t });
  }
  const groups: (typeof qs)[] = [];
  let cur: typeof qs = [];
  let used = stateTokens;
  for (const x of qs) {
    if (cur.length && used + x.t > limits.callTokens) {
      groups.push(cur);
      cur = [];
      used = stateTokens;
    }
    cur.push(x);
    used += x.t;
  }
  if (cur.length) groups.push(cur);
  const out: Asked[] = [];
  for (const g of groups) {
    const names = Object.fromEntries(g.map((x) => [x.req.key, x.q]));
    const result = await serialized(async () => {
      const spent = spentToday();
      if (spent >= cap) {
        // A preview tells nobody, not even about the cap.
        if (!preview) capNotice(spent, cap);
        return null;
      }
      return decide(state, names, { purpose: preview ? 'decide:req:preview' : `decide:req:${kind}`, timeoutMs }).catch(() => null);
    });
    if (!result) continue;
    const each = (Number(result.usage?.cost) || 0) / g.length;
    for (const x of g) {
      const probs = result.answers?.[x.req.key]?.probabilities;
      const nums = ['conforms', 'violates', 'na'].map((k) => probs?.[k]);
      if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)) continue;
      out.push({ req: x.req, p: { conforms: nums[0], violates: nums[1], na: nums[2] }, cost: each });
    }
  }
  return out;
}

// Checks one subject against the requirements in scope. Returns a result per requirement that
// got a verdict (cached or new). Never throws; any failure is logged and gives what it has.
export interface CheckOptions {
  limits?: Limits;
  // Only these requirements (keys or ids).
  keys?: string[];
  // Only requirements this accepts (after the scope filter).
  filter?: (r: Requirement) => boolean;
  timeoutMs?: number;
  // A preview of these requirements, whatever their status: asks the model (cost under
  // `decide:req:preview`, the daily cap applies), records nothing, tells nobody.
  preview?: Requirement[];
}

const isHome = (): boolean => (settings().itsa.home ?? MACHINE) === MACHINE;

export async function check(subject: CheckSubject, opts: CheckOptions = {}): Promise<CheckResult[]> {
  if (!requirements.enabled() || !isHome()) return [];
  try {
    return await run(subject, opts);
  } catch (e) {
    db.addEvent('stam', 'req:error', { subject: subject.ref, error: e instanceof Error ? e.message : String(e) });
    return [];
  }
}

// What the model reads for a set of requirements: the whole subject, or for a branch diff only
// the files the requirements' path globs match, so requirements with the same files share a view.
interface View {
  content: unknown;
  reqs: Requirement[];
}

function viewsOf(subject: CheckSubject, reqs: Requirement[]): View[] {
  if (!subject.files) return [{ content: subject.content, reqs }];
  const groups = new Map<string, { files: FileDiff[]; reqs: Requirement[] }>();
  for (const r of reqs) {
    const globs = r.scope?.paths;
    const files = globs?.length ? subject.files.filter((f) => globs.some((g) => globMatch(g, f.path))) : subject.files;
    if (!files.length) continue;
    const key = files.map((f) => f.path).join('\0');
    const g = groups.get(key) ?? { files, reqs: [] };
    g.reqs.push(r);
    groups.set(key, g);
  }
  const head = typeof subject.content === 'string' ? subject.content : JSON.stringify(subject.content);
  return [...groups.values()].map((g) => ({ content: `${head}\n\n${g.files.map((f) => `=== ${f.path}\n${f.text}`).join('\n')}`, reqs: g.reqs }));
}

async function run(subject: CheckSubject, opts: CheckOptions): Promise<CheckResult[]> {
  const keys = opts.keys;
  const inForce = (opts.preview ?? requirements.list({ status: 'in_force' }))
    .filter((r) => usesDecision(r) && inScope(r, subject) && (!keys || keys.includes(r.key) || keys.includes(r.id)) && (!opts.filter || opts.filter(r)));
  if (!inForce.length) return [];
  const results: CheckResult[] = [];
  const notify: { req: Requirement; p: number }[] = [];
  for (const view of viewsOf(subject, inForce)) results.push(...(await runView(subject, view, opts, notify)));
  if (notify.length && subject.actorId && subject.actorId !== HUMAN && !opts.preview) tellActor(subject, notify);
  return results;
}

async function runView(subject: CheckSubject, view: View, opts: CheckOptions, notify: { req: Requirement; p: number }[]): Promise<CheckResult[]> {
  const limits = opts.limits ?? LIMITS;
  const model = settings().decisions.model;
  const cap = settings().requirements.dailyCapUsd;
  const baseState = { kind: subject.kind, content: view.content, actor: subject.actor };
  const hash = hashOf(baseState);

  const results: CheckResult[] = [];
  const misses: Requirement[] = [];
  for (const r of view.reqs) {
    const c = requirements.cachedVerdict(r.id, r.version, hash, model);
    if (c) results.push({ id: c.id, key: r.key, verdict: c.verdict, p_conforms: c.p_conforms, p_violates: c.p_violates, p_na: c.p_na, cached: true, action: c.action ?? 'none', ...waivedField(c.id) });
    else misses.push(r);
  }
  if (!misses.length) return results;
  if (spentToday() >= cap) {
    if (!opts.preview) capNotice(spentToday(), cap);
    return results;
  }

  // The state is split into parts when the content is too big for one question; each part is
  // asked about every requirement, and the parts' answers merge (violates is the highest seen,
  // n/a only if it is n/a everywhere). The limits are measured on the serialized state, so a part
  // is shrunk until JSON escaping fits too. A requirement is recorded only when every part got
  // its answer: a partial result is never cached under the whole subject's hash.
  const maxQuestion = Math.max(...misses.map((r) => tokens(JSON.stringify(questionFor(r))) + 8));
  const stateOf = (content: unknown, part?: string) => (part ? { ...baseState, content, part } : baseState);
  let maxChars = Math.max(1000, (limits.questionTokens - maxQuestion) * 4);
  let parts = chunks(view.content, maxChars);
  for (let guard = 0; guard < 20; guard++) {
    const worst = Math.max(...parts.map((c, i) => tokens(JSON.stringify(stateOf(c, parts.length > 1 ? `${i + 1}/${parts.length}` : undefined)))));
    if (worst + maxQuestion <= Math.min(limits.questionTokens, limits.callTokens)) break;
    if (maxChars <= 200) throw new Error(`the subject can't be split under the model's limits (${worst} tokens a part)`);
    maxChars = Math.floor(maxChars * Math.max(0.3, Math.min(0.9, (limits.questionTokens - maxQuestion) / worst)));
    parts = chunks(view.content, Math.max(200, maxChars));
  }
  const merged = new Map<string, Asked & { parts: number }>();
  for (let i = 0; i < parts.length; i++) {
    const state = stateOf(parts[i], parts.length > 1 ? `${i + 1}/${parts.length}` : undefined);
    for (const a of await askAll(subject.kind, state, misses, limits, cap, opts.timeoutMs, Boolean(opts.preview))) {
      const m = merged.get(a.req.key);
      if (!m) merged.set(a.req.key, { ...a, parts: 1 });
      else {
        const violates = Math.max(m.p.violates, a.p.violates);
        const na = Math.min(m.p.na, a.p.na);
        m.p = { violates, na, conforms: Math.max(0, 1 - violates - na) };
        m.cost += a.cost;
        m.parts++;
      }
    }
  }
  for (const [k, m] of merged) if (m.parts < parts.length) merged.delete(k);

  for (const a of merged.values()) {
    const verdict = verdictOf(a.p, a.req.threshold);
    // A subject whose verdict on this requirement was waived is not told about again.
    const tell = !opts.preview && !subject.silent && verdict === 'violates' && a.req.mode !== 'observe' && !requirements.waivedOn(a.req.id, subject.ref);
    const action = tell ? 'notified' : a.req.mode === 'observe' ? 'recorded' : 'none';
    if (opts.preview) {
      results.push({ id: null, key: a.req.key, verdict, p_conforms: a.p.conforms, p_violates: a.p.violates, p_na: a.p.na, cached: false, action: 'none' });
      continue;
    }
    const id = requirements.recordVerdict({
      req_id: a.req.id, req_version: a.req.version, subject: subject.ref, subject_hash: hash, subject_label: subject.label ?? null, model,
      verdict, p_conforms: a.p.conforms, p_violates: a.p.violates, p_na: a.p.na, action, cost: a.cost,
    });
    results.push({ id, key: a.req.key, verdict, p_conforms: a.p.conforms, p_violates: a.p.violates, p_na: a.p.na, cached: false, action });
    if (tell) notify.push({ req: a.req, p: a.p.violates });
  }
  return results;
}

// The notice to the actor: an indication from a model, never a finding of fact.
function tellActor(subject: CheckSubject, hits: { req: Requirement; p: number }[]): void {
  const lines = hits.map((h) => {
    const owner = h.req.owner ? steps.actorOf(h.req.owner).name : HUMAN;
    return `${h.req.key} likely not met (p ${h.p.toFixed(2)}): ${h.req.text ?? h.req.title}. If this is wrong, say so to the requirement's owner (${owner}).`;
  });
  const text = `A model check of your ${subject.ref} found ${hits.length > 1 ? 'these likely problems' : 'a likely problem'}. It is an indication, not proof.\n\n${lines.join('\n')}`;
  void tellAnywhere(subject.actorId!, text).catch(() => {});
}

// --- Subjects, and the hooks that feed them ---------------------------------------------------

export function mailSubject(m: { id: string; from_id: string; subject: string; body: string; thread_id?: string | null }, toHuman: boolean): CheckSubject {
  const s = steps.mailSubject(m);
  return { kind: toHuman ? 'mail-to-human' : 'mail', ref: s.ref, content: s.payload, actor: s.actor, actorId: m.from_id };
}

// Called after a mail is stored. Async, off the send path; stam's own mail, permission requests,
// and the human's mail are not checked.
export function maybeCheckMail(m: db.Mail & { thread_id?: string | null }, toHuman: boolean, fromStam = false): void {
  if (fromStam || m.permission_id || m.from_id === HUMAN || !requirements.enabled()) return;
  if (!isHome()) return forwardSubject(mailSubject(m, toHuman));
  void check(mailSubject(m, toHuman));
}

function itsaKeys(x: itsa.Itsa): string[] {
  const keys = [x.key];
  const seen = new Set<string>([x.id]);
  for (let p = x.parent_id ? itsa.find(x.parent_id) : undefined; p && !seen.has(p.id); p = p.parent_id ? itsa.find(p.parent_id) : undefined) {
    seen.add(p.id);
    keys.push(p.key);
  }
  return keys;
}

export function itsaSubject(c: itsa.ItsaChange & { type: 'created' | 'status' | 'edit' }): CheckSubject {
  const s = c.type === 'status' ? steps.itsaStatusSubject(c.itsa, c.from, c.to, c.actor) : { ...steps.itsaCreatedSubject(c.itsa), actor: steps.actorOf(c.actor) };
  return { kind: 'itsa', ref: s.ref, content: { event: c.type, ...s.payload }, actor: s.actor, actorId: c.actor, itsa: itsaKeys(c.itsa) };
}

// A branch's diff as a subject: the files go in per file so each requirement reads only the files
// its path globs match. Null when the diff can't be read (the check is skipped).
export async function branchSubject(x: itsa.Itsa, repo: string, branch: string, silent = false): Promise<CheckSubject | null> {
  const diff = await branchDiff(repo, branch);
  if (!diff) return null;
  return {
    kind: 'branch',
    ref: `branch:${repo}/${branch}@${diff.head}`,
    content: { itsa: x.key, title: x.title, repo, branch, head: diff.head, files: diff.files.map((f) => f.path) },
    actor: steps.actorOf(x.owner),
    actorId: x.owner,
    paths: diff.files.map((f) => f.path),
    repo,
    itsa: itsaKeys(x),
    files: diff.files,
    silent,
  };
}

// An ITSA entered ready_to_merge: check each linked branch's diff against main, once per head
// commit (the cache holds the verdict while the files a requirement reads are unchanged).
async function checkBranches(x: itsa.Itsa): Promise<void> {
  for (const l of itsa.links(x.id)) {
    if (l.system !== 'branch' || !l.external_id || !l.meta?.repo) continue;
    const s = await branchSubject(x, l.meta.repo, l.external_id);
    if (s) await check(s);
  }
}

// A tool call, before it runs: only `enforce` requirements scoped to that tool are asked. A
// violation denies the call with an error naming the requirement; anything else (no requirement,
// a model failure, running out of time) allows it. The denial is the actor's notice.
export type ToolVerdict = { allow: boolean; requirement?: string; p?: number; error?: string };
export async function checkTool(agentId: string, tool: string, args: Record<string, unknown>, budgetMs: number, actor?: steps.Actor): Promise<ToolVerdict> {
  if (!requirements.enabled() || budgetMs <= 0) return { allow: true };
  if (!isHome()) return remoteCheckTool(agentId, tool, args, budgetMs);
  // The index is built at daemon start and on every change, off this path. Cold (just turned on),
  // the call goes through and the index is built right after; a failed lookup also lets it through.
  try {
    if (!requirements.enforcedToolsReady()) {
      setImmediate(() => warm());
      return { allow: true };
    }
    if (!requirements.enforcedTools().has(tool)) return { allow: true };
  } catch {
    return { allow: true };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const subject: CheckSubject = {
      kind: 'tool', ref: `tool:${tool}`, content: { tool, arguments: args }, actor: actor ?? steps.actorOf(agentId), actorId: agentId, tool, silent: true,
    };
    const asked = check(subject, { filter: (r) => r.mode === 'enforce' && Boolean(r.scope?.tools?.includes(tool)), timeoutMs: Math.min(5_000, budgetMs) });
    const late = new Promise<CheckResult[]>((resolve) => (timer = setTimeout(() => resolve([]), budgetMs)));
    const hit = (await Promise.race([asked, late])).find((r) => r.verdict === 'violates' && !r.waived);
    if (!hit) return { allow: true };
    const r = requirements.find(hit.key);
    const owner = r?.owner ? steps.actorOf(r.owner).name : HUMAN;
    const p = hit.p_violates ?? 0;
    return {
      allow: false,
      requirement: hit.key,
      p,
      error: `Denied by requirement ${hit.key} (likely not met, p ${p.toFixed(2)}): ${r?.text ?? r?.title ?? ''}. This is an indication from a model check, not proof. If it is wrong, say so to the requirement's owner (${owner}).`,
    };
  } catch (e) {
    db.addEvent('stam', 'req:error', { subject: `tool:${tool}`, error: e instanceof Error ? e.message : String(e) });
    return { allow: true };
  } finally {
    clearTimeout(timer);
  }
}

// An external event (src/watch.ts ingest), after it is stored. Nobody is told: its actor is a
// person on another system, not an agent.
export function checkEvent(ev: ExtEvent): Promise<void> {
  if (!requirements.enabled()) return Promise.resolve();
  return check({
    kind: 'event',
    ref: `event:${ev.id}`,
    content: { source: ev.source, type: ev.type, subjects: ev.subjects, actor: ev.actor, summary: ev.summary, url: ev.url, payload: ev.payload },
    actor: { name: ev.actor ?? ev.source, role: null, parent: null },
    source: ev.source,
    type: ev.type,
  }).then(() => {});
}

// A check on demand (POST /api/requirements/check, `stam req check`): pasted `text`, or a
// `subject` naming a mail (`mail:ID`), an ITSA (`itsa:KEY`), or a branch (`branch:REPO/NAME`).
// `keys` limits it to named requirements. Records verdicts, tells nobody. Bad input throws; a
// failed check is an empty list, as everywhere.
export async function manual(input: { subject?: unknown; text?: unknown; keys?: unknown }): Promise<{ subject: string; results: CheckResult[] }> {
  if (!requirements.enabled()) throw new requirements.RequirementsOffError(requirements.OFF_MESSAGE);
  const keys = input.keys === undefined || input.keys === null ? undefined : Array.isArray(input.keys) ? input.keys.map(String) : String(input.keys).split(',').map((k) => k.trim()).filter(Boolean);
  const actor = steps.actorOf(HUMAN);
  let subject: CheckSubject;
  const ref = typeof input.subject === 'string' ? input.subject.trim() : '';
  if (typeof input.text === 'string' && input.text.trim()) {
    subject = { kind: 'manual', ref: `text:${hashOf(input.text)}`, label: requirements.clip(input.text), content: input.text, actor, silent: true };
  } else if (ref.startsWith('mail:')) {
    const m = db.getMail(ref.slice(5));
    if (!m) throw new Error(`no mail ${ref.slice(5)}`);
    subject = { ...mailSubject(m, false), silent: true };
  } else if (ref.startsWith('itsa:')) {
    const x = itsa.find(ref.slice(5));
    if (!x) throw new Error(`no ITSA ${ref.slice(5)}`);
    const s = steps.itsaCreatedSubject(x);
    subject = { kind: 'itsa', ref: s.ref, content: { event: 'manual', ...s.payload }, actor, itsa: itsaKeys(x), silent: true };
  } else if (ref.startsWith('branch:')) {
    const m = /^branch:([^/]+)\/(.+)$/.exec(ref);
    if (!m) throw new Error('a branch subject is branch:REPO/NAME');
    const diff = await branchDiff(m[1], m[2]);
    if (!diff) throw new Error(`can't read the diff of ${m[2]} in ${m[1]}`);
    subject = {
      kind: 'branch', ref: `branch:${m[1]}/${m[2]}@${diff.head}`, content: { repo: m[1], branch: m[2], head: diff.head, files: diff.files.map((f) => f.path) },
      actor, paths: diff.files.map((f) => f.path), repo: m[1], files: diff.files, silent: true,
    };
  } else throw new Error('give a text, or a subject: mail:ID, itsa:KEY, or branch:REPO/NAME');
  return { subject: subject.ref, results: await check(subject, { keys }) };
}

// Builds the enforced-tools index (see checkTool); never throws.
export function warm(): void {
  try {
    if (requirements.enabled()) requirements.enforcedTools();
  } catch (e) {
    db.addEvent('stam', 'req:error', { error: `index: ${e instanceof Error ? e.message : String(e)}` });
  }
}

// Connects the ITSA events; called once at daemon start, next to steps.watch().
export function watch(): void {
  warm();
  watchRemote();
  itsa.onChange((c) => {
    if (c.type === 'created' || c.type === 'status' || c.type === 'edit') {
      if (!requirements.enabled()) return;
      void check(itsaSubject(c));
      if (c.type === 'status' && c.to === 'ready_to_merge') void checkBranches(c.itsa).catch((e) => db.addEvent('stam', 'req:error', { subject: `itsa:${c.itsa.key}`, error: String(e?.message ?? e) }));
    }
  });
}

// --- Subjects on a non-home daemon ------------------------------------------------------------
// The requirement tables are on the ITSA home, so another daemon forwards: a mail subject goes
// to the home, async and fire-and-forget (the home checks it and tells the actor wherever the
// actor lives); a tool call is asked of the home in the time left, but only for a tool in the
// copy of the home's enforced-tools index this daemon keeps. A forward never delays or fails the
// caller; an unreachable home logs a `req:error` event and the check is dropped (tool: allowed).

const forwardError = (ref: string, e: unknown) => db.addEvent('stam', 'req:error', { subject: ref, error: `home: ${e instanceof Error ? e.message : String(e)}` });
const homePeer = () => peerByName(settings().itsa.home ?? '');

function forwardSubject(subject: CheckSubject): void {
  const home = homePeer();
  if (!home) return forwardError(subject.ref, `the ITSA home '${settings().itsa.home}' is not a configured peer`);
  peerCall(home, 'POST', '/api/requirements/check-subject', { subject }, 10_000).then(
    (r) => void (r.status >= 300 && forwardError(subject.ref, `answered ${r.status}: ${r.data?.error ?? ''}`)),
    (e) => forwardError(subject.ref, e),
  );
}

const SUBJECT_KINDS: SubjectKind[] = ['mail', 'mail-to-human'];

// The home's side of a forward: a subject from a peer, checked off the request. Only mail kinds
// are taken, so a peer can't make the home check anything else on its say. Returns whether it was taken.
export function acceptForwarded(input: unknown): boolean {
  const s = input as Partial<CheckSubject> | null;
  const a = s?.actor;
  if (!s || typeof s !== 'object' || !SUBJECT_KINDS.includes(s.kind as SubjectKind) || typeof s.ref !== 'string' || !a || typeof a.name !== 'string') return false;
  if (!requirements.enabled() || !isHome()) return false;
  const actor: steps.Actor = { name: a.name, role: typeof a.role === 'string' ? a.role : null, parent: typeof a.parent === 'string' ? a.parent : null };
  void check({ kind: s.kind as SubjectKind, ref: s.ref, content: s.content, actor, actorId: typeof s.actorId === 'string' ? s.actorId : null });
  return true;
}

// The home's answer for a tool call from a peer.
export function toolFromPeer(body: any): Promise<ToolVerdict> {
  const a = body?.actor;
  const actor: steps.Actor | undefined = a && typeof a.name === 'string' ? { name: a.name, role: typeof a.role === 'string' ? a.role : null, parent: typeof a.parent === 'string' ? a.parent : null } : undefined;
  if (typeof body?.agent !== 'string' || typeof body?.tool !== 'string' || !isHome()) return Promise.resolve({ allow: true });
  const budget = Math.min(Number(body.budgetMs) || 0, 7_000);
  return checkTool(body.agent, body.tool, body.args && typeof body.args === 'object' ? body.args : {}, budget, actor);
}

// The copy of the home's enforced-tools index; null until first fetched.
let remoteIndex: Set<string> | null = null;
let fetching = false;
const INDEX_POLL_MS = Number(envVar('REQ_INDEX_MS')) || 60_000;

export function enforcedToolsList(): string[] {
  return [...requirements.enforcedTools()].sort();
}

export async function fetchRemoteIndex(): Promise<void> {
  if (isHome() || !requirements.enabled() || fetching) return;
  fetching = true;
  try {
    const home = homePeer();
    if (!home) throw new Error(`the ITSA home '${settings().itsa.home}' is not a configured peer`);
    const r = await peerCall(home, 'GET', '/api/requirements/enforced-tools', undefined, 5_000);
    if (r.status !== 200 || !Array.isArray(r.data?.tools)) throw new Error(`answered ${r.status}: ${r.data?.error ?? ''}`);
    remoteIndex = new Set(r.data.tools.filter((t: unknown): t is string => typeof t === 'string'));
  } catch (e) {
    forwardError('index', e);
  } finally {
    fetching = false;
  }
}

async function remoteCheckTool(agentId: string, tool: string, args: Record<string, unknown>, budgetMs: number): Promise<ToolVerdict> {
  if (!remoteIndex) {
    void fetchRemoteIndex();
    return { allow: true };
  }
  if (!remoteIndex.has(tool)) return { allow: true };
  const ref = `tool:${tool}`;
  try {
    const home = homePeer();
    if (!home) throw new Error(`the ITSA home '${settings().itsa.home}' is not a configured peer`);
    const r = await peerCall(home, 'POST', '/api/requirements/check-tool', { agent: agentId, actor: steps.actorOf(agentId), tool, args, budgetMs }, budgetMs);
    if (r.status !== 200) throw new Error(`answered ${r.status}: ${r.data?.error ?? ''}`);
    return r.data?.allow === false && typeof r.data.error === 'string' ? { allow: false, requirement: r.data.requirement, p: r.data.p, error: r.data.error } : { allow: true };
  } catch (e) {
    forwardError(ref, e);
    return { allow: true };
  }
}

function watchRemote(): void {
  // The home tells its peers when the index changes; a peer also fetches at boot and every minute.
  requirements.onEnforcedToolsChange(() => {
    if (!isHome() || !requirements.enabled()) return;
    for (const p of peers()) peerNotify(p, 'POST', '/api/requirements/enforced-tools/changed', {}, 3_000);
  });
  // A synced setting that turns requirements on (the cache write) brings the first fetch.
  onSettingsChange(() => void (!remoteIndex && fetchRemoteIndex()));
  void fetchRemoteIndex();
  setInterval(() => void fetchRemoteIndex(), INDEX_POLL_MS).unref();
}

// --- Preview ---------------------------------------------------------------------------------

export const PREVIEW_DEFAULT = 20;
export const PREVIEW_MAX = 50;

export interface PreviewRow {
  subject: string;
  summary: string;
  // Absent when the model gave no answer (a failure, or the daily cap).
  verdict?: Verdict;
  p_conforms?: number | null;
  p_violates?: number | null;
  p_na?: number | null;
  // Whether a live check would act on it: it violates and the requirement is past `observe`.
  would_act?: boolean;
  error?: string;
}

interface Candidate {
  subject: CheckSubject;
  summary: string;
}

// The last `want` real subjects of each kind the requirement's scope names (mail and ITSAs when
// it names none), newest first within a kind, built the way the live hooks build them.
async function candidates(r: Requirement, want: number): Promise<Candidate[]> {
  const kinds = new Set(r.scope?.subjects?.length ? r.scope.subjects : ['mail', 'itsa']);
  const d = db.open();
  const perKind: Candidate[][] = [];
  if (kinds.has('mail')) {
    const rows = d
      .prepare("SELECT id, from_id, subject, body, thread_id FROM mail WHERE from_id != ? AND permission_id IS NULL AND subject NOT LIKE '[stam]%' ORDER BY created_at DESC LIMIT ?")
      .all(HUMAN, want) as { id: string; from_id: string; subject: string; body: string; thread_id: string }[];
    perKind.push(rows.map((m) => ({ subject: mailSubject(m, false), summary: m.subject })));
  }
  if (kinds.has('mail-to-human')) {
    const { subjects } = steps.examples({ kind: 'event', event: 'mail-to-human' }, want);
    perKind.push(subjects.map((s) => ({ subject: { kind: 'mail-to-human', ref: s.ref, content: s.payload, actor: s.actor }, summary: s.summary })));
  }
  if (kinds.has('itsa')) {
    const made = steps.examples({ kind: 'event', event: 'itsa-created' }, want).subjects.map((s) => ({ s, event: 'created' }));
    const moved = steps.examples({ kind: 'event', event: 'itsa-status' }, want).subjects.map((s) => ({ s, event: 'status' }));
    const out: Candidate[] = [];
    for (let i = 0; i < Math.max(made.length, moved.length); i++)
      for (const x of [made[i], moved[i]])
        if (x) {
          const key = String((x.s.payload as { key?: unknown }).key ?? '');
          const it = itsa.find(key);
          out.push({ subject: { kind: 'itsa', ref: x.s.ref, content: { event: x.event, ...x.s.payload }, actor: x.s.actor, itsa: it ? itsaKeys(it) : [key] }, summary: x.s.summary });
        }
    perKind.push(out.slice(0, want));
  }
  if (kinds.has('branch')) {
    const rows = d
      .prepare("SELECT i.id, l.external_id AS branch, l.meta FROM itsa_links l JOIN itsas i ON i.id = l.itsa_id WHERE l.system = 'branch' AND l.external_id IS NOT NULL ORDER BY i.updated_at DESC LIMIT ?")
      .all(want) as { id: string; branch: string; meta: string | null }[];
    const out: Candidate[] = [];
    for (const row of rows) {
      let repo: string | undefined;
      try {
        repo = JSON.parse(row.meta ?? '{}').repo;
      } catch {}
      const x = itsa.find(row.id);
      if (!x || !repo) continue;
      const s = await branchSubject(x, repo, row.branch, true).catch(() => null);
      if (s) out.push({ subject: s, summary: `${x.key} ${row.branch}` });
    }
    perKind.push(out);
  }
  // Interleave the kinds, so a scope with several shows each.
  const merged: Candidate[] = [];
  for (let i = 0; perKind.some((k) => i < k.length); i++) for (const k of perKind) if (k[i]) merged.push(k[i]);
  return merged;
}

// Runs one requirement on the last `n` real subjects of its scope and returns the verdict per
// subject. Records nothing and tells nobody; the model's cost is `decide:req:preview` and the
// daily cap applies. Bad input throws; a model failure is an `error` on that subject.
export async function preview(ref: string, n?: unknown): Promise<{ key: string; n: number; rows: PreviewRow[]; note?: string }> {
  if (!requirements.enabled()) throw new requirements.RequirementsOffError(requirements.OFF_MESSAGE);
  const r = requirements.must(ref);
  const count = Math.max(1, Math.min(PREVIEW_MAX, Math.floor(Number(n)) || PREVIEW_DEFAULT));
  if (!usesDecision(r)) return { key: r.key, n: count, rows: [], note: `${r.key} has no decision method, so there is nothing a model would check` };
  // The scope filter drops some subjects, so look at more than n before it.
  const pool = (await candidates(r, Math.min(PREVIEW_MAX * 3, count * 3))).filter((c) => inScope(r, c.subject));
  const rows: PreviewRow[] = [];
  let note: string | undefined;
  for (const c of pool.slice(0, count)) {
    const [res] = await check(c.subject, { preview: [r], keys: [r.key] });
    if (res) rows.push({ subject: c.subject.ref, summary: c.summary, verdict: res.verdict, p_conforms: res.p_conforms, p_violates: res.p_violates, p_na: res.p_na, would_act: res.verdict === 'violates' && r.mode !== 'observe' });
    else rows.push({ subject: c.subject.ref, summary: c.summary, error: 'the model gave no answer' });
  }
  if (!pool.length) note = `no recent subject in the scope of ${r.key}`;
  else if (spentToday() >= settings().requirements.dailyCapUsd) note = 'the daily cap was reached; the rest got no answer';
  return note ? { key: r.key, n: count, rows, note } : { key: r.key, n: count, rows };
}
