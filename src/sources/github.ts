// The GitHub source (S-55): a poller that turns changes on the repositories agents and ITSAs
// watch into external events. The daemon starts it; every `settings.watch.githubSeconds` it
// polls each subject from `watch.watchedSubjects()` that names a repository, a pull request,
// or an issue. It keeps one snapshot per subject (`watch_state`) and one event per change,
// with stable dedupe keys, so a poll that changes nothing emits nothing. Polling only: no
// public webhook endpoint. The `gh` login's token (mcp-auth.ghToken) authorizes the calls;
// STAM_GITHUB_API and STAM_GITHUB_TOKEN override the base and token for tests. See
// docs/design.md, Event subscriptions.
import * as db from '../db.ts';
import * as watch from '../watch.ts';
import { settings } from '../settings.ts';
import { ghToken } from '../mcp-auth.ts';
import { mirrorEventMain, mirrorEventPr } from '../pr-mirror.ts';

const DEFAULT_BASE = 'https://api.github.com';
const base = () => (process.env.STAM_GITHUB_API || DEFAULT_BASE).replace(/\/+$/, '');

// Log a message once per daemon, so a missing token or a glob subject doesn't repeat every tick.
const logged = new Set<string>();
function logOnce(msg: string): void {
  if (logged.has(msg)) return;
  logged.add(msg);
  console.error(`github: ${msg}`);
}

export interface GithubSubject {
  owner: string;
  repo: string;
  // The pull request or issue number; null for a repository subject.
  number: number | null;
  key: string;
  repoKey: string;
}

// The subject key as GitHub names it, or null when it isn't one stam can poll: a repository
// (`github:OWNER/REPO`), a pull request or issue (`github:OWNER/REPO#N`). Globs are skipped.
export function parseSubject(subject: string): GithubSubject | null {
  const m = /^github:([^/#\s*]+)\/([^/#\s*]+)(?:#(\d+))?$/.exec(String(subject ?? ''));
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: m[3] ? Number(m[3]) : null, key: subject, repoKey: `github:${m[1]}/${m[2]}` };
}

// The token to poll with: a test override, else the `gh` login's. Null when there is none,
// so the tick is skipped (logged once).
export async function token(): Promise<string | null> {
  if (process.env.STAM_GITHUB_TOKEN) return process.env.STAM_GITHUB_TOKEN;
  try {
    return await ghToken();
  } catch {
    logOnce('no gh login; polling skipped (log in with `gh auth login`, or set STAM_GITHUB_TOKEN)');
    return null;
  }
}

interface Reply {
  status: number;
  body: any;
  etag: string | null;
  link: string | null;
  remaining: number | null;
  resetAt: number | null;
}

// One GET. If-None-Match with the stored ETag; a 304 means unchanged. Rate-limit headers are
// passed back so the tick can back off.
async function get(path: string, token: string, etag?: string): Promise<Reply> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'stam', authorization: `Bearer ${token}` };
  if (etag) headers['if-none-match'] = etag;
  const res = await fetch(`${base()}${path}`, { headers, signal: AbortSignal.timeout(20_000) });
  const remaining = num(res.headers.get('x-ratelimit-remaining'));
  const reset = num(res.headers.get('x-ratelimit-reset'));
  const resetAt = reset ? reset * 1000 : null;
  if (res.status === 304) return { status: 304, body: undefined, etag: etag ?? null, link: null, remaining, resetAt };
  const text = await res.text();
  let body: any = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  return { status: res.status, body, etag: res.headers.get('etag'), link: res.headers.get('link'), remaining, resetAt };
}

const num = (v: string | null): number | null => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

export interface PollResult {
  events: watch.EventInput[];
  state: any;
  etags: Record<string, string>;
  remaining: number | null;
  resetAt: number | null;
}

// Polls one subject and returns the events its changes make, the new snapshot, and the new
// ETags. `prev` null means the first poll: it records the snapshot and emits nothing, so a
// long-standing open PR does not flood every subscriber when it is first watched.
export async function pollSubject(subject: string, prev: any | null, prevEtags: Record<string, string> = {}, token: string): Promise<PollResult> {
  const s = parseSubject(subject);
  if (!s) return { events: [], state: prev ?? {}, etags: prevEtags, remaining: null, resetAt: null };
  return s.number == null ? pollRepo(s, prev, prevEtags, token) : pollNumber(s, prev, prevEtags, token);
}

// ---- a pull request or an issue ----

// The fields of a check run and a commit status the snapshot keeps (state.headRuns, headStatuses).
const slimRun = (r: any) => ({ name: r.name ?? '', status: r.status ?? '', conclusion: r.conclusion ?? null, completed_at: r.completed_at ?? null });
const slimStatus = (x: any) => ({ context: x.context ?? '', state: x.state ?? '', description: x.description ?? null, updated_at: x.updated_at ?? null, created_at: x.created_at ?? null });

// The combined check state for a head from its check runs and the commit statuses: pending
// until every one is done, then success, or failure with the names that failed. `none` when
// the head has neither.
export function checksState(checkRuns: any[], statuses: any[]): { state: 'none' | 'pending' | 'success' | 'failure'; failing: string[] } {
  const runs = (checkRuns ?? []).map((r) => ({ name: String(r.name ?? ''), status: String(r.status ?? ''), conclusion: String(r.conclusion ?? '') }));
  const sts = (statuses ?? []).map((s) => ({ name: String(s.context ?? ''), state: String(s.state ?? '') }));
  if (!runs.length && !sts.length) return { state: 'none', failing: [] };
  if (runs.some((r) => r.status !== 'completed') || sts.some((s) => s.state === 'pending')) return { state: 'pending', failing: [] };
  const failing = [...runs.filter((r) => !['success', 'neutral', 'skipped'].includes(r.conclusion)).map((r) => r.name), ...sts.filter((s) => s.state !== 'success').map((s) => s.name)].filter(Boolean);
  return { state: failing.length ? 'failure' : 'success', failing };
}

const lastReviewState = (reviews: any[]): 'approved' | 'changes_requested' | 'none' => {
  let out: 'approved' | 'changes_requested' | 'none' = 'none';
  for (const r of reviews) {
    if (r.state === 'APPROVED') out = 'approved';
    else if (r.state === 'CHANGES_REQUESTED') out = 'changes_requested';
  }
  return out;
};

const firstLine = (body: string): string => String(body ?? '').split('\n')[0].trim().slice(0, 200);

// The commit status context scripts/pr-review.mjs posts a verdict under (scripts/merge-pr.mjs,
// REVIEW_CONTEXT); our gates post `stam/gates`.
export const REVIEW_CONTEXT = 'stam/review';

// The stam agent that posted a review comment or status, from its "Review (AGENT): " text
// (scripts/pr-review.mjs), or null when the text is not one. Every agent posts as one GitHub
// account, so this text is what tells a watcher's own review from someone else's.
export function reviewAgentOfComment(text: unknown): string | null {
  const m = /^Review \(([^)]+)\):/.exec(String(text ?? '').trim());
  return m ? m[1] : null;
}

// The verdict the newest `stam/review` status on the head carries (S-948): approve for a success,
// changes for a failure, null for a pending or missing one. It travels in the checks.completed payload.
export function reviewVerdict(statuses: any[]): 'approve' | 'changes' | null {
  const newest = newestReview(statuses);
  return newest?.state === 'success' ? 'approve' : newest?.state === 'failure' || newest?.state === 'error' ? 'changes' : null;
}

// The newest `stam/review` status of a head's statuses, or undefined (shared with the diff header, S-1917).
export function newestReview(statuses: any[]): any | undefined {
  const at = (x: any) => String(x.updated_at ?? x.created_at ?? '');
  return (statuses ?? []).filter((s) => s.context === REVIEW_CONTEXT).sort((a, b) => at(b).localeCompare(at(a)))[0];
}

// The stam agent whose own `stam/review` status alone made this checks.completed, or null when
// other checks changed too (real news, delivered to everyone). The review status is the newest
// one, and a gate failure anyone has to see is never treated as the watcher's own review.
function ownReviewAgent(state: any): string | null {
  const at = state.checksAt;
  if (!at) return null;
  const newest = (state.headStatuses ?? []).find((s: any) => (s.updated_at ?? s.created_at) === at);
  if (!newest || newest.context !== REVIEW_CONTEXT) return null;
  const agent = reviewAgentOfComment(newest.description);
  if (!agent) return null;
  if (state.checks === 'failure' && (state.failing ?? []).some((f: string) => f !== REVIEW_CONTEXT)) return null;
  return agent;
}

async function pollNumber(s: GithubSubject, prev: any | null, prevEtags: Record<string, string>, token: string): Promise<PollResult> {
  const first = !prev;
  const state: any = { ...(prev ?? {}) };
  const etags = { ...prevEtags };
  const events: watch.EventInput[] = [];
  let remaining: number | null = null;
  let resetAt: number | null = null;
  const track = (r: Reply) => {
    if (r.remaining != null) remaining = remaining == null ? r.remaining : Math.min(remaining, r.remaining);
    if (r.resetAt != null) resetAt = resetAt == null ? r.resetAt : Math.max(resetAt, r.resetAt);
  };
  const actor = () => state.actor ?? null;
  const emit = (type: string, summary: string, extra: Record<string, unknown> = {}) =>
    events.push({ source: 'github', type, subject: s.key, subjects: [s.key, s.repoKey], actor: actor(), url: state.url ?? null, summary, dedupe_key: `${type}:${s.key}:${state.updatedAt ?? ''}`, ...extra });

  // The issue view tells a pull request from an issue, and carries its title, state, and url.
  const issue = await get(`/repos/${s.owner}/${s.repo}/issues/${s.number}`, token, etags[`issues/${s.number}`]);
  track(issue);
  if (issue.status === 200) {
    etags[`issues/${s.number}`] = issue.etag ?? '';
    state.absent = false;
    state.title = issue.body.title ?? null;
    state.url = issue.body.html_url ?? null;
    state.state = issue.body.state ?? null;
    state.updatedAt = issue.body.updated_at ?? null;
    state.actor = issue.body.user?.login ?? state.actor ?? null;
    state.type = issue.body.pull_request ? 'pr' : 'issue';
  } else if (issue.status === 404) {
    state.absent = true;
    state.state = null;
  }

  const isPr = !state.absent && state.type === 'pr';
  if (isPr) {
    const pull = await get(`/repos/${s.owner}/${s.repo}/pulls/${s.number}`, token, etags[`pulls/${s.number}`]);
    track(pull);
    if (pull.status === 200) {
      etags[`pulls/${s.number}`] = pull.etag ?? '';
      state.title = pull.body.title ?? state.title;
      state.url = pull.body.html_url ?? state.url;
      state.draft = Boolean(pull.body.draft);
      state.head = pull.body.head?.sha ?? null;
      state.base = pull.body.base?.ref ?? null;
      state.state = pull.body.merged ? 'merged' : pull.body.state ?? state.state;
      state.actor = pull.body.user?.login ?? state.actor ?? null;
    }
    // The head's checks: check runs and commit statuses, both done before it counts.
    if (state.head) {
      const head = state.head;
      const runs = await get(`/repos/${s.owner}/${s.repo}/commits/${head}/check-runs`, token, etags[`commits/${head}/check-runs`]);
      const status = await get(`/repos/${s.owner}/${s.repo}/commits/${head}/status`, token, etags[`commits/${head}/status`]);
      track(runs);
      track(status);
      if (runs.status === 200 || status.status === 200 || state.checksHead !== head) {
        if (runs.status === 200) etags[`commits/${head}/check-runs`] = runs.etag ?? '';
        if (status.status === 200) etags[`commits/${head}/status`] = status.etag ?? '';
        // A 304 means that side is unchanged: keep what the snapshot last saw of it, not an empty list.
        // On a new head the old lists are the old head's: a failed fetch gives nothing, never a verdict (S-1917) or a pass on a head nobody reviewed.
        const keep = state.checksHead === head;
        const runsBody = runs.status === 200 ? (runs.body?.check_runs ?? []).map(slimRun) : keep ? (state.headRuns ?? []) : [];
        const stsBody = status.status === 200 ? (status.body?.statuses ?? []).map(slimStatus) : keep ? (state.headStatuses ?? []) : [];
        state.headRuns = runsBody;
        state.headStatuses = stsBody;
        const c = checksState(runsBody, stsBody);
        state.checks = c.state;
        state.failing = c.failing;
        state.checksHead = head;
        // The latest check run to finish or status to post: a re-run that fails again has a later one.
        state.checksAt = [...runsBody.map((r: any) => r.completed_at), ...stsBody.map((s: any) => s.updated_at ?? s.created_at)].filter(Boolean).sort().at(-1) ?? null;
      }
    }
    // Reviews: the list grows; anything past the snapshot's count is new.
    const reviews = await get(`/repos/${s.owner}/${s.repo}/pulls/${s.number}/reviews`, token, etags[`pulls/${s.number}/reviews`]);
    track(reviews);
    if (reviews.status === 200) {
      etags[`pulls/${s.number}/reviews`] = reviews.etag ?? '';
      const list = (Array.isArray(reviews.body) ? reviews.body : []).slice().sort((a, b) => String(a.submitted_at ?? '').localeCompare(String(b.submitted_at ?? '')));
      const seen = prev?.reviewCount ?? 0;
      if (!first) for (const r of list.slice(seen)) {
        const who = r.user?.login ?? 'someone';
        const what = String(r.state ?? '').toLowerCase().replace(/_/g, ' ');
        emit('review.submitted', `PR #${s.number} reviewed (${what}) by ${who}`, { dedupe_key: `review.submitted:${s.key}:${r.id}`, actor: who, payload: { at: r.submitted_at ?? null } });
      }
      state.reviewCount = list.length;
      state.review = lastReviewState(list);
      const latest = list.filter((r) => r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED').at(-1);
      state.lastReview = latest ? { state: String(latest.state ?? '').toLowerCase(), user: latest.user?.login ?? null } : null;
    }
  }

  // Comments, both on a PR and on an issue: `since` limits the fetch to new ones.
  const since = prev?.commentsSince ?? null;
  const comments = await get(`/repos/${s.owner}/${s.repo}/issues/${s.number}/comments${since ? `?since=${encodeURIComponent(since)}` : ''}`, token, etags[`issues/${s.number}/comments`]);
  track(comments);
  if (comments.status === 200) {
    etags[`issues/${s.number}/comments`] = comments.etag ?? '';
    const list = Array.isArray(comments.body) ? comments.body : [];
    if (!first) for (const c of list) {
      const who = c.user?.login ?? 'someone';
      emit('comment.created', `${state.type === 'pr' ? 'PR' : 'Issue'} #${s.number} comment by ${who}: ${firstLine(c.body)}`, { dedupe_key: `comment.created:${s.key}:${c.id}`, actor: who, payload: { at: c.updated_at ?? c.created_at ?? null, review_agent: reviewAgentOfComment(c.body) } });
    }
    const newest = list.map((c) => String(c.updated_at ?? c.created_at ?? '')).sort().at(-1);
    if (newest) state.commentsSince = newest;
  }

  if (!first && !state.absent) diffNumber(state, prev, s, emit);

  return { events, state, etags, remaining, resetAt };
}

// The one event per change between the last snapshot and this one.
function diffNumber(state: any, prev: any, s: GithubSubject, emit: (type: string, summary: string, extra?: Record<string, unknown>) => void): void {
  const n = s.number;
  // The change time stamped on each event, so a watch that began later drops it.
  const at = state.updatedAt ?? null;
  if (state.type === 'issue') {
    if (prev.state !== state.state) {
      if (state.state === 'closed') emit('issue.closed', `Issue #${n} closed: ${state.title ?? ''}`, { payload: { at } });
      else if (state.state === 'open') emit(prev.state ? 'issue.reopened' : 'issue.opened', `Issue #${n} ${prev.state ? 'reopened' : 'opened'}: ${state.title ?? ''}`, { payload: { at } });
    }
    return;
  }
  // A pull request. `opened` covers a watched number that appears after an absent first poll.
  if (prev.absent || !prev.type) {
    if (state.state === 'open') emit('pull_request.opened', `PR #${n} opened: ${state.title ?? ''}`, { payload: { at } });
  } else if (prev.state !== state.state) {
    if (state.state === 'merged') emit('pull_request.merged', `PR #${n} merged: ${state.title ?? ''}`, { payload: { at } });
    else if (state.state === 'closed') emit('pull_request.closed', `PR #${n} closed: ${state.title ?? ''}`, { payload: { at } });
    else if (state.state === 'open') emit('pull_request.reopened', `PR #${n} reopened: ${state.title ?? ''}`, { payload: { at } });
  }
  if (prev.type === 'pr' && prev.draft !== state.draft && state.draft != null) emit(state.draft ? 'pull_request.converted_to_draft' : 'pull_request.ready_for_review', `PR #${n} ${state.draft ? 'converted to draft' : 'ready for review'}`, { payload: { at } });
  if (prev.head && state.head && prev.head !== state.head) emit('pull_request.synchronize', `PR #${n} new commits (${String(state.head).slice(0, 7)})`, { dedupe_key: `pull_request.synchronize:${s.key}:${state.head}`, payload: { at, head: state.head } });
  const done = state.checks === 'success' || state.checks === 'failure';
  if (done && (prev.checksHead !== state.checksHead || prev.checks !== state.checks || prev.checksAt !== state.checksAt)) {
    const summary = state.checks === 'failure' ? `PR #${n} checks failed: ${(state.failing ?? []).join(', ') || 'unknown'}` : `PR #${n} checks passed`;
    emit('checks.completed', summary, { dedupe_key: `checks.completed:${s.key}:${state.checksHead ?? ''}:${state.checks}:${state.checksAt ?? ''}`, payload: { at: state.checksAt ?? null, review_agent: ownReviewAgent(state), head: state.checksHead ?? null, verdict: reviewVerdict(state.headStatuses ?? []) } });
  }
}

// ---- a repository ----

const REPO_EVENT_TYPES: Record<string, string> = {
  PushEvent: 'push',
  PullRequestEvent: 'pull_request',
  PullRequestReviewEvent: 'pull_request_review',
  PullRequestReviewCommentEvent: 'pull_request_review_comment',
  IssuesEvent: 'issues',
  IssueCommentEvent: 'issue_comment',
  CreateEvent: 'create',
  DeleteEvent: 'delete',
  ReleaseEvent: 'release',
  WatchEvent: 'star',
  ForkEvent: 'fork',
  PublicEvent: 'public',
};

// GitHub serves at most 100 events a page and 300 in all; a busy repo can outrun one page.
const EVENTS_PER_PAGE = 100;
const EVENT_PAGES_MAX = 3;

async function pollRepo(s: GithubSubject, prev: any | null, prevEtags: Record<string, string>, token: string): Promise<PollResult> {
  const first = !prev;
  const state: any = { ...(prev ?? { type: 'repo', lastEventId: 0 }) };
  const etags = { ...prevEtags };
  const events: watch.EventInput[] = [];
  let remaining: number | null = null;
  let resetAt: number | null = null;

  // Events come newest first. Page 1 is the only one with an ETag; a later page is read only
  // while every event on the page before it is newer than the last poll's lastEventId.
  const seen = prev?.lastEventId ?? 0;
  for (let page = 1; page <= EVENT_PAGES_MAX; page++) {
    const r = await get(`/repos/${s.owner}/${s.repo}/events?per_page=${EVENTS_PER_PAGE}&page=${page}`, token, page === 1 ? etags.events : undefined);
    if (r.remaining != null) remaining = r.remaining;
    if (r.resetAt != null) resetAt = r.resetAt;
    if (r.status !== 200) break;
    if (page === 1) etags.events = r.etag ?? '';
    const list = Array.isArray(r.body) ? r.body : [];
    if (!first) for (const e of list) if (Number(e.id) > seen) events.push(repoEvent(e, s));
    state.lastEventId = list.reduce((m, e) => Math.max(m, Number(e.id) || 0), state.lastEventId ?? 0);
    const allNew = list.length > 0 && list.every((e) => Number(e.id) > seen);
    if (first || !allNew || !/rel="next"/.test(r.link ?? '')) break;
  }
  return { events, state, etags, remaining, resetAt };
}

// One repository event as an external event: its type maps to a stam type, and its payload
// to a one-line summary (a push names its branch and count).
export function repoEvent(e: any, s: GithubSubject): watch.EventInput {
  const raw = String(e.type ?? 'event');
  const base = REPO_EVENT_TYPES[raw] ?? (raw.replace(/Event$/, '').toLowerCase() || 'event');
  const action = base === 'issues' && typeof e.payload?.action === 'string' && e.payload.action ? e.payload.action : null;
  const type = action ? `issues.${action}` : base;
  const actor = e.actor?.login ?? null;
  const payload = e.payload ?? {};
  let summary = `${type} by ${actor ?? 'someone'}`;
  // An issue event carries what happened to it: `issues.opened`, `issues.closed`, and so on (S-947).
  if (type === 'push') {
    const branch = String(payload.ref ?? '').replace('refs/heads/', '');
    const count = Array.isArray(payload.commits) ? payload.commits.length : 0;
    summary = `push: ${count} commit${count === 1 ? '' : 's'} to ${branch || 'a branch'}`;
  }
  const subjects = [s.repoKey];
  const number = payload.pull_request?.number ?? payload.issue?.number;
  if (action) summary = `${type}: #${number ?? '?'} ${String(payload.issue?.title ?? '').trim()} by ${actor ?? 'someone'}`.replace(/\s+/g, ' ');
  if (number) subjects.push(`github:${s.owner}/${s.repo}#${number}`);
  return { source: 'github', type, subjects, subject: s.repoKey, actor, url: `https://github.com/${s.owner}/${s.repo}`, summary, dedupe_key: `${type}:${s.repoKey}:${e.id}`, payload };
}

// ---- the tick and the state view ----

let backoffUntil = 0;
export function resetBackoff(): void {
  backoffUntil = 0;
}

// Whether a poll mirrors its PR's head to storage (S-1347, S-1363): when GitHub reports the PR opened, reopened, or with
// new commits, or when the first poll finds it open. A PR opened with `gh pr create` before the watch began has no
// opened event, so only the first poll sees it. A later poll with the same head emits nothing and mirrors nothing.
const MIRROR_EVENTS = new Set(['pull_request.opened', 'pull_request.reopened', 'pull_request.synchronize']);
export function mirrorsHead(prev: any | null, result: { events: watch.EventInput[]; state: any }): boolean {
  if (!prev && result.state?.type === 'pr' && result.state.state === 'open' && result.state.head) return true;
  return result.events.some((e) => MIRROR_EVENTS.has(String(e.type)));
}

// One poll of every watched GitHub subject. Records each snapshot, ingests one event per
// change, and backs off when the rate limit is low. Returns how many events it ingested.
export async function tick(): Promise<number> {
  if (Date.now() < backoffUntil) return 0;
  const subjects = watch.watchedSubjects().filter((s) => s.startsWith('github:'));
  const pollable: string[] = [];
  for (const subject of subjects) {
    if (!parseSubject(subject)) {
      logOnce(`ignoring subject ${subject}: only github:OWNER/REPO and github:OWNER/REPO#N are polled`);
      continue;
    }
    pollable.push(subject);
  }
  if (!pollable.length) return 0;
  const auth = await token();
  if (!auth) return 0;
  let ingested = 0;
  let remaining: number | null = null;
  let resetAt: number | null = null;
  for (const subject of pollable) {
    const row = db.getWatchState(subject);
    const prev = row ? safeParse(row.state) : null;
    const prevEtags = row ? (safeParse(row.etags) ?? {}) : {};
    let result: PollResult;
    try {
      result = await pollSubject(subject, prev, prevEtags, auth);
    } catch (e) {
      logOnce(`poll ${subject} failed: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    db.setWatchState(subject, result.state, result.etags);
    for (const ev of result.events) {
      watch.ingest(ev);
      ingested++;
    }
    // A PR opened or updated on GitHub gets its head mirrored to storage (S-1347, S-1363), as pr_open does. Not awaited:
    // the mirror is bounded and never rejects, and it must not hold the poll for the other subjects.
    if (mirrorsHead(prev, result)) void mirrorEventPr(subject);
    // A merge moves storage's main to GitHub's now, fast-forward only (S-1389); the deploy still updates the live checkout.
    if (result.events.some((e) => e.type === 'pull_request.merged')) void mirrorEventMain();
    if (result.remaining != null) remaining = remaining == null ? result.remaining : Math.min(remaining, result.remaining);
    if (result.resetAt != null) resetAt = resetAt == null ? result.resetAt : Math.max(resetAt, result.resetAt);
  }
  if (remaining != null && remaining < 200) {
    backoffUntil = resetAt ?? Date.now() + 60_000;
    logOnce(`rate limit low (${remaining} left); backing off until ${new Date(backoffUntil).toISOString()}`);
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

// Per requested subject, what the dashboard shows (S-65): a pull request's state, draft,
// check and review status, head, base, title, and url; an issue's state, title, and url.
export function stateFor(subjects: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const subject of subjects) {
    const row = db.getWatchState(subject);
    if (!row) {
      out[subject] = { updated_at: null };
      continue;
    }
    const state = safeParse(row.state) ?? {};
    if (state.type === 'issue') out[subject] = { state: state.state ?? null, title: state.title ?? null, url: state.url ?? null, updated_at: row.updated_at };
    else if (state.type === 'pr')
      out[subject] = {
        state: state.state ?? null,
        draft: Boolean(state.draft),
        checks: state.checks ?? 'none',
        review: state.review ?? 'none',
        head: state.head ?? null,
        base: state.base ?? null,
        title: state.title ?? null,
        url: state.url ?? null,
        updated_at: row.updated_at,
      };
    else out[subject] = { state: state.state ?? null, updated_at: row.updated_at };
  }
  return out;
}

let started = false;

// Started by the daemon (src/daemon.ts). One interval; 0 disables polling.
export function start(): void {
  if (started) return;
  const seconds = settings().watch.githubSeconds;
  if (!(seconds > 0)) return;
  started = true;
  const run = () => tick().catch((e) => console.error(`github: ${e instanceof Error ? e.message : e}`));
  const timer = setInterval(run, seconds * 1000);
  timer.unref?.();
}
