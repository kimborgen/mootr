// Model classifier for activity items the rules leave NULL (S-214). One flat `choice` question per
// item over all activity leaves (src/activity-categories.ts), asked of the decision model
// (src/decide.ts) with purpose `decide:activity`, so the cost lands in usage like the other
// decisions. Off by default (settings.activity.classify.enabled): nothing is spent until a human
// turns it on. A background loop labels the newest NULL tool and text items, only those created
// since it was enabled; `stam activity --classify-model [--since ISO]` backfills older ones. Both
// stop at the daily cap (maxUsdPerDay, UTC). Rule-labelled rows are never sent. Nothing here
// throws into ingest: a failed call leaves its item NULL and the loop backs off.
import * as db from './db.ts';
import { decideWithFailure, type DecideFailure, type DecisionResult, type Question } from './decide.ts';
import { settings } from './settings.ts';
import { ACTIVITY_DEFINITIONS } from './activity-categories.ts';
import { touched } from './activity-changes.ts';

export const CLASSIFY_PURPOSE = 'decide:activity';
const INSTRUCTIONS =
  "An AI agent produced this item while working (a tool call with its input, or a piece of text it wrote; 'previous_text' is what it said just before). What is the item FOR? Pick the category of activity.";
const INPUT_MAX = 400;
const TEXT_MAX = 400;
const PREVIOUS_MAX = 200;
const TICK_MS = 5_000;
const BACKOFF_MS = 60_000;
const ON = 'activity:classify';
const BACKFILL_BATCH = 50;
// The concurrency the classifier runs at: the saved setting, clamped to 1..4 (S-252).
const CONCURRENCY_MAX = 4;
// Five failed attempts in a row stop the run: the endpoint is broken, not busy (S-252).
const STALL_AFTER = 5;
// A 429 or 5xx retries the same row after Retry-After, else exponential backoff from 10 s, capped at 5 min.
const BACKOFF_BASE_MS = 10_000;
const BACKOFF_MAX_MS = 300_000;

// The state the question reads, for one tool or text item and the text it said just before.
export type ItemState = {
  kind: 'tool' | 'text';
  tool: string;
  input: string;
  text: string;
  previous_text: string;
};

// A NULL item as the classifier reads it: its agent, seq, turn, kind, tool name and summary.
export interface ItemRow {
  agent_id: string;
  seq: number;
  turn: number;
  kind: 'tool' | 'text';
  name: string | null;
  summary: string | null;
  start: string;
}

const cut = (s: string | null | undefined, max: number): string => (s ?? '').slice(0, max);

// The human-started backfill the daemon keeps across restarts (S-253): one row in `kv`, present
// while the run is unfinished. `cappedOn` is the UTC day the daily cap stopped it; it resumes on a later day.
const BACKFILL_KEY = 'activity:classify-backfill';
interface SavedBackfill {
  since: string;
  startedAt: string;
  startedBy: 'human';
  cappedOn?: string;
}
function readSaved(): SavedBackfill | null {
  const r = db.open().prepare('SELECT value FROM kv WHERE key = ?').get(BACKFILL_KEY) as { value: string } | undefined;
  return r ? (JSON.parse(r.value) as SavedBackfill) : null;
}
function writeSaved(s: SavedBackfill | null): void {
  if (s) db.open().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(BACKFILL_KEY, JSON.stringify(s));
  else db.open().prepare('DELETE FROM kv WHERE key = ?').run(BACKFILL_KEY);
}
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function itemState(row: Pick<ItemRow, 'kind' | 'name' | 'summary'>, previous: string | null): ItemState {
  return {
    kind: row.kind,
    tool: row.kind === 'tool' ? (row.name ?? '') : '',
    input: row.kind === 'tool' ? cut(row.summary, INPUT_MAX) : '',
    text: row.kind === 'text' ? cut(row.summary, TEXT_MAX) : '',
    previous_text: cut(previous, PREVIOUS_MAX),
  };
}

export const CATEGORY_QUESTION: Record<string, Question> = {
  category: { type: 'choice', instructions: INSTRUCTIONS, criteria: { ...ACTIVITY_DEFINITIONS } },
};

// The category and confidence of an answer, or null when the answer names no known leaf.
export function categoryOf(r: DecisionResult | null): { category: string; confidence: number | null } | null {
  const a = r?.answers?.category;
  if (typeof a?.choice !== 'string' || !(a.choice in ACTIVITY_DEFINITIONS)) return null;
  const confidence = typeof a.confidence === 'number' && a.confidence >= 0 && a.confidence <= 1 ? a.confidence : null;
  return { category: a.choice, confidence };
}

// Today's decide events, through their partial index (src/db.ts events_stam_decide, S-4356).
export const SPENT_SQL = "SELECT data FROM events INDEXED BY events_stam_decide WHERE agent_id = 'stam' AND type = 'decide' AND ts >= ?";

// The UTC day's spend on the classifier: the decide events (usage keeps one row per day for the
// account, labelled with whichever purpose wrote last, so it can't be split by purpose).
export function spentToday(now = new Date()): number {
  const from = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const rows = db.open().prepare(SPENT_SQL).all(from) as { data: string }[];
  return rows.reduce((n, r) => {
    const d = JSON.parse(r.data ?? '{}');
    return d.purpose === CLASSIFY_PURPOSE ? n + (Number(d.cost) || 0) : n;
  }, 0);
}

// The moment the classifier was last switched on, or null when it is off. Enabling and disabling
// are recorded as events, so a restart keeps the moment the items must be newer than.
function onSince(enabled: boolean, now = new Date()): string | null {
  const last = db.open().prepare("SELECT data FROM events WHERE agent_id = 'stam' AND type = ? ORDER BY id DESC LIMIT 1").get(ON) as { data: string } | undefined;
  const cur = last ? JSON.parse(last.data) : null;
  const on = cur?.state === 'on' ? (cur.at as string) : null;
  if (enabled && !on) {
    const at = now.toISOString();
    db.addEvent('stam', ON, { state: 'on', at });
    return at;
  }
  if (!enabled && on) db.addEvent('stam', ON, { state: 'off', at: now.toISOString() });
  return enabled ? on : null;
}

// NULL tool and text items, newest first, from `since` (ISO, by start time: the table keeps no
// creation time, so an item counts as new when it started after the moment).
export function pending(since: string, limit: number): ItemRow[] {
  return db
    .open()
    .prepare(
      `SELECT agent_id, seq, turn, kind, name, summary, start FROM activity_items
       WHERE category_source IS NULL AND kind IN ('tool', 'text') AND start >= ?
       ORDER BY start DESC, seq DESC LIMIT ?`,
    )
    .all(since, limit) as unknown as ItemRow[];
}

function previousText(agentId: string, seq: number): string | null {
  const r = db
    .open()
    .prepare("SELECT summary FROM activity_items WHERE agent_id = ? AND seq < ? AND kind = 'text' ORDER BY seq DESC LIMIT 1")
    .get(agentId, seq) as { summary: string | null } | undefined;
  return r?.summary ?? null;
}

// Stores one answer on its item, and on the model items of its turn that came before it and after
// the turn's previous tool or text row: those took their category from this item (classifyItems).
function store(row: ItemRow, c: { category: string; confidence: number | null }): void {
  const d = db.open();
  db.transaction(() => {
    d.prepare("UPDATE activity_items SET category = ?, category_source = 'model', confidence = ? WHERE agent_id = ? AND seq = ? AND category_source IS NULL").run(
      c.category,
      c.confidence,
      row.agent_id,
      row.seq,
    );
    const prev = (d.prepare("SELECT MAX(seq) AS s FROM activity_items WHERE agent_id = ? AND turn = ? AND seq < ? AND kind IN ('tool', 'text')").get(row.agent_id, row.turn, row.seq) as { s: number | null }).s ?? 0;
    d.prepare(
      "UPDATE activity_items SET category = ?, category_source = 'derived', confidence = ? WHERE agent_id = ? AND turn = ? AND kind = 'model' AND category_source IS NULL AND seq > ? AND seq < ?",
    ).run(c.category, c.confidence, row.agent_id, row.turn, prev, row.seq);
    // The rows it set run from just after the turn's previous tool or text row to this one.
    const from = (d.prepare('SELECT MIN(start) AS s FROM activity_items WHERE agent_id = ? AND seq > ? AND seq <= ?').get(row.agent_id, prev, row.seq) as { s: string | null }).s;
    touched(row.agent_id, from ? Date.parse(from) : null);
  });
}

// What the next call may cost, before it has run: the most a call has cost so far, from $0.0002.
let perCall = 0.0002;
// The estimated cost of the calls in flight, not yet in the events. Reserved before each call and
// released after it, so concurrent calls and backfills can't overrun the cap together.
let reserved = 0;

// One pass over some rows (a tick, or one backfill batch) and what it has done so far. `concurrency`
// is the effective one: a 429 halves it for the rest of the run, never below 1.
export interface Run {
  since: string;
  labelled: number;
  failed: number;
  capped: boolean;
  // Why the run stopped: 'done', 'capped', 'stalled' (STALL_AFTER failures in a row), or 'off' (the classifier was switched off, S-253). Null while running.
  stopped: 'done' | 'capped' | 'stalled' | 'off' | null;
  consecutive: number;
  lastError: string | null;
  concurrency: number;
  // The attempts in flight, and the ones waiting for a slot (see withSlot).
  inFlight: number;
  waiters: (() => void)[];
  // Ends the retry wait early when the run is latched off (S-253).
  cancelWait?: () => void;
}

export function newRun(concurrency: number, since: string): Run {
  return { since, labelled: 0, failed: 0, capped: false, stopped: null, consecutive: 0, lastError: null, concurrency: clampConcurrency(concurrency), inFlight: 0, waiters: [] };
}

// Runs one attempt in a slot of the run: at most `run.concurrency` at once, read when a slot is
// wanted, so a halved concurrency holds for retries too. A waiter is woken as each attempt ends.
export async function withSlot<T>(run: Run, attempt: () => Promise<T>): Promise<T> {
  while (run.inFlight >= run.concurrency) await new Promise<void>((resolve) => run.waiters.push(resolve));
  run.inFlight++;
  try {
    return await attempt();
  } finally {
    run.inFlight--;
    run.waiters.shift()?.();
  }
}

// The concurrency the classifier actually runs at: an integer from 1 to CONCURRENCY_MAX.
export function clampConcurrency(n: number): number {
  return Math.min(CONCURRENCY_MAX, Math.max(1, Math.floor(Number(n)) || 1));
}

// The outcome of one labelling attempt: stored (with its cost), or failed (with why).
type Attempt = { ok: true; cost: number } | { ok: false; failure: DecideFailure };

// Asks the model about one item and stores the answer.
async function labelOne(row: ItemRow): Promise<Attempt> {
  const r = await decideWithFailure(itemState(row, previousText(row.agent_id, row.seq)), CATEGORY_QUESTION, { purpose: CLASSIFY_PURPOSE });
  const c = categoryOf(r.result);
  if (!c) return { ok: false, failure: r.failure ?? { kind: 'other', error: 'no known category in the answer' } };
  store(row, c);
  return { ok: true, cost: Number(r.result?.usage?.cost) || 0 };
}

// Waits before a retry. latchOff ends it early, so a run switched off never sleeps into a new one (S-253).
function waitRetry(run: Run, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      run.cancelWait = undefined;
      resolve();
    }
    run.cancelWait = done;
  });
}

// The rows a call is in flight for, shared by the tick and a backfill, so no row is sent twice (S-253).
const inFlight = new Set<string>();

// How long to wait before retrying a 429 or 5xx: Retry-After if the response gave one, else
// exponential backoff from 10 s (attempt 0, 1, ...), capped at 5 min, with jitter.
export function retryWaitMs(failure: DecideFailure, attempt: number): number {
  if (failure.retryAfterMs !== undefined) return failure.retryAfterMs;
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return base * (0.5 + Math.random() / 2);
}

// One call for a row, under the budget: reserves its estimate first, and refuses the call (returns
// 'capped') when completed spend plus reservations plus that would pass the cap.
// `clock` is the time the day's cap is read at: the real one, or a shifted one when a run resumes.
async function attemptOne(row: ItemRow, maxUsdPerDay: number, clock: () => number): Promise<Attempt | 'capped' | 'off'> {
  // Off means nothing more is spent: checked before each attempt, in the limiter every run shares (S-253).
  if (!settings().activity.classify.enabled) return 'off';
  const est = perCall;
  if (spentToday(new Date(clock())) + reserved + est > maxUsdPerDay) return 'capped';
  reserved += est;
  try {
    return await labelOne(row).catch((e): Attempt => ({ ok: false, failure: { kind: 'other', error: String(e instanceof Error ? e.message : e) } }));
  } finally {
    reserved -= est;
  }
}

// Labels one row, retrying the same row on a 429 or 5xx. Every attempt, retries included, takes
// a slot first (withSlot); the wait before a retry is taken outside the slot.
async function labelWithRetry(row: ItemRow, run: Run, maxUsdPerDay: number, clock: () => number): Promise<void> {
  for (let attempt = 0; !run.stopped; attempt++) {
    const got = await withSlot(run, async () => {
      if (run.stopped) return 'stopped' as const;
      return attemptOne(row, maxUsdPerDay, clock);
    });
    if (got === 'stopped') return;
    if (got === 'off') {
      run.stopped = 'off';
      return;
    }
    if (got === 'capped') {
      run.capped = true;
      run.stopped = 'capped';
      capEvent(new Date(clock()));
      return;
    }
    if (got.ok) {
      run.labelled++;
      run.consecutive = 0;
      perCall = Math.max(perCall, got.cost);
      return;
    }
    run.failed++;
    run.consecutive++;
    run.lastError = got.failure.error;
    if (run.consecutive >= STALL_AFTER) {
      run.stopped = 'stalled';
      db.addEvent('stam', 'activity:classify-stalled', { error: run.lastError, labelled: run.labelled, failed: run.failed });
      return;
    }
    const retryable = got.failure.kind === 'rate-limit' || got.failure.kind === 'server';
    if (!retryable) return;
    if (got.failure.kind === 'rate-limit') run.concurrency = Math.max(1, Math.floor(run.concurrency / 2));
    await waitRetry(run, retryWaitMs(got.failure, attempt));
  }
}

// Labels rows with up to the run's concurrency workers. Rows are taken in order; a row waits in
// the queue until a worker is free, and no row is dropped.
async function labelRows(rows: ItemRow[], run: Run, maxUsdPerDay: number, clock: () => number): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < rows.length && !run.stopped) {
      const row = rows[next++];
      const key = `${row.agent_id}:${row.seq}`;
      if (inFlight.has(key)) continue;
      inFlight.add(key);
      try {
        await labelWithRetry(row, run, maxUsdPerDay, clock);
      } finally {
        inFlight.delete(key);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(run.concurrency, rows.length)) }, worker));
}

// One `activity:classify-capped` event per UTC day, when the cap stops the classifier.
function capEvent(now = new Date()): void {
  const from = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const seen = db.open().prepare("SELECT 1 FROM events WHERE agent_id = 'stam' AND type = 'activity:classify-capped' AND ts >= ? LIMIT 1").get(from);
  if (!seen) db.addEvent('stam', 'activity:classify-capped', { day: from.slice(0, 10) });
}

let pausedUntil = 0;
let running = false;
// The backfill now running, or the last one that ended (for the Settings control to read). `resumed`
// is set when it picked up a backfill the daemon had saved (S-253).
let backfillRun: { run: Run; running: boolean; resumed: boolean } | null = null;

// The classifier was switched off: a running backfill latches off (it makes no further attempt, even
// if the classifier is turned back on), its retry wait is cut short, and its save is dropped (S-253).
function latchOff(): void {
  if (readSaved()) writeSaved(null);
  const run = backfillRun?.running ? backfillRun.run : null;
  if (run && !run.stopped) {
    run.stopped = 'off';
    run.cancelWait?.();
  }
}

// Resumes the saved backfill when it is due: the classifier is on, none is running, and it was not
// capped on this UTC day (S-253). Switched off, the saved one is dropped instead. Returns whether one started.
function resumeIfDue(now: number): boolean {
  const saved = readSaved();
  if (!saved || backfillRun?.running || running) return false;
  if (!settings().activity.classify.enabled) {
    writeSaved(null);
    return false;
  }
  if (saved.cappedOn === utcDay(now)) return false;
  // The clock runs from `now`, so a tick given a later day sees that day's cap.
  const shift = now - Date.now();
  void runBackfill(saved.since, () => Date.now() + shift, true, saved.startedAt).catch((e) =>
    db.addEvent('stam', 'activity:classify-error', String(e instanceof Error ? e.message : e)),
  );
  return true;
}

// One pass of the background loop: nothing when off, paused, or capped; else up to `concurrency`
// newest items since the moment it was enabled. A failure backs off for a minute.
export async function classifyTick(now = Date.now()): Promise<number> {
  const cfg = settings().activity.classify;
  const since = onSince(cfg.enabled);
  if (!since) {
    latchOff();
    return 0;
  }
  if (resumeIfDue(now)) return 0;
  // A backfill runs its rows itself: the tick waits for it, so no row is in flight twice (S-253).
  if (now < pausedUntil || running || backfillRun?.running) return 0;
  running = true;
  const shift = now - Date.now();
  const clock = () => Date.now() + shift;
  try {
    const rows = pending(since, clampConcurrency(cfg.concurrency));
    if (!rows.length) return 0;
    const run = newRun(cfg.concurrency, since);
    await labelRows(rows, run, cfg.maxUsdPerDay, clock);
    if (run.failed) pausedUntil = now + BACKOFF_MS;
    return run.labelled;
  } finally {
    running = false;
  }
}

// Starts the background loop (called at daemon start), and resumes a backfill the last daemon left
// unfinished (S-253). Errors are logged as events, never thrown. Returns the timer, for a test to stop.
export function startClassifier(): ReturnType<typeof setInterval> {
  resumeIfDue(Date.now());
  return setInterval(() => {
    classifyTick().catch((e) => db.addEvent('stam', 'activity:classify-error', String(e instanceof Error ? e.message : e)));
  }, TICK_MS);
}

// The guards a backfill checks before it starts: the classifier is on, and none is running.
function checkBackfillStart(): ReturnType<typeof settings>['activity']['classify'] {
  const cfg = settings().activity.classify;
  if (!cfg.enabled) throw new Error('the activity classifier is off: turn on Settings › Mail to you › Classify activity first');
  if (backfillRun?.running) throw new Error('a backfill is already running');
  return cfg;
}

// `stam activity --classify-model [--since ISO]`: labels the NULL items from `since` (default:
// all, oldest first) now, up to the daily cap. It needs the classifier switched on, since it
// spends money. A failed call is retried on a 429 or 5xx and skipped otherwise; the run stops at
// the daily cap, or after STALL_AFTER failed attempts in a row (the event activity:classify-stalled).
export async function backfill(since = ''): Promise<{ labelled: number; failed: number; capped: boolean; stopped: Run['stopped']; concurrency: number }> {
  checkBackfillStart();
  return runBackfill(since, () => Date.now(), false, new Date().toISOString());
}

// One backfill run. It is saved in `kv` while it is unfinished, so a daemon restart resumes it (S-253):
// the row is cleared when it finishes or stalls, and kept with `cappedOn` when the cap stops it.
async function runBackfill(
  since: string,
  clock: () => number,
  resumed: boolean,
  startedAt: string,
): Promise<{ labelled: number; failed: number; capped: boolean; stopped: Run['stopped']; concurrency: number }> {
  const cfg = settings().activity.classify;
  const run = newRun(cfg.concurrency, since);
  const state = { run, running: true, resumed };
  backfillRun = state;
  writeSaved({ since, startedAt, startedBy: 'human' });
  if (resumed) db.addEvent('stam', 'activity:classify-resumed', { since, startedAt });
  try {
    // Oldest first, a cursor past each batch: a row that failed stays NULL and must not come back.
    let cursor: ItemRow | null = null;
    for (;;) {
      const rows = pendingOldestFirst(since, cursor, BACKFILL_BATCH);
      if (!rows.length) {
        run.stopped ??= 'done';
        break;
      }
      await labelRows(rows, run, cfg.maxUsdPerDay, clock);
      if (run.stopped) break;
      cursor = rows[rows.length - 1];
    }
  } finally {
    state.running = false;
  }
  // Capped keeps the save for the next day; done, stalled, and off drop it (S-253).
  writeSaved(run.stopped === 'capped' ? { since, startedAt, startedBy: 'human', cappedOn: utcDay(clock()) } : null);
  return { labelled: run.labelled, failed: run.failed, capped: run.capped, stopped: run.stopped, concurrency: run.concurrency };
}

// Starts a backfill in the background and returns at once, so the Settings control can poll
// backfillProgress. The guards throw here, to the caller, as backfill's do.
export function startBackfill(since = ''): { started: true } {
  checkBackfillStart();
  void backfill(since).catch((e) => db.addEvent('stam', 'activity:classify-error', String(e instanceof Error ? e.message : e)));
  return { started: true };
}

// The running backfill's progress, or the last one's (`running` false) and the NULL items left.
export function backfillProgress(): { running: boolean; resumed: boolean; labelled: number; failed: number; remaining: number; stopped: Run['stopped']; capped: boolean; concurrency: number; lastError: string | null } {
  const r = backfillRun?.run;
  const since = r?.since ?? '';
  const remaining = (db.open().prepare("SELECT COUNT(*) AS n FROM activity_items WHERE category_source IS NULL AND kind IN ('tool', 'text') AND start >= ?").get(since) as { n: number }).n;
  return {
    running: backfillRun?.running ?? false,
    resumed: backfillRun?.resumed ?? false,
    labelled: r?.labelled ?? 0,
    failed: r?.failed ?? 0,
    remaining,
    stopped: r?.stopped ?? null,
    capped: r?.capped ?? false,
    concurrency: r?.concurrency ?? clampConcurrency(settings().activity.classify.concurrency),
    lastError: r?.lastError ?? null,
  };
}

// The backfill's rows after a cursor, oldest first: the NULL tool and text items from `since`.
function pendingOldestFirst(since: string, after: ItemRow | null, limit: number): ItemRow[] {
  const cut = after ? ' AND (start, agent_id, seq) > (?, ?, ?)' : '';
  const args = after ? [since, after.start, after.agent_id, after.seq, limit] : [since, limit];
  return db
    .open()
    .prepare(
      `SELECT agent_id, seq, turn, kind, name, summary, start FROM activity_items
       WHERE category_source IS NULL AND kind IN ('tool', 'text') AND start >= ?${cut}
       ORDER BY start, agent_id, seq LIMIT ?`,
    )
    .all(...args) as unknown as ItemRow[];
}
