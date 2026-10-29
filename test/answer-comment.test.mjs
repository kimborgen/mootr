#!/usr/bin/env node
// The human's comment on an answer (S-3829): an approval of a harness dialog with a comment tells the agent in one
// notice, a bare Approve tells it nothing more (as before), and a comment never turns a deny into an approval. Only the
// human approves a dialog. Throwaway STAM_HOME, no daemon. Run with `node --test test/answer-comment.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-answer-comment-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `answer-comment-${process.pid}`;
process.env.STAM_EMBEDDER = 'stub';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

let db, permissions, mail, adapters, commentOf;
const realDialog = {};
before(async () => {
  db = await import('../src/db.ts');
  permissions = await import('../src/permissions.ts');
  ({ commentOf } = permissions);
  mail = await import('../src/mail.ts');
  ({ adapters } = await import('../src/adapters/index.ts'));
  realDialog.answerDialog = adapters.claude.answerDialog;
  // The dialog is on screen and matches the request, so the key is typed: no tmux needed.
  adapters.claude.answerDialog = () => 'typed';
  db.createAgent({ id: 'dlg1', name: 'dialog-one', role: 'dev', machine: 'x', harness: 'claude', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  db.updateAgent('dlg1', { lifecycle: 'active', activity: 'busy' });
});
after(() => {
  adapters.claude.answerDialog = realDialog.answerDialog;
});

// A harness dialog waiting on the human, and the notice text the agent would get next (taken, so each test reads its own).
const dialogRequest = (action) => db.createPermissionRequest('dlg1', action, 'needs it', '', true, null, 'human');
const noticeFor = () => mail.inTurnNotice('dlg1') ?? '';

test('commentOf keeps a real comment and drops the defaults a bare Approve or Deny sends', () => {
  assert.equal(commentOf('yes, but only after the backup'), 'yes, but only after the backup');
  assert.equal(commentOf('  only staging  '), 'only staging');
  assert.equal(commentOf(''), '');
  assert.equal(commentOf('I authorize'), '');
  assert.equal(commentOf('i AUTHORIZE'), '');
  assert.equal(commentOf('Denied'), '');
});

test('approving a dialog with a comment tells the agent the verdict and the comment in one notice', async () => {
  const r = dialogRequest('Read /a/settings.json');
  const out = await permissions.answerPermission(r.id, true, 'human', 'yes, but only after the backup');
  assert.equal(out.status, 'approved');
  const text = noticeFor();
  assert.ok(text.includes('was approved'), 'the verdict');
  assert.ok(text.includes('yes, but only after the backup'), 'the comment, in the same notice');
  assert.equal(text.split('Read /a/settings.json').length - 1, 1, 'one notice, not two');
});

test('a bare approval of a dialog adds no notice, as before', async () => {
  const r = dialogRequest('Read /a/plain.json');
  await permissions.answerPermission(r.id, true, 'human', 'I authorize');
  assert.equal(noticeFor(), '', 'nothing is queued');
});

test('a comment on a deny keeps the deny; the comment never makes it an approval', async () => {
  const r = dialogRequest('Read /a/deny.json');
  const out = await permissions.answerPermission(r.id, false, 'human', 'yes, go ahead');
  assert.equal(out.status, 'denied');
  const text = noticeFor();
  assert.ok(text.includes('was denied'), 'the agent is told it was denied');
  assert.ok(text.includes('yes, go ahead'), 'with the comment');
});

test('an agent may not approve a dialog, with a comment or without', async () => {
  const r = dialogRequest('Read /a/agent.json');
  await assert.rejects(permissions.answerPermission(r.id, true, 'dlg1', 'yes'), /can't answer|only the human/);
  assert.equal(db.getPermissionRequest(r.id).status, 'pending', 'still pending');
});
