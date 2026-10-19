// The retro loop (S-206): after each retro digest, stam spawns a retro steward (a child of the
// chief of staff, in a worktree of its repo) with the open retro items grouped by target. For
// instruction and template edits it drafts one proposal ITSA (kind `proposal`, under Retros) and
// asks the human to approve it. A proposal can't move on to merge or done unless the human's last
// action on it was Approve (S-1050: only instruction and template edits need that gate; a code fix
// answering retro items is an ordinary issue and closes the normal way). When an ITSA answering
// retro items closes as done, the retro items on its `Answers:` line close too. At most one
// proposal or steward at a time. The grouping, the brief and the approval check are pure, so the
// unit test feeds them fixed rows.
import { execFileSync } from 'node:child_process';
import * as db from './db.ts';
import * as itsa from './itsa.ts';
import * as mail from './mail.ts';
import * as org from './org.ts';
import { HUMAN, stamSender } from './mail.ts';
import { settings } from './settings.ts';
import { render } from './templates.ts';
import { MEMORY_FILE, MEMORY_MAX_CHARS, MEMORY_MAX_TOKENS } from './blocks.ts';
import { COUNTED, NOT_WORK, PARENT_KIND, PARENT_TITLE, RETRO_KIND, evidenceRank, headerFields } from './retro.ts';

export const PROPOSAL_KIND = 'proposal';
export const STEWARD_TYPE = 'retro-steward';
// The statuses that apply a proposal's edits: only after the human approved it.
export const APPLY_STATUSES = ['ready_to_merge', 'merging', 'deploying', 'done'];
const APPROVAL_STATUS = 'needs_approval';
// How much of an item's details the brief quotes.
const DETAILS_CHARS = 400;

const log = (what: string, e: unknown) => console.error(`retro loop: ${what}: ${e instanceof Error ? e.message : e}`);

// One open retro item as the steward reads it.
export interface OpenItem {
  key: string;
  title: string;
  // The one-line lesson (S-1016); empty for an item filed before titles were short.
  summary?: string;
  kind: string;
  target: string;
  plusOnes: number;
  details: string;
  // Its Evidence line (with the free-text detail), and its When line (S-728); `none`/'' when absent.
  evidence: string;
  evidenceDetail: string;
  when: string;
}
export interface TargetGroup {
  target: string;
  items: OpenItem[];
  plusOnes: number;
}

// The best (lowest) evidence rank among a group's items, so a group holding one backed item rises.
const bestEvidence = (xs: OpenItem[]) => Math.min(...xs.map((x) => evidenceRank(x.evidence)));

// The items grouped by target, strongest evidence then most +1s then most items first; within a
// group, strongest evidence first, then most +1s.
export function groupByTarget(items: OpenItem[]): TargetGroup[] {
  const groups = new Map<string, OpenItem[]>();
  for (const x of items) groups.set(x.target, [...(groups.get(x.target) ?? []), x]);
  return [...groups.entries()]
    .map(([target, xs]) => ({ target, items: xs.sort((a, b) => evidenceRank(a.evidence) - evidenceRank(b.evidence) || b.plusOnes - a.plusOnes || a.key.localeCompare(b.key)), plusOnes: xs.reduce((n, x) => n + x.plusOnes, 0) }))
    .sort((a, b) => bestEvidence(a.items) - bestEvidence(b.items) || b.plusOnes - a.plusOnes || b.items.length - a.items.length || a.target.localeCompare(b.target));
}

const ones = (n: number) => `${n} +1${n === 1 ? '' : 's'}`;

// The steward's task: the groups as Markdown, then the digest.
export function stewardTask(groups: TargetGroup[], retros: string, label: string, digest: string): string {
  const text = groups
    .map((g) => {
      const rows = g.items.map((x) => {
        const d = x.details.replace(/\s+/g, ' ').trim();
        const ev = `evidence: ${x.evidence || 'none'}${x.evidenceDetail ? ` (${x.evidenceDetail})` : ''}${x.when ? ` · when: ${x.when}` : ''}`;
        return `- ${x.key} [${x.kind}, ${ones(x.plusOnes)}] ${ev} — ${x.title}${x.summary && x.summary !== x.title ? ` (${x.summary})` : ''}: ${d.length > DETAILS_CHARS ? d.slice(0, DETAILS_CHARS) + '…' : d}`;
      });
      return [`### Target: ${g.target} (${g.items.length} item${g.items.length === 1 ? '' : 's'}, ${ones(g.plusOnes)})`, '', ...rows].join('\n');
    })
    .join('\n\n');
  return render('retro-steward-task', { label, retros, groups: text, digest });
}

// The growth option a specialist's proposal asks for (S-920): its body starts `Growth: helpers|split|team`.
export type Growth = 'helpers' | 'split' | 'team';
export function growthKind(body: string | null | undefined): Growth | null {
  const m = body?.match(/^Growth: (helpers|split|team)\b/);
  return (m?.[1] as Growth | undefined) ?? null;
}

// The retro item keys an ITSA answers: its `Answers:` line, with any leading space or indentation.
export function answersOf(body: string | null | undefined): string[] {
  const line = body?.match(/^\s*Answers:\s*(.*)$/m)?.[1] ?? '';
  return [...new Set(line.split(/[\s,]+/).filter((k) => /^[A-Za-z][A-Za-z0-9-]*-\d+$/.test(k)))];
}

type Event = { actor: string | null; type: string; data: string | null };
const dataOf = (e: Event) => {
  try {
    return e.data ? JSON.parse(e.data) : null;
  } catch {
    return null;
  }
};

// The chief of staff's agent id, or null.
const cosId = (): string | null => org.chiefOfStaff()?.id ?? null;

// A move that approves: into a ready status, in_progress, or one that applies. A move to canceled, wont_do,
// blocked and the like is a refusal, which no approval path counts.
const approvesTo = (to: unknown): boolean => typeof to === 'string' && (itsa.statusOf(to)?.category === 'ready' || to === 'in_progress' || APPLY_STATUSES.includes(to));

// Whether the chief of staff may approve this proposal (S-920): a helpers growth proposal and nothing else.
// By who: its owner and creator are standing agents other than the retro steward, whose proposals carry
// diffs and memory. By body: a helpers proposal is prose and numbers, so a body that answers retro items,
// has a fenced code block or HTML code, or has a diff-like line is a change to apply, which only your user
// approves. Any run of quote and list prefixes doesn't hide a marker; 4-space indented code isn't checked.
const PREFIX = '^(?:[\\s>]|[-*+]\\s|\\d+[.)]\\s)*';
const MARKS = '(?:diff --git |\\+\\+\\+ |--- \\S|\\*\\*\\* \\S|@@ -\\d)';
const FENCE = new RegExp(`${PREFIX}(?:\`\`\`|~~~)|<(?:pre|code)\\b`, 'im');
const DIFFISH = new RegExp(`^\\s*(?:diff |\\+\\+\\+ |--- \\S|\\*\\*\\* \\S|@@ -\\d)|${PREFIX}${MARKS}`, 'm');
const standingNonSteward = (id: string | null | undefined) => {
  const a = id ? db.getAgent(id) : undefined;
  return a?.standing === 1 && a.type !== STEWARD_TYPE;
};
export function cosMayApprove(body: string | null | undefined, x: { owner?: string | null; created_by?: string | null }): boolean {
  return (
    growthKind(body) === 'helpers' && standingNonSteward(x.owner) && standingNonSteward(x.created_by) &&
    answersOf(body).length === 0 && !FENCE.test(body ?? '') && !DIFFISH.test(body ?? '')
  );
}

// Whether the human approved the proposal: their latest action since it last entered
// needs_approval (by a status change, or by being created in it) is Approve. A kind change since
// then needs a new approval. Events oldest first. With `cos` (a Growth: helpers proposal, S-920) the chief
// of staff's own move out of needs_approval counts too, unless the body changed after it or the human
// answered since (their answer decides).
export function approved(events: Event[], cos: string | null = null): boolean {
  let asked = -1;
  events.forEach((e, i) => {
    const d = dataOf(e);
    if ((e.type === 'status' && d?.to === APPROVAL_STATUS) || (e.type === 'created' && d?.status === APPROVAL_STATUS)) asked = i;
    if (e.type === 'kind') asked = -1;
  });
  if (asked < 0) return false;
  const after = events.slice(asked + 1);
  const acts = after.filter((e) => e.type === 'action' && e.actor === HUMAN);
  if (acts.length > 0) return dataOf(acts.at(-1)!)?.id === 'approve';
  if (!cos) return false;
  const i = after.findLastIndex((e) => e.type === 'status' && e.actor === cos && dataOf(e)?.from === APPROVAL_STATUS && approvesTo(dataOf(e)?.to));
  return i >= 0 && !after.slice(i + 1).some((e) => e.type === 'body');
}

// Whether a retro steward created the ITSA.
const stewardCreated = (id: string | null | undefined) => !!id && db.getAgent(id)?.type === STEWARD_TYPE;

// An ITSA that answers retro items: an `Answers:` line, and either a parent under Retros or a retro
// steward as its creator. Retro items and the other bookkeeping kinds (NOT_WORK) aren't work, so they
// never count.
function answersRetroItems(next: { kind: string | null; body?: string | null; parent_id?: string | null; created_by?: string | null }): boolean {
  if (next.kind && NOT_WORK.includes(next.kind)) return false;
  if (!next.body || !/^\s*Answers:\s*/m.test(next.body)) return false;
  const parent = next.parent_id ? itsa.find(next.parent_id) : undefined;
  return parent?.kind === PARENT_KIND || stewardCreated(next.created_by);
}

// The instruction and template paths a proposal changes (S-1050): CLAUDE.md, AGENTS.md, and
// everything under blocks/, templates/, or registry/. A code fix elsewhere keeps the issue kind.
const INSTRUCTION_PATH = /^(?:claude\.md|agents\.md|blocks\/|templates\/|registry\/)/;

// One diff header's path, normalised for matching (S-1050 review): quotes stripped, a leading `a/`,
// `b/`, `./`, or `/` removed, `//` and `x/../` collapsed, lowercased.
export function headerPath(raw: string): string {
  let p = raw.trim();
  if (p.length > 1 && ((p[0] === '"' && p.endsWith('"')) || (p[0] === "'" && p.endsWith("'")))) p = p.slice(1, -1);
  p = p.replace(/^[ab]\//, '').replace(/^\.\//, '');
  p = p.replace(/\/{2,}/g, '/');
  while (/[^/]+\/\.\.\//.test(p)) p = p.replace(/[^/]+\/\.\.\//, '');
  return p.replace(/^\.?\//, '').toLowerCase();
}

// Whether a body's diff touches instructions or templates (S-1050): the path on a `diff --git a/…`,
// `--- a/…` (a deletion), or `+++ b/…` header line, normalised, is one above. Leading whitespace and
// quoting are allowed. This reads the path the body claims, never the branch's real diff: the gate
// only decides whether the human must approve a retro answer (S-1050 review).
export function instructionEdit(body: string | null | undefined): boolean {
  const re = /^\s*(?:diff --git\s+("[^"]*"|\S+)|(?:---|\+\+\+)\s+("[^"]*"|\S+))/gm;
  return [...(body ?? '').matchAll(re)].some((m) => INSTRUCTION_PATH.test(headerPath(m[1] ?? m[2] ?? '')));
}

// Whether an ITSA answering retro items must be a proposal (S-1050): one the retro steward created,
// or one whose diff edits instructions or templates. Any other retro answer may be an ordinary issue,
// which closes the normal way (the deploy watcher sets done) and still closes the items it answers.
function needsProposal(next: { kind: string | null; body?: string | null; parent_id?: string | null; created_by?: string | null }): boolean {
  return answersRetroItems(next) && (stewardCreated(next.created_by) || instructionEdit(next.body));
}

// The types whose memory block a body's diff changes (S-888): `diff --git` or `+++` header lines naming
// blocks/type-NAME/99-memory.md.
export function memoryTypesIn(body: string | null | undefined): string[] {
  const re = new RegExp(`^(?:diff --git a/|\\+\\+\\+ b/)blocks/type-([\\w-]+)/${MEMORY_FILE.replace('.', '\\.')}`, 'gm');
  return [...new Set([...(body ?? '').matchAll(re)].map((m) => m[1]))];
}

// The characters a diff adds: its `+` lines other than the `+++` headers, a lower bound on the size of what it writes.
const addedChars = (body: string) => body.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).reduce((n, l) => n + l.length, 0);

// The gate, run before an ITSA is created or its kind, status, body, or parent changes: an agent
// can't create or move a proposal into a status that applies it until the human approved it, nor
// drop the proposal kind, nor make an instruction or template retro answer any other kind (S-1050).
// The human can do all of these.
export function gate(cur: itsa.Itsa | null, next: { kind: string | null; status: string; body?: string | null; parent_id?: string | null; created_by?: string | null }, actor: string): void {
  if (actor === HUMAN) return;
  // A filed process proposal's body names the commit to merge: only the human, or the system sender that filed it, writes it.
  if (cur && processProposalOf(cur) && next.body !== undefined && next.body !== cur.body && !itsa.isSystem(actor)) throw new Error(`${cur.key} is a process proposal: its body is written by the system, and only your user may change it`);
  if (cur?.kind === PROPOSAL_KIND && next.kind !== PROPOSAL_KIND) throw new Error(`${cur.key} is a proposal: only your user can change its kind`);
  // A type's memory block is written only by the retro steward, in a proposal, within its size cap.
  const memory = memoryTypesIn(next.body);
  if (memory.length) {
    if (next.kind !== PROPOSAL_KIND) throw new Error(`${cur?.key ?? 'A new ITSA'} changes a type's memory block, so its kind must be ${PROPOSAL_KIND}, not ${next.kind ?? 'none'}`);
    if (db.getAgent(actor)?.type !== STEWARD_TYPE) throw new Error(`${cur?.key ?? 'A new proposal'} changes the memory block of ${memory.join(', ')}: only the ${STEWARD_TYPE} writes type memory`);
    if (addedChars(next.body ?? '') > MEMORY_MAX_CHARS * memory.length) throw new Error(`${cur?.key ?? 'A new proposal'} adds more than ${MEMORY_MAX_TOKENS} tokens to a memory block: keep each at ${MEMORY_MAX_TOKENS} or fewer`);
  }
  if (next.kind !== PROPOSAL_KIND && needsProposal(next))
    throw new Error(`${cur?.key ?? 'A new ITSA'} answers retro items with an instruction or template edit, so its kind must be ${PROPOSAL_KIND}, not ${next.kind ?? 'none'}: use kind ${PROPOSAL_KIND}`);
  if (next.kind !== PROPOSAL_KIND || !APPLY_STATUSES.includes(next.status)) return;
  // A helpers growth proposal (S-920) is reversible and stays in the specialist's tree: the chief of staff approves it too.
  // Not in a call that also changes the body: the guard runs before the body event is recorded.
  const cos = cur && cosMayApprove(next.body, cur) && next.body === cur.body ? cosId() : null;
  if (cos && actor === cos && cur?.kind === PROPOSAL_KIND && cur.status === APPROVAL_STATUS) return;
  if (!cur || cur.kind !== PROPOSAL_KIND || !approved(itsa.events(cur.id, 1000), cos))
    throw new Error(`${cur?.key ?? 'A new proposal'} is a proposal ${cos ? 'your user or the chief of staff hasn' : 'your user has'}${cos ? "'t" : "n't"} approved: set it to ${APPROVAL_STATUS} with the diff and wait for Approve before you apply it`);
}

// Any ITSA closed as done closes the open retro items it answers, each with a comment naming it
// (S-1050): a proposal that reaches done and answers retro items, even one outside Retros, as before,
// or an issue that answers them. Each comment says which it was.
export async function closeAnswered(x: itsa.Itsa, actor: string): Promise<string[]> {
  if (x.status !== 'done' || !(x.kind === PROPOSAL_KIND || answersRetroItems(x))) return [];
  const by = actor !== HUMAN ? actor : x.owner ?? stamSender()?.id;
  if (!by) return [];
  const closed: string[] = [];
  for (const key of answersOf(x.body)) {
    const item = itsa.find(key);
    if (!item || item.kind !== RETRO_KIND || item.closed_at) continue;
    const note = x.kind === PROPOSAL_KIND ? `Answered by ${x.key} "${x.title}", approved and applied.` : `Closed: ${x.key} is done.`;
    await itsa.post(item.id, { by, body: note });
    await itsa.set(item.id, { status: 'done' }, by);
    closed.push(item.key);
  }
  return closed;
}

// The process a proposal changes when it is a process change (S-1084: body line `Process proposal: ID`),
// else null. Those are handled by src/process-proposal.ts, not by the steward's notices.
export function processProposalOf(x: { kind: string | null; body?: string | null }): string | null {
  if (x.kind !== PROPOSAL_KIND) return null;
  return /^Process proposal: ([a-z][a-z0-9_-]*)\s*$/m.exec(x.body ?? '')?.[1] ?? null;
}

// The human's last action on an ITSA (Approve, Request changes), or null.
export function lastAction(x: itsa.Itsa): string | null {
  const e = itsa.events(x.id, 1000).findLast((v) => v.type === 'action' && v.actor === HUMAN);
  return e ? (dataOf(e)?.id ?? null) : null;
}

// The steward hears the human's answer on its proposal even when the human wrote no text.
export function tellOwner(x: itsa.Itsa, actor: string, from: string): void {
  if (x.kind !== PROPOSAL_KIND || from !== APPROVAL_STATUS || !x.owner || x.owner === HUMAN || processProposalOf(x)) return;
  const growth = growthKind(x.body);
  if (growth) {
    // A growth proposal is the specialist's own: the chief of staff approves helpers only, your user any.
    const ok = actor === HUMAN ? lastAction(x) === 'approve' : cosMayApprove(x.body, x) && actor === cosId() && approvesTo(x.status);
    if (ok) mail.queueNotice(x.owner, render('standing-growth-approved', { key: x.key, next: GROWTH_NEXT[growth] }));
    else if (actor === HUMAN && lastAction(x) === 'changes') mail.queueNotice(x.owner, render('retro-proposal-changes', { key: x.key }));
    return;
  }
  if (actor !== HUMAN) return;
  const act = lastAction(x);
  if (act === 'approve') mail.queueNotice(x.owner, render('retro-proposal-approved', { key: x.key }));
  else if (act === 'changes') mail.queueNotice(x.owner, render('retro-proposal-changes', { key: x.key }));
}

const GROWTH_NEXT: Record<Growth, string> = {
  helpers: 'Spawn the helpers yourself as your own children with `spawn_agent` (the same type, your workspace shared read with `workspace_share`), and archive them when your load drops. Nothing spawns them for you.',
  split: 'Tell your parent the split is approved; it spawns the second specialist, and you copy the workspace topics that move to it.',
  team: 'Tell your parent the team is approved; it sets up the composite type with you as the lead lane.',
};

// The chief of staff hears that a helpers proposal waits for it (S-920); a split or a team waits for your user.
function tellCos(x: itsa.Itsa, actor: string): void {
  if (x.kind !== PROPOSAL_KIND || x.status !== APPROVAL_STATUS || actor === HUMAN || growthKind(x.body) !== 'helpers' || !cosMayApprove(x.body, x)) return;
  const cos = cosId();
  if (!cos || cos === actor) return;
  const by = db.getAgent(actor)?.name ?? actor;
  mail.queueNotice(cos, render('standing-growth-approval', { key: x.key, title: x.title, agent: by, load: (x.body ?? '').replace(/\s+/g, ' ').slice(0, 300) }));
}

export function watchProposals(): void {
  itsa.guardChange(gate);
  itsa.onStatus((x, actor, from) => {
    if (from !== APPROVAL_STATUS) tellCos(x, actor);
    tellOwner(x, actor, from);
    closeAnswered(x, actor).catch((e) => log(`closing the items ${x.key} answers`, e));
  });
}

// The +1 count of one ITSA: the counted comments in its thread (S-796). The daemon answers this
// alone, so an agent that +1s an item, or searches them, never reads the item's thread: the
// OpenCode server must name an agent for that, and only a participant of the item may read it.
export function plusOnesOf(x: itsa.Itsa): number {
  return (x.thread_id ? db.threadMail(x.thread_id) : []).filter((m) => COUNTED.test(m.body ?? '')).length;
}

// The open retro items, read from the store, with their header metadata and +1 counts.
export async function openItems(): Promise<OpenItem[]> {
  return (await itsa.list({ kind: RETRO_KIND }))
    .filter((x) => !x.closed_at)
    .map((x) => ({
      key: x.key,
      title: x.title,
      summary: x.summary ?? '',
      ...headerFields(x.body),
      plusOnes: plusOnesOf(x),
    }));
}

const isRepo = (dir: string) => {
  try {
    execFileSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};

export interface StewardResult {
  spawned: string | null;
  reason: string;
}

// After a digest went out: spawn the steward, unless the loop is off, a proposal is still open or
// a steward still lives, or no retro item is open. The spawn function is the daemon's. Calls run
// one at a time, so two digests can't both spawn one.
let queue: Promise<unknown> = Promise.resolve();
export function afterDigest(label: string, digest: string, spawn: (body: Record<string, unknown>) => Promise<{ name: string }>): Promise<StewardResult> {
  const run = queue.then(() => spawnSteward(label, digest, spawn));
  queue = run.catch(() => {});
  return run;
}

// The reason no steward may spawn now, or null: checked again right before the spawn.
async function busy(): Promise<string | null> {
  // A process change waiting for approval (S-1084) is not the steward's proposal: it doesn't hold the steward back.
  const open = (await itsa.list({ kind: PROPOSAL_KIND })).find((x) => !x.closed_at && !processProposalOf(x));
  if (open) return `proposal ${open.key} is still open`;
  const live = db.listAgents().find((a) => a.type === STEWARD_TYPE && a.lifecycle !== 'archived');
  return live ? `steward ${live.name} is still alive` : null;
}

async function spawnSteward(label: string, digest: string, spawn: (body: Record<string, unknown>) => Promise<{ name: string }>): Promise<StewardResult> {
  if (!settings().retro.steward.enabled) return { spawned: null, reason: 'the retro steward is off' };
  const cos = settings().chiefOfStaff ? db.getAgent(settings().chiefOfStaff!) : undefined;
  if (!cos) return { spawned: null, reason: 'no chief of staff' };
  if (!cos.cwd) return { spawned: null, reason: `${cos.name} has no working directory for the steward` };
  const early = await busy();
  if (early) return { spawned: null, reason: early };
  const items = await openItems();
  if (!items.length) return { spawned: null, reason: 'no open retro items' };
  const retros = (await itsa.list({ kind: PARENT_KIND })).find((x) => x.title === PARENT_TITLE);
  if (!retros) return { spawned: null, reason: 'no Retros ITSA' };
  let name = STEWARD_TYPE;
  for (let i = 2; db.getAgent(name); i++) name = `${STEWARD_TYPE}-${i}`;
  const late = await busy();
  if (late) return { spawned: null, reason: late };
  const a = await spawn({ type: STEWARD_TYPE, name, parent: cos.id, cwd: cos.cwd, worktree: isRepo(cos.cwd), prompt: stewardTask(groupByTarget(items), retros.key, label, digest) });
  return { spawned: a.name, reason: '' };
}
