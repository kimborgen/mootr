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

export function seedScale(db, opts = {}) {
  const nAgents = opts.agents ?? 700;
  const days = opts.days ?? 7;
  const now = opts.now ?? Date.parse('2026-10-15T12:00:00.000Z');
  const r = rng(opts.seed ?? 1009);
  const from = now - days * 86_400_000;
  const iso = (ms) => new Date(ms).toISOString();
  const prefix = opts.prefix ?? '';
  const keyPrefix = opts.keyPrefix ?? 'S';
  const d = db.open();
  if (opts.wipe !== false) for (const t of ['activity_items', 'activity_cursors', 'usage', 'usage_samples', 'window_readings', 'subscriptions', 'itsa_events', 'itsa_participants', 'itsa_links', 'itsas', 'agent_parents', 'agents']) d.exec(`DELETE FROM ${t}`);

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
  const account = (h) => (h === 'opencode' ? 'openrouter' : h);
  const insSample = d.prepare(
    'INSERT INTO usage_samples (agent_id, account, harness, model, bucket, cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)',
  );
  const insReading = d.prepare('INSERT INTO window_readings (name, window, at, used_percentage, resets_at) VALUES (?, ?, ?, ?, ?)');
  let samples = 0;

  let items = 0;
  let itsaN = 0;
  d.exec('BEGIN');
  try {
    for (const a of agents) insAgent.run(a.id, a.name, 'test', 'x', a.harness, a.model, '/tmp', a.parent?.id ?? null, iso(a.start), iso(a.start), a.type);
    if (opts.allTypes) {
      const set = d.prepare('UPDATE agents SET type = ? WHERE id = ?');
      const extra = ['advisor', 'retro-steward', 'coordinator', 'reviewer-fallback', null];
      agents.forEach((a, i) => {
        if (i < 3 || a.type === 'manager' || i % 9 !== 4) return;
        set.run(extra[Math.floor(i / 9) % extra.length], a.id);
      });
      const workers = agents.filter((a, i) => i >= 3 && a.type !== 'manager');
      d.prepare("UPDATE agents SET kind = 'assistant', type = NULL WHERE id = ?").run(workers[0].id);
      d.prepare('UPDATE agents SET name = ?, type = NULL WHERE id = ?').run(`${prefix}intake`, workers[1].id);
    }
    if (opts.lifecycle) {
      const life = d.prepare('UPDATE agents SET lifecycle = ? WHERE id = ?');
      for (const a of agents) life.run(opts.lifecycle, a.id);
    }

    // ITSAs: managers own a project, every worker owns one issue (under its manager's project) and
    // most get a review round; reviewers take part in a sibling's issue.
    const project = new Map();
    for (const m of managers) {
      const id = `p${itsaN}`;
      const key = `${keyPrefix}-${++itsaN}`;
      project.set(m.id, id);
      insItsa.run(id, key, m.parent ? (project.get(m.parent.id) ?? null) : null, 'project', `${key} project`, 'in_progress', m.id, m.id, iso(m.start), iso(m.start), null);
      insEvent.run(id, iso(m.start), m.id, 'created', JSON.stringify({ key, status: 'in_progress' }));
    }
    const issueOf = new Map();
    for (const a of agents) {
      if (a.type === 'manager') continue;
      const id = `i${itsaN}`;
      const key = `${keyPrefix}-${++itsaN}`;
      const done = a.end < now - 600_000 && r() < 0.8;
      const closed = done ? iso(a.end) : null;
      insItsa.run(id, key, project.get(a.parent.id) ?? null, r() < 0.9 ? 'issue' : 'retro', `${key} issue`, done ? 'done' : 'in_progress', a.id, a.parent.id, iso(a.start), iso(a.start), closed);
      insEvent.run(id, iso(a.start), a.parent.id, 'created', JSON.stringify({ key, status: 'in_progress' }));
      const mid = a.start + (a.end - a.start) * 0.6;
      if (r() < 0.7) {
        insEvent.run(id, iso(mid), a.id, 'status', JSON.stringify({ from: 'in_progress', to: 'in_review' }));
        insEvent.run(id, iso(mid + 300_000), a.id, 'status', JSON.stringify({ from: 'in_review', to: 'in_progress' }));
      }
      if (done) insEvent.run(id, closed, a.id, 'status', JSON.stringify({ from: 'in_progress', to: 'done' }));
      issueOf.set(a.id, id);
      if (a.type.startsWith('reviewer')) {
        const sib = agents[Math.floor(r() * agents.length)];
        if (issueOf.has(sib.id)) insPart.run(issueOf.get(sib.id), a.id);
      }
    }

    // Items: turns of model and tool items, separated by gaps, over each agent's life.
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
          insItem.run(a.id, seq++, turn, 'model', iso(t), iso(t + ms), ms > 300_000 ? 'model.stall' : 'model.generate', usd, usd, unclassified ? null : cat, unclassified ? null : 'rule');
          const day = iso(t).slice(0, 10);
          cost.set(day, (cost.get(day) ?? 0) + usd);
          const bucket = Math.floor(t / 300_000) * 300_000;
          buckets.set(bucket, (buckets.get(bucket) ?? 0) + usd);
          t += ms;
          items++;
          const [wk, , lo, hi] = pickWeighted(r, TOOLS);
          const tms = (lo + r() * (hi - lo)) * 1000;
          // A few tool calls run in parallel with the next one: concurrent items share their wall time.
          const overlap = r() < 0.05 ? tms / 2 : 0;
          insItem.run(a.id, seq++, turn, 'tool', iso(t), iso(t + tms), wk, 0, 0, unclassified ? null : cat, unclassified ? null : 'rule');
          t += tms - overlap;
          items++;
          if (r() < 0.02) {
            insItem.run(a.id, seq++, turn, 'model', iso(t), iso(t + 420_000), 'model.stall', 0, 0, cat, 'rule');
            t += 420_000;
            items++;
          }
        }
        const [wk, , lo, hi] = pickWeighted(r, isManager ? GAPS : GAPS.filter((g) => g[0] !== 'agent.child'));
        // One long pause now and then: the "one 12 h pause" a bottleneck names.
        const gs = r() < 0.003 ? 12 * 3600 : lo + r() * (hi - lo);
        const end = Math.min(t + gs * 1000, a.end);
        if (end > t) {
          insItem.run(a.id, seq++, turn, 'gap', iso(t), iso(end), wk, 0, 0, null, 'derived');
          items++;
        }
        t = end;
      }
      for (const [day, usd] of cost) insUsage.run(a.id, day, a.harness, a.model, account(a.harness), usd);
      for (const [bucket, usd] of buckets) {
        insSample.run(a.id, account(a.harness), a.harness, a.model, iso(bucket), usd, Math.round(usd * 1e5), Math.round(usd * 2e4));
        samples++;
      }
    }
    // Claude's windows: readings every 5 minutes, the 5-hour one resetting every 5 hours.
    if (opts.windows !== false) seedWindows(d, insReading, from, now, iso);
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  return { now, agents: agents.length, items, itsas: itsaN, roots: roots.map((x) => x.id), samples };
}

function seedWindows(d, insReading, from, now, iso) {
  const sevenReset = Math.floor((now + 86_400_000) / 1000);
  for (let t = from; t <= now; t += 300_000) {
    const five = Math.floor(t / 18_000_000) * 18_000_000 + 18_000_000;
    insReading.run('claude', 'five_hour', iso(t), Math.round(((t % 18_000_000) / 18_000_000) * 60 * 10) / 10, Math.floor(five / 1000));
    insReading.run('claude', 'seven_day', iso(t), Math.round(((t - from) / (now - from)) * 70 * 10) / 10, sevenReset);
  }
  const lastFive = Math.floor(now / 18_000_000) * 18_000_000 + 18_000_000;
  d.prepare('INSERT INTO subscriptions (name, data, updated_at) VALUES (?, ?, ?)').run(
    'claude',
    JSON.stringify({ five_hour: { used_percentage: 30, resets_at: Math.floor(lastFive / 1000) }, seven_day: { used_percentage: 70, resets_at: sevenReset } }),
    iso(now - 60_000),
  );
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
