// Raises an OpenCode ask the way the TS daemon does (S-3980): a fresh home with a manager and its OpenCode developer,
// then each permission.asked event of EVENTS (a JSON list) through src/adapters/opencode.ts onEvent, whose raise writes
// the request row with src/permissions.ts. Prints {agent, asks: [{id, action, details}]}, each ask the row it left
// pending, for go/internal/server's OpenCode ask test, which answers it after a daemon restart (S-4237 PR 4b). Never
// the live home.
//
//   node go/internal/server/testdata/ocaskref.mjs DIR EVENTS
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const [dir, events] = process.argv.slice(2);
if (!dir || !events) {
  console.error('usage: ocaskref.mjs DIR EVENTS');
  process.exit(2);
}
const home = resolve(dir);
if (existsSync(`${home}/stam.db`)) {
  console.error(`ocaskref: ${home} already has a stam.db`);
  process.exit(2);
}
process.env.STAM_HOME = home;
process.env.STAM_MACHINE = 'test-machine';
process.env.STAM_EMBEDDER = 'stub';
// No OpenCode server answers here: the raise asks it nothing.
process.env.STAM_OPENCODE_PORT = '1';
for (const k of ['OPENROUTER_API_KEY', 'STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID']) delete process.env[k];
const config = await import('../../../../src/config.ts');
if (config.LIVE_HOME) {
  console.error('ocaskref: refusing the live home');
  process.exit(2);
}
const db = await import('../../../../src/db.ts');
await import('../../../../src/lifecycle.ts');
const { onEvent } = await import('../../../../src/adapters/opencode.ts');

const base = { machine: 'test-machine', model: null, effort: null, cwd: home };
db.createAgent({ ...base, id: 'amgr', name: 'mgr', role: 'manager', harness: 'claude', parent_id: null, session_id: null });
db.createAgent({ ...base, id: 'aoc', name: 'oc-dev', role: 'developer', harness: 'opencode', parent_id: 'amgr', session_id: 'ses_tsask' });
db.updateAgent('amgr', { lifecycle: 'active' });
db.updateAgent('aoc', { lifecycle: 'active', activity: 'working' });

const asks = [];
for (const ev of JSON.parse(events)) {
  onEvent(ev);
  // The raise is deferred (permissionsLater): wait for its row.
  for (let i = 0; i < 200; i++) {
    const r = db.pendingDialog('aoc');
    if (r && JSON.parse(r.details).permission === ev.data.id) {
      asks.push({ id: r.id, action: r.action, details: r.details });
      break;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}
db.open().exec('PRAGMA wal_checkpoint(TRUNCATE)');
process.stdout.write(JSON.stringify({ agent: 'aoc', asks }));
process.exit(0);
