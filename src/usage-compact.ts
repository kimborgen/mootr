// The compact default of the usage_info MCP tool (S-4236). GET /api/usage returns every agent, tree
// and window share with hourly history and every cost unit per row, about 1 MB on a busy system; the
// web UI and `stam usage` read all of it. The tool keeps what a cost-aware agent plans with: the
// windows with their projections, the top few trees, agents and models, the allocations and the
// machines. `detail: true` returns the whole route answer.

type Obj = Record<string, unknown>;

// Rows kept per list in the compact answer.
export const TOP = 5;
// Blocked agents named in full; the rest are counted.
const BLOCKED = 10;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const pick = (o: Obj, keys: string[]): Obj => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));
const rows = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);

// One window's summary (attribution.windowSummary) without the full agent and tree lists, the
// 14-day daily series and the hourly history, which `detail` or `tree` give.
function compactWindow(w: unknown): unknown {
  if (!isObj(w)) return w;
  const out = pick(w, ['estimate', 'since', 'change', 'other', 'agents', 'trees', 'worth', 'projection', 'other_trees']);
  const models = rows(w.by_model);
  out.by_model = models.slice(0, TOP);
  const omitted = (Array.isArray(w.by_agent) ? w.by_agent.length : 0) - rows(w.agents).length;
  if (omitted > 0) out.more_agents = omitted;
  if (isObj(w.history)) out.percent_per_hour = w.history.percent_per_hour;
  return out;
}

function compactTotals(r: Obj, keys: string[]): Obj {
  return pick(r, ['cost_usd', 'tokens_in', 'tokens_out', 'tokens_cache_read', 'tokens_cache_write', ...keys]);
}

const compactTree = (t: Obj): Obj => ({ ...pick(t, ['id', 'name', 'cost_usd', 'tokens', 'shares']), subagents: Array.isArray(t.children) ? t.children.length : 0 });
// The caller's node and its direct children (the TOP dearest, by cost), each as compactTree with its
// subagents count: a root can hold every agent ever made, so the subtree is not walked.
function ownTree(t: Obj): Obj {
  const kids = rows(t.children).sort((x, y) => (Number(y.cost_usd) || 0) - (Number(x.cost_usd) || 0));
  const out = { ...compactTree(t), children: kids.slice(0, TOP).map(compactTree) };
  return kids.length > TOP ? { ...out, omitted_children: kids.length - TOP } : out;
}
function findTree(trees: Obj[], id: string): Obj | undefined {
  for (const t of trees) {
    if (t.id === id) return t;
    const inner = findTree(rows(t.children), id);
    if (inner) return inner;
  }
  return undefined;
}

// `me` is the calling agent: its own node (wherever it sits in the forest) and its direct children are
// kept as own_tree whatever its rank, since it is the one an agent plans with.
export function compactUsage(full: Obj, me?: string): Obj {
  if (!isObj(full)) return {};
  const out: Obj = pick(full, ['note', 'display_mode', 'instructions', 'subscriptions', 'openrouter_reserve', 'shares_note', 'allocations', 'tree', 'machines', 'paid_spend_by_machine', 'sample_count', 'filtered_agents']);
  out.accounts = rows(full.accounts).map((a) => ({
    ...a,
    shares: isObj(a.shares) ? Object.fromEntries(Object.entries(a.shares).map(([name, w]) => [name, compactWindow(w)])) : a.shares,
  }));
  const trees = rows(full.trees);
  // The top roots by rank, and the "other" line a scoped answer collapses the hidden trees into.
  out.trees = trees.filter((t, i) => i < TOP || t.id === 'other').map(compactTree);
  const own = me ? findTree(trees, me) : undefined;
  if (own) out.own_tree = ownTree(own);
  if (isObj(full.today)) out.today = compactTotals(full.today, []);
  out.by_day = rows(full.by_day).map((r) => compactTotals(r, ['day']));
  const models = rows(full.by_model);
  out.by_model = models.slice(0, TOP).map((r) => compactTotals(r, ['harness', 'model']));
  const agents = rows(full.by_agent);
  out.by_agent = agents.slice(0, TOP).map((r) => compactTotals(r, ['agent_id', 'agent', 'type', 'harness', 'model']));
  out.by_account = rows(full.by_account).map((r) => compactTotals(r, ['account']));
  const blocked = Array.isArray(full.blocked) ? full.blocked : [];
  out.blocked = blocked.slice(0, BLOCKED);
  out.omitted = {
    trees: Math.max(0, trees.length - (out.trees as Obj[]).length),
    by_model: Math.max(0, models.length - TOP),
    by_agent: Math.max(0, agents.length - TOP),
    blocked: Math.max(0, blocked.length - BLOCKED),
    hint: 'Compact by default. Pass detail: true for every agent, tree, model and cost unit with the hourly history (about 1 MB), or tree: AGENT for one tree\'s hourly history.',
  };
  return out;
}
