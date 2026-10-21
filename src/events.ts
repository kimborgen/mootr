// The daemon's event stream (GET /api/live): one SSE connection per web client, so the
// system view (epic S-445) can animate mail, agents, ITSAs, and cost as they change instead
// of polling. Each write site calls `emitEvent` once; `agent.changed` is coalesced.
// This module imports nothing from stam's own modules, so a write site (db.ts, mail.ts,
// itsa.ts, usage.ts) can import it without a cycle.
import { scrubAgents } from './agent-public.ts';
import type { ServerResponse } from 'node:http';

const streams = new Set<ServerResponse>();
// A client that falls more than this behind (it stopped reading) is dropped; it reconnects
// and refetches. The layout stream uses the same cap (src/layout.ts).
const STREAM_CAP = 1 << 20;

// Writes one chunk, dropping only a client that has really stopped reading: more than
// STREAM_CAP waiting before or after the write. `write` returning false is not enough — it
// only means the buffer passed the highWaterMark (about 16 KB), which a burst briefly crosses
// for a healthy client that drains it. Its close handler removes it from the set.
function send(res: ServerResponse, data: string): void {
  if (res.writableLength > STREAM_CAP) {
    res.destroy();
    return;
  }
  res.write(data);
  if (res.writableLength > STREAM_CAP) res.destroy();
}

// Adds one client's response as a stream: SSE headers, a first comment so the client knows
// it is connected, a ping every 25 s (the layout stream's cadence), and cleanup on close.
export function addEventStream(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  // A dropped client can emit an error after close; it must never reach the daemon's handler.
  res.on('error', () => {});
  streams.add(res);
  send(res, ': connected\n\n');
  const ping = setInterval(() => send(res, ': ping\n\n'), 25_000);
  // Cleanup first: nothing below awaits, and a closed socket must leave the set at once.
  res.on('close', () => {
    clearInterval(ping);
    streams.delete(res);
  });
}

// One event to every connected client, as `event: TYPE` then `data: JSON`. Nothing connected
// is the common case in a daemon with no web UI open, so it returns before serialising.
export function emitEvent(type: string, data: unknown): void {
  if (!streams.size) return;
  const payload = `event: ${type}\ndata: ${JSON.stringify(scrubAgents(data ?? {}))}\n\n`;
  for (const res of streams) send(res, payload);
}

// An agent's state for `agent.changed`, filled in when the event flushes (the daemon
// registers it: db.ts cannot be imported here without a cycle, since db.ts imports this).
type AgentSnapshot = (id: string) => Record<string, unknown> | undefined;
let agentSnapshot: AgentSnapshot = () => undefined;
export function setAgentSnapshot(fn: AgentSnapshot): void {
  agentSnapshot = fn;
}

// `agent.changed` is coalesced: a burst of activity changes for one agent sends at most four
// a second, the latest state only, so a busy tree never floods the clients (S-456). With no
// client connected there is nothing to send, so nothing is queued and no timer is armed.
const AGENT_COALESCE_MS = 250;
const pending = new Map<string, Record<string, unknown>>();
let flushTimer: NodeJS.Timeout | undefined;

export function agentChanged(id: string, patch: Record<string, unknown> = {}): void {
  if (!streams.size) return;
  pending.set(id, { ...(pending.get(id) ?? {}), ...patch });
  flushTimer ??= setTimeout(flushAgentChanges, AGENT_COALESCE_MS).unref();
}

function flushAgentChanges(): void {
  flushTimer = undefined;
  // Every client may have gone since the timer was armed: drop what piled up.
  if (!streams.size) {
    pending.clear();
    return;
  }
  const batch = [...pending];
  pending.clear();
  for (const [id, patch] of batch) emitEvent('agent.changed', { ...(agentSnapshot(id) ?? {}), ...patch, id });
}

// For the routes and the unit test: how many clients are connected, and how many agents await
// a flush.
export function streamCount(): number {
  return streams.size;
}
export function pendingCount(): number {
  return pending.size;
}
