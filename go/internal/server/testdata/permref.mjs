// Builds a home with three agents, copies its stam.db to stam.pre.db, then runs each case of permref-cases.json through
// src/permissions.ts refusalFor and writes the refusal of each (or "" when the ask is accepted) to expect.json, for
// go/internal/server's refusal parity test (S-3253). Never the live home.
//
//   node go/internal/server/testdata/permref.mjs DIR
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: permref.mjs DIR');
  process.exit(2);
}
const home = resolve(dir);
if (existsSync(`${home}/stam.db`)) {
  console.error(`permref: ${home} already has a stam.db`);
  process.exit(2);
}
process.env.STAM_HOME = home;
process.env.STAM_MACHINE = 'test-machine';
delete process.env.OPENROUTER_API_KEY;
const config = await import('../../../../src/config.ts');
if (config.LIVE_HOME) {
  console.error('permref: refusing the live home');
  process.exit(2);
}
const db = await import('../../../../src/db.ts');
const permissions = await import('../../../../src/permissions.ts');

const base = { machine: 'test-machine', harness: 'claude', model: 'claude-opus-5-5', effort: null, cwd: home, session_id: null };
db.createAgent({ ...base, id: 'aboss', name: 'boss', role: 'manager', parent_id: null });
db.createAgent({ ...base, id: 'achild', name: 'worker', role: 'developer', parent_id: 'aboss' });
db.createAgent({ ...base, id: 'aorphan', name: 'loner', role: 'developer', parent_id: null });
writeFileSync(`${home}/settings.json`, '{}');
const d = db.open();
d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
copyFileSync(`${home}/stam.db`, `${home}/stam.pre.db`);

const cases = JSON.parse(readFileSync(new URL('./permref-cases.json', import.meta.url), 'utf8'));
const results = [];
for (const c of cases) {
  if (c.sql) {
    d.exec(c.sql);
    continue;
  }
  const refused = permissions.refusalFor(db.getAgent(c.agent), c.action, c.reason, c.audience);
  results.push({ name: c.name, refused: refused ?? '' });
}
writeFileSync(`${home}/expect.json`, JSON.stringify(results));
