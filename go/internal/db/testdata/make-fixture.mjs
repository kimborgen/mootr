// Builds stam.db in DIR the way the TS daemon leaves it (src/db.ts open(): every table, column and pragma), with a
// few agents and events, for go/internal/db's tests (S-2613). Never the live home: DIR must be a new, empty folder.
//
//   node go/internal/db/testdata/make-fixture.mjs DIR
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: make-fixture.mjs DIR');
  process.exit(2);
}
const home = resolve(dir);
if (readdirSync(home).length) {
  console.error(`make-fixture: ${home} is not empty`);
  process.exit(2);
}
process.env.STAM_HOME = home;
process.env.STAM_MACHINE = 'test-machine';
const config = await import('../../../../src/config.ts');
if (config.LIVE_HOME) {
  console.error('make-fixture: refusing the live home');
  process.exit(2);
}
const db = await import('../../../../src/db.ts');

const base = { role: 'developer', machine: 'test-machine', harness: 'claude', model: 'claude-haiku-5-5', effort: null, cwd: home, session_id: null };
db.createAgent({ ...base, id: 'aboss', name: 'boss', role: 'manager', parent_id: null });
db.createAgent({ ...base, id: 'achild', name: 'child', parent_id: 'aboss' });
db.createAgent({ ...base, id: 'agone', name: 'gone', parent_id: 'aboss' });
db.updateAgent('achild', {
  workspace: JSON.stringify({ spec: { kind: 'worktree', repo: '/repo', branch: 'b', base: 'origin/main' }, cwd: '/repo-wt', worktree: { repo: '/repo', path: '/repo-wt', branch: 'b' }, baseUsed: { ref: 'origin/main', sha: 'abc', fetch: 'ok' } }),
  visibility: JSON.stringify({ reach: 'tree', siblings: false }),
  pending_action: JSON.stringify({ type: 'compact', reason: 'context', instructions: 'keep it short' }),
  capabilities: JSON.stringify({ mcp: true, effort: ['low', 'high'] }),
  paused_by: JSON.stringify(['human', 'aboss']),
  usage_last: JSON.stringify({ cost_usd: 1.5, tokens: 1200 }),
  lifecycle: 'paused',
  context_tokens: 4200,
  standing: 1,
});
db.setTokenHash('achild', 'f'.repeat(64));
db.updateAgent('agone', { lifecycle: 'archived', activity: 'unknown' });
db.addEvent('achild', 'spawn', { prompt: 'hello' });
db.addEvent('achild', 'hook:Stop');
db.addEvent('achild', 'input:screen', { text: 'x' });
db.addEvent('aboss', 'spawn');
db.open().close();
