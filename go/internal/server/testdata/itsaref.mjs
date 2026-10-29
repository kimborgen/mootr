// Builds a home with six agents, copies its stam.db to stam.pre.db, then runs the steps of itsa-steps.json through
// src/itsa.ts (create, set, get, list, links, fields) and writes what each returned, and the tables left behind, to expect.json, for
// go/internal/server's ITSA test (S-2849). Never the live home.
//
//   node go/internal/server/testdata/itsaref.mjs DIR
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: itsaref.mjs DIR');
  process.exit(2);
}
const home = resolve(dir);
if (existsSync(`${home}/stam.db`)) {
  console.error(`itsaref: ${home} already has a stam.db`);
  process.exit(2);
}
process.env.STAM_HOME = home;
process.env.STAM_MACHINE = 'test-machine';
const config = await import('../../../../src/config.ts');
if (config.LIVE_HOME) {
  console.error('itsaref: refusing the live home');
  process.exit(2);
}
const db = await import('../../../../src/db.ts');
const itsa = await import('../../../../src/itsa.ts');
const human = await import('../../../../src/itsa-human.ts');
const asks = await import('../../../../src/asks.ts');

const base = { machine: 'test-machine', harness: 'claude', model: 'claude-opus-5-5', effort: null, cwd: home, session_id: null };
db.createAgent({ ...base, id: 'aboss', name: 'boss', role: 'manager', parent_id: null });
db.createAgent({ ...base, id: 'aw1', name: 'worker-one', role: 'developer', parent_id: 'aboss' });
db.createAgent({ ...base, id: 'aw2', name: 'worker-two', role: 'developer', parent_id: 'aboss' });
db.createAgent({ ...base, id: 'ahaiku', name: 'haiku', role: 'developer', parent_id: 'aboss', model: 'claude-haiku-5-5' });
// A repo for branch links, and a mail with an attachment for screenshots.
writeFileSync(`${home}/settings.json`, JSON.stringify({ itsa: { repos: { r1: "/tmp" }, ownerNotices: "off" } }));
const d = db.open();
d.prepare("INSERT INTO mail (id, from_id, from_name, subject, body, created_at, thread_id) VALUES ('mshot', 'aboss', 'boss', 's', 'b', '2026-10-01T00:00:00.000Z', 'mshot')").run();
d.prepare("INSERT INTO attachments (mail_id, name, path, size) VALUES ('mshot', 'shot.png', '/tmp/shot.png', 3)").run();
d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
copyFileSync(`${home}/stam.db`, `${home}/stam.pre.db`);

const steps = JSON.parse(readFileSync(new URL('./itsa-steps.json', import.meta.url), 'utf8'));
const ids = [];
const sub = (v) => (typeof v === 'string' ? v.replace(/^#(\d+)$/, (_, n) => ids[Number(n)] ?? v) : Array.isArray(v) ? v.map(sub) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)])) : v);
// src/daemon.ts itsaRoute: a missing ITSA, link or field is 404, a status that moved 409, the rest 400.
const statusOf = (msg) => (/^no ITSA |^no link |^no field /.test(msg) ? 404 : /^status changed|^the text changed/.test(msg) ? 409 : 400);
const results = [];
for (const [i, step] of steps.entries()) {
  await new Promise((r) => setTimeout(r, 3));
  try {
    let out;
    if (step.op === 'create') out = await itsa.create({ ...sub(step.input) });
    else if (step.op === 'set') out = await itsa.set(sub(step.ref), sub(step.fields), step.by ?? 'human');
    else if (step.op === 'link') out = await itsa.addLink(sub(step.ref), sub(step.link), step.by ?? 'human');
    else if (step.op === 'unlink') out = await itsa.removeLink(sub(step.ref), step.n, step.by ?? 'human');
    else if (step.op === 'record') out = await itsa.recordLink(sub(step.ref), step.n, sub(step.rec), step.by ?? 'human');
    else if (step.op === 'fields') out = itsa.fields();
    else if (step.op === 'deffield') out = await itsa.createField(sub(step.input), step.by ?? 'human');
    else if (step.op === 'editfield') out = await itsa.updateField(step.ref, step.patch, step.by ?? 'human');
    else if (step.op === 'rmfield') out = await itsa.removeField(step.ref, step.by ?? 'human');
    else if (step.op === 'order') out = await itsa.reorderFields(step.order, step.by ?? 'human');
    else if (step.op === 'get') {
      // The daemon's GET /api/itsas/:ref (src/daemon.ts itsaWithAsk) adds the open ask the ITSA holds (S-4021).
      const v = itsa.get(sub(step.ref));
      out = { ...v, open_ask_detail: asks.askDetail(asks.openAskLinks('test-machine', human.waitingIds()).itsas.get(v.id)) };
    }
    else if (step.op === 'sql') out = { ran: d.prepare(step.sql).run().changes };
    else out = await itsa.list(sub(step.query));
    ids.push(step.op === 'create' ? out.id : null);
    results.push({ step: i, status: 200, result: out });
  } catch (e) {
    ids.push(null);
    results.push({ step: i, status: statusOf(e.message), error: e.message });
  }
}
const tables = {
  itsas: d.prepare('SELECT * FROM itsas ORDER BY rowid').all(),
  links: d.prepare('SELECT * FROM itsa_links ORDER BY rowid').all(),
  participants: d.prepare('SELECT itsa_id, agent_id, left_at FROM itsa_participants ORDER BY rowid').all(),
  events: d.prepare('SELECT itsa_id, actor, type, data FROM itsa_events ORDER BY id').all(),
  counter: d.prepare('SELECT name, value FROM itsa_counter').all(),
  fields: d.prepare('SELECT * FROM itsa_fields ORDER BY position, created_at').all(),
  values: d.prepare('SELECT itsa_id, field_id, value, updated_by FROM itsa_field_values ORDER BY rowid').all(),
};
writeFileSync(`${home}/expect.json`, JSON.stringify({ results, tables }));
process.exit(0);
