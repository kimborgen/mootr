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
  'paused_by', 'forwarded_to', 'launched_at', 'resumed_at', 'created_at', 'updated_at',
] as const;

// Fields a route adds to a row before it goes out (list, detail, spawn replies, peer rows).
export const PUBLIC_AGENT_EXTRAS = [
  'parents', 'unread', 'cost_usd', 'cost', 'cost_raw', 'pending_requests', 'chief_of_staff', 'blockers',
  'waits', 'open_ask', 'open_ask_detail', 'resting', 'in_itsa', 'view', 'load', 'default_view', 'warning', 'pending', 'busy', 'busy_at',
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

// The columns a row of the agent list (GET /api/agents) sends as null (S-3808). first_prompt is the whole spawn brief,
// several KB and never shortened, so over every archived agent it was most of a 22 MB list that the web polls every
// 2 s and each MCP ITSA reply reads; no reader of the list uses it. The detail route and spawn replies keep it.
export const LIST_NULLED = ['first_prompt'] as const;
const NULLED = new Set<string>(LIST_NULLED);

// publicAgent for a row of the agent list: the same keys, with LIST_NULLED sent as null.
export function listedAgent<T extends object>(a: T): Omit<T, 'token_hash'> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) if (ALLOWED.has(k)) out[k] = NULLED.has(k) ? null : v;
  return out as Omit<T, 'token_hash'>;
}

// The lifecycle groups GET /api/agents can list (S-3816): live is active or paused, stopped is shut down.
export const LIST_STATES = ['live', 'stopped', 'archived', 'all'] as const;
const GROUP: Record<string, string> = { active: 'live', paused: 'live', shut_down: 'stopped', archived: 'archived' };

// Which agents a GET /api/agents lists, from its `state` and `ids` (S-3816). `state` is a comma list of LIST_STATES;
// without it (or empty) the list is live agents only, since ~99% of the registry is archived and every open tab polls the list.
// `ids` (ids or names, comma-separated) adds those agents in any state, and alone lists only them, for a caller that
// resolves names. Null for a state it doesn't know.
export function listFilter(state: string | null, ids: string | null): ((a: { id: string; name: string; lifecycle: string }) => boolean) | null {
  const want = new Set((ids ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  const groups = new Set((state || (ids === null ? 'live' : '')).split(',').map((s) => s.trim()).filter(Boolean));
  if ([...groups].some((g) => !(LIST_STATES as readonly string[]).includes(g))) return null;
  const all = groups.has('all');
  return (a) => all || groups.has(GROUP[a.lifecycle] ?? '') || want.has(a.id) || want.has(a.name);
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
