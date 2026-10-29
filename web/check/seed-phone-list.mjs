// Agents for the phone Agents list (S-3281), on a test daemon only: node seed-phone-list.mjs DB_PATH
// Three trees of live agents across two fixture machines, 26 in all: one 5 deep, one 4 deep and one with two
// branches under a root, with four waiting. Five stopped agents and forty archived ones. Names are fixtures
// (fixture-a and fixture-b are the machines), never real host names.
import { DatabaseSync } from 'node:sqlite';

const [path] = process.argv.slice(2);
if (!path) { console.error('usage: node seed-phone-list.mjs DB_PATH'); process.exit(2); }
const db = new DatabaseSync(path);
db.exec('PRAGMA busy_timeout = 10000');
const DAY = 24 * 60 * 60_000;
const now = Date.now();
const iso = (t) => new Date(t).toISOString();
const run = (sql, ...v) => db.prepare(sql).run(...v);

// [id, name, parent, machine, role, model, harness, activity, lifecycle]
const MODELS = { claude: 'claude-sonnet-5-5', codex: 'gpt-6.1-sol', opencode: 'openrouter/deepseek/deepseek-v4-flash-latest' };
const LIVE = [
  ['pl-a0', 'fixture-root-a', null, 'fixture-a', 'manager', 'claude', 'idle'],
  ['pl-a1', 'fixture-a-lead', 'pl-a0', 'fixture-a', 'manager', 'claude', 'working'],
  ['pl-a2', 'fixture-a-dev', 'pl-a0', 'fixture-b', 'developer', 'codex', 'idle'],
  ['pl-a3', 'fixture-a-review', 'pl-a0', 'fixture-a', 'reviewer', 'claude', 'waiting'],
  ['pl-a4', 'fixture-a-level3', 'pl-a1', 'fixture-b', 'developer', 'claude', 'working'],
  ['pl-a5', 'fixture-a-level4', 'pl-a4', 'fixture-a', 'developer', 'opencode', 'waiting'],
  ['pl-a6', 'fixture-a-level5', 'pl-a5', 'fixture-b', 'developer', 'claude', 'idle'],
  ['pl-a7', 'fixture-a-level6', 'pl-a6', 'fixture-a', 'tester', 'claude', 'working'],
  ['pl-a8', 'fixture-a-level7', 'pl-a7', 'fixture-b', 'tester', 'codex', 'idle'],
  ['pl-b0', 'fixture-b-root', null, 'fixture-b', 'manager', 'claude', 'working'],
  ['pl-b1', 'fixture-b-one', 'pl-b0', 'fixture-b', 'developer', 'claude', 'idle'],
  ['pl-b2', 'fixture-b-two', 'pl-b0', 'fixture-a', 'developer', 'codex', 'waiting'],
  ['pl-b3', 'fixture-b-three', 'pl-b1', 'fixture-a', 'developer', 'claude', 'idle'],
  ['pl-b4', 'fixture-b-four', 'pl-b3', 'fixture-b', 'reviewer', 'claude', 'idle'],
  ['pl-b5', 'fixture-b-five', 'pl-b4', 'fixture-a', 'tester', 'opencode', 'working'],
  ['pl-b6', 'fixture-b-six', 'pl-b5', 'fixture-b', 'developer', 'claude', 'idle'],
  ['pl-b7', 'fixture-b-seven', 'pl-b6', 'fixture-a', 'developer', 'claude', 'idle'],
  ['pl-c0', 'fixture-c-root', null, 'fixture-a', 'manager', 'claude', 'idle'],
  ['pl-c1', 'fixture-c-left', 'pl-c0', 'fixture-b', 'developer', 'claude', 'working'],
  ['pl-c2', 'fixture-c-right', 'pl-c0', 'fixture-a', 'developer', 'codex', 'idle'],
  ['pl-c3', 'fixture-c-left-2', 'pl-c1', 'fixture-b', 'reviewer', 'claude', 'waiting'],
  ['pl-c4', 'fixture-c-left-3', 'pl-c3', 'fixture-a', 'developer', 'claude', 'idle'],
  ['pl-c5', 'fixture-c-right-2', 'pl-c2', 'fixture-b', 'tester', 'opencode', 'idle'],
  ['pl-c6', 'fixture-c-right-3', 'pl-c5', 'fixture-a', 'developer', 'claude', 'working'],
  ['pl-c7', 'fixture-c-right-4', 'pl-c6', 'fixture-b', 'developer', 'claude', 'idle'],
  ['pl-c8', 'fixture-c-right-5', 'pl-c7', 'fixture-a', 'developer', 'claude', 'idle'],
];
const STOPPED = Array.from({ length: 5 }, (_, i) => [`pl-s${i}`, `fixture-stopped-${i + 1}`, null, i % 2 ? 'fixture-b' : 'fixture-a', 'developer', 'claude', 'idle']);
// The second archived agent is the first one's child, so an archived fold has a child to hide.
const ARCHIVED = Array.from({ length: 40 }, (_, i) => [`pl-r${i}`, `fixture-archived-${i + 1}`, i === 1 ? 'pl-r0' : null, i % 2 ? 'fixture-b' : 'fixture-a', ['developer', 'reviewer', 'tester'][i % 3], ['claude', 'codex', 'opencode'][i % 3], 'idle']);

const rows = [
  ...LIVE.map((r, i) => [...r, 'active', i]),
  ...STOPPED.map((r, i) => [...r, 'shut_down', 100 + i]),
  ...ARCHIVED.map((r, i) => [...r, 'archived', 200 + i]),
];
for (const [id, name, parent, machine, role, harness, activity, lifecycle, order] of rows) {
  run('DELETE FROM agents WHERE id = ?', id);
  // Created in its order, so the tree's sibling order is the same on every run; stopped and archived by when they changed.
  const created = now - 20 * DAY + order * 60_000;
  const updated = lifecycle === 'active' ? now : now - (order - 100) * 3_600_000;
  run("INSERT INTO agents (id, name, role, machine, harness, model, cwd, parent_id, lifecycle, activity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '/tmp', ?, ?, ?, ?, ?)",
    id, name, role, machine, harness, MODELS[harness], parent, lifecycle, activity, iso(created), iso(updated));
}
console.log(`seeded ${LIVE.length} live, ${STOPPED.length} stopped, ${ARCHIVED.length} archived`);
