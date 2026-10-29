#!/usr/bin/env node
// Restart test for answer notices (S-3923). An answer's notice is written in the same transaction as the answer, so a
// daemon restart before the agent is handed it delivers it. A handoff the hook's client acknowledged is never delivered
// again; a handoff whose response was lost (a timed-out client) is replayed after a restart. The answers are real: requests go through requestPermission and are answered with answerPermission
// (a permission) or expired by the production sweep (an input). Each "daemon start" is a child process
// (answer-notice-child.mjs) on the same home. Run with `node --test test/answer-notice-restart.test.mjs`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempHome } from './tmphome.mjs';

process.env.STAM_HOME = tempHome('stam-answer-notice-');
process.env.STAM_TMUX_SOCKET = `answer-notice-test-${process.pid}`;
// Deliver by calling inTurnNotice, not by a push from a timer.
process.env.STAM_EVENT_FOLD_MS = '60000';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

const CHILD = fileURLToPath(new URL('./answer-notice-child.mjs', import.meta.url));
let db, perm, mail;

before(async () => {
  db = await import('../src/db.ts');
  perm = await import('../src/permissions.ts');
  mail = await import('../src/mail.ts');
  db.open();
});

// A working agent, so a push never starts a turn: the notice waits for a take.
const agent = (id, name) => {
  db.createAgent({ id, name, role: 'dev', machine: 'x', harness: 'claude', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  db.updateAgent(id, { lifecycle: 'active', activity: 'working' });
  return db.getAgent(id);
};

// The human denies a request the agent made, with a comment: the production answer path writes the row and queues it.
async function deniedWithComment(a, action, comment) {
  const r = await perm.requestPermission(a, action, 'needed for the task', '');
  await perm.answerPermission(r.id, false, mail.HUMAN, comment);
  return r.id;
}

// One daemon start on the home: the rows the restore left, and what the agent was handed. `ack` says the hook's client
// printed the response and acknowledged its rows; without it the response was lost.
function daemonStart(agentId, ack = true) {
  const r = spawnSync(process.execPath, [CHILD, agentId, ...(ack ? ['ack'] : [])], { env: process.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('a permission answer the daemon stops on before the take is delivered once after the restart', async () => {
  const a = agent('ar-stop', 'stop-agent');
  await deniedWithComment(a, 'Run npm test', 'use the staging database');
  // The first daemon stops here, before the agent takes the notice.
  const started = daemonStart(a.id);
  assert.equal(started.rowsAfterRestore, 1);
  assert.match(started.taken, /denied/);
  assert.match(started.taken, /use the staging database/);
  assert.match(started.taken, /Don't do it; continue without it\./);
  // The next start finds nothing: the client acknowledged the handoff.
  assert.equal(daemonStart(a.id).taken, '');
});

test('a handoff acknowledged by the hook client is not delivered again after a restart', async () => {
  const a = agent('ar-acked', 'acked-agent');
  await deniedWithComment(a, 'Run npm run build', 'skip the lint step');
  // The hook takes the notice, the client prints it and acknowledges the row.
  assert.match(daemonStart(a.id, true).taken, /skip the lint step/);
  // A restart finds no row and hands over nothing.
  const next = daemonStart(a.id, true);
  assert.equal(next.rowsAfterRestore, 0);
  assert.equal(next.taken, '');
});

test('a handoff whose response was lost (no client ack, then a Stop) is replayed after a restart, so it is never lost', async () => {
  const a = agent('ar-lost', 'lost-agent');
  await deniedWithComment(a, 'Run npm run build', 'skip the lint step');
  // The hook takes the notice, but the client timed out and discarded the response; the turn then ends and the daemon restarts.
  assert.match(daemonStart(a.id, false).taken, /skip the lint step/);
  // The row was kept, so the restart hands the notice over again, and this time the client acknowledges it.
  const replay = daemonStart(a.id, true);
  assert.equal(replay.rowsAfterRestore, 1);
  assert.match(replay.taken, /skip the lint step/);
  assert.equal(daemonStart(a.id).rowsAfterRestore, 0);
});

test('an archived agent\'s answer is dropped at the restart, and a resting agent keeps its own', async () => {
  const gone = agent('ar-gone', 'gone-agent');
  const rest = agent('ar-rest', 'rest-agent');
  await deniedWithComment(gone, 'Run npm run deploy', 'not today');
  await deniedWithComment(rest, 'Run npm run lint', 'lint it later');
  db.updateAgent(gone.id, { lifecycle: 'archived' });
  db.updateAgent(rest.id, { lifecycle: 'paused' });
  const goneStart = daemonStart(gone.id);
  assert.equal(goneStart.rowsAfterRestore, 1, 'only the resting agent\'s row is left');
  assert.equal(goneStart.taken, '');
  assert.match(daemonStart(rest.id).taken, /lint it later/);
});

test('an input answer (the expiry of an approved, held suggestion) is delivered once after the restart', () => {
  const a = agent('ar-input', 'input-agent');
  const expired = new Date(Date.now() - 60_000).toISOString();
  const r = db.createPermissionRequest(a.id, 'Type suggested input', 'to see the tree', '', false, null, 'human', { text: 'ls', sha256: 'abc', expires_at: expired });
  assert.ok(db.moveInputRequest(r.id, 'pending', 'held', {}));
  // The production sweep expires it: the move and its input-answered row commit together.
  perm.expireInputs();
  // The daemon stops before the agent takes it.
  const started = daemonStart(a.id);
  assert.equal(started.rowsAfterRestore, 1);
  assert.match(started.taken, new RegExp(`input-answered|${r.id}`));
  assert.match(started.taken, /expired/);
  assert.match(started.taken, /so nothing was typed/);
  assert.equal(daemonStart(a.id).taken, '');
});

test('an archive drops the agent\'s answer rows and queued notices at once, with no restart', async () => {
  const a = agent('ar-forget', 'forget-agent');
  await deniedWithComment(a, 'Run npm run release', 'not this week');
  assert.equal(db.answerNotices().filter((r) => r.agent_id === a.id).length, 1);
  // The archive's own step: the agent's rows and queued notices go with it.
  mail.forgetAgentNotices(a.id);
  assert.equal(db.answerNotices().filter((r) => r.agent_id === a.id).length, 0);
  assert.equal(mail.queuedNoticeCount(a.id), 0);
  assert.equal(daemonStart(a.id).taken, '');
});
