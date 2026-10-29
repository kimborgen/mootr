#!/usr/bin/env node
// The adapter's 'gone' answer for a question dialog (S-3978): a dialog the agent no longer shows
// types nothing. An agent that moved on (not blocked), or a dialog from another session, answers
// 'gone' before any key is sent. Throwaway STAM_HOME, no daemon, no model.
// `node --test test/claude-question-gone.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-claude-question-gone-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `claude-question-gone-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let db, claude;
before(async () => {
  await import('../src/adapters/index.ts');
  db = await import('../src/db.ts');
  claude = (await import('../src/adapters/claude.ts')).claude;
});
after(() => rmSync(home, { recursive: true, force: true }));

const QUESTION = { tool: 'AskUserQuestion', input: { questions: [{ question: 'Which folder?', options: [{ label: 'Alpha' }, { label: 'Beta' }] }] }, session: 'q-session' };
const request = (details = QUESTION) => ({ id: 'req-q', action: 'Claude Code asks a question', details: JSON.stringify(details) });

function agent(id, activity, session) {
  db.createAgent({ id, name: id, role: 'test', machine: 'x', harness: 'claude', model: null, effort: null, cwd: home, parent_id: null, session_id: session });
  db.updateAgent(id, { activity, activity_detail: 'question' });
  return db.getAgent(id);
}

test('a question dialog the agent moved on from answers gone, for a choice or a deny', () => {
  const a = agent('q-idle', 'idle', 'q-session');
  assert.equal(claude.answerDialog(a, request(), true, 'Beta'), 'gone');
  assert.equal(claude.answerDialog(a, request(), false), 'gone');
});

test('a question dialog from another session answers gone, so no choice reaches a newer dialog', () => {
  const a = agent('q-other', 'blocked', 'q-session-new');
  assert.equal(claude.answerDialog(a, request(), true, 'Beta'), 'gone');
});
