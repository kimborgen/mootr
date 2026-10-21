// The shape of an agent row that leaves the daemon (S-2519). The `agents` row holds secrets
// (token_hash) next to public columns, and routes used to send the whole row. Everything that
// serves an agent (the list, the detail, spawn and control replies, MCP find_agents, peer fan-out)
// goes through publicAgent, an allowlist: a column added to the table later is not served until
// someone adds it here on purpose. send() in daemon.ts runs scrubAgents over every JSON reply as a
// net for a route that returns a raw row.
//
// token_hash is on no list. A peer authenticates a forwarded agent with its own peer token and the
// x-stam-agent header, never with the agent's hash (peer_agents keeps id, name, machine and state
// only), so no route sends it to a peer either.

// The columns of the agents table (db.Agent) that may be served.
export const PUBLIC_AGENT_COLUMNS = [
  'id', 'name', 'role', 'machine', 'harness', 'model', 'effort', 'cwd', 'parent_id', 'session_id',
  'transcript_path', 'lifecycle', 'activity', 'activity_detail', 'context_tokens', 'context_window',
  'workspace', 'personal_workspace', 'standing', 'pending_action', 'idle_since', 'idle_notified',
  'context_level', 'tokens_after_compaction', 'capabilities', 'permission_mode', 'permission_source',
  'visibility', 'child_notices', 'last_message', 'first_prompt', 'usage_last', 'kind', 'type',
  'paused_by', 'forwarded_to', 'created_at', 'updated_at',
] as const;

// Fields a route adds to a row before it goes out (list, detail, spawn replies, peer rows).
export const PUBLIC_AGENT_EXTRAS = [
  'parents', 'unread', 'cost_usd', 'cost', 'cost_raw', 'pending_requests', 'chief_of_staff', 'blockers',
  'waits', 'resting', 'in_itsa', 'view', 'load', 'default_view', 'warning', 'pending', 'busy', 'busy_at',
  // POST /api/register with token: true returns the new agent's own launch token to that agent, once.
  'token',
] as const;

const ALLOWED = new Set<string>([...PUBLIC_AGENT_COLUMNS, ...PUBLIC_AGENT_EXTRAS]);

// Whether an object is an agent row: the columns that no other served object has together.
export function looksLikeAgent(o: unknown): o is Record<string, unknown> {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const r = o as Record<string, unknown>;
  return typeof r.id === 'string' && typeof r.name === 'string' && typeof r.harness === 'string' && typeof r.lifecycle === 'string' && typeof r.machine === 'string' && 'cwd' in r;
}

export function publicAgent<T extends object>(a: T): Omit<T, 'token_hash'> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) if (ALLOWED.has(k)) out[k] = v;
  return out as Omit<T, 'token_hash'>;
}

// Replaces every agent row anywhere in a reply with its public shape; other objects pass through.
export function scrubAgents(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(scrubAgents);
  if (!data || typeof data !== 'object') return data;
  if (looksLikeAgent(data)) return publicAgent(data);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) out[k] = scrubAgents(v);
  return out;
}
