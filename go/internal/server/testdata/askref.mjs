// Builds a home with agents, copies its stam.db to stam.pre.db, then runs the steps of ask-steps.json through src/itsa.ts
// with the human's ask registered (src/itsa-human.ts watchHumanStatuses), and writes what each returned, and the tables
// left behind (the ask mail, its withdrawal, the archived thread), to expect.json, for go/internal/server's ask test
// (S-2849, PR 3d). Never the live home.
//
//   node go/internal/server/testdata/askref.mjs DIR
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: askref.mjs DIR');
  process.exit(2);
}
const home = resolve(dir);
if (existsSync(`${home}/stam.db`)) {
  console.error(`askref: ${home} already has a stam.db`);
  process.exit(2);
}
process.env.STAM_HOME = home;
process.env.STAM_MACHINE = 'test-machine';
delete process.env.OPENROUTER_API_KEY;
const config = await import('../../../../src/config.ts');
if (config.LIVE_HOME) {
  console.error('askref: refusing the live home');
  process.exit(2);
}
const db = await import('../../../../src/db.ts');
const itsa = await import('../../../../src/itsa.ts');
const human = await import('../../../../src/itsa-human.ts');
human.watchHumanStatuses();

const base = { machine: 'test-machine', harness: 'claude', model: 'claude-opus-5-5', effort: null, cwd: home, session_id: null };
db.createAgent({ ...base, id: 'aboss', name: 'boss', role: 'manager', parent_id: null });
db.createAgent({ ...base, id: 'aw1', name: 'worker-one', role: 'developer', parent_id: 'aboss' });
db.createAgent({ ...base, id: 'aw2', name: 'worker-two', role: 'developer', parent_id: 'aboss' });
const settings = { itsa: { ownerNotices: 'off' } };
writeFileSync(`${home}/settings.json`, JSON.stringify(settings));
const d = db.open();
d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
copyFileSync(`${home}/stam.db`, `${home}/stam.pre.db`);

const steps = JSON.parse(readFileSync(new URL('./ask-steps.json', import.meta.url), 'utf8'));
const ids = [];
const sub = (v) => (typeof v === 'string' ? v.replace(/^#(\d+)$/, (_, n) => ids[Number(n)] ?? v) : Array.isArray(v) ? v.map(sub) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)])) : v);
// src/daemon.ts itsaRoute: a missing ITSA is 404, a status that moved 409, the rest 400.
const statusOf = (msg) => (/^no ITSA |^no link |^no field /.test(msg) ? 404 : /^status changed|^the text changed/.test(msg) ? 409 : 400);
const results = [];
// When each step began: a thread's order within one step depends on the millisecond, so the test compares it per step.
const starts = [];
for (const [i, step] of steps.entries()) {
  await new Promise((r) => setTimeout(r, 3));
  starts.push(new Date().toISOString());
  try {
    let out;
    let id = null;
    const ref = sub(step.ref);
    if (step.op === 'sql') {
      d.exec(step.sql.replace(/'#(\d+)'/g, (_, n) => `'${ids[Number(n)]}'`));
      out = {};
    } else if (step.op === 'create') {
      out = await itsa.create({ ...sub(step.input) });
      id = out.id;
    } else if (step.op === 'set') {
      out = await itsa.set(ref, { ...sub(step.input) }, step.by ?? 'human');
      // The ask is written after the move, off its answer: let it land.
      await new Promise((r) => setTimeout(r, 25));
    }
    else if (step.op === 'post') out = await itsa.post(ref, { ...sub(step.input), by: step.by ?? 'human' });
    else if (step.op === 'act') out = await human.act(ref, String(step.input?.action ?? ''), String(step.input?.text ?? ''), typeof step.input?.if_rev === 'string' ? step.input.if_rev : undefined);
    else if (step.op === 'attention') out = human.attention();
    else if (step.op === 'thread') {
      const x = itsa.must(ref);
      const mails = x.thread_id ? db.threadMail(x.thread_id) : [];
      out = { itsa: { id: x.id, key: x.key, title: x.title, thread_id: x.thread_id }, items: itsa.mergeThread(mails, itsa.threadEvents(x.id)) };
    } else if (step.op === 'threads') {
      const x = itsa.must(ref);
      out = itsa.aboutThreads(db.foldThreads(db.aboutItsaThreads(x.id)), x.thread_id);
    } else throw new Error(`bad op ${step.op}`);
    ids.push(id);
    results.push({ step: i, status: 200, result: out });
  } catch (e) {
    ids.push(null);
    results.push({ step: i, status: statusOf(e.message), error: e.message });
  }
}
const tables = {
  mail: d.prepare("SELECT id, from_id, from_name, subject, body, thread_id, reply_to, itsa_id, kind, about_itsa, notice FROM mail ORDER BY rowid").all(),
  recipients: d.prepare('SELECT mail_id, agent_id, quiet, read_at IS NOT NULL AS read, withdrawn_at IS NOT NULL AS withdrawn, withdrawn_by, withdrawn_note FROM mail_recipients ORDER BY rowid').all(),
  itsas: d.prepare('SELECT id, key, title, owner, status, thread_id FROM itsas ORDER BY rowid').all(),
  participants: d.prepare('SELECT itsa_id, agent_id FROM itsa_participants ORDER BY rowid').all(),
  itsaEvents: d.prepare('SELECT itsa_id, actor, type, data FROM itsa_events ORDER BY id').all(),
  archive: d.prepare('SELECT mailbox_id, thread_id FROM thread_archive ORDER BY rowid').all(),
  archived: d.prepare('SELECT mailbox_id, thread_id, mail_id FROM thread_archive_mail ORDER BY rowid').all(),
  shownRevs: d.prepare('SELECT m.subject, s.itsa_id, s.rev, s.at, s.len FROM itsa_shown_revs s JOIN mail m ON m.id = s.mail_id ORDER BY m.rowid').all(),
};
writeFileSync(`${home}/expect.json`, JSON.stringify({ results, tables, starts }));
process.exit(0);
