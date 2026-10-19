#!/usr/bin/env node
// Seeds STAM_HOME (a throwaway home, set by test/e2e-agents-route.sh before its daemon starts) with 300 agents in
// chains of four, unread and read mail, waits that point at mail threads, and blockers, so one GET /api/agents
// has every per-agent read to do (S-344). Writes nothing else.
import * as db from '../src/db.ts';

const home = process.env.STAM_HOME;
if (!home || home.includes('/.local/share/stam')) {
  console.error('refusing: STAM_HOME must be a throwaway home');
  process.exit(1);
}
const N = 300;
for (let i = 0; i < N; i++) {
  db.createAgent({ id: `id-${i}`, name: `ag-${i}`, role: '', machine: process.env.STAM_MACHINE ?? 'test', harness: 'claude', model: null, effort: null, cwd: '', parent_id: i % 4 ? `id-${i - 1}` : null, session_id: null });
}
// Some links beyond the parent column, so the parent links are read from both places.
for (let i = 8; i < N; i += 8) db.open().prepare('INSERT INTO agent_parents (child_id, parent_id) VALUES (?, ?)').run(`id-${i}`, `id-${i - 2}`);
for (let i = 0; i < N; i++) {
  for (let m = 0; m < i % 4; m++) {
    const id = `mail-${i}-${m}`;
    db.createMail({ id, from_id: 'id-0', from_name: 'ag-0', subject: `s ${i} ${m}`, body: 'b', thread_id: `thread-${i}-${m}`, reply_to: null }, [`id-${i}`]);
  }
  if (i % 3 === 0) db.addWait({ agent_id: `id-${i}`, kind: 'event', source: 'test', detail: 'a thread', data: JSON.stringify({ thread: `mail-${i}-0` }) });
  if (i % 5 === 0) db.addWait({ agent_id: `id-${i}`, kind: 'timer', source: 'test', detail: 'a timer' });
  if (i % 7 === 0) db.open().prepare('INSERT INTO blockers (agent_id, kind, account, reason, since, clear) VALUES (?, ?, ?, ?, ?, ?)').run(`id-${i}`, 'usage', 'claude', 'test', new Date().toISOString(), null);
}
console.log(`seeded ${N} agents in ${home}`);
