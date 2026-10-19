// Cold-wake measurement (S-2236): which turns re-wrote most of the prompt cache after a wake or a
// compaction, and which cache window (1 h or 5 min) each Claude agent's transcript shows.
// Measures only; nothing here changes when an agent rests or compacts.
import * as db from './db.ts';

// A cache write over this share of the context counts as a cold turn.
export const COLD_SHARE = 0.8;

export type ColdCause = 'wake' | 'compaction';
export type CacheTtl = '1h' | '5m';

// The pending mark lives in the agent's events, so a daemon restart with the harness still
// running keeps it: `cache:mark` {cause, seen} is pending until a `cache:cold` or `cache:warm`
// event follows it. `seen` is the id of the last model turn in the transcript when the mark was
// set; only a later turn counts, so a status line that still reports the old usage (before the
// first new turn) is not measured.
type Marked = { cause: ColdCause; seen?: string };

function pendingMark(agentId: string): Marked | null {
  const d = db.open();
  const r = d.prepare(PENDING_SQL).get(agentId, agentId, agentId) as { m: number | null; done: number | null };
  if (r.m == null || (r.done != null && r.done > r.m)) return null;
  const row = d.prepare('SELECT data FROM events WHERE id = ?').get(r.m) as { data: string | null } | undefined;
  try {
    return JSON.parse(row?.data ?? '{}') as Marked;
  } catch {
    return null;
  }
}
// The latest mark and the latest resolution: each a MAX(id) over the (agent_id, type) index, so an
// agent's long event history is not walked on every status line.
export const PENDING_SQL =
  "SELECT (SELECT MAX(id) FROM events WHERE agent_id = ? AND type = 'cache:mark') AS m, (SELECT MAX(id) FROM (SELECT MAX(id) AS id FROM events WHERE agent_id = ? AND type = 'cache:cold' UNION ALL SELECT MAX(id) FROM events WHERE agent_id = ? AND type = 'cache:warm')) AS done";

// The id of the agent's latest model turn in its transcript, for the harnesses that have one
// (the Claude adapter registers it).
type Turn = { id: string; cacheWrite: number; total: number };
let turnReader: ((a: db.Agent) => string | undefined) | undefined;
let turnAfter: ((session: string, seen?: string) => Turn | undefined) | undefined;
export function setTurnReader(last: (a: db.Agent) => string | undefined, after: (session: string, seen?: string) => Turn | undefined): void {
  turnReader = last;
  turnAfter = after;
}

// A status line for the agent's session: measures the first model turn after the pending mark,
// even when several turns were written since the last report.
export function onCacheTurn(agentId: string, session: string): boolean {
  const mark = pendingMark(agentId);
  const t = mark && turnAfter?.(session, mark.seen);
  return t ? onCacheUsage(agentId, { cacheWrite: t.cacheWrite, total: t.total, turn: t.id }) : false;
}

// Marks that the agent's next model turn follows a wake (a resume relaunch from rest or a
// restart) or a compaction, whether stam's (relaunch) or the harness's own (PostCompact). A
// compaction mark is kept when a wake mark follows it, and the same cause is not marked twice, so
// stam's compaction and the hook for it count once.
export function markCold(a: db.Agent, cause: ColdCause): void {
  const pending = pendingMark(a.id);
  if (pending && (pending.cause === cause || cause === 'wake')) return;
  db.addEvent(a.id, 'cache:mark', { cause, seen: turnReader?.(a) });
}

// One model turn's usage (Claude Code's status line `current_usage`, with the id of the latest
// turn in the transcript): the first new turn after a mark either wrote most of its context (cold,
// recorded as a `cache:cold` event) or didn't (`cache:warm`). Returns true when it was cold.
export function onCacheUsage(agentId: string, usage: { cacheWrite: number; total: number; turn?: string }): boolean {
  if (!(usage.total > 0) || !usage.turn) return false;
  const mark = pendingMark(agentId);
  if (!mark || mark.seen === usage.turn) return false;
  const cold = usage.cacheWrite > COLD_SHARE * usage.total;
  db.addEvent(agentId, cold ? 'cache:cold' : 'cache:warm', { tokens: usage.cacheWrite, context: usage.total, cause: mark.cause });
  return cold;
}

// The window the transcript shows: 1 h writes mean the 1 h window, 5 min writes alone mean 5 min.
export function ttlOf(u: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } | null | undefined): CacheTtl | undefined {
  if ((u?.ephemeral_1h_input_tokens ?? 0) > 0) return '1h';
  if ((u?.ephemeral_5m_input_tokens ?? 0) > 0) return '5m';
  return undefined;
}

// Records an agent's detected window as a `cache:ttl` event when it differs from the last one.
export function onCacheTtl(agentId: string, ttl: CacheTtl | undefined): void {
  if (!ttl || latestTtl(agentId) === ttl) return;
  db.addEvent(agentId, 'cache:ttl', { ttl });
}

function latestTtl(agentId: string): CacheTtl | undefined {
  const r = db.open().prepare("SELECT json_extract(data, '$.ttl') AS ttl FROM events WHERE agent_id = ? AND type = 'cache:ttl' ORDER BY id DESC LIMIT 1").get(agentId) as { ttl: CacheTtl } | undefined;
  return r?.ttl;
}

// For usage_info: cold turns and tokens per day since `since` (a YYYY-MM-DD day), their total, and the
// live agents whose latest detected window is 5 min. `agentSql`/`agentArg` narrow to kept agents.
export const COLD_BY_DAY_SQL = "SELECT substr(ts, 1, 10) AS day, COUNT(*) AS turns, SUM(json_extract(data, '$.tokens')) AS tokens FROM events WHERE type = 'cache:cold' AND ts >= ?";
export const TTL_AGENTS_SQL = "SELECT agent_id, json_extract(data, '$.ttl') AS ttl FROM events WHERE id IN (SELECT MAX(id) FROM events WHERE type = 'cache:ttl'";

export function summary(since: string, agentSql = '', agentArg: string[] = []): unknown {
  const d = db.open();
  const byDay = d.prepare(`${COLD_BY_DAY_SQL}${agentSql} GROUP BY day ORDER BY day`).all(since, ...agentArg) as { day: string; turns: number; tokens: number }[];
  const rows = d.prepare(`${TTL_AGENTS_SQL}${agentSql} GROUP BY agent_id)`).all(...agentArg) as { agent_id: string; ttl: string }[];
  const short = rows.filter((r) => r.ttl === '5m').map((r) => db.getAgent(r.agent_id)).filter((a): a is db.Agent => Boolean(a) && a!.lifecycle !== 'archived');
  return {
    note: 'A cold turn is the first turn after a wake or a compaction whose cache write is over 80% of its context. Codex and OpenCode are not counted.',
    cold_by_day: byDay,
    cold_total: { turns: byDay.reduce((n, r) => n + r.turns, 0), tokens: byDay.reduce((n, r) => n + (r.tokens ?? 0), 0) },
    ttl_5m_agents: short.map((a) => ({ agent_id: a.id, agent: a.name })),
  };
}
