// Context management: threshold notices, compaction requests, and cache-aware
// compaction of agents that sit idle long enough for their prompt cache to expire.
import { warmLessons } from './retro-lessons.ts';
import { workspacePrompt } from './workspace-prompt.ts';
import * as db from './db.ts';
import { settings } from './settings.ts';
import { render, renderWithRetro, withRetroReminder } from './templates.ts';
import { queueNotice } from './mail.ts';
import { requestCompaction } from './lifecycle.ts';
import { markCold } from './cache-cold.ts';

const measureNext = new Set<string>();
const idleCompacted = new Map<string, string>();
const compactInstructions = new Map<string, string>();

const k = (n: number) => `${Math.round(n / 1000)}k`;

export function historyOf(a: db.Agent): string {
  return a.transcript_path ?? (a.harness === 'opencode' ? `OpenCode session ${a.session_id}` : 'not available');
}

// Called after a compaction, so the next size report becomes the post-compaction size.
export function markCompacted(agentId: string): void {
  const a = db.getAgent(agentId);
  if (a) markCold(a, 'compaction');
  measureNext.add(agentId);
}

// OpenCode's plugin asks for these when the compaction runs.
export function setCompactInstructions(agentId: string, text: string | undefined): void {
  if (text) compactInstructions.set(agentId, text);
  else compactInstructions.delete(agentId);
}
export function takeCompactInstructions(agentId: string): string | undefined {
  const t = compactInstructions.get(agentId);
  compactInstructions.delete(agentId);
  return t;
}

// The level an agent's context is at. After a compaction a threshold counts only once the
// context has grown by growthTokens past its size right after that compaction: an agent whose
// summary alone is above a threshold would otherwise be compacted again on every turn, and
// each compaction would throw away its prompt cache for nothing.
function levelOf(tokens: number, base: number | undefined): { level: number; floor: number } {
  const s = settings().context;
  const floor = base ? base + Math.max(0, settings().idleCompaction.growthTokens) : 0;
  const at = (t: number) => tokens >= Math.max(t, floor);
  return { level: at(s.enforceTokens) ? 3 : at(s.instructTokens) ? 2 : at(s.warnTokens) ? 1 : 0, floor };
}

// The context size at which compaction is enforced for an agent: the enforcement threshold, or
// the growth floor after its last compaction when that is higher (S-919 shows it as the load).
export function enforceThreshold(a: db.Agent): number {
  return Math.max(settings().context.enforceTokens, levelOf(0, a.tokens_after_compaction || undefined).floor);
}

export function onContext(agentId: string, tokens: number): void {
  // A harness reports 0 before its first model call, such as Claude Code right after the
  // relaunch that follows a compaction: that is no size, so it neither measures nor lowers the level.
  if (!(tokens > 0)) return;
  const a = db.getAgent(agentId);
  if (!a) return;
  let base = a.tokens_after_compaction || undefined;
  if (measureNext.has(agentId)) {
    measureNext.delete(agentId);
    base = tokens;
    db.updateAgent(agentId, { tokens_after_compaction: tokens });
    db.addEvent(agentId, 'compaction:measured', { tokens });
  }
  const { level, floor } = levelOf(tokens, base);
  if (level === a.context_level) return;
  db.updateAgent(agentId, { context_level: level });
  if (level < a.context_level) return;
  const s = settings().context;
  const vars = { tokens: k(tokens), instruct: k(Math.max(s.instructTokens, floor)), enforce: k(Math.max(s.enforceTokens, floor)), history: historyOf(a) };
  db.addEvent(agentId, 'context:threshold', { level, tokens, ...(floor ? { floor } : {}) });
  if (level === 1) queueNotice(agentId, withRetroReminder(render('context-warning', vars)));
  if (level === 2) queueNotice(agentId, renderWithRetro('context-instruct', vars));
  if (level === 3) warmLessons(a).then((lessons) => requestCompaction(a, { prompt: withRetroReminder(render('compacted-forced', { ...vars, lessons, workspace: workspacePrompt(a) })), reason: 'enforcement threshold' })).catch(() => {});
}

function avgAfterCompaction(): number | undefined {
  const r = db
    .open()
    .prepare(`SELECT AVG(json_extract(data, '$.tokens')) AS avg FROM events WHERE type = 'compaction:measured' AND json_extract(data, '$.tokens') > 0 AND ts > ?`)
    .get(new Date(Date.now() - 5 * 86_400_000).toISOString()) as { avg: number | null };
  return r.avg ?? undefined;
}

// Compacts agents idle for longer than the cache lifetime, once per idle period.
export function idleSweep(): void {
  const s = settings().idleCompaction;
  if (!s.enabled) return;
  const avg = avgAfterCompaction();
  for (const a of db.listAgents()) {
    if ((a.lifecycle !== 'active' && a.lifecycle !== 'paused') || !a.idle_since || a.context_tokens == null) continue;
    // A resting agent has no harness to compact; its rest compacted first when it would outlast the cache (lifecycle.rest).
    if (db.restOwned(a)) continue;
    if (Date.now() - Date.parse(a.idle_since) < s.idleMinutes * 60_000) continue;
    idleCompactIfDue(a, 'idle past the cache lifetime', avg);
  }
}

// The idle compaction's rule for one agent: compacts it, once per idle period, when its context
// has grown past the threshold. True when it asked for one. The rest sweep (lifecycle.ts) calls it
// before a rest predicted to outlast the cache, so the agent doesn't wake to a full re-read.
export function idleCompactIfDue(a: db.Agent, reason: string, avg = avgAfterCompaction()): boolean {
  const s = settings().idleCompaction;
  if (!s.enabled || !a.idle_since || a.context_tokens == null) return false;
  if (idleCompacted.get(a.id) === a.idle_since) return false;
  // A stored 0 dates from before onContext ignored it: no measurement.
  const base = a.tokens_after_compaction || avg;
  const threshold = base != null ? base + s.growthTokens : s.minTokens;
  if (a.context_tokens <= threshold) return false;
  idleCompacted.set(a.id, a.idle_since);
  db.addEvent(a.id, 'context:idle-compaction', { tokens: a.context_tokens, threshold, reason });
  requestCompaction(a, { reason }).catch((e) => db.addEvent(a.id, 'compaction-error', String(e)));
  return true;
}
