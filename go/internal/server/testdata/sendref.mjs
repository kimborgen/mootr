// Builds a home with three agents, copies its stam.db to stam.pre.db, then runs the steps of send-steps.json through
// src/mail.ts sendMail and writes what each returned, and the tables left behind, to expect.json, for go/internal/server's
// send test (S-2824). Never the live home.
//
//   node go/internal/server/testdata/sendref.mjs DIR
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: sendref.mjs DIR');
  process.exit(2);
}
const home = resolve(dir);
if (existsSync(`${home}/stam.db`)) {
  console.error(`sendref: ${home} already has a stam.db`);
  process.exit(2);
}
process.env.STAM_HOME = home;
process.env.STAM_MACHINE = 'test-machine';
// No key: the mail gate does not run, whatever the machine running this has set.
delete process.env.OPENROUTER_API_KEY;
const config = await import('../../../../src/config.ts');
if (config.LIVE_HOME) {
  console.error('sendref: refusing the live home');
  process.exit(2);
}
const db = await import('../../../../src/db.ts');
const mail = await import('../../../../src/mail.ts');

const base = { machine: 'test-machine', harness: 'claude', model: 'claude-opus-5-5', effort: null, cwd: home, session_id: null };
db.createAgent({ ...base, id: 'aboss', name: 'boss', role: 'manager', parent_id: null });
db.createAgent({ ...base, id: 'aw1', name: 'worker-one', role: 'developer', parent_id: 'aboss' });
db.createAgent({ ...base, id: 'aw2', name: 'worker-two', role: 'developer', parent_id: 'aboss' });
db.createAgent({ ...base, id: 'ahaiku', name: 'haiku', role: 'developer', parent_id: 'aboss', model: 'claude-haiku-5-5' });
db.createAgent({ ...base, id: 'astop', name: 'stopped', role: 'developer', parent_id: 'aboss' });
db.createAgent({ ...base, id: 'alim', name: 'limited', role: 'developer', parent_id: 'aboss' });
db.updateAgent('astop', { lifecycle: 'shut_down' });
db.updateAgent('alim', { visibility: JSON.stringify({ reach: 'parent', siblings: false, registry: true }) });
// aboss waits for a reply from aw1; aw1's mail to aboss clears it.
db.updateAgent('aboss', { activity: 'waiting', activity_detail: 'waiting for worker-one\'s reply' });
db.addWait({ agent_id: 'aboss', kind: 'agent', target: 'aw1', source: 'declared' });
const d = db.open();
d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
copyFileSync(`${home}/stam.db`, `${home}/stam.pre.db`);

const steps = JSON.parse(readFileSync(new URL('./send-steps.json', import.meta.url), 'utf8'));
const ids = [];
const sub = (v) => (typeof v === 'string' ? v.replace(/^#(\d+)$/, (_, n) => ids[Number(n)] ?? v) : Array.isArray(v) ? v.map(sub) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)])) : v);
const results = [];
for (const [i, step] of steps.entries()) {
  await new Promise((r) => setTimeout(r, 3));
  if (step.do === 'read') {
    const got = db.readMail(step.agent, sub(step.ids));
    results.push({ step: i, read: got.map((m) => m.id) });
    ids.push(null);
    continue;
  }
  try {
    const out = await mail.sendMail(sub(step.input));
    ids.push(out.id);
    results.push({ step: i, status: 200, result: out });
  } catch (e) {
    ids.push(null);
    results.push({ step: i, status: e instanceof mail.RefusedError ? 400 : 500, error: e.message });
  }
}
const tables = {
  mail: d.prepare('SELECT id, from_id, from_name, subject, body, created_at, thread_id, reply_to, permission_id, auto_threaded, notice, itsa_id, kind, health, about_itsa, verdict, override, note FROM mail ORDER BY rowid').all(),
  recipients: d.prepare('SELECT mail_id, agent_id, read_at, quiet FROM mail_recipients ORDER BY rowid').all(),
  events: d.prepare('SELECT agent_id, type, data FROM events ORDER BY id').all(),
  waits: d.prepare('SELECT agent_id, kind, target, source FROM waits ORDER BY rowid').all(),
  agents: d.prepare('SELECT id, activity, activity_detail FROM agents ORDER BY id').all(),
  decisions: d.prepare('SELECT mail_id, thread_id FROM decision_mails ORDER BY rowid').all(),
  deferred: d.prepare('SELECT thread_id, mail_id FROM thread_deferred ORDER BY rowid').all(),
  deferMail: d.prepare('SELECT mailbox_id, thread_id, mail_id FROM thread_defer_mail ORDER BY rowid').all(),
};
writeFileSync(`${home}/expect.json`, JSON.stringify({ results, tables }));
process.exit(0);
