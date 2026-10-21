// Builds a home with agents, copies its stam.db to stam.pre.db, then runs the steps of post-steps.json through
// src/itsa.ts (create, post) and src/mail.ts (sendMail) and writes what each returned, and the tables left behind, to
// expect.json, for go/internal/server's ITSA post test (S-2849, PR 3b). Never the live home.
//
//   node go/internal/server/testdata/postref.mjs DIR
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: postref.mjs DIR');
  process.exit(2);
}
const home = resolve(dir);
if (existsSync(`${home}/stam.db`)) {
  console.error(`postref: ${home} already has a stam.db`);
  process.exit(2);
}
process.env.STAM_HOME = home;
process.env.STAM_MACHINE = 'test-machine';
// No key: the mail gate does not run, whatever the machine running this has set.
delete process.env.OPENROUTER_API_KEY;
const config = await import('../../../../src/config.ts');
if (config.LIVE_HOME) {
  console.error('postref: refusing the live home');
  process.exit(2);
}
const db = await import('../../../../src/db.ts');
const itsa = await import('../../../../src/itsa.ts');
const mail = await import('../../../../src/mail.ts');

const base = { machine: 'test-machine', harness: 'claude', model: 'claude-opus-5-5', effort: null, cwd: home, session_id: null };
db.createAgent({ ...base, id: 'aboss', name: 'boss', role: 'manager', parent_id: null });
db.createAgent({ ...base, id: 'aw1', name: 'worker-one', role: 'developer', parent_id: 'aboss' });
db.createAgent({ ...base, id: 'aw2', name: 'worker-two', role: 'developer', parent_id: 'aboss' });
db.createAgent({ ...base, id: 'ahaiku', name: 'haiku', role: 'developer', parent_id: 'aboss', model: 'claude-haiku-5-5' });
db.createAgent({ ...base, id: 'aarch', name: 'gone-one', role: 'developer', parent_id: 'aboss' });
writeFileSync(`${home}/settings.json`, JSON.stringify({ itsa: { ownerNotices: 'off' } }));
const d = db.open();
d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
copyFileSync(`${home}/stam.db`, `${home}/stam.pre.db`);

const steps = JSON.parse(readFileSync(new URL('./post-steps.json', import.meta.url), 'utf8'));
const ids = [];
const sub = (v) => (typeof v === 'string' ? v.replace(/^#(\d+)$/, (_, n) => ids[Number(n)] ?? v) : Array.isArray(v) ? v.map(sub) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)])) : v);
// src/daemon.ts itsaRoute: a missing ITSA is 404, a status that moved 409, the rest 400.
const statusOf = (msg) => (/^no ITSA |^no link |^no field /.test(msg) ? 404 : /^status changed/.test(msg) ? 409 : 400);
const results = [];
for (const [i, step] of steps.entries()) {
  await new Promise((r) => setTimeout(r, 3));
  try {
    let out;
    if (step.op === 'sql') {
      d.exec(step.sql);
      out = {};
    } else if (step.op === 'create') out = await itsa.create({ ...sub(step.input) });
    else if (step.op === 'post') out = await itsa.post(sub(step.ref), { ...sub(step.input), by: step.by ?? 'human' });
    else if (step.op === 'mail') {
      try {
        out = await mail.sendMail(sub(step.input));
      } catch (e) {
        ids.push(null);
        results.push({ step: i, status: e instanceof mail.RefusedError ? 400 : 500, error: e.message });
        continue;
      }
    } else throw new Error(`bad op ${step.op}`);
    ids.push(step.op === 'create' || step.op === 'post' || step.op === 'mail' ? out.id : null);
    results.push({ step: i, status: 200, result: out });
  } catch (e) {
    ids.push(null);
    results.push({ step: i, status: statusOf(e.message), error: e.message });
  }
}
const tables = {
  mail: d.prepare('SELECT id, from_id, from_name, subject, body, created_at, thread_id, reply_to, permission_id, auto_threaded, notice, itsa_id, kind, health, about_itsa, verdict, override, note FROM mail ORDER BY rowid').all(),
  recipients: d.prepare('SELECT mail_id, agent_id, read_at, quiet FROM mail_recipients ORDER BY rowid').all(),
  mailItsas: d.prepare('SELECT mail_id, itsa_id, source FROM mail_itsas ORDER BY rowid').all(),
  itsas: d.prepare('SELECT id, key, title, owner, thread_id FROM itsas ORDER BY rowid').all(),
  participants: d.prepare('SELECT itsa_id, agent_id FROM itsa_participants ORDER BY rowid').all(),
  events: d.prepare('SELECT agent_id, type, data FROM events ORDER BY id').all(),
  decisions: d.prepare('SELECT mail_id, thread_id FROM decision_mails ORDER BY rowid').all(),
  deferred: d.prepare('SELECT thread_id, mail_id FROM thread_deferred ORDER BY rowid').all(),
};
writeFileSync(`${home}/expect.json`, JSON.stringify({ results, tables }));
process.exit(0);
