// Builds a home with agents, copies its stam.db to stam.pre.db, then runs the ops of steps-steps.json through src/steps.ts
// the way src/daemon.ts routes them (a missing step is 404, any other throw 400), and writes what each returned to
// expect.json, for go/internal/server's steps test (S-2952, PR 1). The decision model is the stub at STAM_OPENROUTER_URL.
// Never the live home.
//
//   node go/internal/server/testdata/stepsref.mjs DIR
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: stepsref.mjs DIR');
  process.exit(2);
}
const home = resolve(dir);
if (existsSync(`${home}/stam.db`)) {
  console.error(`stepsref: ${home} already has a stam.db`);
  process.exit(2);
}
process.env.STAM_HOME = home;
process.env.STAM_MACHINE = 'test-machine';
process.env.STAM_EMBEDDER = 'stub';
const config = await import('../../../../src/config.ts');
if (config.LIVE_HOME) {
  console.error('stepsref: refusing the live home');
  process.exit(2);
}
const db = await import('../../../../src/db.ts');
const steps = await import('../../../../src/steps.ts');

const base = { machine: 'test-machine', harness: 'claude', model: 'claude-opus-5-5', effort: null, cwd: home, session_id: null };
db.createAgent({ ...base, id: 'aboss', name: 'boss', role: 'manager', parent_id: null });
db.createAgent({ ...base, id: 'achild', name: 'child', role: 'developer', parent_id: 'aboss' });
const d = db.open();
d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
copyFileSync(`${home}/stam.db`, `${home}/stam.pre.db`);

const ops = JSON.parse(readFileSync(new URL('./steps-steps.json', import.meta.url), 'utf8'));
const ids = [];
const sub = (v) => (typeof v === 'string' ? v.replace(/^#(\d+)$/, (_, n) => ids[Number(n)] ?? v) : Array.isArray(v) ? v.map(sub) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)])) : v);
const results = [];
for (const [i, op] of ops.entries()) {
  await new Promise((r) => setTimeout(r, 3));
  let id = '';
  try {
    const ref = sub(op.ref ?? '');
    let out;
    if (op.op === 'list') out = { steps: steps.list(), events: steps.EVENTS };
    else if (op.op === 'create') {
      out = steps.create(sub(op.input ?? {}));
      id = out.id;
    } else if (op.op === 'get') out = steps.must(ref);
    else if (op.op === 'update') out = steps.update(ref, sub(op.input ?? {}));
    else if (op.op === 'remove') {
      steps.remove(ref);
      out = { removed: ref };
    } else if (op.op === 'preview') out = await steps.preview(ref, Number(op.n) || 5);
    else if (op.op === 'log') out = { decisions: steps.log(steps.must(ref).id, Number(op.limit) || 100) };
    else if (op.op === 'decisions') out = { decisions: steps.decisionsOn(String(sub(op.subject ?? '')), Number(op.limit) || 100) };
    else if (op.op === 'check') out = await steps.checkTool(op.agent, op.tool, op.args && typeof op.args === 'object' ? op.args : {});
    else throw new Error(`bad op ${op.op}`);
    results.push({ status: 200, result: out });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    results.push({ status: /^no step /.test(msg) ? 404 : 400, error: msg });
  }
  ids.push(id);
}
const tables = {};
for (const name of ['decision_steps', 'step_decisions', 'tool_calls']) tables[name] = d.prepare(`SELECT * FROM ${name} ORDER BY ${name === "decision_steps" ? "created_at" : "1"}`).all();
writeFileSync(`${home}/expect.json`, JSON.stringify({ results, tables, ids }));
process.exit(0);
