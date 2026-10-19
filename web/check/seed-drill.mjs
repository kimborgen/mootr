// Trees, ITSAs with child ITSAs and many agents, with spend, for the Usage drill-down view (a test
// daemon only): node seed-drill.mjs DB_PATH
// Three trees (a manager and workers each), one project ITSA with three child ITSAs, and spend per
// day (the `usage` table) and per 5 minutes over the last 8 hours (`usage_samples`). Models are paired
// with their real harness: Claude Code with Opus, Sonnet or Haiku, Codex with gpt-6.1-sol, OpenCode with
// DeepSeek. Times are relative to now; costs are deterministic.
import { DatabaseSync } from 'node:sqlite';

const [path] = process.argv.slice(2);
if (!path) { console.error('usage: node seed-drill.mjs DB_PATH'); process.exit(2); }
const db = new DatabaseSync(path);
db.exec('PRAGMA busy_timeout = 10000');
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const now = Date.now();
const base = Math.floor(now / (5 * MIN)) * (5 * MIN);
const iso = (t) => new Date(t).toISOString();
const machine = db.prepare('SELECT machine FROM agents LIMIT 1').get()?.machine ?? 'seed';

const OPUS = { harness: 'claude', model: 'claude-opus-5-5', account: 'claude-max', rate: 1.6 };
const SONNET = { harness: 'claude', model: 'claude-sonnet-5-5', account: 'claude-max', rate: 0.7 };
const HAIKU = { harness: 'claude', model: 'claude-haiku-5-5', account: 'claude-max', rate: 0.15 };
const CODEX = { harness: 'codex', model: 'gpt-6.1-sol', account: 'codex-plus', rate: 0.5 };
const DEEPSEEK = { harness: 'opencode', model: 'openrouter/deepseek/deepseek-v4-flash', account: 'openrouter', rate: 0.05 };

const trees = [
  { root: 'drill-usage', cfg: OPUS, role: 'manager', kids: [['drill-band', SONNET], ['drill-chart', SONNET], ['drill-review', CODEX], ['drill-tables', HAIKU], ['drill-api', SONNET]] },
  { root: 'drill-sweep', cfg: SONNET, role: 'manager', kids: [['drill-names', DEEPSEEK], ['drill-paths', DEEPSEEK], ['drill-lint', HAIKU]] },
  { root: 'drill-retro', cfg: HAIKU, role: 'manager', kids: [['drill-dedupe', HAIKU], ['drill-tags', DEEPSEEK]] },
];
const agentRows = [];
for (const t of trees) {
  agentRows.push({ id: 'sd-' + t.root, name: t.root, role: t.role, parent: null, cfg: t.cfg });
  for (const [name, cfg] of t.kids) agentRows.push({ id: 'sd-' + name, name, role: name.endsWith('review') ? 'reviewer' : 'developer', parent: 'sd-' + t.root, cfg });
}
const run = (sql, ...v) => db.prepare(sql).run(...v);
for (const a of agentRows) {
  run('DELETE FROM agents WHERE id = ?', a.id);
  run("INSERT INTO agents (id, name, role, machine, harness, model, cwd, parent_id, lifecycle, activity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '/tmp', ?, 'active', 'idle', ?, ?)",
    a.id, a.name, a.role, machine, a.cfg.harness, a.cfg.model, a.parent, iso(now - 20 * DAY), iso(now));
  run('DELETE FROM usage WHERE agent_id = ?', a.id);
  run('DELETE FROM usage_samples WHERE agent_id = ?', a.id);
}
// A tiny deterministic wobble, so the columns differ without random.
const wob = (i, j) => 0.4 + ((i * 7 + j * 13) % 10) / 10;
agentRows.forEach((a, i) => {
  for (let d = 0; d < 14; d++) {
    const day = iso(now - d * DAY).slice(0, 10);
    const cost = a.cfg.rate * 6 * wob(i, d) * (a.role === 'manager' ? 1.4 : 1);
    run('INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      a.id, day, a.cfg.harness, a.cfg.model, a.cfg.account, cost, Math.round(cost * 90_000), Math.round(cost * 6_000), Math.round(cost * 700_000), Math.round(cost * 40_000));
  }
});

// The project ITSA, owned by the first manager, open for 8 hours, with three child ITSAs owned by workers.
const at = (t) => iso(t);
const itsas = [
  { id: 'sd-i0', key: 'DR-0', title: 'Redesign the Usage page', owner: 'sd-drill-usage', parent: null, status: 'in_progress', start: -480 },
  { id: 'sd-i1', key: 'DR-1', title: 'Limits band and tiles', owner: 'sd-drill-band', parent: 'sd-i0', status: 'done', start: -470 },
  { id: 'sd-i2', key: 'DR-2', title: 'Spend chart and drill-down', owner: 'sd-drill-chart', parent: 'sd-i0', status: 'in_progress', start: -400 },
  { id: 'sd-i3', key: 'DR-3', title: 'Tables tab', owner: 'sd-drill-tables', parent: 'sd-i0', status: 'todo', start: -300 },
  { id: 'sd-i4', key: 'DR-4', title: 'Review the usage API', owner: 'sd-drill-review', parent: 'sd-i0', status: 'in_progress', start: -200 },
];
for (const x of itsas) {
  run('DELETE FROM itsa_events WHERE itsa_id = ?', x.id);
  run('DELETE FROM itsas WHERE id = ?', x.id);
  const t0 = base + x.start * MIN;
  run("INSERT INTO itsas (id, key, parent_id, kind, title, status, owner, created_by, created_at, updated_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    x.id, x.key, x.parent, x.parent ? 'issue' : 'project', x.title, x.status, x.owner, x.owner, at(t0 - 5 * MIN), at(now), x.status === 'done' ? at(base - 120 * MIN) : null);
  run("INSERT INTO itsa_events (itsa_id, ts, actor, type, data) VALUES (?, ?, ?, 'created', ?)", x.id, at(t0 - 5 * MIN), x.owner, JSON.stringify({ key: x.key, title: x.title, status: 'todo' }));
  if (x.status !== 'todo') run("INSERT INTO itsa_events (itsa_id, ts, actor, type, data) VALUES (?, ?, ?, 'status', ?)", x.id, at(t0), x.owner, JSON.stringify({ from: 'todo', to: 'in_progress' }));
  if (x.status === 'done') run("INSERT INTO itsa_events (itsa_id, ts, actor, type, data) VALUES (?, ?, ?, 'status', ?)", x.id, at(base - 120 * MIN), x.owner, JSON.stringify({ from: 'in_progress', to: 'done' }));
}
// Samples every 15 minutes for the ITSA owners while their ITSA is in progress.
for (const x of itsas.filter((y) => y.status !== 'todo')) {
  const a = agentRows.find((r) => r.id === x.owner);
  const end = x.status === 'done' ? base - 120 * MIN : base;
  for (let t = base + x.start * MIN; t <= end; t += 15 * MIN) {
    const cost = a.cfg.rate * 0.12 * wob(x.start, Math.round(t / MIN));
    db.prepare('INSERT OR REPLACE INTO usage_samples (agent_id, account, harness, model, bucket, cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(a.id, a.cfg.account, a.cfg.harness, a.cfg.model, at(t), cost, Math.round(cost * 90_000), Math.round(cost * 6_000), Math.round(cost * 700_000), Math.round(cost * 40_000));
  }
}
// Window shares need readings and samples of the same account: every agent samples each 30 minutes for
// six days, and the claude account's windows rise as they are used (readings are stored under the harness).
const putSample = db.prepare('INSERT OR IGNORE INTO usage_samples (agent_id, account, harness, model, bucket, cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
db.exec('BEGIN');
agentRows.forEach((a, i) => {
  for (let t = base - 6 * DAY; t <= base; t += 30 * MIN) {
    const cost = a.cfg.rate * 0.1 * wob(i, Math.round(t / MIN));
    putSample.run(a.id, a.cfg.account, a.cfg.harness, a.cfg.model, at(t), cost, Math.round(cost * 90_000), Math.round(cost * 6_000), Math.round(cost * 700_000), Math.round(cost * 40_000));
  }
});
run("DELETE FROM window_readings WHERE name IN ('claude', 'codex')");
const reading = db.prepare('INSERT INTO window_readings (name, window, at, used_percentage, resets_at) VALUES (?, ?, ?, ?, ?)');
for (const [name, pace] of [['claude', 1], ['codex', 0.4]]) {
  for (let t = base - 6 * DAY, n = 0; t <= base; t += HOUR, n++) reading.run(name, 'seven_day', at(t), Math.min(95, 1 + n * 0.7 * pace), Math.floor((base + DAY) / 1000));
  for (let t = base - 8 * HOUR, n = 0; t <= base; t += 10 * MIN, n++) reading.run(name, 'five_hour', at(t), Math.min(90, 2 + n * 1.5 * pace), Math.floor((base + 2 * HOUR) / 1000));
}
// The current reading the account cards and window shares start from (the subscriptions table).
for (const [name, five, seven] of [['claude', 62, 48], ['codex', 25, 71]]) {
  db.prepare('INSERT INTO subscriptions (name, data, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
    .run(name, JSON.stringify({ five_hour: { used_percentage: five, resets_at: Math.floor((base + 2 * HOUR) / 1000) }, seven_day: { used_percentage: seven, resets_at: Math.floor((base + DAY) / 1000) } }), iso(now));
}
db.exec('COMMIT');
console.log(`seeded ${agentRows.length} agents in ${trees.length} trees and ${itsas.length} ITSAs`);
