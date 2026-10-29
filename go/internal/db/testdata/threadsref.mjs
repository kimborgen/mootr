// Builds a home with mail threads, copies its stam.db to stam.pre.db, then runs the thread list, archive, defer, kept-open,
// unread, decision and human-wait functions of src/db.ts and src/waits.ts on stam.db and writes what they returned to
// expect.json, for go/internal/db's threads test (S-3734). Never the live home.
//
//   node go/internal/db/testdata/threadsref.mjs DIR
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: threadsref.mjs DIR');
  process.exit(2);
}
const home = resolve(dir);
if (existsSync(`${home}/stam.db`)) {
  console.error(`threadsref: ${home} already has a stam.db`);
  process.exit(2);
}
process.env.STAM_HOME = home;
process.env.STAM_MACHINE = 'test-machine';
const config = await import('../../../../src/config.ts');
if (config.LIVE_HOME) {
  console.error('threadsref: refusing the live home');
  process.exit(2);
}
const db = await import('../../../../src/db.ts');
const waits = await import('../../../../src/waits.ts');

const base = { machine: 'test-machine', harness: 'claude', model: 'claude-haiku-5-5', effort: null, cwd: home, session_id: null };
db.createAgent({ ...base, id: 'aboss', name: 'boss', role: 'manager', parent_id: null });
db.createAgent({ ...base, id: 'aw1', name: 'worker-one', role: 'developer', parent_id: 'aboss' });
db.createAgent({ ...base, id: 'aw2', name: 'worker-two', role: 'developer', parent_id: 'aboss' });

const d = db.open();
// Mail with fixed times, so the order of threads and mails is the same on both sides.
let n = 0;
const send = (id, from, subject, body, thread, to, extra = {}) => {
  db.createMail({ id, from_id: from, from_name: null, subject, body, thread_id: thread, reply_to: null, ...extra }, to);
  d.prepare('UPDATE mail SET created_at = ? WHERE id = ?').run(`2026-10-01T00:00:${String(10 + n++).padStart(2, '0')}.000Z`, id);
};
send('m0000001', 'human', 'Plan', 'Start.', 'm0000001', ['aboss']);
send('m0000002', 'aboss', 'Re: Plan', 'Pick one:\n```decision\nA or B?\n- A\n- B\n```', 'm0000001', ['human', 'aw1']);
send('m0000003', 'aw1', 'Re: Plan', 'Between us.', 'm0000001', ['aboss']);
send('m0000004', 'aboss', 'Task', 'Do it.', 'm0000004', ['aw1']);
send('m0000005', 'aw2', 'Other', 'Hello.', 'm0000005', ['aboss', 'aw2']);
send('m0000006', 'aboss', 'Ask', 'Go ahead with p1?', 'm0000006', ['human']);
send('m0000007', 'aw1', 'Result', 'Done.', 'm0000007', ['human']);
d.prepare("UPDATE mail_recipients SET read_at = '2026-10-01T01:00:00.000Z' WHERE agent_id IN ('human', 'aw1')").run();
d.prepare("INSERT INTO decision_mails (mail_id, thread_id) VALUES ('m0000002', 'm0000001'), ('m0000006', 'm0000006')").run();
d.prepare("INSERT INTO thread_deferred (thread_id, mail_id) VALUES ('m0000001', 'm0000001')").run();
// m0000006 names p1, a request still pending with the human: the request is its row, not the decision.
d.prepare(`INSERT INTO permission_requests (id, agent_id, action, reason, details, audience, status, created_at)
  VALUES ('p1', 'aboss', 'push', 'needed', '', 'human', 'pending', '2026-10-01T00:00:00.000Z')`).run();
d.prepare(`INSERT INTO waits (id, agent_id, kind, target, detail, since, source, data) VALUES
  ('w1', 'aw1', 'human', NULL, 'my result', '2026-10-01T00:00:00.000Z', 'declared', '{"on":"human","thread":"m0000007"}'),
  ('w2', 'aboss', 'human', 'p1', 'your approval', '2026-10-01T00:00:00.000Z', 'stam', NULL),
  ('w3', 'aw2', 'human', NULL, 'other', '2026-10-01T00:00:00.000Z', 'declared', '{"on":"human","thread":"mnothere"}'),
  ('w4', 'aw2', 'agent', 'aboss', 'reply', '2026-10-01T00:00:00.000Z', 'declared', NULL)`).run();
d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
copyFileSync(`${home}/stam.db`, `${home}/stam.pre.db`);

const ids = (ts) => ts.map((t) => t.thread_id);
const split = (box, keep) => {
  const { active, archived } = db.splitArchived(box, db.threads(box, 50), new Set(keep));
  const { rest, deferred } = db.splitDeferred(box, active);
  return { active: ids(rest), archived: ids(archived), deferred: ids(deferred) };
};
const tables = () => ({
  archive: d.prepare('SELECT mailbox_id, thread_id FROM thread_archive ORDER BY mailbox_id, thread_id').all(),
  archiveMail: d.prepare('SELECT mailbox_id, thread_id, mail_id FROM thread_archive_mail ORDER BY mailbox_id, thread_id, mail_id').all(),
  defer: d.prepare('SELECT mailbox_id, thread_id FROM thread_defer ORDER BY mailbox_id, thread_id').all(),
  deferMail: d.prepare('SELECT mailbox_id, thread_id, mail_id FROM thread_defer_mail ORDER BY mailbox_id, thread_id, mail_id').all(),
  keptOpen: d.prepare('SELECT mailbox_id, thread_id, mail_ids FROM thread_kept_open ORDER BY mailbox_id, thread_id').all(),
});

const out = {};
out.threadsBoss = db.threads('aboss', 10);
out.threadsHumanWith = ids(db.threads('human', 10, 'aw1'));
out.threadsLimit = ids(db.threads('aboss', 1));
out.threadsNobody = db.threads('human', 10, 'nobody');
out.splitBefore = split('human', []);
db.archiveThread('human', 'm0000007', ['m0000007']);
db.archiveThread('human', 'm0000001', ['m0000001', 'm0000002']);
db.deferThread('aw1', 'm0000004', ['m0000004']);
out.counts = [db.archivedCount('human'), db.deferredCount('aw1'), db.archivedCount('aw1')];
// m0000001 has m0000003 beyond the archive's set, but between others: still archived; a keep holds it in the list.
out.splitHuman = split('human', []);
out.splitHumanKeep = split('human', ['m0000001']);
out.splitAw1 = split('aw1', []);
// A system notice doesn't bring the deferred thread back; the boss's mail does.
send('m0000008', 'system:deploy-watch', 'Deployed', 'A notice', 'm0000004', ['aw1'], { notice: true });
out.splitAw1Notice = split('aw1', []);
send('m0000009', 'aboss', 'Re: Task', 'More.', 'm0000004', ['aw1']);
out.splitAw1Mail = split('aw1', []);
// Deferring an archived thread unarchives it; archiving a deferred one undefers it.
db.deferThread('human', 'm0000007', ['m0000007']);
db.archiveThread('aw1', 'm0000004', ['m0000004', 'm0000008', 'm0000009']);
out.tablesMid = tables();
db.undeferThread('human', 'm0000007');
db.unarchiveThread('human', 'm0000001');
db.keepOpen('human', 'm0000001', ['m0000002', 'm0000001', 'm0000002']);
out.kept = [db.keptOpen('human', 'm0000001', ['m0000002']), db.keptOpen('human', 'm0000001', ['m0000002', 'm0000009']), db.keptOpen('human', 'm0000007', [])];
db.markAutoArchived('human', 'm0000007');
db.markAutoArchived('human', 'm0000001');
db.forgetAutoArchived('human', 'm0000001');
out.auto = db.autoArchivedThreads('human');
out.unread = [db.markUnread('human', ['m0000002', 'm0000007', 'm0000003', 'nosuch']), db.markUnread('human', ['m0000002']), db.markUnread('human', [])];
out.decisions = db.decisionMails();
out.decisionOpen = [db.decisionMailOpen('m0000002'), db.decisionMailOpen('m0000007')];
db.removeDecisionMail('m0000002');
out.decisionsAfter = db.decisionMails();
out.threadDeferred = [db.isThreadDeferred('m0000001'), db.isThreadDeferred('m0000004')];
out.recipients = db.mailRecipientIds('m0000005');
out.humanWaits = waits.openHumanWaits();
out.tables = tables();
out.readState = d.prepare("SELECT mail_id, agent_id, read_at FROM mail_recipients WHERE agent_id = 'human' ORDER BY mail_id").all();
writeFileSync(`${home}/expect.json`, JSON.stringify(out));
