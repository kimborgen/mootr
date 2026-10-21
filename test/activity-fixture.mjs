// A realistic-scale activity fixture (S-1009): about 700 agents over 7 days, mixed harnesses, a few deep
// trees, ITSAs with owners, participants and status moves, and activity items shaped like real
// transcripts (model, tool and gap items, every wait kind, categories on working items, some long
// pauses). Deterministic: the same options give the same rows. Used by the summary's speed test and
// scripts/activity-bench.mjs; never by a live daemon.
//
//   seedScale(db, { agents = 700, days = 7, now })  ->  { now, agents, items, itsas, roots, samples }
//
// Into a database that holds other rows (the web checks' daemon, web/check/seed-activity.mjs), pass
// { wipe: false, prefix: 'ax-', keyPrefix: 'AX', lifecycle: 'archived', windows: false }: nothing is
// deleted, ids and names take the prefix, ITSA keys the key prefix, the agents get that lifecycle
// (so they stay out of the tree), and no window readings or subscription are written.
//
// { allTypes: true } gives the web checks every kind of agent the type filter names (S-1491): after the draw, with
// no random numbers used, some workers become advisors, retro-stewards, coordinators, fallback reviewers and
// untyped agents, one is the assistant (kind assistant) and one is `intake` (no type). The chief of staff type
// comes from the check daemon's own `cos` agent (web/check/daemon.sh sets it); the fixture's first agent stays a manager.
//
// It also seeds what the cost views read: usage rows per agent and day, usage samples per 5-minute
// bucket (one per agent and bucket with model spend), and Claude's 5-hour and 7-day window readings
// every 5 minutes with a fresh subscription row, so the usage snapshot calibrates as it does live.
import { ACTIVITY_KEYS } from '../src/activity-categories.ts';

// mulberry32: a small seeded PRNG.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HARNESSES = [
  ['claude', 'claude-opus-5-5', 0.35],
  ['claude', 'claude-haiku-5-5', 0.25],
  ['codex', 'gpt-6.1-sol', 0.15],
  ['opencode', 'deepseek-v4.1-flash', 0.25],
];
const TYPES = ['developer', 'developer', 'developer', 'reviewer', 'reviewer-opus', 'manager'];
// Gap wait kinds and how long they tend to last (seconds): [kind, weight, min, max].
const GAPS = [
  ['agent.child', 8, 60, 3600],
  ['agent.peer', 4, 10, 900],
  ['agent.release', 3, 120, 3600],
  ['job.background', 3, 30, 900],
  ['human.reply', 2, 60, 7200],
  ['human.prompt', 1, 300, 14400],
  ['human.permission', 1, 30, 1800],
  ['event.timer', 2, 60, 1800],
  ['event.external', 1, 30, 600],
  ['throttle.cost', 1, 300, 7200],
  ['throttle.scheduler', 1, 300, 5400],
  ['idle.none', 2, 300, 10800],
];
const TOOLS = [
  ['tool.short', 30, 0.2, 5],
  ['tool.test', 3, 20, 600],
  ['tool.build', 2, 10, 240],
  ['tool.network', 3, 1, 30],
  ['tool.sleep', 1, 30, 600],
  ['tool.contention', 1, 30, 900],
];

function pickWeighted(r, list) {
  const total = list.reduce((n, x) => n + x[1], 0);
  let v = r() * total;
  for (const x of list) if ((v -= x[1]) <= 0) return x;
  return list[list.length - 1];
}

// The fixture as rows, before any database: { agents, itsas, itsa_events, itsa_participants, activity_items, usage,
// usage_samples, window_readings, subscription, roots }. Each row is named after the API's shape (agents carry
// `parent_id`, `created_at`, `type`, ...). seedScale inserts them; seedFile (below) writes them as a
// daemon's startup seed (test-seed.json), so the e2e test never opens the database.
export function generateScale(opts = {}) {
  const nAgents = opts.agents ?? 700;
  const days = opts.days ?? 7;
  const now = opts.now ?? Date.parse('2026-10-15T12:00:00.000Z');
  const r = rng(opts.seed ?? 1009);
  const from = now - days * 86_400_000;
  const iso = (ms) => new Date(ms).toISOString();
  const prefix = opts.prefix ?? '';
  const keyPrefix = opts.keyPrefix ?? 'S';

  // Agents: a chief of staff, a few root managers, managers under them (some three deep), workers.
  const agents = [];
  const addAgent = (parent, type, depth) => {
    const i = agents.length;
    const [harness, model] = type === 'manager' || depth < 2 ? ['claude', 'claude-opus-5-5'] : pickWeighted(r, HARNESSES.map((h) => [h, h[2]]))[0];
    const start = depth === 0 ? from - 86_400_000 : from + r() * (days - 0.2) * 86_400_000;
    const life = depth === 0 ? now - start : Math.min(now - start, (0.5 + r() * (type === 'manager' ? 36 : 10)) * 3_600_000);
    const a = { id: `${prefix}a${i.toString(36).padStart(4, '0')}`, name: `${prefix}agent-${i}`, harness, model, type, parent, depth, start, end: start + life };
    agents.push(a);
    return a;
  };
  const cos = addAgent(null, 'manager', 0);
  cos.name = `${prefix}cos`;
  const roots = [cos, addAgent(null, 'manager', 0), addAgent(null, 'manager', 0)];
  const managers = [...roots];
  while (agents.length < nAgents) {
    const parent = managers[Math.floor(r() * managers.length)];
    const isManager = parent.depth < 4 && r() < 0.12;
    const a = addAgent(parent, isManager ? 'manager' : TYPES[Math.floor(r() * (TYPES.length - 1))], parent.depth + 1);
    if (isManager) managers.push(a);
  }

  const account = (h) => (h === 'opencode' ? 'openrouter' : h);
  const out = { agents: [], itsas: [], itsa_events: [], itsa_participants: [], activity_items: [], usage: [], usage_samples: [], window_readings: [], subscription: null, roots: roots.map((x) => x.id), now };
  for (const a of agents) out.agents.push({ id: a.id, name: a.name, role: 'test', machine: 'x', harness: a.harness, model: a.model, cwd: '/tmp', parent_id: a.parent?.id ?? null, created_at: iso(a.start), updated_at: iso(a.start), type: a.type });
  const row = new Map(out.agents.map((x) => [x.id, x]));
  if (opts.allTypes) {
    const extra = ['advisor', 'retro-steward', 'coordinator', 'reviewer-fallback', null];
    agents.forEach((a, i) => {
      if (i < 3 || a.type === 'manager' || i % 9 !== 4) return;
      row.get(a.id).type = extra[Math.floor(i / 9) % extra.length];
    });
    const workers = agents.filter((a, i) => i >= 3 && a.type !== 'manager');
    Object.assign(row.get(workers[0].id), { kind: 'assistant', type: null });
    Object.assign(row.get(workers[1].id), { name: `${prefix}intake`, type: null });
  }
  if (opts.lifecycle) for (const x of out.agents) x.lifecycle = opts.lifecycle;

  let itsaN = 0;
  // ITSAs: managers own a project, every worker owns one issue (under its manager's project) and
  // most get a review round; reviewers take part in a sibling's issue.
  const project = new Map();
  const itsa = (id, key, parent_id, kind, title, status, owner, created_by, created_at, updated_at, closed_at) => out.itsas.push({ id, key, parent_id, kind, title, status, owner, created_by, created_at, updated_at, closed_at });
  const event = (itsa_id, ts, actor, type, data) => out.itsa_events.push({ itsa_id, ts, actor, type, data });
  for (const m of managers) {
    const id = `p${itsaN}`;
    const key = `${keyPrefix}-${++itsaN}`;
    project.set(m.id, id);
    itsa(id, key, m.parent ? (project.get(m.parent.id) ?? null) : null, 'project', `${key} project`, 'in_progress', m.id, m.id, iso(m.start), iso(m.start), null);
    event(id, iso(m.start), m.id, 'created', { key, status: 'in_progress' });
  }
  const issueOf = new Map();
  for (const a of agents) {
    if (a.type === 'manager') continue;
    const id = `i${itsaN}`;
    const key = `${keyPrefix}-${++itsaN}`;
    const done = a.end < now - 600_000 && r() < 0.8;
    const closed = done ? iso(a.end) : null;
    itsa(id, key, project.get(a.parent.id) ?? null, r() < 0.9 ? 'issue' : 'retro', `${key} issue`, done ? 'done' : 'in_progress', a.id, a.parent.id, iso(a.start), iso(a.start), closed);
    event(id, iso(a.start), a.parent.id, 'created', { key, status: 'in_progress' });
    const mid = a.start + (a.end - a.start) * 0.6;
    if (r() < 0.7) {
      event(id, iso(mid), a.id, 'status', { from: 'in_progress', to: 'in_review' });
      event(id, iso(mid + 300_000), a.id, 'status', { from: 'in_review', to: 'in_progress' });
    }
    if (done) event(id, closed, a.id, 'status', { from: 'in_progress', to: 'done' });
    issueOf.set(a.id, id);
    if (a.type.startsWith('reviewer')) {
      const sib = agents[Math.floor(r() * agents.length)];
      if (issueOf.has(sib.id)) out.itsa_participants.push({ itsa_id: issueOf.get(sib.id), agent_id: a.id });
    }
  }

  // Items: turns of model and tool items, separated by gaps, over each agent's life.
  const item = (agent_id, seq, turn, kind, start, end, wait_kind, raw_cost_usd, est_cost_usd, category, category_source) => out.activity_items.push({ agent_id, seq, turn, kind, start, end, wait_kind, raw_cost_usd, est_cost_usd, category, category_source });
  for (const a of agents) {
    let t = a.start;
    let seq = 0;
    let turn = 0;
    const cost = new Map();
    const buckets = new Map();
    const isManager = a.type === 'manager';
    while (t < a.end) {
      turn++;
      const calls = 2 + Math.floor(r() * 25);
      for (let c = 0; c < calls && t < a.end; c++) {
        const ms = (1 + r() * 20) * 1000;
        const usd = a.harness === 'claude' ? r() * 0.08 : r() * 0.01;
        const cat = ACTIVITY_KEYS[Math.floor(r() * ACTIVITY_KEYS.length)];
        const unclassified = r() < 0.08;
        item(a.id, seq++, turn, 'model', iso(t), iso(t + ms), ms > 300_000 ? 'model.stall' : 'model.generate', usd, usd, unclassified ? null : cat, unclassified ? null : 'rule');
        const day = iso(t).slice(0, 10);
        cost.set(day, (cost.get(day) ?? 0) + usd);
        const bucket = Math.floor(t / 300_000) * 300_000;
        buckets.set(bucket, (buckets.get(bucket) ?? 0) + usd);
        t += ms;
        const [wk, , lo, hi] = pickWeighted(r, TOOLS);
        const tms = (lo + r() * (hi - lo)) * 1000;
        // A few tool calls run in parallel with the next one: concurrent items share their wall time.
        const overlap = r() < 0.05 ? tms / 2 : 0;
        item(a.id, seq++, turn, 'tool', iso(t), iso(t + tms), wk, 0, 0, unclassified ? null : cat, unclassified ? null : 'rule');
        t += tms - overlap;
        if (r() < 0.02) {
          item(a.id, seq++, turn, 'model', iso(t), iso(t + 420_000), 'model.stall', 0, 0, cat, 'rule');
          t += 420_000;
        }
      }
      const [wk, , lo, hi] = pickWeighted(r, isManager ? GAPS : GAPS.filter((g) => g[0] !== 'agent.child'));
      // One long pause now and then: the "one 12 h pause" a bottleneck names.
      const gs = r() < 0.003 ? 12 * 3600 : lo + r() * (hi - lo);
      const end = Math.min(t + gs * 1000, a.end);
      if (end > t) item(a.id, seq++, turn, 'gap', iso(t), iso(end), wk, 0, 0, null, 'derived');
      t = end;
    }
    for (const [day, usd] of cost) out.usage.push({ agent_id: a.id, day, harness: a.harness, model: a.model, account: account(a.harness), cost_usd: usd });
    for (const [bucket, usd] of buckets) out.usage_samples.push({ agent_id: a.id, account: account(a.harness), harness: a.harness, model: a.model, bucket: iso(bucket), cost_usd: usd, tokens_in: Math.round(usd * 1e5), tokens_out: Math.round(usd * 2e4) });
  }
  // Claude's windows: readings every 5 minutes, the 5-hour one resetting every 5 hours.
  if (opts.windows !== false) {
    const sevenReset = Math.floor((now + 86_400_000) / 1000);
    for (let t = from; t <= now; t += 300_000) {
      const five = Math.floor(t / 18_000_000) * 18_000_000 + 18_000_000;
      out.window_readings.push({ name: 'claude', window: 'five_hour', at: iso(t), used_percentage: Math.round(((t % 18_000_000) / 18_000_000) * 60 * 10) / 10, resets_at: Math.floor(five / 1000) });
      out.window_readings.push({ name: 'claude', window: 'seven_day', at: iso(t), used_percentage: Math.round(((t - from) / (now - from)) * 70 * 10) / 10, resets_at: sevenReset });
    }
    const lastFive = Math.floor(now / 18_000_000) * 18_000_000 + 18_000_000;
    out.subscription = { name: 'claude', data: { five_hour: { used_percentage: 30, resets_at: Math.floor(lastFive / 1000) }, seven_day: { used_percentage: 70, resets_at: sevenReset } }, updated_at: iso(now - 60_000) };
  }
  return out;
}

// Writes the generated rows to a database (db.ts), the way the unit tests and the web checks seed one.
export function seedScale(db, opts = {}) {
  const f = generateScale(opts);
  const d = db.open();
  if (opts.wipe !== false) for (const t of ['activity_items', 'activity_cursors', 'usage', 'usage_samples', 'window_readings', 'subscriptions', 'itsa_events', 'itsa_participants', 'itsa_links', 'itsas', 'agent_parents', 'agents']) d.exec(`DELETE FROM ${t}`);
  const insAgent = d.prepare('INSERT INTO agents (id, name, role, machine, harness, model, effort, cwd, parent_id, session_id, created_at, updated_at, type) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?)');
  const insItsa = d.prepare('INSERT INTO itsas (id, key, parent_id, kind, title, status, owner, created_by, created_at, updated_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insEvent = d.prepare('INSERT INTO itsa_events (itsa_id, ts, actor, type, data) VALUES (?, ?, ?, ?, ?)');
  const insPart = d.prepare('INSERT OR IGNORE INTO itsa_participants (itsa_id, agent_id) VALUES (?, ?)');
  const insItem = d.prepare(
    'INSERT INTO activity_items (agent_id, seq, turn, kind, name, start, "end", summary, wait_kind, raw_cost_usd, est_cost_usd, tokens_in, tokens_out, category, category_source, confidence) VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, 0, 0, ?, ?, 1)',
  );
  const insUsage = d.prepare(
    'INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, paid_estimate_usd) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0)',
  );
  const insSample = d.prepare(
    'INSERT INTO usage_samples (agent_id, account, harness, model, bucket, cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)',
  );
  const insReading = d.prepare('INSERT INTO window_readings (name, window, at, used_percentage, resets_at) VALUES (?, ?, ?, ?, ?)');
  d.exec('BEGIN');
  try {
    for (const a of f.agents) insAgent.run(a.id, a.name, a.role, a.machine, a.harness, a.model, a.cwd, a.parent_id, a.created_at, a.updated_at, a.type);
    for (const a of f.agents) {
      if (a.kind) d.prepare('UPDATE agents SET kind = ? WHERE id = ?').run(a.kind, a.id);
      if (a.lifecycle) d.prepare('UPDATE agents SET lifecycle = ? WHERE id = ?').run(a.lifecycle, a.id);
    }
    for (const i of f.itsas) insItsa.run(i.id, i.key, i.parent_id, i.kind, i.title, i.status, i.owner, i.created_by, i.created_at, i.updated_at, i.closed_at);
    for (const e of f.itsa_events) insEvent.run(e.itsa_id, e.ts, e.actor, e.type, JSON.stringify(e.data));
    for (const p of f.itsa_participants) insPart.run(p.itsa_id, p.agent_id);
    for (const x of f.activity_items) insItem.run(x.agent_id, x.seq, x.turn, x.kind, x.start, x.end, x.wait_kind, x.raw_cost_usd, x.est_cost_usd, x.category, x.category_source);
    for (const u of f.usage) insUsage.run(u.agent_id, u.day, u.harness, u.model, u.account, u.cost_usd);
    for (const u of f.usage_samples) insSample.run(u.agent_id, u.account, u.harness, u.model, u.bucket, u.cost_usd, u.tokens_in, u.tokens_out);
    for (const w of f.window_readings) insReading.run(w.name, w.window, w.at, w.used_percentage, w.resets_at);
    if (f.subscription) d.prepare('INSERT INTO subscriptions (name, data, updated_at) VALUES (?, ?, ?)').run(f.subscription.name, JSON.stringify(f.subscription.data), f.subscription.updated_at);
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  return { now: f.now, agents: f.agents.length, items: f.activity_items.length, itsas: f.itsas.length, roots: f.roots, samples: f.usage_samples.length };
}

// Keeps one machine's share of a seeded fixture (S-1079): `all`, or the agents at the even or odd positions in id
// order (their items, usage and samples; the trees cross machines). Without `itsas` the ITSA tables are emptied,
// as on a daemon that is not the ITSA home.
export function splitFixture(db, part, { itsas = true } = {}) {
  const d = db.open();
  const ids = d.prepare('SELECT id FROM agents ORDER BY id').all().map((r) => r.id);
  const keep = new Set(ids.filter((id, i) => part === 'all' || (part === 'even' ? i % 2 === 0 : i % 2 === 1)));
  for (const [t, col] of [['activity_items', 'agent_id'], ['activity_cursors', 'agent_id'], ['usage', 'agent_id'], ['usage_samples', 'agent_id'], ['agent_parents', 'child_id'], ['agents', 'id']]) {
    const del = d.prepare(`DELETE FROM ${t} WHERE ${col} = ?`);
    for (const id of ids) if (!keep.has(id)) del.run(id);
  }
  if (!itsas) for (const t of ['itsa_events', 'itsa_participants', 'itsa_links', 'itsas']) d.exec(`DELETE FROM ${t}`);
  return keep;
}

// splitFixture over generated rows (generateScale), keeping one machine's share of them: `all`, or the agents at the
// even or odd positions in id order with their items, usage and samples. Without `itsas` the ITSA rows are dropped.
export function splitScale(f, part, { itsas = true } = {}) {
  const ids = f.agents.map((a) => a.id).sort();
  const keep = new Set(ids.filter((id, i) => part === 'all' || (part === 'even' ? i % 2 === 0 : i % 2 === 1)));
  const mine = (x) => keep.has(x.agent_id);
  const out = { ...f, agents: f.agents.filter((a) => keep.has(a.id)), activity_items: f.activity_items.filter(mine), usage: f.usage.filter(mine), usage_samples: f.usage_samples.filter(mine) };
  if (!itsas) Object.assign(out, { itsas: [], itsa_events: [], itsa_participants: [] });
  return { rows: out, keep };
}

// The startup seed (test-seed.json, see applyTestSeed in src/test-hooks.ts) for generated rows: the same state
// seedScale would write, with each agent holding the token `tok-ID`.
export function seedFile(f) {
  const byItsa = (list, key) => {
    const m = new Map();
    for (const x of list) m.set(x[key], [...(m.get(x[key]) ?? []), x]);
    return m;
  };
  const events = byItsa(f.itsa_events, 'itsa_id');
  const parts = byItsa(f.itsa_participants, 'itsa_id');
  return {
    agents: f.agents.map((a) => ({
      agent: a.id,
      create: { name: a.name, role: a.role, machine: a.machine, harness: a.harness, model: a.model, cwd: a.cwd },
      ...(a.parent_id ? { parent: a.parent_id } : {}),
      type: a.type,
      ...(a.kind ? { kind: a.kind } : {}),
      ...(a.lifecycle ? { lifecycle: a.lifecycle } : {}),
      created_at: a.created_at,
      updated_at: a.updated_at,
      token: `tok-${a.id}`,
    })),
    itsas: f.itsas.map((i) => ({ ...i, participants: (parts.get(i.id) ?? []).map((p) => p.agent_id), events: (events.get(i.id) ?? []).map((e) => ({ ts: e.ts, actor: e.actor, type: e.type, data: e.data })) })),
    activity: f.activity_items.map((x) => ({ agent: x.agent_id, seq: x.seq, turn: x.turn, kind: x.kind, start: x.start, end: x.end, wait_kind: x.wait_kind, raw_cost_usd: x.raw_cost_usd, est_cost_usd: x.est_cost_usd, category: x.category, category_source: x.category_source })),
    usage: [
      { table: 'usage', rows: f.usage.map((u) => ({ agent: u.agent_id, day: u.day, harness: u.harness, model: u.model, account: u.account, cost_usd: u.cost_usd })) },
      { table: 'usage_samples', rows: f.usage_samples.map((u) => ({ agent: u.agent_id, account: u.account, harness: u.harness, model: u.model, bucket: u.bucket, cost_usd: u.cost_usd, tokens_in: u.tokens_in, tokens_out: u.tokens_out })) },
    ],
    windows: { readings: f.window_readings, subscription: f.subscription },
  };
}
