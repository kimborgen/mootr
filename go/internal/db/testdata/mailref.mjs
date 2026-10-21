// Builds a home with mail, copies its stam.db to stam.pre.db, then runs the mail reads of src/db.ts on stam.db and writes
// what they returned to expect.json, for go/internal/db's mail test (S-2824). Never the live home.
//
//   node go/internal/db/testdata/mailref.mjs DIR
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: mailref.mjs DIR');
  process.exit(2);
}
const home = resolve(dir);
if (existsSync(`${home}/stam.db`)) {
  console.error(`mailref: ${home} already has a stam.db`);
  process.exit(2);
}
process.env.STAM_HOME = home;
process.env.STAM_MACHINE = 'test-machine';
const config = await import('../../../../src/config.ts');
if (config.LIVE_HOME) {
  console.error('mailref: refusing the live home');
  process.exit(2);
}
const db = await import('../../../../src/db.ts');

const base = { machine: 'test-machine', harness: 'claude', model: 'claude-haiku-5-5', effort: null, cwd: home, session_id: null };
db.createAgent({ ...base, id: 'aboss', name: 'boss', role: 'manager', parent_id: null });
db.createAgent({ ...base, id: 'aw1', name: 'worker-one', role: 'developer', parent_id: 'aboss' });
db.createAgent({ ...base, id: 'aw2', name: 'worker-two', role: 'developer', parent_id: 'aboss' });

const send = (id, from, fromName, subject, body, thread, replyTo, to, extra = {}) => {
  db.createMail({ id, from_id: from, from_name: fromName, subject, body, thread_id: thread, reply_to: replyTo, ...extra }, to);
};
send('m0000001', 'aboss', 'boss', 'Plan', 'Start the task.\n\nNo action needed', 'm0000001', null, ['aw1', 'aw2']);
send('m0000002', 'aw1', 'worker-one', 'Re: Plan', 'On it é <&>', 'm0000001', 'm0000001', ['aboss']);
send('m0000003', 'human', null, 'Question', 'Is it done?', 'm0000003', null, ['aboss']);
send('m0000004', 'aboss', 'boss', 'Re: Question', 'Yes.', 'm0000003', 'm0000003', ['human', 'aw1']);
send('m0000005', 'aboss', null, 'Second', 'Another one', 'm0000005', null, ['aw1']);
send('m0000006', 'system:deploy-watch', 'deploy-watch', 'Deployed', 'A notice', 'm0000006', null, ['aw1'], { notice: true });
send('m0000007', 'aw2', 'worker-two', 'Third', 'x'.repeat(50), 'm0000007', null, ['aw1', 'aboss'], { verdict: { follows: true, score: 3 } });
const d = db.open();
d.prepare("UPDATE mail_recipients SET read_at = '2026-10-01T00:00:00.000Z' WHERE mail_id = 'm0000002' AND agent_id = 'aboss'").run();
d.prepare("INSERT INTO attachments (mail_id, name, path, size) VALUES ('m0000005', 'a.txt', '/x/a.txt', 12)").run();
d.prepare("INSERT INTO mail_agents (mail_id, agent_id, added_by) VALUES ('m0000005', 'aw2', 'aboss')").run();
d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
copyFileSync(`${home}/stam.db`, `${home}/stam.pre.db`);

const out = {};
out.inboxUnread = db.inbox('aw1', true, 20);
out.inboxAll2 = db.inbox('aw1', false, 2);
out.inboxHuman = db.inbox('human', true, 10);
out.thread1 = db.threadMail('m0000001');
out.thread1Box = db.threadMail('m0000001', 'aw2');
out.defaultBefore = db.defaultRead('aw1');
out.read1 = db.readMail('aw1', ['m0000001', 'm0000005', 'nosuch'], 'batch-1');
out.defaultOwed = db.defaultRead('aw1');
db.ackDelivered('aw1', 'batch-1');
out.defaultAfterAck = db.defaultRead('aw1');
out.inboxAfter = db.inbox('aw1', true, 20);
out.unread = db.unreadCount('aw1');
out.readNoBatch = db.readMail('aboss', ['m0000002', 'm0000003']);
out.deliveries = d.prepare('SELECT agent_id, mail_id, batch FROM mail_deliveries ORDER BY agent_id, mail_id, batch').all();
out.recipients = d.prepare('SELECT mail_id, agent_id, read_at FROM mail_recipients ORDER BY mail_id, agent_id').all();
writeFileSync(`${home}/expect.json`, JSON.stringify(out));
