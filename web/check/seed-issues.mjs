// Closed issues with spend, for the Usage page's Issues fold (a test daemon only): node seed-issues.mjs DB_PATH
// Six issues on three configurations (Haiku, DeepSeek over OpenCode, Opus), each owned by one of the
// daemon's first agents, in progress for an hour and done, with usage samples inside that time.
// Times are relative to now, so the rows stay inside the default window. Deterministic costs.
import { DatabaseSync } from 'node:sqlite';

const [path] = process.argv.slice(2);
if (!path) { console.error('usage: node seed-issues.mjs DB_PATH'); process.exit(2); }
const db = new DatabaseSync(path);
// The check daemon writes to this DB while we seed it; wait for its lock instead of failing with SQLITE_BUSY.
db.exec('PRAGMA busy_timeout = 10000');
const MIN = 60_000;
const base = Math.floor(Date.now() / (5 * MIN)) * (5 * MIN);
const iso = (t) => new Date(t).toISOString();
const at = (min) => iso(base + min * MIN);
// Workers (agents with no child agents), so each issue's config is its own model, not a manager's.
// With fewer than three workers, the issues share them.
const agents = db.prepare('SELECT id FROM agents a WHERE NOT EXISTS (SELECT 1 FROM agents c WHERE c.parent_id = a.id) ORDER BY created_at').all().map((r) => r.id);
if (!agents.length) { console.error('need an agent'); process.exit(1); }

const HAIKU = { harness: 'claude', model: 'claude-haiku-5-5', account: 'claude', cost: 2 };
const DEEPSEEK = { harness: 'opencode', model: 'openrouter/deepseek/deepseek-v4-flash', account: 'openrouter', cost: 1 };
const OPUS = { harness: 'claude', model: 'claude-opus-5-5', account: 'claude', cost: 9 };
const issues = [
  { id: 'seed-i1', key: 'SEED-1', title: 'Fix the login redirect', owner: agents[0 % agents.length], cfg: HAIKU, tokens: 40000, start: -150 },
  { id: 'seed-i2', key: 'SEED-2', title: 'Tidy the mail index', owner: agents[1 % agents.length], cfg: DEEPSEEK, tokens: 25000, start: -110 },
  { id: 'seed-i3', key: 'SEED-3', title: 'Rework the scheduler', owner: agents[2 % agents.length], cfg: OPUS, tokens: 90000, start: -70 },
  // Costlier and cheaper repeats, so the Finished issues panel has five rows and some sit over their median.
  { id: 'seed-i4', key: 'SEED-4', title: 'Rewrite the mail rules', owner: agents[0 % agents.length], cfg: { ...HAIKU, cost: 7 }, tokens: 70000, start: -230 },
  { id: 'seed-i5', key: 'SEED-5', title: 'Retire the old importer', owner: agents[1 % agents.length], cfg: { ...DEEPSEEK, cost: 0.5 }, tokens: 18000, start: -190 },
  { id: 'seed-i6', key: 'SEED-6', title: 'Speed up the board', owner: agents[2 % agents.length], cfg: { ...OPUS, cost: 14 }, tokens: 120000, start: -30 },
];

// A sample counts only once its agent exists, so the owners are backdated to before the issues.
for (const id of new Set(issues.map((x) => x.owner))) db.prepare('UPDATE agents SET created_at = ? WHERE id = ?').run(at(-300), id);

const del = (t, where, ...v) => db.prepare(`DELETE FROM ${t} WHERE ${where}`).run(...v);
for (const x of issues) {
  del('itsa_events', 'itsa_id = ?', x.id);
  del('itsas', 'id = ?', x.id);
  // Each issue is in progress for its own 30 minutes, with its samples inside them: a sample is
  // split over the owner's active ITSAs at its time, so no two issues share one.
  const s0 = x.start;
  // Samples already in this issue's window (a re-run) go, so the inserts below do not clash.
  db.prepare('DELETE FROM usage_samples WHERE agent_id = ? AND bucket BETWEEN ? AND ?').run(x.owner, at(x.start - 10), at(x.start + 40));
  db.prepare("INSERT INTO itsas (id, key, kind, title, status, owner, created_by, created_at, updated_at, closed_at) VALUES (?, ?, 'issue', ?, 'done', ?, ?, ?, ?, ?)")
    .run(x.id, x.key, x.title, x.owner, x.owner, at(s0 - 10), at(s0 + 30), at(s0 + 30));
  db.prepare("INSERT INTO itsa_events (itsa_id, ts, actor, type, data) VALUES (?, ?, ?, 'created', ?)").run(x.id, at(s0 - 10), x.owner, JSON.stringify({ key: x.key, title: x.title, status: 'todo' }));
  db.prepare("INSERT INTO itsa_events (itsa_id, ts, actor, type, data) VALUES (?, ?, ?, 'status', ?)").run(x.id, at(s0), x.owner, JSON.stringify({ from: 'todo', to: 'in_progress' }));
  db.prepare("INSERT INTO itsa_events (itsa_id, ts, actor, type, data) VALUES (?, ?, ?, 'status', ?)").run(x.id, at(s0 + 30), x.owner, JSON.stringify({ from: 'in_progress', to: 'done' }));
  for (const min of [s0 + 5, s0 + 15, s0 + 25]) {
    db.prepare('INSERT INTO usage_samples (agent_id, account, harness, model, bucket, cost_usd, tokens_in, tokens_out, tokens_cache_read) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(x.owner, x.cfg.account, x.cfg.harness, x.cfg.model, at(min), x.cfg.cost / 3, x.tokens / 3, x.tokens / 9, x.tokens / 2);
  }
}
console.log(`seeded ${issues.length} closed issues`);
