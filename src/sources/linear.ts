// The Linear source (S-56): a poller that turns changes on the Linear issues agents and ITSAs
// watch into external events. The daemon starts it; every `settings.watch.linearSeconds` it
// polls each `linear:TEAM-123` subject from `watch.watchedSubjects()` through Linear's MCP
// server (the `linear` entry in mcpServers, logged in once through the shared OAuth), with
// `get_issue` and `list_comments`. It keeps one snapshot per subject in `watch_state` and one
// event per change, with dedupe keys that name the change's time. The first poll records the
// snapshot silently. No login, or no `linear` server, is logged once and skipped. The tool
// names are settings (`watch.linearTools`); the real names and result shapes are unverified
// until Kim logs in, so the parsing is defensive. See docs/design.md, Event subscriptions.
import * as db from '../db.ts';
import * as watch from '../watch.ts';
import { settings } from '../settings.ts';
import { callTool, jsonOf } from './mcp-client.ts';

// The stam name of the Linear MCP server in mcpServers.
export const SERVER = 'linear';

// Log a message once per daemon, so a missing login doesn't repeat every tick.
const logged = new Set<string>();
function logOnce(msg: string): void {
  if (logged.has(msg)) return;
  logged.add(msg);
  console.error(`linear: ${msg}`);
}

// `linear:TEAM-123` is an issue we can poll. `linear:team:KEY` is a team, which is not polled
// yet (it needs a list tool); null for both and anything else.
export function parseSubject(subject: string): { id: string } | null {
  const m = /^linear:([A-Za-z][A-Za-z0-9]*-\d+)$/.exec(subject);
  return m ? { id: m[1].toUpperCase() } : null;
}

export interface LinearIssue {
  id: string;
  title: string | null;
  url: string | null;
  state: string | null;
  assignee: string | null;
  priority: string | null;
  updatedAt: string | null;
}

export interface LinearComment {
  id: string;
  author: string | null;
  body: string;
  createdAt: string | null;
}

// A name from a field that may be a string or an object with a name, displayName, or email.
const named = (v: any): string | null => {
  if (typeof v === 'string') return v || null;
  if (v && typeof v === 'object') return (v.name ?? v.displayName ?? v.email ?? null) || null;
  return null;
};

// The issue from whatever shape the tool answered with. Priority is its label or name, or the
// bare number, as text.
export function normalizeIssue(o: any, id: string): LinearIssue {
  const issue = o && typeof o === 'object' ? (o.issue ?? o) : {};
  const p = issue.priority;
  const priority = p == null || p === '' ? null : typeof p === 'object' ? (named(p) ?? (p.value != null ? String(p.value) : null)) : String(p);
  return {
    id,
    title: typeof issue.title === 'string' ? issue.title : null,
    url: typeof issue.url === 'string' ? issue.url : null,
    state: named(issue.state),
    assignee: named(issue.assignee),
    priority,
    updatedAt: issue.updatedAt ?? issue.updated_at ?? null,
  };
}

// The comments from a list answer, which may be a bare array or hold one under `comments` or
// `nodes`.
export function normalizeComments(o: any): LinearComment[] {
  const list: any[] = Array.isArray(o) ? o : Array.isArray(o?.comments) ? o.comments : Array.isArray(o?.nodes) ? o.nodes : [];
  return list
    .filter((c) => c && c.id != null)
    .map((c) => ({
      id: String(c.id),
      author: named(c.user) ?? named(c.author) ?? named(c.creator),
      body: String(c.body ?? ''),
      createdAt: c.createdAt ?? c.created_at ?? null,
    }));
}

// The events one poll's changes make. `prev` is the last snapshot (its `commentIds` the
// comments already seen); null means the first poll, which emits nothing.
export function diffIssue(subject: string, prev: any | null, cur: LinearIssue, comments: LinearComment[]): watch.EventInput[] {
  if (!prev) return [];
  const events: watch.EventInput[] = [];
  const at = cur.updatedAt ?? '';
  const base = { source: 'linear', subject, subjects: [subject], url: cur.url, actor: null };
  const label = cur.id;
  if (prev.state && cur.state && prev.state !== cur.state) {
    events.push({ ...base, type: 'issue.state_changed', summary: `${label} state: ${prev.state} → ${cur.state}`, dedupe_key: `issue.state_changed:${subject}:${at}` });
  }
  if (prev.assignee !== cur.assignee) {
    events.push({ ...base, type: 'issue.assigned', summary: `${label} assigned to ${cur.assignee ?? 'nobody'}`, dedupe_key: `issue.assigned:${subject}:${at}` });
  }
  if (prev.priority !== cur.priority) {
    events.push({ ...base, type: 'issue.priority_changed', summary: `${label} priority: ${prev.priority ?? 'none'} → ${cur.priority ?? 'none'}`, dedupe_key: `issue.priority_changed:${subject}:${at}` });
  }
  if (prev.title && cur.title && prev.title !== cur.title) {
    events.push({ ...base, type: 'issue.title_changed', summary: `${label} renamed: ${cur.title}`, dedupe_key: `issue.title_changed:${subject}:${at}` });
  }
  const seen = new Set<string>(prev.commentIds ?? []);
  for (const c of comments) {
    if (seen.has(c.id)) continue;
    events.push({ ...base, type: 'comment.created', actor: c.author, summary: `${label} comment by ${c.author ?? 'someone'}: ${firstLine(c.body)}`, dedupe_key: `comment.created:${subject}:${c.id}` });
  }
  return events;
}

const firstLine = (body: string): string => String(body ?? '').split('\n')[0].trim().slice(0, 200);

// The snapshot to keep: the issue's fields and the ids of the comments seen (the last 500).
function snapshot(cur: LinearIssue, comments: LinearComment[], prev: any | null): any {
  const ids = [...new Set([...(prev?.commentIds ?? []), ...comments.map((c) => c.id)])];
  return { ...cur, commentIds: ids.slice(-500) };
}

// Polls one issue: its fields and comments through the Linear MCP server. Throws when the
// server, its login, or a tool fails, so the tick logs it and keeps the old snapshot.
export async function pollIssue(subject: string, prev: any | null): Promise<{ events: watch.EventInput[]; state: any }> {
  const p = parseSubject(subject);
  if (!p) return { events: [], state: prev ?? {} };
  const tools = settings().watch.linearTools;
  const issue = normalizeIssue(jsonOf(await callTool(SERVER, tools.issue, { id: p.id })), p.id);
  const comments = normalizeComments(jsonOf(await callTool(SERVER, tools.comments, { issueId: p.id })));
  return { events: diffIssue(subject, prev, issue, comments), state: snapshot(issue, comments, prev) };
}

// One poll of every watched Linear issue. Records each snapshot and ingests one event per
// change. Returns how many events it ingested.
export async function tick(): Promise<number> {
  const subjects = watch.watchedSubjects().filter((s) => s.startsWith('linear:'));
  let ingested = 0;
  for (const subject of subjects) {
    if (!parseSubject(subject)) {
      logOnce(`ignoring subject ${subject}: only linear:TEAM-123 issues are polled for now`);
      continue;
    }
    const row = db.getWatchState(subject);
    const prev = row ? safeParse(row.state) : null;
    let result: { events: watch.EventInput[]; state: any };
    try {
      result = await pollIssue(subject, prev);
    } catch (e) {
      logOnce(`poll ${subject} failed: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    db.setWatchState(subject, result.state, {});
    for (const ev of result.events) {
      watch.ingest(ev);
      ingested++;
    }
  }
  return ingested;
}

function safeParse(raw: string | null): any {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// Per requested subject, what the dashboard shows (S-65): the issue's state, assignee,
// priority, title, and url.
export function stateFor(subjects: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const subject of subjects) {
    const row = db.getWatchState(subject);
    const state = row ? (safeParse(row.state) ?? {}) : null;
    out[subject] = state
      ? { state: state.state ?? null, assignee: state.assignee ?? null, priority: state.priority ?? null, title: state.title ?? null, url: state.url ?? null, updated_at: row!.updated_at }
      : { updated_at: null };
  }
  return out;
}

let started = false;

// Started by the daemon (src/daemon.ts). One interval; 0 disables polling.
export function start(): void {
  if (started) return;
  const seconds = settings().watch.linearSeconds;
  if (!(seconds > 0)) return;
  started = true;
  const run = () => tick().catch((e) => console.error(`linear: ${e instanceof Error ? e.message : e}`));
  const timer = setInterval(run, seconds * 1000);
  timer.unref?.();
}
