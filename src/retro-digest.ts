// The retro digest (S-161; daily by default, or weekly on settings.retro.digest.day): stam mails
// the owner of the Retros ITSA, with its participants, the retro items and feedback reports filed
// or +1'd since the last digest, the final rounds and archives since then, and the loop-health
// metrics (S-806: new items and +1s per target, the recurrence of a target a proposal answered,
// items per archived agent, and the instruction word delta of the proposals merged), grouped so it
// can act on them (S-1059; the chief of staff only forwarded it, so it is the fallback when there is
// no live owner). buildDigest is pure, so the unit test feeds it fixed rows; gather reads the stores
// and sendDigest mails the result. Nothing is sent when there is nothing new.
import * as db from './db.ts';
import { MACHINE } from './config.ts';
import * as itsa from './itsa.ts';
import * as mail from './mail.ts';
import { DIGEST_DAYS, settings, setSetting } from './settings.ts';
import { COUNTED, EFFORT_KEYS, EPIC_KINDS, PARENT_KIND, PARENT_TITLE, RETRO_KIND, epicOffer, evidenceRank, headerFields } from './retro.ts';
import { PROPOSAL_KIND, answersOf } from './retro-loop.ts';
import { REPORT_KIND } from './feedback.ts';
import { fixWindows, measuredEffort } from './activity-stats.ts';
import * as usage from './usage.ts';
import { blockIdsOf } from './blocks.ts';
import { typeTemplate } from './agent-types.ts';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
// The keys a group names before it says how many more there are.
const MAX_KEYS = 3;
// The agents without a final round that the digest names before it says how many more there are.
const MAX_WITHOUT = 10;

// One retro item or feedback report: its Kind line, its Target (or Tool) line, and its +1 count.
export interface DigestItem {
  key: string;
  kind: string;
  target: string;
  plusOnes: number;
  // Its Evidence line and When line (S-728): absent on rows from before the field, read as `none`.
  evidence?: string;
  when?: string;
  // A feedback report (stam_issue, S-1230): it has no Evidence line, so the digest always shows it.
  report?: boolean;
}
// One final round: the agent's effort split, with the model and type it ran as, and the measured
// split beside it (S-227; null for an agent archived before the measure, or with no timed activity).
export interface DigestRound {
  name: string;
  model: string | null;
  type: string | null;
  effort: Record<string, number>;
  measured?: Record<string, number> | null;
}
// An agent not archived yet, active in the period: its measured split, computed live (S-227).
export interface DigestLive {
  name: string;
  model: string | null;
  type: string | null;
  measured: Record<string, number>;
}
// An agent archived since the last digest, and whether it filed a final round.
export interface DigestArchived {
  name: string;
  hasRound: boolean;
  // Why it archived without a round (S-1402): the `archive:round-skipped` event's reason; absent for older archives.
  reason?: string;
}
export interface DigestRows {
  items: DigestItem[];
  rounds: DigestRound[];
  archived: DigestArchived[];
  live?: DigestLive[];
  // The loop-health rows (S-806, R7 of docs/research/retros.md); absent means no Loop health section.
  loop?: LoopRows;
}
// One retro item for the loop metrics: its target, when it was filed, and when each of its counted
// +1s arrived. Every retro item, open or closed, so recurrence can count the items a proposal's
// edits answered and then closed.
export interface LoopItem {
  key: string;
  target: string;
  created_at: string;
  plusOnes: string[];
}
// A proposal closed as done and one retro item on its `Answers:` line (S-806): the answer's target
// is read from the item, and recurrence counts what arrived on that target since the close.
export interface LoopAnswer {
  proposal: string;
  item: string;
  closed_at: string;
}
export interface LoopRows {
  // The digest window's start: "new" means filed or +1'd at or after it.
  since: string;
  items: LoopItem[];
  answers: LoopAnswer[];
  // The net word delta per instruction file, from the proposals merged in the period.
  words: { file: string; delta: number }[];
}
export interface LoopMetrics {
  newItems: number;
  newPlusOnes: number;
  // The new items and +1s with no target (S-1289): counted apart, never ranked as a thread.
  untargeted: { items: number; plusOnes: number };
  targets: { target: string; items: number; plusOnes: number }[];
  moreTargets: number;
  recurrence: { key: string; target: string; items: number; plusOnes: number }[];
  moreRecurrence: number;
  // Retro items filed per agent archived in the period; null when no agent was archived.
  perAgent: number | null;
  words: { file: string; delta: number }[];
  wordsTotal: number;
}
// The top five targets with new activity, and the top five answered targets by recurrence.
const MAX_TARGETS = 5;
const MAX_RECURRENCE = 5;
// The instruction files the word delta counts (S-806): CLAUDE.md, AGENTS.md, and each type brief.
const INSTRUCTION_FILE = /^(?:CLAUDE\.md|AGENTS\.md|templates\/type-[^/]+\.md)$/;
// A retro item as the Retros view shows it: the ITSA's own id, title, status and creation too.
export interface RetroRow extends DigestItem {
  id: string;
  title: string;
  status: string;
  created_at: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const plusOnes = (n: number) => `${n} +1${n === 1 ? '' : 's'}`;
// The mean of one key over a list of splits, 0 for a missing key.
const meanOf = (xs: Record<string, number>[], k: string) => xs.reduce((n, x) => n + (x[k] ?? 0), 0) / xs.length;
// The rows grouped by `model · type`, sorted by that label.
const runsOf = <T extends { model: string | null; type: string | null }>(xs: T[]): [string, T[]][] => {
  const g = new Map<string, T[]>();
  for (const x of xs) {
    const label = `${x.model ?? 'no model'} · ${x.type ?? 'no type'}`;
    g.set(label, [...(g.get(label) ?? []), x]);
  }
  return [...g].sort((a, b) => a[0].localeCompare(b[0]));
};
// A self-reported cell: the average share, then the measured average of the rounds that have one, or a dash.
const effortCell = (rs: DigestRound[], k: string) => {
  const measured = rs.filter((r) => r.measured).map((r) => r.measured!);
  return `${Math.round(meanOf(rs.map((r) => r.effort), k))}% (measured ${measured.length ? `${Math.round(meanOf(measured, k))}%` : '–'})`;
};
// A live cell: no self-report, the measured average of the agents not archived yet.
const liveCell = (ls: DigestLive[], k: string) => `– (measured ${Math.round(meanOf(ls.map((l) => l.measured), k))}%)`;
// The self-report whose measured average is furthest from it, over the runs that have measured rounds.
function largestGap(rounds: DigestRound[]) {
  let best: { label: string; key: string; self: number; measured: number; diff: number } | null = null;
  for (const [label, rs] of runsOf(rounds)) {
    const measured = rs.filter((r) => r.measured).map((r) => r.measured!);
    if (!measured.length) continue;
    for (const k of EFFORT_KEYS) {
      const self = Math.round(meanOf(rs.map((r) => r.effort), k));
      const got = Math.round(meanOf(measured, k));
      if (!best || Math.abs(got - self) > Math.abs(best.diff)) best = { label, key: k, self, measured: got, diff: got - self };
    }
  }
  return best;
}

// The digest's label for the subject and the heading: the local date when daily, the week otherwise.
export function digestLabel(d: Date, day: string): string {
  return day === 'daily' ? dayLabel(d) : weekLabel(d);
}

// The local date, as 2026-10-12.
export function dayLabel(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// "W41" style week label: ISO year and week.
export function weekLabel(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}

// The best (lowest) evidence rank among a group's items, so a group holding one backed item rises.
const bestEvidence = (xs: DigestItem[]) => Math.min(...xs.map((x) => evidenceRank(x.evidence)));

// The words in one diff line, after its +/- marker.
const wordsIn = (line: string): number => line.slice(1).trim().split(/\s+/).filter(Boolean).length;

// The answers one proposal contributes to the recurrence check (S-806): only a proposal closed as
// done applied its edits, so only its `Answers:` items count. A refused (wont_do/canceled) or still
// open proposal contributes none, or the check would credit an edit nobody applied.
export function answeredTargets(x: { key: string; status: string; closed_at: string | null; body: string | null }): LoopAnswer[] {
  const at = x.status === 'done' ? x.closed_at : null;
  return at ? answersOf(x.body).map((item) => ({ proposal: x.key, item, closed_at: at })) : [];
}

// The net word delta per instruction file in a proposal body's `diff` block (S-806): the words on
// `+` lines minus those on `-` lines, per file, for CLAUDE.md, AGENTS.md and templates/type-*.md.
// Other files and a body with no diff block count nothing, so the metric is left out, not zeroed.
// A file is named by its `diff --git` header or the `--- a/`/`+++ b/` line, so neither is counted
// as a changed line.
export function wordsInDiff(body: string | null | undefined): { file: string; delta: number }[] {
  const block = /^```diff\n([\s\S]*?)^```$/m.exec(body ?? '')?.[1];
  if (!block) return [];
  const out = new Map<string, number>();
  let file: string | null = null;
  for (const line of block.split('\n')) {
    const head = /^diff --git a\/\S+ b\/(\S+)$/.exec(line)?.[1] ?? /^--- a\/(.+)$/.exec(line)?.[1] ?? /^\+\+\+ b\/(.+)$/.exec(line)?.[1];
    if (head) {
      file = INSTRUCTION_FILE.test(head) ? head : null;
      continue;
    }
    if (!file || !/^[+-]/.test(line)) continue;
    out.set(file, (out.get(file) ?? 0) + (line[0] === '+' ? wordsIn(line) : -wordsIn(line)));
  }
  return [...out].filter(([, delta]) => delta !== 0).map(([file, delta]) => ({ file, delta }));
}

// An item with no target (S-1289): the header's `none`, whatever its case or whitespace. It is not a
// thread, so it never ranks as a target or counts toward recurrence.
const isUntargeted = (target: string) => target.trim().toLowerCase() === 'none';

// The loop-health numbers (S-806): the new items and +1s in the period and the targets they land on,
// the recurrence of the targets a done proposal answered, items per archived agent, and the net word
// delta of the instruction files proposals changed. Pure, so the unit test feeds it fixed rows.
export function loopMetrics(loop: LoopRows, archived: number): LoopMetrics {
  const inPeriod = (t: string) => t >= loop.since;
  const newOf = (x: LoopItem) => (inPeriod(x.created_at) ? 1 : 0) + x.plusOnes.filter(inPeriod).length;
  const newItems = loop.items.filter((x) => inPeriod(x.created_at)).length;
  const newPlusOnes = loop.items.reduce((n, x) => n + x.plusOnes.filter(inPeriod).length, 0);
  const untargeted = loop.items.filter((x) => isUntargeted(x.target)).reduce(
    (u, x) => ({ items: u.items + (inPeriod(x.created_at) ? 1 : 0), plusOnes: u.plusOnes + x.plusOnes.filter(inPeriod).length }),
    { items: 0, plusOnes: 0 },
  );

  const targets = new Map<string, { target: string; items: number; plusOnes: number }>();
  for (const x of loop.items) {
    if (!newOf(x) || isUntargeted(x.target)) continue;
    const t = targets.get(x.target) ?? { target: x.target, items: 0, plusOnes: 0 };
    t.items += inPeriod(x.created_at) ? 1 : 0;
    t.plusOnes += x.plusOnes.filter(inPeriod).length;
    targets.set(x.target, t);
  }
  const ranked = [...targets.values()].sort((a, b) => b.items + b.plusOnes - (a.items + a.plusOnes) || b.items - a.items || a.target.localeCompare(b.target));

  // The recurrence check: each target a done proposal answered, counted from the latest close of the
  // proposals that answered it (so one item is never counted twice).
  const targetOf = new Map(loop.items.map((x) => [x.key, x.target]));
  const answered = new Map<string, { key: string; at: string }>();
  for (const a of loop.answers) {
    const target = targetOf.get(a.item);
    if (!target || isUntargeted(target)) continue;
    const seen = answered.get(target);
    if (!seen || a.closed_at > seen.at) answered.set(target, { key: a.proposal, at: a.closed_at });
  }
  const recurrence = [...answered]
    .map(([target, { key, at }]) => ({
      key,
      target,
      items: loop.items.filter((x) => x.target === target && x.created_at >= at).length,
      plusOnes: loop.items.filter((x) => x.target === target).reduce((n, x) => n + x.plusOnes.filter((t) => t >= at).length, 0),
    }))
    .sort((a, b) => b.items + b.plusOnes - (a.items + a.plusOnes) || a.target.localeCompare(b.target));

  const wordsTotal = loop.words.reduce((n, w) => n + w.delta, 0);
  return {
    newItems,
    newPlusOnes,
    untargeted,
    targets: ranked.slice(0, MAX_TARGETS),
    moreTargets: Math.max(0, ranked.length - MAX_TARGETS),
    recurrence: recurrence.slice(0, MAX_RECURRENCE),
    moreRecurrence: Math.max(0, recurrence.length - MAX_RECURRENCE),
    perAgent: archived > 0 ? newItems / archived : null,
    words: loop.words,
    wordsTotal,
  };
}

// Whether the Loop health section has something to report (S-806 review): activity in the period, or
// an instruction word delta from a proposal merged in it. Recurrence alone is not news: an answered
// target reports its count on every digest after the close, so it would send a digest forever.
export function loopHasNews(loop: LoopRows, archived: number): boolean {
  const m = loopMetrics(loop, archived);
  return m.newItems > 0 || m.newPlusOnes > 0 || m.words.length > 0;
}

// The Loop health section (S-806): one line per metric, plus the top-five targets. A number that
// can't be computed (no archived agent, no diff block) leaves its line out instead of showing a zero.
export function loopLines(loop: LoopRows, archived: number): string[] {
  const m = loopMetrics(loop, archived);
  const signed = (n: number) => `${n > 0 ? '+' : ''}${n}`;
  const out = [`- ${plural(m.newItems, 'new item')}, ${plusOnes(m.newPlusOnes)} since the last digest.`];
  if (m.untargeted.items || m.untargeted.plusOnes) out.push(`- Untargeted: ${plural(m.untargeted.items, 'item')}, ${plusOnes(m.untargeted.plusOnes)}.`);
  if (m.targets.length) {
    const list = m.targets.map((t) => `${t.target} ${t.items}/${t.plusOnes}`).join(', ');
    out.push(`- Top targets (items/+1s): ${list}${m.moreTargets ? `, and ${m.moreTargets} more` : ''}.`);
  }
  if (m.recurrence.length) {
    const list = m.recurrence
      .map((r) => {
        const parts = [...(r.items ? [plural(r.items, 'item')] : []), ...(r.plusOnes ? [plusOnes(r.plusOnes)] : [])].join(', ');
        return `${r.target} ${r.items + r.plusOnes} new${parts ? ` (${parts})` : ''} after ${r.key} closed`;
      })
      .join('; ');
    out.push(`- Recurrence: ${list}${m.moreRecurrence ? `; and ${m.moreRecurrence} more` : ''}.`);
  }
  if (m.perAgent !== null) out.push(`- ${m.perAgent.toFixed(1)} items per archived agent (${m.newItems} items, ${plural(archived, 'agent')} archived).`);
  if (m.words.length) out.push(`- Instruction words: ${signed(m.wordsTotal)} net (${m.words.map((w) => `${w.file} ${signed(w.delta)}`).join(', ')}).`);
  return out;
}

// The digest as Markdown, or null when there is nothing to send.
export function buildDigest(rows: DigestRows, week: string): string | null {
  if (!rows.items.length && !rows.rounds.length && !rows.archived.length && !(rows.live ?? []).length && !(rows.loop && loopHasNews(rows.loop, rows.archived.length))) return null;
  const out = [`# Retro digest, ${week}`, '', 'Items filed or +1\'d since the last digest that have evidence or a +1, by evidence first, then +1s, grouped by kind and target; the rest are counted at the end.', '', '## Threads'];

  // An item with no evidence and no +1 is only counted (S-1230), so the digest leads with what has backing.
  const backed = (x: DigestItem) => !!x.report || x.plusOnes > 0 || (!!x.evidence && x.evidence !== 'none');
  const shown = rows.items.filter(backed);
  const hidden = rows.items.filter((x) => !backed(x));
  const groups = new Map<string, DigestItem[]>();
  for (const x of shown) {
    const label = `Kind: ${x.kind} · Target: ${x.target}`;
    groups.set(label, [...(groups.get(label) ?? []), x]);
  }
  const ranked = [...groups.entries()]
    .map(([label, items]) => ({ label, items: items.sort((a, b) => evidenceRank(a.evidence) - evidenceRank(b.evidence) || b.plusOnes - a.plusOnes || a.key.localeCompare(b.key)), total: items.reduce((n, x) => n + x.plusOnes, 0) }))
    .sort((a, b) => bestEvidence(a.items) - bestEvidence(b.items) || b.total - a.total || b.items.length - a.items.length || a.label.localeCompare(b.label));
  if (!ranked.length) out.push('None.');
  for (const g of ranked) {
    const keys = g.items.slice(0, MAX_KEYS).map((x) => `${x.key} (${plusOnes(x.plusOnes)})`).join(', ');
    const more = g.items.length > MAX_KEYS ? `, and ${g.items.length - MAX_KEYS} more` : '';
    out.push(`- **${g.label}**: ${plural(g.items.length, 'item')}, ${plusOnes(g.total)}. ${keys}${more}`);
  }
  if (hidden.length) {
    const kinds = new Map<string, number>();
    for (const x of hidden) kinds.set(x.kind, (kinds.get(x.kind) ?? 0) + 1);
    const byKind = [...kinds].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([kind, n]) => `${kind} ${n}`).join(', ');
    out.push(`- ${plural(hidden.length, 'more item')} without evidence or +1s: ${byKind}.`);
  }

  out.push('', '## Effort', '');
  const live = rows.live ?? [];
  if (!rows.rounds.length && !live.length) out.push('No final rounds.');
  else {
    out.push(`| Model · type | Rounds | ${EFFORT_KEYS.join(' | ')} |`, `|${'---|'.repeat(EFFORT_KEYS.length + 2)}`);
    for (const [label, rs] of runsOf(rows.rounds)) out.push(`| ${label} | ${rs.length} | ${EFFORT_KEYS.map((k) => effortCell(rs, k)).join(' | ')} |`);
    for (const [label, ls] of runsOf(live)) out.push(`| ${label} (live, not archived) | ${ls.length} live | ${EFFORT_KEYS.map((k) => liveCell(ls, k)).join(' | ')} |`);
    const gap = largestGap(rows.rounds);
    if (gap) out.push('', `Largest self-report gap: ${gap.key} in ${gap.label}, ${gap.self}% self-reported vs ${gap.measured}% measured (${gap.diff > 0 ? '+' : ''}${gap.diff} points).`);
  }

  out.push('', '## Coverage', '');
  if (!rows.archived.length) out.push('No agents archived.');
  else {
    const without = rows.archived.filter((a) => !a.hasRound).map((a) => (a.reason ? `${a.name}: ${a.reason}` : a.name));
    const withRound = rows.archived.length - without.length;
    const named = without.slice(0, MAX_WITHOUT).join(', ');
    const more = without.length > MAX_WITHOUT ? `, and ${without.length - MAX_WITHOUT} more` : '';
    out.push(`${plural(rows.archived.length, 'agent')} archived: ${withRound} with a final round, ${without.length} without${without.length ? ` (${named}${more})` : ''}.`);
  }

  if (rows.loop) out.push('', '## Loop health', '', ...loopLines(rows.loop, rows.archived.length));

  out.push(
    '',
    '## What to do with it',
    '',
    '- Promote a thread that recurs, with several items or +1s, to a work ITSA under the project it is about, so the fix is tracked.',
    '- A retro steward (run by the chief of staff) drafts proposals from this digest; leave instruction edits to it.',
    '- Close the items you handled with `itsa_set` (closed), with a comment saying why.',
    '',
  );
  return out.join('\n');
}

// The rows since a time: the open retro items and feedback reports created or +1'd since then,
// the final rounds and archives since then.
// `live` adds the measured split of the agents not archived yet: the digest wants it, the API doesn't.
export async function gather(since: string, live = true): Promise<DigestRows & { items: RetroRow[] }> {
  const items: RetroRow[] = [];
  const loopItems: LoopItem[] = [];
  for (const kind of [RETRO_KIND, REPORT_KIND]) {
    for (const x of await itsa.list({ kind })) {
      const mails = x.thread_id ? db.threadMail(x.thread_id) : [];
      const counted = mails.filter((m) => COUNTED.test(m.body ?? ''));
      const f = headerFields(x.body);
      // Every retro item, open or closed, feeds the loop metrics (S-806): recurrence counts items
      // filed after a proposal closed, and those the proposal answered are usually closed already.
      if (kind === RETRO_KIND) loopItems.push({ key: x.key, target: f.target, created_at: x.created_at, plusOnes: counted.map((m) => m.created_at) });
      if (x.closed_at) continue;
      const fresh = counted.filter((m) => m.created_at >= since).length;
      if (x.created_at < since && !fresh) continue;
      items.push({ id: x.id, key: x.key, title: x.title, status: x.status, created_at: x.created_at, kind: f.kind, target: f.target, evidence: f.evidence, when: f.when, plusOnes: counted.length, report: kind === REPORT_KIND });
    }
  }

  // The proposals closed as done that answered retro items (the recurrence check), and the
  // instruction word delta of the proposals merged in the period, per file (S-806).
  const answers: LoopAnswer[] = [];
  const words = new Map<string, number>();
  for (const x of await itsa.list({ kind: PROPOSAL_KIND })) {
    answers.push(...answeredTargets(x));
    if (x.status !== 'done' || !x.closed_at || x.closed_at < since) continue;
    for (const w of wordsInDiff(x.body)) words.set(w.file, (words.get(w.file) ?? 0) + w.delta);
  }
  const loop: LoopRows = { since, items: loopItems, answers, words: [...words].filter(([, d]) => d !== 0).map(([file, delta]) => ({ file, delta })) };

  const d = db.open();
  const names = new Map(db.listAgents().map((a) => [a.id, a.name]));
  const nameOf = (id: string) => names.get(id) ?? id;
  const rounds = (d.prepare("SELECT agent_id, data FROM events WHERE type = 'retro_final' AND ts >= ? ORDER BY id").all(since) as { agent_id: string; data: string }[]).map((r) => {
    const data = JSON.parse(r.data);
    return { name: nameOf(r.agent_id), model: data.model ?? null, type: data.type ?? null, effort: data.effort ?? {}, measured: data.measured ?? null };
  });
  const firstRound = (d.prepare("SELECT MIN(ts) AS ts FROM events WHERE type = 'retro_final'").get() as { ts: string | null }).ts;
  const from = archiveWindow(since, firstRound);
  const archives = from ? (d.prepare("SELECT DISTINCT agent_id FROM events WHERE type = 'archive' AND ts >= ?").all(from) as { agent_id: string }[]) : [];
  const archived = archives.map((r) => {
    const skip = d.prepare("SELECT data FROM events WHERE agent_id = ? AND type = 'archive:round-skipped' ORDER BY id DESC LIMIT 1").get(r.agent_id) as { data: string } | undefined;
    return {
      name: nameOf(r.agent_id),
      hasRound: Boolean(d.prepare("SELECT 1 FROM events WHERE agent_id = ? AND type = 'retro_final' LIMIT 1").get(r.agent_id)),
      reason: skip ? (JSON.parse(skip.data) as { reason?: string }).reason : undefined,
    };
  });
  // Agents active in the period and not archived yet: their measured split, live (S-227).
  const everArchived = new Set((d.prepare("SELECT DISTINCT agent_id FROM events WHERE type = 'archive'").all() as { agent_id: string }[]).map((r) => r.agent_id));
  const windows = fixWindows();
  const agents = new Map(db.listAgents().map((a) => [a.id, a]));
  const liveRows: DigestLive[] = [];
  for (const { agent_id } of live ? (d.prepare('SELECT DISTINCT agent_id FROM activity_items WHERE "end" > ?').all(since) as { agent_id: string }[]) : []) {
    if (everArchived.has(agent_id)) continue;
    const m = measuredEffort(agent_id, { since }, windows);
    if (m) liveRows.push({ name: nameOf(agent_id), model: agents.get(agent_id)?.model ?? null, type: agents.get(agent_id)?.type ?? null, measured: m.split });
  }
  return { items, rounds, archived, live: liveRows, loop };
}

// Where the archives count from: the window's start, or the first final round if that is later.
// Before the retro tool there were no rounds, so with no final round ever, nothing counts.
export function archiveWindow(since: string, firstRound: string | null): string | null {
  return firstRound ? [since, firstRound].sort().at(-1)! : null;
}

// Whether the digest is due: its day and hour have passed since the last slot, and it hasn't gone
// out (or been found empty) since that slot began. Daily, the slot is each day's hour.
export function digestDue(now: Date, cfg: { enabled: boolean; day: string; hour: number }, lastDigest: string | null): boolean {
  if (!cfg.enabled) return false;
  const slot = new Date(now);
  slot.setHours(cfg.hour, 0, 0, 0);
  if (cfg.day === 'daily') {
    if (slot > now) slot.setDate(slot.getDate() - 1);
    return !lastDigest || new Date(lastDigest) < slot;
  }
  slot.setDate(slot.getDate() - ((slot.getDay() - DIGEST_DAYS.indexOf(cfg.day) + 7) % 7));
  if (slot > now) slot.setDate(slot.getDate() - 7);
  return !lastDigest || new Date(lastDigest) < slot;
}

// The early start (S-714): besides its daily slot, the digest (and so the steward) also goes out
// when enough open retro items arrived since the last one, or one item with several +1s was +1'd
// again. earlyCounts reads the store with two light queries and earlyDue is pure over its result,
// so the unit test feeds it fixed counts.
export interface EarlyCounts {
  // Open retro items created after the last digest.
  newItems: number;
  // The total +1 count of each open retro item whose thread got a counted +1 after the last digest.
  freshPlusOnes: number[];
}

// Whether an early start is due: at least cfg.newItems open items were created since the last
// digest, or one open item with at least cfg.plusOnes +1s got a counted +1 since then, and at least
// cfg.minHours have passed since that last digest (S-1059), so a burst of items can't fire one
// early digest after another.
export function earlyDue(counts: EarlyCounts, cfg: { enabled: boolean; newItems: number; plusOnes: number; minHours: number }, hoursSince: number): boolean {
  if (!cfg.enabled || hoursSince < cfg.minHours) return false;
  return counts.newItems >= cfg.newItems || counts.freshPlusOnes.some((n) => n >= cfg.plusOnes);
}

// The early start's counts (S-714), with two light queries instead of reading every item's thread:
// open retro items created after `since`, and, for the usually few open retro items whose thread
// got a counted +1 after `since`, their total +1 count. The strict `>` keeps an item or +1 stamped
// in the same millisecond as the digest from counting again. COUNTED is a prefix match, so a
// case-sensitive GLOB matches the same comments the regex does.
export function earlyCounts(since: string, d = db.open()): EarlyCounts {
  const counted = "(m.body GLOB '+1 from *' OR m.body GLOB 'Reported again by *')";
  const newItems = (d
    .prepare('SELECT COUNT(*) AS n FROM itsas i WHERE i.kind = ? AND i.closed_at IS NULL AND i.created_at > ?')
    .get(RETRO_KIND, since) as { n: number }).n;
  const freshPlusOnes = (d
    .prepare(
      `SELECT (SELECT COUNT(*) FROM mail m WHERE m.thread_id = i.thread_id AND ${counted}) AS n
       FROM itsas i
       WHERE i.kind = ? AND i.closed_at IS NULL AND i.thread_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM mail m WHERE m.thread_id = i.thread_id AND m.created_at > ? AND ${counted})`,
    )
    .all(RETRO_KIND, since) as { n: number }[]).map((r) => r.n);
  return { newItems, freshPlusOnes };
}

// The Retros view (S-162): the open items ranked by +1s then newest, the effort split per model and
// type (the rounds and each area's average share), and coverage of the archived agents.
export interface RetrosView {
  items: RetroRow[];
  effort: { model: string | null; type: string | null; rounds: number; avg: Record<string, number>; measured: Record<string, number> | null }[];
  coverage: { archived: number; withRound: number; without: string[] };
}

export function buildRetros(rows: DigestRows & { items: RetroRow[] }): RetrosView {
  const items = [...rows.items].sort((a, b) => evidenceRank(a.evidence) - evidenceRank(b.evidence) || b.plusOnes - a.plusOnes || b.created_at.localeCompare(a.created_at) || a.key.localeCompare(b.key));
  const byRun = new Map<string, DigestRound[]>();
  for (const r of rows.rounds) {
    const run = JSON.stringify([r.model, r.type]);
    byRun.set(run, [...(byRun.get(run) ?? []), r]);
  }
  const effort = [...byRun.values()].map((rs) => {
    const measured = rs.filter((r) => r.measured).map((r) => r.measured!);
    return {
      model: rs[0].model,
      type: rs[0].type,
      rounds: rs.length,
      avg: Object.fromEntries(EFFORT_KEYS.map((k) => [k, Math.round(rs.reduce((n, r) => n + (r.effort[k] ?? 0), 0) / rs.length)])),
      measured: measured.length ? Object.fromEntries(EFFORT_KEYS.map((k) => [k, Math.round(meanOf(measured, k))])) : null,
    };
  });
  effort.sort((a, b) => `${a.model ?? ''} ${a.type ?? ''}`.localeCompare(`${b.model ?? ''} ${b.type ?? ''}`));
  const without = rows.archived.filter((a) => !a.hasRound).map((a) => a.name);
  return { items, effort, coverage: { archived: rows.archived.length, withRound: rows.archived.length - without.length, without } };
}

// The Retros view's rows since a time (default: the last 30 days), built from gather.
const RETROS_DAYS = 30;
export async function retros(since = new Date(Date.now() - RETROS_DAYS * 24 * 60 * 60 * 1000).toISOString()): Promise<RetrosView> {
  return buildRetros(await gather(since, false));
}

// The type of the agent that filed a retro item: its creator's type, or the type in the item's
// `Reporter: name (model, type)` line when the creator is gone from the registry.
function reporterType(x: itsa.Itsa): string | null {
  const t = db.getAgent(x.created_by)?.type;
  if (t) return t;
  const m = /^Reporter: .*\(([^()]*)\)\s*$/m.exec((x.body ?? '').split(/\n\s*\n/)[0]);
  return m ? m[1].split(',').pop()!.trim() || null : null;
}

// Memory of an agent type (S-888): the retro items its agents reported, or aimed at the type's template
// `type-NAME` or one of its block ids, open or done, ranked as the Retros view ranks them. Items
// closed as duplicate, wont_do or canceled are not memory.
export async function retrosOfType(type: string): Promise<RetrosView> {
  const targets = new Set([typeTemplate(type), ...blockIdsOf(type)]);
  const items: RetroRow[] = [];
  for (const x of await itsa.list({ kind: RETRO_KIND })) {
    if (x.closed_at && x.status !== 'done') continue;
    const f = headerFields(x.body);
    if (reporterType(x) !== type && !targets.has(f.target)) continue;
    const counted = (x.thread_id ? db.threadMail(x.thread_id) : []).filter((m) => COUNTED.test(m.body ?? ''));
    items.push({ id: x.id, key: x.key, title: x.title, status: x.status, created_at: x.created_at, kind: f.kind, target: f.target, evidence: f.evidence, when: f.when, plusOnes: counted.length });
  }
  return buildRetros({ items, rounds: [], archived: [] });
}

// Only the ITSA home sends the digest: the other daemons hold no ITSAs of their own to report on.
export const isDigestHome = (home: string, machine: string): boolean => home === machine;

export interface DigestResult {
  sent: boolean;
  to: string | null;
  reason: string;
}

// Run after a digest went out (the retro loop's steward, retro-loop.ts); set by the daemon.
const digestHandlers: ((label: string, text: string) => void)[] = [];
export function onDigest(fn: (label: string, text: string) => void): void {
  if (!digestHandlers.includes(fn)) digestHandlers.push(fn);
}

// Who the digest goes to (S-1059): the owner of the standing Retros ITSA, with its participants
// copied, instead of the chief of staff, who only forwarded it. Only a live, non-archived agent
// counts, and the human is skipped, because the digest is for agents. An owner that isn't live
// falls back to the chief of staff, as the digest always went. Pure, so the unit test feeds it
// fixed rows.
export function digestRecipients(
  retros: { owner: string | null; participants: string[] } | null | undefined,
  live: (ref: string) => boolean,
  cos: string | null,
): string[] {
  const out: string[] = [];
  const add = (ref: string | null | undefined): void => {
    if (ref && ref !== mail.HUMAN && !out.includes(ref)) out.push(ref);
  };
  add(retros?.owner && live(retros.owner) ? retros.owner : cos);
  for (const p of retros?.participants ?? []) if (live(p)) add(p);
  return out;
}

// Whether a digest recipient is live (S-1059). A local agent counts by its lifecycle; a participant
// on a peer machine counts by the lifecycle the peer cache last saw, unless that is archived or
// shut down (as mail.ts startsPeer does), so a peer-only participant isn't dropped.
export function digestLive(ref: string): boolean {
  const a = db.getAgent(ref);
  if (a) return db.isLive(a);
  if (!db.peerAgentById(ref)) return false;
  return !['archived', 'shut_down'].includes(db.peerAgentLifecycle(ref) ?? '');
}

// Mails the digest to the Retros ITSA's owner and participants (S-1059) as stam, in a new thread,
// and records when it went (or when there was nothing new, so the same window isn't checked again).
// Without a recipient nothing is recorded, so the next tick tries again.
export async function sendDigest(now = new Date()): Promise<DigestResult> {
  if (!isDigestHome(settings().itsa.home ?? MACHINE, MACHINE)) return { sent: false, to: null, reason: 'not the ITSA home' };
  const retros = (await itsa.list({ kind: PARENT_KIND })).find((x) => x.title === PARENT_TITLE);
  const to = digestRecipients(retros, digestLive, settings().chiefOfStaff);
  if (!to.length) return { sent: false, to: null, reason: 'no Retros owner or chief of staff to send it' };
  // The result names who it went to, so a caller (and the CLI) reads names, not ids.
  const who = to.map((ref) => db.getAgent(ref)?.name ?? db.peerAgentById(ref)?.name ?? ref).join(', ');
  const cfg = settings().retro.digest;
  const last = settings().retro.lastDigest ?? new Date(now.getTime() - (cfg.day === 'daily' ? DAY_MS : WEEK_MS)).toISOString();
  const label = digestLabel(now, cfg.day);
  const text = buildDigest(await gather(last), label);
  const record = () => setSetting('retro', { ...settings().retro, lastDigest: now.toISOString() });
  if (!text) {
    record();
    return { sent: false, to: who, reason: 'nothing new since the last digest' };
  }
  const sent = await mail.sendFromStam(to, `Retro digest: ${label}`, text);
  if (sent) {
    record();
    for (const fn of digestHandlers) fn(label, text);
  }
  return { sent, to: who, reason: sent ? '' : 'no agent to send it' };
}

// The timer's tick: sends the digest when it is due, or starts it early when enough has piled up
// (S-714). Both run sendDigest, so lastDigest advances and the same window isn't checked twice.
export async function digestTick(now = new Date()): Promise<void> {
  const cfg = settings().retro;
  if (digestDue(now, cfg.digest, cfg.lastDigest)) await sendDigest(now);
  else if (earlyStart(now)) await sendDigest(now);
}

// Whether the early start fires now. Nothing before a first digest (the daily path owns that), and
// nothing when the digest itself is off. At least settings.retro.early.minHours must have passed
// since the last digest (S-1059); the daily digest isn't held by that.
function earlyStart(now = new Date()): boolean {
  const cfg = settings().retro;
  if (!cfg.digest.enabled || !cfg.early.enabled || !cfg.lastDigest) return false;
  return earlyDue(earlyCounts(cfg.lastDigest), cfg.early, (now.getTime() - new Date(cfg.lastDigest).getTime()) / HOUR_MS);
}

// The epic retro offer (S-163) for an ITSA that just closed: the retro items and reports On the
// ITSA's subtree, and its owner's share of the 5-hour window (the largest account's, or null when
// no share is known, which gives the solo retro).
export async function epicRetroOffer(epic: itsa.Itsa): Promise<string | null> {
  if (!EPIC_KINDS.includes(epic.kind ?? '')) return null;
  const subtree = new Set((await itsa.list({ subtree: epic.id })).map((x) => x.key));
  const items = (await Promise.all([RETRO_KIND, REPORT_KIND].map((kind) => itsa.list({ kind })))).flat();
  let share: number | null = null;
  if (epic.owner) {
    const tree = (usage.summary(7, epic.owner) as { tree?: { accounts?: Record<string, Record<string, { percent?: number }>> } }).tree;
    const percents = Object.values(tree?.accounts ?? {}).map((w) => w.five_hour?.percent).filter((p): p is number => typeof p === 'number');
    if (percents.length) share = Math.max(...percents);
  }
  return epicOffer(epic, subtree, items, share, settings().retro.epic);
}
