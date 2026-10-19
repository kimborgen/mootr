// The `retro` MCP tool and `stam retro` (S-158): an agent files a retro item about how the work
// went (a time sink, a misleading instruction, a trick that worked, an idea) as a retro ITSA under
// a standing "Retros" parent. Search first: it returns open retro items and feedback reports
// nearest the query, each with its Kind line, its +1 count and the first line of its details, and a
// +1 comment on one adds the reporter's own scenario instead of a near-duplicate. Search ranks by
// meaning when the embedder is ready (S-729) and by shared words otherwise. The API is passed in, so
// the unit test runs against a fake without a daemon.
import { WRITE_CALL_MS, writeId } from './client.ts';
import { normalize, report as fileFeedback, type Api } from './feedback.ts';
import { render } from './templates.ts';

export const RETRO_KINDS = ['went_well', 'improve', 'idea', 'instruction'] as const;
// What external event backs an item, strongest first, `none` last (S-728, R1 of docs/research/retros.md):
// a correction from the human, a merge gate result, a review verdict, a rollback or deploy hold, a
// measured wait or cost, or nothing external. Items are read and ranked in this order.
export const EVIDENCE_KINDS = ['human', 'gate', 'review', 'rollback', 'measured', 'none'] as const;
// A problem with stam itself (S-160): filed as a feedback report under Feedback, not a retro item.
export const STAM_ISSUE_KIND = 'stam_issue';
// The parent is found by its kind, a marker no other ITSA uses, and its title.
export const PARENT_KIND = 'retros';
export const PARENT_TITLE = 'Retros';
export const RETRO_KIND = 'retro';
// Feedback reports (S-156) are searched and +1'd too, so the feedback tool needs no change here.
const REPORT_KIND = 'feedback-report';
// The search shows at most this many (S-729: the top 3 near-duplicates).
const MAX_HITS = 3;
// The final round an agent files as it is archived (S-159): where its effort went, as percentages.
export const EFFORT_KEYS = ['reading', 'implementing', 'testing', 'waiting', 'review_fixes', 'coordination'] as const;
// Kinds that are retro bookkeeping, never the work an `On` line names.
export const NOT_WORK = [RETRO_KIND, PARENT_KIND, REPORT_KIND, 'feedback'];
// What counts as a +1: a `+1 from` comment, and feedback's `Reported again by` comment.
export const COUNTED = /^(\+1 from |Reported again by )/;

// The rank of an item's evidence, `none` (or an old item without the line) last: the position in
// EVIDENCE_KINDS, so sorting by it raises items an external event backs above unbacked ones.
export function evidenceRank(evidence: string | null | undefined): number {
  const i = (EVIDENCE_KINDS as readonly string[]).indexOf(evidence ?? 'none');
  return i < 0 ? EVIDENCE_KINDS.length : i;
}

// The header of a retro item or report body: the `Name: value` lines before the first blank line,
// last one winning. Metadata is never read from the details after the blank, so a detail that
// quotes `Evidence: gate` can't be read as one, nor can a `Target:` that smuggles a newline add a
// line the body readers see (S-728 review).
export function headerOf(body: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (body ?? '').split('\n')) {
    if (!line.trim()) break;
    const m = line.match(/^([A-Za-z][A-Za-z-]*): (.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

// One item's metadata, read only from the header (S-728): the digest and the steward share this,
// so both read an item the same way. An absent line takes its default, which is how an old item
// without any of them reads. `Detail:` is the `evidence_detail` free text (a single capitalised
// word so the retro search's header strip treats it as a header too, S-729/#212).
export function headerFields(body: string | null | undefined): { kind: string; target: string; evidence: string; evidenceDetail: string; when: string; details: string } {
  const h = headerOf(body);
  return {
    kind: h.Kind || 'none',
    target: h.Target || h.Tool || 'none',
    evidence: h.Evidence || 'none',
    evidenceDetail: h.Detail || '',
    when: h.When || '',
    details: (body ?? '').split(/\n\s*\n/).slice(1).join('\n\n'),
  };
}

export interface RetroArgs {
  kind?: string;
  title?: string;
  summary?: string;
  details?: string;
  target?: string;
  evidence?: string;
  evidence_detail?: string;
  when?: string;
  feedback_kind?: string;
  tool?: string;
  search?: string;
  plus_one?: string;
  final?: boolean;
  effort?: Record<string, number>;
}

// The standing parent, created on first use under the root of S-1's tree when S-1 exists,
// else as a root.
export async function retroParent(api: Api, by: string): Promise<any> {
  const found = (await api('GET', `/api/itsas?kind=${PARENT_KIND}`)).find((x: any) => x.title === PARENT_TITLE);
  if (found) return found;
  let parent: string | undefined;
  try {
    const s1 = await api('GET', '/api/itsas/S-1');
    parent = s1.parent_chain?.[0]?.id ?? s1.id;
  } catch {}
  return api('POST', '/api/itsas', {
    title: PARENT_TITLE,
    summary: 'How the work went, as agents report it. Search here before filing a new item.',
    kind: PARENT_KIND,
    parent,
    by,
  });
}

// The reporter as the body names it: `NAME (model, type)`, the parts it has.
async function reporterOf(api: Api, by: string): Promise<{ name: string; label: string }> {
  const agent = (await api('GET', `/api/agents?as=${encodeURIComponent(by)}`)).find((a: any) => a.id === by);
  const name = agent?.name ?? by;
  const extra = [agent?.model, agent?.type].filter(Boolean).join(', ');
  return { name, label: extra ? `${name} (${extra})` : name };
}

// The Kind line of a body, or "none".
// The Kind line of a body, or "none". Read from the header only, like the other metadata (S-728).
const kindOf = (body: string | null | undefined): string => headerFields(body).kind;

// The words of a text, as a set, once case and punctuation are dropped.
const wordsOf = (s: string): Set<string> => new Set(normalize(s).split(' ').filter(Boolean));

// The +1 count, from the daemon's count route (S-796): the number alone. A +1 on a retro item or
// feedback report must never read the item's thread: the OpenCode server must name an agent for
// that read, and only a participant of the item may do it.
async function plusOnes(api: Api, id: string): Promise<number> {
  const { count } = await api('GET', `/api/itsas/${id}/plus-ones`);
  return Number(count) || 0;
}

// Files a retro item, with the open ITSA the reporter is most recently active on named as `On`.
export async function fileRetro(api: Api, by: string, a: { kind: string; title?: string; summary: string; details: string; target?: string; evidence?: string; evidenceDetail?: string; when?: string }): Promise<string> {
  if (!(RETRO_KINDS as readonly string[]).includes(a.kind)) throw new Error(`kind must be one of ${RETRO_KINDS.join(', ')}`);
  const summary = a.summary.replace(/\s+/g, ' ').trim();
  if (!summary) throw new Error('summary is required');
  // The short title (S-1016); an older caller without one gets the summary, so nothing breaks mid-deploy.
  const title = a.title?.replace(/\s+/g, ' ').trim() || summary;
  const details = a.details?.trim();
  if (!details) throw new Error('details is required');
  const target = a.target?.replace(/\s+/g, ' ').trim() || 'none';
  // A lesson to change a template, block, tool or file must name it, or the steward can't route it (S-1228).
  if (['improve', 'instruction'].includes(a.kind) && target.toLowerCase() === 'none') {
    throw new Error('target is required for improve and instruction items: name the template, block, tool, script or file the lesson is about, so the steward can route it. Examples: type-reviewer, blocks/type-manager/30-manager-mail-wait.md, scripts/merge-pr.mjs, web/check/phone.mjs, pr_open.');
  }
  // Evidence defaults to `none`, so an old caller's schema keeps working; an unknown class is refused.
  const evidence = a.evidence?.trim() || 'none';
  if (!(EVIDENCE_KINDS as readonly string[]).includes(evidence)) throw new Error(`evidence must be one of ${EVIDENCE_KINDS.join(', ')}`);
  const evidenceDetail = a.evidenceDetail?.replace(/\s+/g, ' ').trim();
  const when = a.when?.replace(/\s+/g, ' ').trim();
  const parent = await retroParent(api, by);
  const reporter = await reporterOf(api, by);

  // The work the reporter is on, not the standing items: filed retros and reports stay open as the reporter's own.
  const mine = (await api('GET', `/api/itsas?participant=${encodeURIComponent(by)}`))
    .filter((x: any) => !x.closed_at && !NOT_WORK.includes(x.kind))
    .sort((x: any, y: any) => (y.updated_at ?? '').localeCompare(x.updated_at ?? ''));
  const on = mine[0]?.key;

  const body = [
    `Kind: ${a.kind}`,
    `Target: ${target}`,
    `Evidence: ${evidence}`,
    ...(evidenceDetail ? [`Detail: ${evidenceDetail}`] : []),
    ...(when ? [`When: ${when}`] : []),
    `Reporter: ${reporter.label}`,
    ...(on ? [`On: ${on}`] : []),
    '',
    details,
  ].join('\n');
  const x = await api('POST', '/api/itsas', {
    title,
    summary,
    body,
    kind: RETRO_KIND,
    status: 'idea',
    parent: parent.id,
    participants: [by],
    by,
  });
  return `Filed ${x.key} "${title}" [idea] under Retros.`;
}

// The first line of a body's details: the text after the `Kind:`/`Target:`/`Reporter:`/`On:` header
// lines, so the agent can judge "same lesson, different words".
const firstDetail = (body: string | null | undefined): string =>
  (body ?? '')
    .replace(/^(?:[A-Z][A-Za-z]*: .*\n)+\n?/, '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean) ?? '';

// How many candidates the meaning search returns, in one route call (S-1925): one embedding of the
// query and one scan of the vectors per search. The route allows up to 200 per request.
const MAX_CANDIDATES = 150;

// Words that carry no meaning in a query, left out of the word coverage.
const STOPWORDS = new Set('a an the is are was were be been it its this that these those of to in on at by for from with and or but not no nor so as if then than use used using do does did can could should would will we you i my our your there here'.split(' '));
// How much the squared word coverage (0 to 1) counts against a cosine (about 0.15 to 0.7). Squared,
// so a lone shared word adds little but a paraphrase sharing half the query's rare words outranks an
// unrelated item with a higher cosine, and a pure paraphrase with no shared words isn't crowded out
// by items that share one (S-721).
const COVERAGE_WEIGHT = 4;

// The meaning search, one call, or null when the embedder isn't ready (the route answered by
// keyword) or the route failed: the caller then uses word overlap. Empty when the page is past the
// end. The route ranks by meaning, restricted to the kinds and to open items, best first.
async function meaningHits(api: Api, words: string): Promise<any[] | null> {
  try {
    const hits = await api('GET', `/api/itsas/search?${new URLSearchParams({ q: words, limit: String(MAX_CANDIDATES), kind: `${RETRO_KIND},${REPORT_KIND}`, open: '1' })}`);
    if (!Array.isArray(hits)) return null;
    return hits.length && hits[0].by !== 'meaning' ? null : hits;
  } catch {
    return null;
  }
}

// The count of an item the count route refuses, off the open board (the daemon's 403), or of one
// whose daemon has no count route yet (a 404), is null: the match is skipped, not an error.
async function plusOnesOrNull(api: Api, id: string): Promise<number | null> {
  try {
    return await plusOnes(api, id);
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 403 || status === 404) return null;
    throw e;
  }
}

// One search line: the key, title, status, Kind, +1 count and the first line of the details.
const hitLine = (x: any, n: number): string => {
  const detail = firstDetail(x.body);
  return `${x.key} "${x.title}" [${x.status}] · Kind: ${kindOf(x.body)} · ${n} +1${n === 1 ? '' : 's'}${detail ? ` · ${detail}` : ''}`;
};

// Open retro items and feedback reports nearest the query, up to three, each with its Kind line,
// its +1 count and the first line of its details. An item scores its cosine from the meaning
// search (when the embedder is ready) plus how much of the query's words it covers, each word
// weighted by how rare it is among the open items and counted fully in the title or summary, half in
// the details (S-1925). So a paraphrase that shares the rare words still ranks first when the
// vector is missing, stale, or outscored by a longer item. A match whose +1 count the daemon
// refuses is skipped, not an error: the search goes on to the next.
export async function searchRetros(api: Api, words: string): Promise<string> {
  const all = [...wordsOf(words)];
  if (!all.length) throw new Error('search needs at least one word');
  const want = all.filter((w) => !STOPWORDS.has(w));
  if (!want.length) want.push(...all);
  const rows = (await Promise.all([RETRO_KIND, REPORT_KIND].map((k) => api('GET', `/api/itsas?kind=${k}`))))
    .flat()
    .filter((x: any) => !x.closed_at);
  // The meaning search's cosines, from one route call; none when the embedder isn't ready. A text-only
  // match carries cosine 0 and counts as none.
  const cosine = new Map<string, number>();
  for (const h of (await meaningHits(api, words)) ?? []) cosine.set(h.id, Number(h.cosine ?? h.score) || 0);
  const head = rows.map((x: any) => wordsOf(`${x.title} ${x.summary ?? ''}`));
  const rest = rows.map((x: any) => wordsOf(headerFields(x.body).details));
  const idf = new Map(want.map((w) => [w, Math.log(1 + rows.length / (1 + head.filter((h, i) => h.has(w) || rest[i].has(w)).length))]));
  const total = [...idf.values()].reduce((a, b) => a + b, 0) || 1;
  const ranked = rows
    .map((x: any, i: number) => {
      const covered = want.reduce((sum, w) => sum + idf.get(w)! * (head[i].has(w) ? 1 : rest[i].has(w) ? 0.5 : 0), 0) / total;
      return { x, cos: cosine.get(x.id), score: (cosine.get(x.id) ?? 0) + COVERAGE_WEIGHT * covered * covered, covered };
    })
    .filter((h) => (h.cos ?? 0) > 0 || h.covered > 0)
    .sort((a, b) => b.score - a.score || a.x.key.localeCompare(b.x.key));
  const lines: string[] = [];
  let byMeaning = false;
  for (const { x, cos } of ranked) {
    if (lines.length >= MAX_HITS) break;
    const n = await plusOnesOrNull(api, x.id);
    if (n === null) continue;
    if ((cos ?? 0) > 0) byMeaning = true;
    lines.push(hitLine(x, n));
  }
  if (!lines.length) return `No open retro items or feedback reports match "${words}". File yours with kind, title, summary and details.`;
  return `Ranked by ${byMeaning ? 'meaning and words' : 'keyword'}.\n${lines.join('\n')}`;
}

// A +1 on a retro item or feedback report: a comment with the reporter's scenario, which also
// makes the reporter a participant (posting does that).
export async function plusOne(api: Api, by: string, key: string, details: string): Promise<string> {
  const d = details?.trim();
  if (!d) throw new Error('details is required');
  const x = await api('GET', `/api/itsas/${encodeURIComponent(key)}`);
  if (x.kind !== RETRO_KIND && x.kind !== REPORT_KIND) throw new Error(`${x.key} is not a retro item or feedback report`);
  const { name } = await reporterOf(api, by);
  const body = `+1 from ${name}: ${d}`;
  await api('POST', `/api/itsas/${x.id}/post`, { by, body, client_id: writeId('post', by, x.id, body) }, WRITE_CALL_MS);
  // The +1 has landed, so a count read that fails must not turn it into an error (S-796).
  let n: number | null = null;
  try {
    n = await plusOnes(api, x.id);
  } catch {}
  if (n === null) return `+1 on ${x.key} "${x.title}": the +1 landed, but its count couldn't be read.`;
  return `+1 on ${x.key} "${x.title}": ${n} +1${n === 1 ? '' : 's'} now.`;
}

// The final round: the agent's effort split, stored as a retro_final event on the agent (not an
// ITSA), with its model and type so the coverage can be counted per kind of agent.
export async function finalRound(api: Api, by: string, effort: Record<string, number> | undefined): Promise<string> {
  if (!effort || typeof effort !== 'object') throw new Error(`effort is required: percentages over ${EFFORT_KEYS.join(', ')}`);
  const clean: Record<string, number> = {};
  for (const [k, v] of Object.entries(effort)) {
    if (!(EFFORT_KEYS as readonly string[]).includes(k)) throw new Error(`effort ${k} is not one of ${EFFORT_KEYS.join(', ')}`);
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) throw new Error(`effort ${k} must be a percentage from 0 to 100`);
    clean[k] = v;
  }
  await api('POST', `/api/agents/${encodeURIComponent(by)}/retro-final`, { by, effort: clean });
  return `Recorded the final retro round for ${by}: ${Object.entries(clean).map(([k, v]) => `${k} ${v}%`).join(', ') || 'no effort'}.`;
}

// The one entry point for the MCP tool and the CLI: the final round, search, +1, or file, by which field is given.
export async function runRetro(api: Api, by: string, a: RetroArgs): Promise<string> {
  if (a.final) return finalRound(api, by, a.effort);
  if (a.kind === STAM_ISSUE_KIND) return fileFeedback(api, by, { kind: a.feedback_kind ?? '', title: a.title, summary: a.summary ?? '', details: a.details ?? '', tool: a.tool });
  if (a.search?.trim()) return searchRetros(api, a.search);
  if (a.plus_one?.trim()) return plusOne(api, by, a.plus_one.trim(), a.details ?? '');
  return fileRetro(api, by, { kind: a.kind ?? '', title: a.title, summary: a.summary ?? '', details: a.details ?? '', target: a.target, evidence: a.evidence, evidenceDetail: a.evidence_detail, when: a.when });
}

// The epic retro offer (S-163): a project or initiative closed with retro items from several
// reporters under its subtree gets one offer, a one-round ring over those items when its tree has
// room in the 5-hour window, else a solo retro. Pure: the caller gathers the subtree keys, the items
// and the tree's share (retro-digest.ts epicRetroOffer).
export const EPIC_KINDS = ['project', 'initiative'];
export interface EpicRetroConfig {
  minReporters: number;
  maxWindowShare: number;
}
export interface EpicItem {
  key: string;
  body: string | null;
}
const RING_STEP = 'Offer one ring: `ring_create` with format `rounds`, `max_rounds` 1, only members still alive (no spawns), and a topic that lists these items, each answer under about 300 words. Then file the result as retro items (search and +1 first) whose `On:` names {epic}.';
const SOLO_STEP = 'Write the epic retro yourself from these items, then file it as a retro item (search and +1 first) whose `On:` names {epic}.';

// The offer, or null: not an epic, fewer than minReporters distinct reporters, or no item On the subtree.
// The tree's share of the 5-hour window below maxWindowShare gives the ring; a share that is unknown gives the solo retro.
export function epicOffer(epic: { key: string; kind: string | null }, subtree: Set<string>, items: EpicItem[], share: number | null, cfg: EpicRetroConfig): string | null {
  if (!EPIC_KINDS.includes(epic.kind ?? '')) return null;
  const hits = items.filter((x) => subtree.has(headerOf(x.body).On?.split(/\s+/)[0] ?? ''));
  const reporters = new Set(hits.map((x) => headerOf(x.body).Reporter?.replace(/ \(.*$/, '').trim()).filter(Boolean));
  if (reporters.size < cfg.minReporters) return null;
  const ring = share !== null && share < cfg.maxWindowShare;
  return render('retro-epic', {
    epic: epic.key,
    count: hits.length,
    keys: hits.map((x) => x.key).join(', '),
    step: (ring ? RING_STEP : SOLO_STEP).replace('{epic}', epic.key),
  });
}

// Lessons from similar work (S-725, R2 of docs/research/retros.md): the retro items nearest an agent's
// task by meaning, for its system prompt at spawn and its prompt after a compaction. Retrieval, never
// a digest of the store (R10). The embedder and the store are passed in, so the unit test needs no daemon.
export const LESSON_STATUSES_OUT = ['duplicate', 'wont_do', 'canceled'];
// The least cosine (MiniLM) that counts as similar. Below it an agent gets nothing instead of noise. On the
// live store an unrelated task tops out at 0.16, and the weakest hits that still name the task's topic (a CSS
// merge-conflict item for a CSS task) score 0.27; real matches run 0.35-0.65. Measured for S-725.
export const LESSON_FLOOR = 0.25;
// The block stays near 300 tokens: about 4 characters each.
export const LESSON_MAX_CHARS = 1200;
const LESSON_DETAIL_CHARS = 200;

export interface LessonItem {
  id: string;
  key: string;
  summary: string;
  body: string | null;
  status: string;
}
export interface LessonDeps {
  // The retro items under Retros, any status.
  items(): LessonItem[];
  // The cosine of the text to each id, best first; null when no embedder is ready.
  similar(text: string, ids: Set<string>): Promise<{ id: string; score: number }[] | null>;
}
export interface Lesson extends LessonItem {
  score: number;
}

// The k items nearest `text`: open ones and ones closed as done (absorbed), above the floor.
// Nothing when the embedder is down or fails: an agent never waits on lessons.
export async function lessonsFor(deps: LessonDeps, text: string, k: number): Promise<Lesson[]> {
  const q = text.replace(/\s+/g, ' ').trim();
  if (!q || k < 1) return [];
  try {
    const items = new Map(deps.items().filter((x) => !LESSON_STATUSES_OUT.includes(x.status)).map((x) => [x.id, x]));
    if (!items.size) return [];
    const near = await deps.similar(q, new Set(items.keys()));
    if (!near) return [];
    return near
      .filter((n) => n.score >= LESSON_FLOOR && items.has(n.id))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((n) => ({ ...items.get(n.id)!, score: n.score }));
  } catch {
    return [];
  }
}

// The details of a retro body: the text after the header lines (Kind, Target, Reporter, On).
const detailsOf = (body: string | null): string => (body ?? '').replace(/^(?:[A-Z][A-Za-z]*: .*\n)+\n?/, '').trim();

// One line per lesson: the key, the summary, and the first lines of the details; the whole block
// stays under LESSON_MAX_CHARS. Empty when there are no lessons.
export function renderLessons(lessons: Lesson[]): string {
  const lines: string[] = [];
  let used = 0;
  for (const x of lessons) {
    const d = detailsOf(x.body).split('\n').filter(Boolean).slice(0, 2).join(' ');
    const detail = d.length > LESSON_DETAIL_CHARS ? `${d.slice(0, LESSON_DETAIL_CHARS).trimEnd()}…` : d;
    const summary = x.summary.replace(/\s+/g, ' ').trim().replace(/[.:;]+$/, '');
    const line = `- ${x.key} ${summary}${detail ? `: ${detail}` : ''}`;
    if (lines.length && used + line.length > LESSON_MAX_CHARS) break;
    lines.push(line.slice(0, LESSON_MAX_CHARS));
    used += line.length;
  }
  return lines.length ? render('lessons', { items: lines.join('\n') }) : '';
}
