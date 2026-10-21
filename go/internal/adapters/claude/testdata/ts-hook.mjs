// Runs Claude Code hook payloads through the TS daemon's own src/adapters/claude.ts onHook, for
// go/internal/adapters/claude's golden hook test (S-2820). DIR is a test home (never the live home). The cases come as
// JSON on stdin, [{agent: {lifecycle, activity, activity_detail}, payload}], one agent set to each state in turn, and it
// prints [{fields, afterTool, turnEnded, dialog}] in the same order: the agent fields src/daemon.ts onHook writes from the
// result.
//
//   node go/internal/adapters/claude/testdata/ts-hook.mjs DIR [waits] < cases.json
import { readFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';

const [dir] = process.argv.slice(2);
if (!dir) {
  console.error('usage: ts-hook.mjs DIR');
  process.exit(2);
}
process.env.STAM_HOME = resolve(dir);
process.env.STAM_MACHINE = 'test-machine';
process.env.STAM_EMBEDDER = 'stub';
delete process.env.STAM_RELEASE_ID;
const config = await import('../../../../../src/config.ts');
if (config.LIVE_HOME) {
  console.error('ts-hook: refusing the live home');
  process.exit(2);
}
const db = await import('../../../../../src/db.ts');
// Through the index, as the daemon loads it: claude.ts imported first meets an import cycle.
const { adapters } = await import('../../../../../src/adapters/index.ts');
const { claude } = adapters;

const id = 'ahook';
db.createAgent({ id, name: 'hooked', role: 'developer', machine: 'test-machine', harness: 'claude', model: null, effort: null, cwd: resolve(dir), parent_id: null, session_id: null });
const cases = JSON.parse(readFileSync(0, 'utf8'));
// `waits` mode (S-2848 B2a): each case is a payload for an active, working agent with no waits, and the result is the
// hook waits onHook left: [{kind, target, detail, until, data}], in the order they were added.
if (process.argv[3] === 'waits') {
  const out = cases.map((payload) => {
    for (const w of db.listWaits(id)) db.clearWait(w.id);
    db.updateAgent(id, { lifecycle: 'active', activity: 'working', activity_detail: null });
    claude.onHook(db.getAgent(id), payload);
    return db.open().prepare("SELECT kind, target, detail, until, data FROM waits WHERE agent_id = ? AND source = 'hook' ORDER BY rowid").all(id).map((w) => ({ ...w }));
  });
  writeSync(1, JSON.stringify(out));
  process.exit(0);
}
const out = cases.map((c) => {
  db.updateAgent(id, { lifecycle: c.agent.lifecycle, activity: c.agent.activity, activity_detail: c.agent.activity_detail });
  const r = claude.onHook(db.getAgent(id), c.payload);
  // As src/daemon.ts onHook turns the result into the agent's fields.
  const fields = {};
  if (r.activity) fields.activity = r.activity;
  if (r.detail !== undefined) fields.activity_detail = r.detail;
  if (r.session_id) fields.session_id = r.session_id;
  if (r.transcript_path) fields.transcript_path = r.transcript_path;
  if (r.last_message) fields.last_message = String(r.last_message).slice(0, 4000);
  return { fields, afterTool: !!r.afterTool, turnEnded: !!r.turnEnded, dialog: r.dialog ? { replaces: false, ...r.dialog } : null };
});
// Synchronous, so process.exit can't cut the result short on a pipe.
writeSync(1, JSON.stringify(out));
process.exit(0);
