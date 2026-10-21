// Builds stam.db in DIR the way the TS daemon leaves it (src/db.ts open()), with agents that carry every extra GET
// /api/agents reads: a parent and a standing child with a model, an effort and a last message, an extra parent, unread
// and deferred mail, spend, a pending human permission request, and a default view. For go/internal/server's tests and
// go/contract.sh (S-2614). Never the live home, and never over a stam.db: DIR may hold test/lib.sh's home files only.
//
//   node go/internal/server/testdata/seed.mjs DIR
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: seed.mjs DIR');
  process.exit(2);
}
const home = resolve(dir);
if (existsSync(`${home}/stam.db`)) {
  console.error(`seed: ${home} already has a stam.db`);
  process.exit(2);
}
process.env.STAM_HOME = home;
process.env.STAM_MACHINE = 'test-machine';
const config = await import('../../../../src/config.ts');
if (config.LIVE_HOME) {
  console.error('seed: refusing the live home');
  process.exit(2);
}
const db = await import('../../../../src/db.ts');

const base = { machine: 'test-machine', harness: 'claude', model: 'claude-haiku-5-5', effort: null, cwd: home, session_id: null };
db.createAgent({ ...base, id: 'aboss', name: 'boss', role: 'manager', parent_id: null });
db.createAgent({ ...base, id: 'achild', name: 'child', role: 'developer', effort: 'low', parent_id: 'aboss' });
db.createAgent({ ...base, id: 'acodex', name: 'coder', role: 'reviewer', harness: 'codex', model: null, parent_id: 'aboss', session_id: 'thread-1' });
db.createAgent({ ...base, id: 'agone', name: 'gone', role: 'developer', parent_id: 'aboss' });
db.updateAgent('aboss', { transcript_path: `${home}/boss.jsonl`, last_message: 'DONE' });
db.updateAgent('achild', { standing: 1, context_tokens: 4200, last_message: 'hello' });
db.updateAgent('agone', { lifecycle: 'archived', standing: 1 });
db.setTokenHash('achild', 'f'.repeat(64));
const d = db.open();
const now = new Date().toISOString();
d.prepare('INSERT INTO agent_parents (child_id, parent_id) VALUES (?, ?)').run('achild', 'acodex');
d.prepare('INSERT INTO mail (id, from_id, subject, body, created_at) VALUES (?, ?, ?, ?, ?)').run('m1', 'aboss', 's', 'b', now);
d.prepare('INSERT INTO mail (id, from_id, subject, body, created_at) VALUES (?, ?, ?, ?, ?)').run('m2', 'aboss', 's', 'b', now);
d.prepare('INSERT INTO mail (id, from_id, subject, body, created_at) VALUES (?, ?, ?, ?, ?)').run('m3', 'aboss', 's', 'b', now);
for (const m of ['m1', 'm2', 'm3']) d.prepare('INSERT INTO mail_recipients (mail_id, agent_id) VALUES (?, ?)').run(m, 'achild');
d.prepare('UPDATE mail_recipients SET read_at = ? WHERE mail_id = ?').run(now, 'm3');
d.prepare('INSERT INTO thread_defer_mail (mailbox_id, thread_id, mail_id) VALUES (?, ?, ?)').run('achild', 'm2', 'm2');
d.prepare("INSERT INTO usage (agent_id, day, harness, account, cost_usd) VALUES (?, ?, 'claude', ?, ?)").run('achild', now.slice(0, 10), '', 1.25);
d.prepare("INSERT INTO usage (agent_id, day, harness, account, cost_usd) VALUES (?, ?, 'claude', ?, ?)").run('achild', now.slice(0, 10), 'work', 0.5);
d.prepare("INSERT INTO permission_requests (id, agent_id, action, reason, details, status, audience, created_at) VALUES (?, ?, 'a', 'r', 'd', 'pending', ?, ?)").run('p1', 'achild', 'human', now);
d.prepare("INSERT INTO permission_requests (id, agent_id, action, reason, details, status, audience, created_at) VALUES (?, ?, 'a', 'r', 'd', 'pending', ?, ?)").run('p2', 'achild', 'delegate', now);
d.prepare("INSERT INTO permission_requests (id, agent_id, action, reason, details, status, audience, created_at) VALUES (?, ?, 'a', 'r', 'd', 'approved', ?, ?)").run('p3', 'achild', 'human', now);
d.prepare('INSERT INTO agent_views (agent_id, view, updated_at) VALUES (?, ?, ?)').run('aboss', 'terminal', now);
d.close();
