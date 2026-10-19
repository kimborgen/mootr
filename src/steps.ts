// Decision steps: custom yes/no checks the human writes in their own words. A step has a
// trigger (a tool call or a stam event), a question asked of the decision model as a `noul`
// question (src/decide.ts), a threshold, and an action. "Yes" means P(yes) >= threshold.
//
//   trigger   {kind: 'tool', tool: NAME}    an MCP tool from the catalogue (GET /api/tools)
//             {kind: 'event', event: E}     E in EVENTS: mail-to-human, itsa-created,
//                                           itsa-status, agent-spawned
//   action    tool triggers:  approve-if-yes (allow only on yes), deny-if-yes (deny on yes)
//             event triggers: flag (record), notify (mail the human, if settings.humanMail
//                             allows 'important'), annotate (record on the subject: a
//                             step_decisions row, and an ITSA event for an ITSA)
//
// The state given to the model is JSON: the tool's arguments or the event's payload, plus
// who did it ({name, role, parent}). Event steps run after the event commits, off its path:
// they never block or fail it, and a model error or timeout is logged and changes nothing.
// Tool steps are checked by `checkTool`, which fails open. mcp.ts asks the daemon before each
// tool runs (POST /api/steps/check) and withholds the call on a denial; a failed check runs the
// tool anyway.
// Every run is a row of step_decisions; the cost goes to usage as `decide:step:<id>`.
//
// HTTP API (src/daemon.ts):
//   GET    /api/steps                     -> {steps: Step[], events: EVENTS}
//   POST   /api/steps {name, trigger, question, threshold?, action, enabled?} -> Step
//   GET    /api/steps/:id                 -> Step
//   PATCH  /api/steps/:id {any of the create fields} -> Step
//   DELETE /api/steps/:id                 -> {removed: id}
//   POST   /api/steps/:id/preview {n?}    -> {examples: [{subject, summary, p, answer, error?}], note?}
//                                            runs the question on the last n (default 5, at
//                                            most 20) real examples; takes no action, logs nothing
//   GET    /api/steps/:id/log?limit=      -> {decisions: Decision[]} newest first
//   GET    /api/steps/decisions?subject=  -> {decisions: Decision[]} every step's, on a subject
//   POST   /api/steps/check {agent, tool, args} -> ToolCheck {allow, step?, question?, p?, error?}
//                                            checks a tool call before it runs; `agent` must be a
//                                            registered agent. Every call is kept in the tool
//                                            history (the last 50 per tool), steps or not.
// Built-in steps (`builtin` set) can be turned off and edited but not deleted.
import { randomBytes } from 'node:crypto';
import * as db from './db.ts';
import { decide, noul } from './decide.ts';
import { humanMailAllows } from './settings.ts';
import { HUMAN, onMailToHuman, sendFromStam } from './mail.ts';
import * as itsa from './itsa.ts';
import * as reqCheck from './req-check.ts';

export const EVENTS = ['mail-to-human', 'itsa-created', 'itsa-status', 'agent-spawned'] as const;
export type StepEvent = (typeof EVENTS)[number];
export type Trigger = { kind: 'tool'; tool: string } | { kind: 'event'; event: StepEvent };
export const TOOL_ACTIONS = ['approve-if-yes', 'deny-if-yes'] as const;
export const EVENT_ACTIONS = ['flag', 'notify', 'annotate'] as const;
export type Action = (typeof TOOL_ACTIONS)[number] | (typeof EVENT_ACTIONS)[number];

export interface Step {
  id: string;
  name: string;
  trigger: Trigger;
  question: string;
  threshold: number;
  action: Action;
  enabled: boolean;
  builtin: string | null;
  created_at: string;
  updated_at: string;
}

export interface Decision {
  id: number;
  step_id: string;
  ts: string;
  // What was decided about: `mail:ID`, `itsa:KEY`, `agent:NAME`, or `tool:NAME`.
  subject: string;
  p: number | null;
  answer: boolean | null;
  // What the step did: flagged, notified, annotated, allowed, denied, or none (a "no", or
  // a notify the human's mail settings held back); `failed-open` on a model error.
  action: string;
  error: string | null;
}

// Who did it, as given to the model.
export interface Actor {
  name: string;
  role: string | null;
  parent: string | null;
}

const DEFAULT_THRESHOLD = 0.5;
const PREVIEW_MAX = 20;
const now = () => new Date().toISOString();

// The tables live here rather than in db.ts's schema, so this change is self-contained.
let ready = false;
function table(): void {
  if (ready) return;
  db.open().exec(`
    CREATE TABLE IF NOT EXISTS decision_steps (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      trigger TEXT NOT NULL,
      question TEXT NOT NULL,
      threshold REAL NOT NULL DEFAULT 0.5,
      action TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      builtin TEXT UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS step_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      step_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      subject TEXT NOT NULL,
      p REAL,
      answer INTEGER,
      action TEXT NOT NULL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS step_decisions_step ON step_decisions (step_id, id);
    CREATE INDEX IF NOT EXISTS step_decisions_subject ON step_decisions (subject, id);
    CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      agent TEXT NOT NULL,
      tool TEXT NOT NULL,
      args TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tool_calls_tool ON tool_calls (tool, id);
  `);
  ready = true;
}

type Row = Omit<Step, 'trigger' | 'enabled'> & { trigger: string; enabled: number };
const parse = (r: Row): Step => ({ ...r, trigger: JSON.parse(r.trigger), enabled: Boolean(r.enabled) });

// --- Steps ---------------------------------------------------------------------------------

export function list(): Step[] {
  table();
  return (db.open().prepare('SELECT * FROM decision_steps ORDER BY created_at, id').all() as unknown as Row[]).map(parse);
}

export function get(id: string): Step | undefined {
  table();
  const r = db.open().prepare('SELECT * FROM decision_steps WHERE id = ?').get(id) as Row | undefined;
  return r && parse(r);
}

export function must(id: string): Step {
  const s = get(id);
  if (!s) throw new Error(`no step ${id}`);
  return s;
}

export interface StepInput {
  name?: unknown;
  trigger?: unknown;
  question?: unknown;
  threshold?: unknown;
  action?: unknown;
  enabled?: unknown;
}

// Checks a whole step, filled in from `cur` where the input leaves a field out. Tool names
// are checked loosely (an MCP-style name), since the catalogue is another change's.
function validate(input: StepInput, cur?: Step): Omit<Step, 'id' | 'builtin' | 'created_at' | 'updated_at'> {
  const name = String(input.name ?? cur?.name ?? '').trim();
  if (!name) throw new Error('a step needs a name');
  const question = String(input.question ?? cur?.question ?? '').trim();
  if (!question) throw new Error('a step needs a question');
  const t = (input.trigger ?? cur?.trigger) as any;
  let trigger: Trigger;
  if (t?.kind === 'tool' && typeof t.tool === 'string' && /^[\w.:\-]{1,128}$/.test(t.tool)) trigger = { kind: 'tool', tool: t.tool };
  else if (t?.kind === 'event' && EVENTS.includes(t.event)) trigger = { kind: 'event', event: t.event };
  else throw new Error(`a trigger is {kind: 'tool', tool: NAME} or {kind: 'event', event: E}, E one of ${EVENTS.join(', ')}`);
  const threshold = input.threshold === undefined || input.threshold === null ? (cur?.threshold ?? DEFAULT_THRESHOLD) : Number(input.threshold);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('the threshold is a number from 0 to 1');
  const allowed: readonly string[] = trigger.kind === 'tool' ? TOOL_ACTIONS : EVENT_ACTIONS;
  const action = String(input.action ?? (cur && allowed.includes(cur.action) ? cur.action : allowed[0]));
  if (!allowed.includes(action)) throw new Error(`a ${trigger.kind} step's action is one of ${allowed.join(', ')}`);
  const enabled = input.enabled === undefined ? (cur?.enabled ?? true) : Boolean(input.enabled);
  return { name, trigger, question, threshold, action: action as Action, enabled };
}

export function create(input: StepInput, builtin: string | null = null): Step {
  table();
  const v = validate(input);
  const id = `st${randomBytes(4).toString('hex')}`;
  const t = now();
  db.open()
    .prepare('INSERT INTO decision_steps (id, name, trigger, question, threshold, action, enabled, builtin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, v.name, JSON.stringify(v.trigger), v.question, v.threshold, v.action, v.enabled ? 1 : 0, builtin, t, t);
  return must(id);
}

export function update(id: string, input: StepInput): Step {
  const cur = must(id);
  const v = validate(input, cur);
  db.open()
    .prepare('UPDATE decision_steps SET name = ?, trigger = ?, question = ?, threshold = ?, action = ?, enabled = ?, updated_at = ? WHERE id = ?')
    .run(v.name, JSON.stringify(v.trigger), v.question, v.threshold, v.action, v.enabled ? 1 : 0, now(), id);
  return must(id);
}

export function remove(id: string): void {
  const s = must(id);
  if (s.builtin) throw new Error(`step ${s.name} is built in; turn it off instead`);
  db.open().prepare('DELETE FROM decision_steps WHERE id = ?').run(id);
}

// --- The log -------------------------------------------------------------------------------

type DecisionRow = Omit<Decision, 'answer'> & { answer: number | null };
const parseDecision = (r: DecisionRow): Decision => ({ ...r, answer: r.answer == null ? null : Boolean(r.answer) });

function record(stepId: string, subject: string, p: number | null, answer: boolean | null, action: string, error: string | null): void {
  table();
  db.open()
    .prepare('INSERT INTO step_decisions (step_id, ts, subject, p, answer, action, error) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(stepId, now(), subject, p, answer == null ? null : answer ? 1 : 0, action, error);
}

export function log(stepId: string, limit = 100): Decision[] {
  table();
  return (db.open().prepare('SELECT * FROM step_decisions WHERE step_id = ? ORDER BY id DESC LIMIT ?').all(stepId, limit) as unknown as DecisionRow[]).map(parseDecision);
}

export function decisionsOn(subject: string, limit = 100): Decision[] {
  table();
  return (db.open().prepare('SELECT * FROM step_decisions WHERE subject = ? ORDER BY id DESC LIMIT ?').all(subject, limit) as unknown as DecisionRow[]).map(parseDecision);
}

// --- Asking --------------------------------------------------------------------------------

// Who an agent id (or the human) is, for the model.
export function actorOf(ref: string | null | undefined): Actor {
  if (!ref || ref === HUMAN) return { name: HUMAN, role: null, parent: null };
  const a = db.getAgent(ref);
  if (!a) return { name: String(ref), role: null, parent: null };
  const parent = db.parentsOf(a)[0];
  return { name: a.name, role: a.role || null, parent: parent ? (db.getAgent(parent)?.name ?? parent) : null };
}

// One question to the model. Returns P(yes), or an error string on any failure: decide
// itself never throws, and a missing answer is an error too.
async function ask(step: Step, state: Record<string, unknown>, purpose: string, timeoutMs?: number): Promise<{ p: number } | { error: string }> {
  const result = await decide(state, { answer: { type: 'noul', instructions: step.question } }, { purpose, timeoutMs }).catch(() => null);
  const p = noul(result, 'answer');
  return p == null ? { error: result ? 'no answer from the decision model' : 'the decision model failed or timed out' } : { p };
}

const stateFor = (step: Step, subject: Subject): Record<string, unknown> =>
  step.trigger.kind === 'tool' ? { tool: step.trigger.tool, arguments: subject.payload, by: subject.actor } : { event: step.trigger.event, payload: subject.payload, by: subject.actor };

// What a step decides about: its reference for the log, its payload, and who did it.
export interface Subject {
  ref: string;
  payload: Record<string, unknown>;
  actor: Actor;
}

// --- Event triggers ------------------------------------------------------------------------

// Called right after an event commits. Runs each enabled step on that event in the
// background; returns at once and never throws.
export function emit(event: StepEvent, subject: Subject): void {
  let matching: Step[];
  try {
    matching = list().filter((s) => s.enabled && s.trigger.kind === 'event' && s.trigger.event === event);
  } catch (e) {
    console.error(`steps: ${event}: ${e instanceof Error ? e.message : e}`);
    return;
  }
  for (const s of matching) {
    const run = runEvent(s, subject).catch((e) => record(s.id, subject.ref, null, null, 'failed-open', e instanceof Error ? e.message : String(e)));
    pending.add(run);
    void run.finally(() => pending.delete(run));
  }
}

// Runs in flight, for tests and an orderly stop.
const pending = new Set<Promise<unknown>>();
export async function settled(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}

async function runEvent(step: Step, subject: Subject): Promise<void> {
  const r = await ask(step, stateFor(step, subject), `decide:step:${step.id}`);
  if ('error' in r) return record(step.id, subject.ref, null, null, 'failed-open', r.error);
  const yes = r.p >= step.threshold;
  if (!yes) return record(step.id, subject.ref, r.p, false, 'none', null);
  let action = 'flagged';
  let error: string | null = null;
  if (step.action === 'notify') {
    // A step's notice is stam's own mail; the human's mail settings decide whether it goes.
    if (!humanMailAllows('important')) action = 'none';
    else {
      const body = `Step **${step.name}** answered yes (p ${r.p.toFixed(2)}) on ${subject.ref}.\n\nQuestion: ${step.question}\n\nBy: ${subject.actor.name}${subject.actor.role ? ` (${subject.actor.role})` : ''}`;
      action = (await sendFromStam([HUMAN], `[stam] Step ${step.name}: ${subject.ref}`, body).catch((e) => ((error = String(e?.message ?? e)), false))) ? 'notified' : 'none';
      if (action === 'none' && !error) error = 'no running agent to send stam mail';
    }
  } else if (step.action === 'annotate') {
    action = 'annotated';
    const key = subject.ref.match(/^itsa:(.+)$/)?.[1];
    // An ITSA also keeps the note in its own history.
    if (key) {
      const x = db.open().prepare('SELECT id FROM itsas WHERE key = ? OR id = ?').get(key, key) as { id: string } | undefined;
      if (x) db.open().prepare('INSERT INTO itsa_events (itsa_id, ts, actor, type, data) VALUES (?, ?, ?, ?, ?)').run(x.id, now(), 'stam', 'step.note', JSON.stringify({ step: step.id, name: step.name, question: step.question, p: r.p }));
    }
  }
  record(step.id, subject.ref, r.p, true, action, error);
}

// --- Tool triggers -------------------------------------------------------------------------

export interface ToolCheck {
  allow: boolean;
  // Set when a step denied the call: which one, its question, and its P(yes).
  step?: { id: string; name: string };
  question?: string;
  p?: number;
  // Set when an `enforce` requirement denied the call (src/req-check.ts).
  requirement?: string;
  // The error the caller returns to the agent.
  error?: string;
}

// A tool check's model call is short: the caller waits for it before the tool runs.
const TOOL_TIMEOUT_MS = 5_000;
// The whole check, under mcp.ts's 8 s: a step not reached in time is failed open, so a denial
// is never logged after the caller has already run the tool.
const TOOL_BUDGET_MS = 7_000;
const TOOL_HISTORY = 50;
const TOOL_ARGS_MAX = 4096;
const ARG_STRING_CAPS = [1024, 512, 256, 128, 64, 16, 0];
const TRUNCATED = '…[truncated]';

// The longest prefix of `s`, in whole characters, that fits in `max` UTF-8 bytes.
function fit(s: string, max: number): string {
  let out = '';
  let used = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch);
    if (used + b > max) break;
    out += ch;
    used += b;
  }
  return out;
}

// Each string value longer than `cap` bytes is cut to fit, with a marker; the shape stays.
function clipArgs(v: unknown, cap: number): unknown {
  if (typeof v === 'string') return Buffer.byteLength(v) <= cap ? v : fit(v, Math.max(0, cap - Buffer.byteLength(TRUNCATED))) + TRUNCATED;
  if (Array.isArray(v)) return v.map((x) => clipArgs(x, cap));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clipArgs(x, cap)]));
  return v;
}

// The arguments as stored: valid JSON of at most TOOL_ARGS_MAX bytes, keeping the arguments'
// shape (long strings are shortened, so a preview still sees e.g. `body`). Only arguments with
// too many keys to keep whole fall back to their raw text under one key.
export function storedArgs(args: Record<string, unknown>): string {
  for (const cap of ARG_STRING_CAPS) {
    const text = JSON.stringify(clipArgs(args, cap)) ?? '{}';
    if (Buffer.byteLength(text) <= TOOL_ARGS_MAX) return text;
  }
  const raw = JSON.stringify(args) ?? '{}';
  let lo = 0;
  let hi = Math.min(raw.length, TOOL_ARGS_MAX);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(JSON.stringify({ _truncated: raw.slice(0, mid) })) <= TOOL_ARGS_MAX) lo = mid;
    else hi = mid - 1;
  }
  return JSON.stringify({ _truncated: raw.slice(0, lo) });
}

// Keeps one checked tool call in the history, and only the last TOOL_HISTORY per tool.
function recordCall(agentId: string, tool: string, args: Record<string, unknown>): void {
  table();
  const d = db.open();
  d.prepare('INSERT INTO tool_calls (ts, agent, tool, args) VALUES (?, ?, ?, ?)').run(now(), agentId, tool, storedArgs(args ?? {}));
  d.prepare('DELETE FROM tool_calls WHERE tool = ? AND id NOT IN (SELECT id FROM tool_calls WHERE tool = ? ORDER BY id DESC LIMIT ?)').run(tool, tool, TOOL_HISTORY);
}

// Asks every enabled step on `tool`, in order, until one denies. approve-if-yes denies on
// "no"; deny-if-yes denies on "yes". A model failure allows (fail open), logged. A tool with
// no enabled step is allowed without a model call.
export async function checkTool(agentId: string, tool: string, args: Record<string, unknown>): Promise<ToolCheck> {
  recordCall(agentId, tool, args);
  const matching = list().filter((s) => s.enabled && s.trigger.kind === 'tool' && s.trigger.tool === tool);
  const subject: Subject = { ref: `tool:${tool}`, payload: args, actor: actorOf(agentId) };
  const started = Date.now();
  for (const s of matching) {
    const left = TOOL_BUDGET_MS - (Date.now() - started);
    if (left <= 0) {
      record(s.id, subject.ref, null, null, 'failed-open', 'budget');
      continue;
    }
    const r = await ask(s, stateFor(s, subject), `decide:step:${s.id}`, Math.min(TOOL_TIMEOUT_MS, left));
    if ('error' in r) {
      record(s.id, subject.ref, null, null, 'failed-open', r.error);
      continue;
    }
    const yes = r.p >= s.threshold;
    const deny = s.action === 'deny-if-yes' ? yes : !yes;
    record(s.id, subject.ref, r.p, yes, deny ? 'denied' : 'allowed', null);
    if (deny)
      return {
        allow: false,
        step: { id: s.id, name: s.name },
        question: s.question,
        p: r.p,
        error: `Denied by step "${s.name}": asked "${s.question}", the answer was ${yes ? 'yes' : 'no'} (p ${r.p.toFixed(2)}, threshold ${s.threshold}).`,
      };
  }
  // Requirements with mode `enforce` scoped to this tool, in what is left of the budget.
  const rest = TOOL_BUDGET_MS - (Date.now() - started);
  const req = await reqCheck.checkTool(agentId, tool, args, rest);
  if (!req.allow) return req;
  return { allow: true };
}

// --- Preview -------------------------------------------------------------------------------

// The last n real examples of a trigger, newest first, as subjects.
export function examples(trigger: Trigger, n: number): { subjects: (Subject & { summary: string })[]; note?: string } {
  const d = db.open();
  if (trigger.kind === 'tool') {
    const rows = d.prepare('SELECT ts, agent, args FROM tool_calls WHERE tool = ? ORDER BY id DESC LIMIT ?').all(trigger.tool, n) as { ts: string; agent: string; args: string }[];
    if (!rows.length) return { subjects: [], note: `stam has no recorded calls of ${trigger.tool} yet` };
    return {
      subjects: rows.map((r) => {
        let args: unknown;
        try { args = JSON.parse(r.args); } catch { args = { truncated: r.args }; }
        const payload = (args && typeof args === 'object' ? args : { value: args }) as Record<string, unknown>;
        const actor = actorOf(r.agent);
        return { ref: `tool:${trigger.tool}`, payload, actor, summary: `${actor.name}: ${argsLine(payload)}` };
      }),
    };
  }
  switch (trigger.event) {
    case 'mail-to-human': {
      const rows = d
        .prepare(
          `SELECT m.id, m.from_id, m.subject, m.body, m.thread_id FROM mail m JOIN mail_recipients r ON r.mail_id = m.id
           WHERE r.agent_id = ? AND m.from_id != ? AND m.permission_id IS NULL AND m.subject NOT LIKE '[stam]%'
           ORDER BY m.created_at DESC LIMIT ?`,
        )
        .all(HUMAN, HUMAN, n) as { id: string; from_id: string; subject: string; body: string; thread_id: string }[];
      return { subjects: rows.map((m) => ({ ...mailSubject(m), summary: m.subject })) };
    }
    case 'itsa-created': {
      const rows = d.prepare('SELECT * FROM itsas ORDER BY created_at DESC LIMIT ?').all(n) as any[];
      return { subjects: rows.map((x) => ({ ...itsaCreatedSubject(x), summary: `${x.key} ${x.title}` })) };
    }
    case 'itsa-status': {
      const rows = d
        .prepare(`SELECT e.actor, e.data, i.* FROM itsa_events e JOIN itsas i ON i.id = e.itsa_id WHERE e.type = 'status' ORDER BY e.id DESC LIMIT ?`)
        .all(n) as any[];
      return {
        subjects: rows.map((x) => {
          const ch = JSON.parse(x.data ?? '{}');
          return { ...itsaStatusSubject(x, ch.from, ch.to, x.actor), summary: `${x.key} ${ch.from} -> ${ch.to}` };
        }),
      };
    }
    case 'agent-spawned': {
      const rows = d.prepare('SELECT id FROM agents ORDER BY created_at DESC LIMIT ?').all(n) as { id: string }[];
      return {
        subjects: rows
          .map((r) => db.getAgent(r.id))
          .filter((a): a is db.Agent => !!a)
          .map((a) => ({ ...spawnSubject(a, db.parentsOf(a)[0] ?? null), summary: a.name })),
      };
    }
  }
}

// A tool call's arguments on one line for the preview, as `key: value` pairs. `self` (the
// caller's own id, which some tools take) is left out: the agent's name already leads.
function argsLine(args: Record<string, unknown>): string {
  const line = Object.entries(args)
    .filter(([k]) => k !== 'self')
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' · ')
    .replace(/\s+/g, ' ');
  return line.length > 160 ? line.slice(0, 159) + '…' : line || '(no arguments)';
}

// Runs the step's question on the last n examples of its trigger. Takes no action and
// writes no log; the cost is recorded as `decide:step:<id>:preview`.
export async function preview(id: string, n = 5): Promise<{ examples: { subject: string; summary: string; p: number | null; answer: boolean | null; error?: string }[]; note?: string }> {
  const step = must(id);
  const count = Math.max(1, Math.min(PREVIEW_MAX, Math.floor(Number(n)) || 5));
  const { subjects, note } = examples(step.trigger, count);
  const out = await Promise.all(
    subjects.map(async (s) => {
      const r = await ask(step, stateFor(step, s), `decide:step:${step.id}:preview`);
      return 'error' in r ? { subject: s.ref, summary: s.summary, p: null, answer: null, error: r.error } : { subject: s.ref, summary: s.summary, p: r.p, answer: r.p >= step.threshold };
    }),
  );
  return note ? { examples: out, note } : { examples: out };
}

// --- Subjects, one builder per event, shared by the live hooks and the preview --------------

export function mailSubject(m: { id: string; from_id: string; subject: string; body: string; thread_id?: string | null }): Subject {
  return { ref: `mail:${m.id}`, payload: { subject: m.subject, body: m.body, thread: m.thread_id ?? null }, actor: actorOf(m.from_id) };
}

type ItsaLike = { id: string; key: string; title: string; kind: string | null; summary: string | null; body: string | null; status: string; owner: string | null; parent_id: string | null; created_by: string };
const itsaPayload = (x: ItsaLike) => ({ key: x.key, title: x.title, kind: x.kind, summary: x.summary, body: x.body, status: x.status, owner: x.owner ? actorOf(x.owner).name : null, parent: x.parent_id });

export function itsaCreatedSubject(x: ItsaLike): Subject {
  return { ref: `itsa:${x.key}`, payload: itsaPayload(x), actor: actorOf(x.created_by) };
}

export function itsaStatusSubject(x: ItsaLike, from: unknown, to: unknown, actor: string | null): Subject {
  return { ref: `itsa:${x.key}`, payload: { ...itsaPayload(x), from, to }, actor: actorOf(actor) };
}

export function spawnSubject(a: db.Agent, by: string | null): Subject {
  return {
    ref: `agent:${a.name}`,
    payload: { name: a.name, role: a.role || null, harness: a.harness, model: a.model, effort: a.effort, cwd: a.cwd, first_prompt: a.first_prompt ?? null },
    actor: actorOf(by),
  };
}

// Connects the event triggers to stam's events; called once at daemon start. Mail to the
// human is stored on the sender's daemon and ITSAs live on their home, so each event runs
// its steps on exactly one daemon, against that daemon's steps.
export function watch(): void {
  onMailToHuman((m) => emit('mail-to-human', mailSubject(m)));
  itsa.onChange((c) => {
    if (c.type === 'created') emit('itsa-created', itsaCreatedSubject(c.itsa));
    else if (c.type === 'status') emit('itsa-status', itsaStatusSubject(c.itsa, c.from, c.to, c.actor));
  });
}
