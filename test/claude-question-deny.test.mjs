#!/usr/bin/env node
// A question dialog's no (S-3978): the screen must show that question and its options, as a yes needs, before Esc is
// typed. A question another dialog replaced, or a Read dialog on screen, is never cancelled with Esc. A fake tmux on
// PATH serves the screen and logs the keys sent, so this checks what would be typed without a real session.
// Throwaway STAM_HOME, no daemon, no model. `node --test test/claude-question-deny.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-claude-question-deny-');
const bin = join(home, 'fake-bin');
const screenFile = join(home, 'screen.txt');
const keysFile = join(home, 'keys.txt');
const PATH = process.env.PATH;
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `claude-question-deny-${process.pid}`;
process.env.FAKE_TMUX_SCREEN = screenFile;
process.env.FAKE_TMUX_KEYS = keysFile;
process.env.PATH = `${bin}:${PATH}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let db, claude;
before(async () => {
  mkdirSync(bin, { recursive: true });
  // has-session succeeds, capture-pane prints the screen, send-keys logs its keys and types nothing else.
  writeFileSync(join(bin, 'tmux'), '#!/bin/sh\ncase "$*" in\n  *has-session*) exit 0 ;;\n  *capture-pane*) cat "$FAKE_TMUX_SCREEN" ;;\n  *send-keys*) echo "$*" >> "$FAKE_TMUX_KEYS" ;;\nesac\nexit 0\n', { mode: 0o755 });
  await import('../src/adapters/index.ts');
  db = await import('../src/db.ts');
  claude = (await import('../src/adapters/claude.ts')).claude;
});
after(() => {
  process.env.PATH = PATH;
  rmSync(home, { recursive: true, force: true });
});

const QUESTION = { tool: 'AskUserQuestion', input: { questions: [{ question: 'Which folder?', options: [{ label: 'Alpha' }, { label: 'Beta' }] }] }, session: 'q-deny' };
const request = { id: 'req-deny', action: 'Claude Code asks a question', details: JSON.stringify(QUESTION) };
const ASKED = ['────────────────', ' Which folder?', ' ❯ 1. Alpha', '   2. Beta', ' Enter to confirm · Esc to cancel'];
const READ = ['────────────────', ' Read file', '  Read(/elsewhere/menu.png)', ' ❯ 1. Yes', '   2. No', ' Enter to confirm · Esc to cancel'];

function showScreen(lines) {
  writeFileSync(screenFile, lines.join('\n') + '\n');
  rmSync(keysFile, { force: true });
}
// The keys stam typed into the pane, one line per send-keys call; none when the file was never written.
const keysTyped = () => (existsSync(keysFile) ? readFileSync(keysFile, 'utf8').trim().split('\n') : []);

function blockedAgent(id) {
  db.createAgent({ id, name: id, role: 'test', machine: 'x', harness: 'claude', model: null, effort: null, cwd: home, parent_id: null, session_id: 'q-deny' });
  db.updateAgent(id, { activity: 'blocked', activity_detail: 'question' });
  return db.getAgent(id);
}

test('a no on the question the screen shows types Esc', () => {
  showScreen(ASKED);
  assert.equal(claude.answerDialog(blockedAgent('deny-same'), request, false), 'typed');
  assert.equal(keysTyped().length, 1);
  assert.match(keysTyped()[0], /Escape$/);
});

test('a no while the screen shows another question types nothing', () => {
  showScreen(ASKED.map((l) => l.replace('Which folder?', 'Which region?')));
  assert.equal(claude.answerDialog(blockedAgent('deny-other-q'), request, false), 'unsafe');
  assert.deepEqual(keysTyped(), []);
});

test('a no while the screen shows another tool\'s dialog types nothing', () => {
  showScreen(READ);
  assert.equal(claude.answerDialog(blockedAgent('deny-read'), request, false), 'unsafe');
  assert.deepEqual(keysTyped(), []);
});

test('a no with no dialog on screen answers gone and types nothing', () => {
  showScreen(['❯ ', '? for shortcuts']);
  assert.equal(claude.answerDialog(blockedAgent('deny-gone'), request, false), 'gone');
  assert.deepEqual(keysTyped(), []);
});

test('a choice still types its option number when the screen shows the question', () => {
  showScreen(ASKED);
  assert.equal(claude.answerDialog(blockedAgent('choose-beta'), request, true, 'Beta'), 'typed');
  assert.match(keysTyped()[0], / 2$/);
});

// A no matches the question's text and every label, multi-select or repeated-label question too, since the labels name the
// dialog; a yes still needs the single-select shape, and two questions fail closed for a no as well (S-3978 review).
const asking = (question) => ({ ...request, details: JSON.stringify({ tool: 'AskUserQuestion', input: { questions: [question] }, session: 'q-deny' }) });

test('a no on a multi-select question types Esc, and a yes on it is refused', () => {
  showScreen(ASKED);
  const multi = asking({ question: 'Which folder?', multiSelect: true, options: [{ label: 'Alpha' }, { label: 'Beta' }] });
  assert.equal(claude.answerDialog(blockedAgent('deny-multi'), multi, false), 'typed');
  assert.match(keysTyped()[0], /Escape$/);
  showScreen(ASKED);
  assert.equal(claude.answerDialog(blockedAgent('yes-multi'), multi, true, 'Beta'), 'unsafe');
  assert.deepEqual(keysTyped(), []);
});

test('a no on a repeated-label question types Esc when its labels match the screen', () => {
  showScreen(['────────────────', ' Which folder?', ' ❯ 1. Alpha', '   2. Alpha', ' Enter to confirm · Esc to cancel']);
  const repeated = asking({ question: 'Which folder?', options: [{ label: 'Alpha' }, { label: 'Alpha' }] });
  assert.equal(claude.answerDialog(blockedAgent('deny-repeated'), repeated, false), 'typed');
  assert.match(keysTyped()[0], /Escape$/);
});

test('a no on several questions types nothing', () => {
  showScreen(ASKED);
  const two = { tool: 'AskUserQuestion', input: { questions: [{ question: 'Which folder?', options: [{ label: 'Alpha' }] }, { question: 'Which folder?', options: [{ label: 'Alpha' }] }] }, session: 'q-deny' };
  assert.equal(claude.answerDialog(blockedAgent('deny-two'), { ...request, details: JSON.stringify(two) }, false), 'unsafe');
  assert.deepEqual(keysTyped(), []);
});
