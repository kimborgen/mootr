#!/usr/bin/env node
// Direct-db helper for test/e2e-mail-archive.sh: shapes a throwaway daemon's database in
// ways the HTTP API can't (a fixed message timestamp, a forced archive over a pending
// request, a mailbox with no running harness). Reads STAM_HOME from the environment.
import * as db from '../src/db.ts';

const [cmd, ...args] = process.argv.slice(2);
const d = db.open();

if (cmd === 'agent') {
  const [id, name] = args;
  db.createAgent({ id, name, role: 'mail-archive test helper', machine: 'test', harness: 'claude', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  d.prepare("UPDATE agents SET lifecycle = 'shut_down' WHERE id = ?").run(id);
} else if (cmd === 'set-time') {
  d.prepare('UPDATE mail SET created_at = ? WHERE id = ?').run(args[1], args[0]);
} else if (cmd === 'archive') {
  const [box, tid] = args;
  const ids = d.prepare('SELECT id FROM mail WHERE thread_id = ?').all(tid).map((r) => r.id);
  // archiveThread hides a thread by the ids it held at that moment.
  db.archiveThread(box, tid, ids);
} else if (cmd === 'mail-id') {
  const rows = d.prepare('SELECT id FROM mail WHERE thread_id = ? ORDER BY created_at, id').all(args[0]);
  console.log(rows[Number(args[1] ?? 0)].id);
} else {
  console.error('usage: mail-archive-helper.mjs agent|set-time|archive|mail-id ...');
  process.exit(2);
}
