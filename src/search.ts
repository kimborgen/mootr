// One search box across stam, behind GET /api/search: agents, the human's mail threads,
// ITSAs, and Settings. Mail lives on whichever daemon it was sent to, so a request from
// the web UI also fans out to the peers; a peer's own request (x-stam-local) returns only
// what it holds, as the other list routes do. ITSAs live on their home daemon, so only the
// daemon answering the web UI asks for them.
import { MACHINE } from './config.ts';
import * as db from './db.ts';
import { fanOut, peerByName, peerCall } from './peers.ts';
import { searchItsas, type ItsaHit } from './itsa-search.ts';
import { searchMail, type MailHit } from './mail-search.ts';
import { settings } from './settings.ts';

export type Kind = 'agent' | 'thread' | 'itsa' | 'setting';

export interface Result {
  kind: Kind;
  // What opening needs: an agent id, a thread id, an ITSA id, or a setting key.
  id: string;
  title: string;
  // A short excerpt: an agent's role, the matched mail text, an ITSA's summary.
  snippet?: string;
  meta?: string;
  score: number;
  // Mail and ITSAs only: which ranking placed the hit.
  by?: 'meaning' | 'keyword';
  // Suggestions only: the agent turn that matched (its id), with the turn as the snippet.
  turn?: string;
  // Settings only: the section to open, and the instruction item when the result is one.
  section?: string;
  item?: string;
}

// Ranks one field against the query: an exact hit beats a prefix, which beats a match at a
// word start, which beats a match inside a word. 0 means no match.
export function rank(text: string | null | undefined, q: string): number {
  const t = (text ?? '').toLowerCase();
  const s = q.toLowerCase();
  if (!s) return 0;
  const i = t.indexOf(s);
  if (i < 0) return 0;
  if (t === s) return 5;
  if (i === 0) return 4;
  return /[\s\-_/.([{]/.test(t[i - 1] ?? '') ? 3 : 2;
}

// Component blocks carry their name on the fence line (```decision) or on the line after a
// bare fence; a search snippet drops those, the fence markers, callout tags, HTML tags, and
// math delimiters, so it reads as plain prose even when a mail is full of mail components.
const COMPONENT = new Set(['decision', 'yesno', 'pick', 'rank', 'table', 'csv', 'chart', 'metrics', 'checklist', 'progress', 'timeline', 'diff', 'tests', 'error', 'spend', 'terminal', 'ts', 'mermaid', 'embed', 'pane', 'details', 'compare', 'math']);

// The prose of a text, one line: the component fences and markup dropped (the same cleaning
// the excerpt uses). The embedder reads it too (S-141).
export function plainText(text: string): string {
  return String(text ?? '')
    .split('\n')
    .map((l) => l.replace(/^\s*```[a-z-]*\s*$/i, '').replace(/^\s*```[a-z-]*\s+/i, ''))
    .filter((l) => !COMPONENT.has(l.trim().toLowerCase()))
    .join(' ')
    .replace(/\[![A-Z]+\]/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\\[()[\]]/g, ' ')
    .replace(/\$\$/g, ' ')
    .replace(/[#>*`_[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// A one-line excerpt of prose around the match.
export function excerpt(text: string, q: string, n = 90): string {
  const flat = plainText(text);
  const i = flat.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return flat.length > n ? flat.slice(0, n) + '…' : flat;
  const start = Math.max(0, i - 24);
  return (start > 0 ? '…' : '') + flat.slice(start, start + n) + (start + n < flat.length ? '…' : '');
}

function agentResults(q: string): Result[] {
  return db
    .searchAgents(q)
    .map((a) => ({ kind: 'agent' as const, id: a.id, title: a.name, snippet: a.role || undefined, meta: a.machine, score: rank(a.name, q) * 2 + rank(a.role, q) + rank(a.id, q) }))
    .filter((r) => r.score > 0);
}

// Threads the human takes part in. The daemon hands back matching messages newest first (or
// best-first under FTS5); each thread keeps the message that scored highest.
function threadResults(q: string, limit: number): Result[] {
  const best = new Map<string, { mail: db.Mail; score: number }>();
  for (const m of db.searchMailText(q, 'human', limit * 3)) {
    const tid = m.thread_id ?? m.id;
    const score = rank(m.subject, q) * 2 + rank(m.body, q);
    if (!best.has(tid) || score > best.get(tid)!.score) best.set(tid, { mail: m, score });
  }
  return [...best.values()].map(({ mail: m, score }) => ({
    kind: 'thread' as const,
    id: m.thread_id ?? m.id,
    title: m.subject || '(no subject)',
    snippet: excerpt(m.body, q) || undefined,
    meta: m.from_name ?? (m.from_id === 'human' ? 'you' : m.from_id),
    score,
  }));
}

// The human's ITSAs by meaning, from their home daemon (this one, or a peer that holds them).
export async function itsaHits(q: string, limit: number): Promise<ItsaHit[]> {
  try {
    const home = settings().itsa.home ?? MACHINE;
    if (home === MACHINE) return await searchItsas(q, { limit });
    const peer = peerByName(home);
    if (!peer) return [];
    const r = await peerCall(peer, 'GET', `/api/itsas/search?q=${encodeURIComponent(q)}&limit=${limit}`);
    return r.status === 200 && Array.isArray(r.data) ? (r.data as ItsaHit[]) : [];
  } catch {
    return [];
  }
}

function itsaResults(hits: ItsaHit[]): Result[] {
  return hits.map((x) => ({
    kind: 'itsa' as const,
    id: x.id,
    title: x.title,
    snippet: x.excerpt || undefined,
    meta: `${x.key} · ${x.status}`,
    score: x.score,
    by: x.by,
  }));
}

// The human's mail threads by meaning, across the daemons (searchMail fans out to the peers itself).
async function mailResults(q: string, limit: number): Promise<Result[]> {
  try {
    const hits = (await searchMail('human', q, { limit, local: false })) as MailHit[];
    return hits.map((h) => ({
      kind: 'thread' as const,
      id: h.thread_id,
      title: h.subject,
      snippet: h.excerpt || undefined,
      meta: h.people.map((p) => (p === 'human' ? 'you' : p)).join(', '),
      score: h.score,
      by: h.by,
    }));
  } catch {
    return [];
  }
}

// Settings sections and instruction items, from the same list the UI shows (ConfigView's
// SECTIONS and instructionGroups). Static: search doesn't need the live settings to name
// where a section is.
const SECTIONS = [
  { key: 'assistant', label: 'Executive assistant' },
  { key: 'agents', label: 'New agents' },
  { key: 'view', label: 'Agent view' },
  { key: 'tools', label: 'Tools' },
  { key: 'workcols', label: 'Fields and cards' },
  { key: 'mail', label: 'Mail to you' },
  { key: 'context', label: 'Context and compaction' },
  { key: 'spend', label: 'Spending' },
  { key: 'machines', label: 'Machines' },
  { key: 'instructions', label: 'Instructions' },
  { key: 'messages', label: 'Messages mootr sends' },
  { key: 'advanced', label: 'Advanced' },
];
const INSTRUCTION_ITEMS = [
  { name: 'instructions', label: 'Your instructions' },
  { name: 'system-prompt', label: 'Base system prompt' },
  { name: 'chief-of-staff', label: 'Chief of staff' },
  { name: 'assistant', label: 'Executive assistant' },
  { name: 'mail-to-human', label: 'Mail rules' },
  { name: 'mail-to-human-restricted', label: 'Mail to you: restricted model' },
  { name: 'human-mail-when-necessary', label: 'Mail to you: necessary' },
  { name: 'human-mail-when-important', label: 'Mail to you: important' },
  { name: 'human-mail-when-everything', label: 'Mail to you: everything' },
  { name: 'instruction-files', label: 'Instruction files' },
  { name: 'workspace-instructions', label: 'Workspace instructions' },
];

function settingResults(q: string): Result[] {
  const out: Result[] = [];
  for (const s of SECTIONS) {
    const score = rank(s.label, q);
    if (score) out.push({ kind: 'setting', id: 'section:' + s.key, title: s.label, meta: 'Settings', section: s.key, score });
  }
  for (const it of INSTRUCTION_ITEMS) {
    const score = rank(it.label, q);
    if (score) out.push({ kind: 'setting', id: 'item:' + it.name, title: it.label, meta: 'Settings · Instructions', section: 'instructions', item: it.name, score });
  }
  return out;
}

// Scores of different kinds don't share a scale: agents and settings rank by keyword (up to about
// 13), mail and ITSAs by meaning (0-1). Each kind's scores are divided by that kind's best, so each
// kind keeps its own order and its top hit can reach the trimmed list beside the others.
export function scaleByKind(all: Result[]): Result[] {
  const best = new Map<Kind, number>();
  for (const r of all) best.set(r.kind, Math.max(best.get(r.kind) ?? 0, r.score));
  return all.map((r) => ({ ...r, score: best.get(r.kind)! > 0 ? r.score / best.get(r.kind)! : 0 }));
}

// Dedupes by kind and id (a thread or an ITSA may be reported by more than one source),
// then sorts by score and trims.
export function rankAndTrim(all: Result[], limit: number): Result[] {
  const seen = new Map<string, Result>();
  for (const r of all) {
    const key = r.kind + ':' + r.id;
    if (!seen.has(key) || r.score > seen.get(key)!.score) seen.set(key, r);
  }
  return [...seen.values()].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
}

// `humanMail` is false for an agent's or the OpenCode server's request: the human's mail isn't theirs to
// search, here or on the peers (S-259).
export async function search(q: string, limit: number, local: boolean, humanMail = true): Promise<Result[]> {
  const s = String(q ?? '').trim();
  if (!s) return [];
  if (local) return rankAndTrim([...agentResults(s), ...(humanMail ? threadResults(s, limit) : [])], limit);
  // The peers' threads are dropped: searchMail already covers every daemon's mail.
  const [peerOwn, mail, issues] = await Promise.all([
    fanOut<Result>(`/api/search?q=${encodeURIComponent(s)}&limit=${limit}`),
    humanMail ? mailResults(s, limit) : Promise.resolve([]),
    itsaHits(s, limit),
  ]);
  const agents = [...agentResults(s), ...peerOwn.filter((r) => r.kind !== 'thread')];
  return rankAndTrim(scaleByKind([...agents, ...mail, ...itsaResults(issues), ...settingResults(s)]), limit);
}
