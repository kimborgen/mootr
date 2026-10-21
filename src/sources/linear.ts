// The Linear source (S-56): a poller that turns changes on the Linear issues agents and ITSAs
// watch into external events. The daemon starts it; every `settings.watch.linearSeconds` it
// polls each `linear:TEAM-123` subject from `watch.watchedSubjects()` through Linear's MCP
// server (the `linear` entry in mcpServers, logged in once through the shared OAuth), with
// `get_issue` and `list_comments`. It keeps one snapshot per subject in `watch_state` and one
// event per change, with dedupe keys that name the change's time. The first poll records the
// snapshot silently. No login, or no `linear` server, is logged once and skipped. The tool
// names are settings (`watch.linearTools`); the real names and result shapes are unverified
// until the user logs in, so the parsing is defensive. A `linear:team:KEY` subject polls the
// team's issues instead: `list_issues` for those changed since the team's cursor, then the
// same snapshot diff per issue (see tickTeam). See docs/design.md, Event subscriptions.
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

// `linear:TEAM-123` is an issue we can poll; null for anything else (a team is parseTeamSubject).
export function parseSubject(subject: string): { id: string } | null {
  const m = /^linear:([A-Za-z][A-Za-z0-9]*-\d+)$/.exec(subject);
  return m ? { id: m[1].toUpperCase() } : null;
}

// `linear:team:KEY` is a team: every issue in it is polled. Null for anything else.
export function parseTeamSubject(subject: string): { key: string } | null {
  const m = /^linear:team:([A-Za-z][A-Za-z0-9]*)$/.exec(subject);
  return m ? { key: m[1].toUpperCase() } : null;
}

export interface LinearIssue {
  id: string;
  title: string | null;
  url: string | null;
  state: string | null;
  assignee: string | null;
  priority: string | null;
  updatedAt: string | null;
  createdAt: string | null;
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
    createdAt: issue.createdAt ?? issue.created_at ?? null,
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
// comments already seen); null means the first poll, which emits nothing. A team's poll
// (`team`, its subject) makes each event carry the team alone, not the issue, so an issue-only
// subscriber hears the change once (from the issue's poll) and a team subscriber once (from the
// team's); the dedupe keys name the team too, since the dedupe is global and the issue's own
// poll may ingest the same change first.
export function diffIssue(subject: string, prev: any | null, cur: LinearIssue, comments: LinearComment[], team: string | null = null): watch.EventInput[] {
  if (!prev) return [];
  const events: watch.EventInput[] = [];
  const at = cur.updatedAt ?? '';
  // A team's event names the issue in its payload, so a team watcher can tell which issue moved.
  const base = { source: 'linear', subject: team ?? subject, subjects: [team ?? subject], url: cur.url, actor: null, ...(team ? { payload: { issue: subject } } : {}) };
  const dedupe = (type: string, tail: string) => (team ? `${type}:${team}:${subject}:${tail}` : `${type}:${subject}:${tail}`);
  const label = cur.id;
  if (prev.state && cur.state && prev.state !== cur.state) {
    events.push({ ...base, type: 'issue.state_changed', summary: `${label} state: ${prev.state} → ${cur.state}`, dedupe_key: dedupe('issue.state_changed', at) });
  }
  if (prev.assignee !== cur.assignee) {
    events.push({ ...base, type: 'issue.assigned', summary: `${label} assigned to ${cur.assignee ?? 'nobody'}`, dedupe_key: dedupe('issue.assigned', at) });
  }
  if (prev.priority !== cur.priority) {
    events.push({ ...base, type: 'issue.priority_changed', summary: `${label} priority: ${prev.priority ?? 'none'} → ${cur.priority ?? 'none'}`, dedupe_key: dedupe('issue.priority_changed', at) });
  }
  if (prev.title && cur.title && prev.title !== cur.title) {
    events.push({ ...base, type: 'issue.title_changed', summary: `${label} renamed: ${cur.title}`, dedupe_key: dedupe('issue.title_changed', at) });
  }
  const seen = new Set<string>(prev.commentIds ?? []);
  for (const c of comments) {
    if (seen.has(c.id)) continue;
    events.push({ ...base, type: 'comment.created', actor: c.author, summary: `${label} comment by ${c.author ?? 'someone'}: ${firstLine(c.body)}`, dedupe_key: dedupe('comment.created', c.id) });
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

// A team's poll. The first poll sets the team's cursor and baseline to now and lists nothing, so
// the history before it is not replayed. Each later poll lists the issues changed since the cursor,
// every page of them, sorted locally (so Linear's order does not matter), and works through them
// oldest first with at most TEAM_COMMENTS_PER_TICK comment calls; the rest carry over to the next
// tick. An issue already snapshotted at its updatedAt takes no call and no cap. The cursor moves
// only past the issues processed, and never on a failed list. Each issue's snapshot is
// `${team}/${id}`, so the issue's own subject is never touched.
const TEAM_PAGE = 50;
// Comment calls one tick makes; the changes past them carry over to the next tick.
const TEAM_COMMENTS_PER_TICK = 10;
// Pages one list may read. A list that never ends (a server that ignores `after`, or never runs out)
// fails at this cap instead of hanging the tick.
const TEAM_PAGES_MAX = 200;
// A 429 (or a message that says so) pauses every team's poll for this long.
const RATE_BACKOFF_MS = 5 * 60_000;
const RATE_LIMITED = /\b429\b|rate.?limit/i;
let teamBackoffUntil = 0;

// The team's issues changed since `since`, oldest first. Throws when a page fails, when a page's
// endCursor is the one it was asked for (the list did not move on), and past TEAM_PAGES_MAX pages.
async function listTeamIssues(key: string, since: string): Promise<LinearIssue[]> {
  const tool = settings().watch.linearTools.teamIssues;
  const out: LinearIssue[] = [];
  let after: string | null = null;
  for (let page = 1; ; page++) {
    if (page > TEAM_PAGES_MAX) throw new Error(`linear team ${key}: more than ${TEAM_PAGES_MAX} pages of changes`);
    const args: Record<string, unknown> = { team: key, updatedAt: since, orderBy: 'updatedAt', limit: TEAM_PAGE };
    if (after) args.after = after;
    const o: any = jsonOf(await callTool(SERVER, tool, args));
    const list: any[] = Array.isArray(o) ? o : Array.isArray(o?.issues) ? o.issues : Array.isArray(o?.nodes) ? o.nodes : [];
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      out.push(normalizeIssue(raw, String(raw.identifier ?? raw.id ?? '')));
    }
    if (!o?.pageInfo?.hasNextPage) break;
    const end = o.pageInfo.endCursor;
    if (!end || end === after) throw new Error(`linear team ${key}: the list did not move past page ${page}`);
    after = end;
  }
  return out.filter((i) => i.id).sort((a, b) => String(a.updatedAt ?? '').localeCompare(String(b.updatedAt ?? '')));
}

// The event for an issue first seen after the team's baseline: it was created since the team's first poll.
function createdEvent(team: string, subject: string, cur: LinearIssue): watch.EventInput {
  return {
    source: 'linear',
    type: 'issue.created',
    subject: team,
    subjects: [team],
    actor: null,
    url: cur.url,
    summary: `${cur.id} created: ${cur.title ?? ''}`.trim(),
    payload: { issue: subject },
    dedupe_key: `issue.created:${team}:${subject}`,
  };
}

// The event for an issue this team has not seen before that changed after the baseline, but was
// created before it: a change the poll never snapshotted.
function updatedEvent(team: string, subject: string, cur: LinearIssue): watch.EventInput {
  return {
    source: 'linear',
    type: 'issue.updated',
    subject: team,
    subjects: [team],
    actor: null,
    url: cur.url,
    summary: `${cur.id} updated: ${cur.title ?? ''}`.trim(),
    payload: { issue: subject },
    dedupe_key: `issue.updated:${team}:${subject}:${cur.updatedAt}`,
  };
}

// One poll of a team. Returns how many events it ingested.
async function tickTeam(subject: string, key: string): Promise<number> {
  const tools = settings().watch.linearTools;
  const row = safeParse(db.getWatchState(subject)?.state ?? null) ?? {};
  if (!row.cursor) {
    // The first poll: the cursor and the baseline are now, and no history is read.
    const now = new Date().toISOString();
    db.setWatchState(subject, { cursor: now, baseline: now }, {});
    return 0;
  }
  const cursor: string = row.cursor;
  const baseline: string = row.baseline ?? cursor;
  const issues = await listTeamIssues(key, cursor);
  let next = cursor;
  let ingested = 0;
  let commentCalls = 0;
  try {
    for (const cur of issues) {
      const snap = `${subject}/${cur.id}`;
      const prev = safeParse(db.getWatchState(snap)?.state ?? null);
      // A snapshot already at this updatedAt has nothing new: no comment call, no cap, and the cursor moves past it.
      // Without this, ten issues sharing one updatedAt would hold the cursor for good.
      if (prev && cur.updatedAt && prev.updatedAt === cur.updatedAt) {
        if (!next || cur.updatedAt > next) next = cur.updatedAt;
        continue;
      }
      if (commentCalls >= TEAM_COMMENTS_PER_TICK) break;
      const comments = normalizeComments(jsonOf(await callTool(SERVER, tools.comments, { issueId: cur.id })));
      commentCalls++;
      const events = diffIssue(`linear:${cur.id}`, prev, cur, comments, subject);
      if (!prev) {
        if (cur.createdAt && cur.createdAt > baseline) events.push(createdEvent(subject, `linear:${cur.id}`, cur));
        else if (cur.updatedAt && cur.updatedAt > baseline) events.push(updatedEvent(subject, `linear:${cur.id}`, cur));
      }
      db.setWatchState(snap, snapshot(cur, comments, prev), {});
      for (const ev of events) {
        watch.ingest(ev);
        ingested++;
      }
      if (cur.updatedAt && (!next || cur.updatedAt > next)) next = cur.updatedAt;
    }
  } finally {
    db.setWatchState(subject, { cursor: next, baseline }, {});
  }
  return ingested;
}

// Forgets a team's rows (its cursor and its issues' snapshots) once no subscription watches it.
function dropUnwatchedTeams(watched: string[]): void {
  const teams = new Set(watched);
  for (const subject of db.watchStateSubjects('linear:team:')) {
    if (!subject.includes('/') && !teams.has(subject)) db.deleteWatchStateTree(subject);
  }
}

// For tests: forget a rate-limit pause, so the next tick polls teams again.
export function resetBackoff(): void {
  teamBackoffUntil = 0;
}

// One poll of every watched Linear issue and team. Records each snapshot and ingests one event per
// change. Returns how many events it ingested.
export async function tick(): Promise<number> {
  const subjects = watch.watchedSubjects().filter((s) => s.startsWith('linear:'));
  dropUnwatchedTeams(subjects);
  let ingested = 0;
  for (const subject of subjects) {
    const team = parseTeamSubject(subject);
    if (team) {
      if (Date.now() < teamBackoffUntil) continue;
      try {
        ingested += await tickTeam(subject, team.key);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (RATE_LIMITED.test(msg)) teamBackoffUntil = Date.now() + RATE_BACKOFF_MS;
        logOnce(`team ${subject} poll failed: ${msg}`);
      }
      continue;
    }
    if (!parseSubject(subject)) {
      logOnce(`ignoring subject ${subject}: only linear:TEAM-123 issues and linear:team:KEY are polled`);
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

// The tick in flight, if any: a tick that outlives its interval makes the next one skip, not stack.
let inFlight: Promise<number> | null = null;
export function tickOnce(): Promise<number> {
  if (!inFlight) inFlight = tick().finally(() => (inFlight = null));
  return inFlight;
}

let started = false;

// Started by the daemon (src/daemon.ts). One interval; 0 disables polling.
export function start(): void {
  if (started) return;
  const seconds = settings().watch.linearSeconds;
  if (!(seconds > 0)) return;
  started = true;
  const run = () => tickOnce().catch((e) => console.error(`linear: ${e instanceof Error ? e.message : e}`));
  const timer = setInterval(run, seconds * 1000);
  timer.unref?.();
}
