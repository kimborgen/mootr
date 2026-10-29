#!/usr/bin/env node
// Unit tests for src/adapters/claude-dialog.ts (S-276): a yes is typed into a Claude Code
// dialog only when its body shows the call TOOL(full target) starting a line, so a
// file of the same name elsewhere, a longer path, a command sharing a long prefix, or a
// shortened target fails closed. A yes picks only a one-time yes, by its text (S-320).
// Deterministic, no daemon.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { dialogNames, dialogTarget, dialogDetails, dialogKey, dialogPrompt, dialogQuestion, questionNames } from '../src/adapters/claude-dialog.ts';

const read = (path) => ['Read file', '', `  Read(${path})`, '', 'Do you want to proceed?', '❯ 1. Yes', '  2. No'];
const LONG = 'echo ' + 'a'.repeat(60);

test('the full target and tool name a dialog', () => {
  assert.equal(dialogNames(read('/public/settings.json'), 'Read', '/public/settings.json'), true);
  assert.equal(dialogNames(['Bash command', '', `  Bash(${LONG} one)`, '', 'Do you want to proceed?'], 'Bash', `${LONG} one`), true);
  // A command with no Bash( ) around it isn't a shape stam can tie to the request.
  assert.equal(dialogNames(['Bash command', '', `  ${LONG} one`, '', 'Do you want to proceed?'], 'Bash', `${LONG} one`), false);
});

test('a file of the same name elsewhere, or a longer path, is another dialog', () => {
  assert.equal(dialogNames(read('/secret/settings.json'), 'Read', '/public/settings.json'), false);
  assert.equal(dialogNames(read('/secret/public/settings.json'), 'Read', '/public/settings.json'), false);
  assert.equal(dialogNames(read('/public/settings.json.bak'), 'Read', '/public/settings.json'), false);
});

test('a command sharing a long prefix, or with more after it, is another dialog', () => {
  assert.equal(dialogNames(['Bash command', '', `  Bash(${LONG} two)`], 'Bash', `${LONG} one`), false);
  assert.equal(dialogNames(['Bash command', '', '  Bash(ls -la; rm -rf x)'], 'Bash', 'ls -la'), false);
});

test('the tool is the call itself, not a word inside the text', () => {
  assert.equal(dialogNames(['Write(/tmp/Read/config)', '', '❯ 1. Yes', '2. No'], 'Read', '/tmp/Read/config'), false);
  assert.equal(dialogNames(['Edit file', '', '  Edit(/a/Read)', '  Read(/a/x)'], 'Read', '/a/x'), true);
  assert.equal(dialogNames(['Write file', '', '  Write(/a/x)', '  (Read later)'], 'Read', '/a/x'), false);
  assert.equal(dialogNames(['Bash command', '', '  Read /a/x', ''], 'Read', '/a/x'), false);
  assert.equal(dialogNames(['Read file', '', '  Write(/a/x)', ''], 'Read', '/a/x'), false);
  assert.equal(dialogNames(['Read /a/x', '', '❯ 1. Yes'], 'Read', '/a/x'), false);
});

test('the tool must be named, and a shortened target fails closed', () => {
  assert.equal(dialogNames(read('/public/settings.json'), 'Write', '/public/settings.json'), false);
  assert.equal(dialogNames(read('/public/sett…'), 'Read', '/public/settings.json'), false);
  assert.equal(dialogNames(read('/public/settings.json'), '', '/public/settings.json'), false);
  assert.equal(dialogNames(read('/public/settings.json'), 'Read', ''), false);
});

test('wrapped lines, box borders, and ~ for the home folder still match', () => {
  const long = '/very/long/folder/name/that/wraps/across/the/dialog/settings.json';
  const boxed = ['│ Read file                         │', '│   Read(/very/long/folder/name/that/ │', '│   wraps/across/the/dialog/settings. │', '│   json)                             │', '│ ❯ 1. Yes                            │'];
  assert.equal(dialogNames(boxed, 'Read', long), true);
  assert.equal(dialogNames(read('~/.cache/x.log'), 'Read', homedir() + '/.cache/x.log'), true);
});

test('details carry the tool, input, and session', () => {
  const d = dialogDetails(JSON.stringify({ tool: 'Read', input: { file_path: '/a/b' }, session: 's1' }));
  assert.equal(d.tool, 'Read');
  assert.equal(d.session, 's1');
  assert.equal(dialogTarget(d.input), '/a/b');
  assert.deepEqual(dialogDetails('not json'), {});
});

// Claude Code's menu for a read outside the working directories (storage, 2026-10-13, S-320).
const REAL = [
  '  Read(/home/user/x.png)',
  '',
  ' Allow this read outside the working directories?',
  ' ❯ 1. Yes, and keep allowing any reads outside the working directories',
  '   2. No, and block reads outside the working directories from now on',
  '   3. No, and ask again next time',
  '   4. Yes, but ask again next time',
];

test('a yes is a one-time yes, found by its text', () => {
  assert.equal(dialogKey(REAL, true), '4');
  assert.equal(dialogKey(read('/a/b'), true), '1');
  assert.equal(dialogKey(['│ ❯ 1. Yes                │', '│   2. No                 │'], true), '1');
});

test('no one-time yes fails closed', () => {
  assert.equal(dialogKey(REAL.slice(0, 6), true), undefined);
  assert.equal(dialogKey(['❯ 1. Yes, and don\'t ask again for this file', '  2. No'], true), undefined);
  assert.equal(dialogKey(['❯ 1. Yes, allow all edits during this session', '  2. No'], true), undefined);
  // Yes named only in other text isn't an option.
  assert.equal(dialogKey(['Yes', 'Do you want to proceed?', '❯ 1. No'], true), undefined);
});

test('a no asks again next time when the dialog offers it, else Esc', () => {
  assert.equal(dialogKey(REAL, false), '3');
  assert.equal(dialogKey(read('/a/b'), false), undefined);
});

// A question dialog (AskUserQuestion, S-3978): a choice is typed only when the screen shows its one
// question with its options in order, so a different question, a changed option, or a second question
// fails closed.
const ASK = { questions: [{ question: 'Which folder should I use?', options: [{ label: 'Alpha' }, { label: 'Beta' }] }] };
const ASKED = ['─'.repeat(40), 'Which folder should I use?', '❯ 1. Alpha', '  2. Beta', 'Enter to confirm · Esc to cancel'];

test('a question dialog names its one question and its option labels', () => {
  assert.deepEqual(dialogQuestion(ASK), { question: 'Which folder should I use?', options: ['Alpha', 'Beta'] });
  assert.equal(dialogQuestion({ questions: [ASK.questions[0], ASK.questions[0]] }), undefined);
  assert.equal(dialogQuestion({}), undefined);
  assert.equal(dialogQuestion({ questions: [{ question: 'Pick?', options: [{ label: '' }] }] }), undefined);
});

// dialogPrompt is the looser shape a no matches (S-3978 review): a multi-select question and repeated labels are still
// the dialog's own, so their text and labels name it; several questions and an unlabelled option are not.
test('a deny\'s prompt keeps a multi-select question or repeated labels, and still refuses several questions', () => {
  assert.deepEqual(dialogPrompt({ questions: [{ question: 'Pick?', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }] }), { question: 'Pick?', options: ['A', 'B'], multiSelect: true });
  assert.deepEqual(dialogPrompt({ questions: [{ question: 'Pick?', options: [{ label: 'A' }, { label: 'A' }] }] }), { question: 'Pick?', options: ['A', 'A'], multiSelect: false });
  assert.equal(dialogPrompt({ questions: [ASK.questions[0], ASK.questions[0]] }), undefined);
  assert.equal(dialogPrompt({ questions: [{ question: 'Pick?', options: [{ label: '' }] }] }), undefined);
});

test('the screen must show the request\'s question and options, in order', () => {
  assert.equal(questionNames(ASKED, 'Which folder should I use?', ['Alpha', 'Beta']), true);
  // Wrapped question text and box borders still match.
  assert.equal(questionNames(['│ Which folder should I │', '│ use?                    │', '│ ❯ 1. Alpha              │', '│   2. Beta               │'], 'Which folder should I use?', ['Alpha', 'Beta']), true);
});

test('a different question, a changed or reordered option, or a missing one fails closed', () => {
  assert.equal(questionNames(ASKED, 'Which region should I use?', ['Alpha', 'Beta']), false);
  assert.equal(questionNames(ASKED, 'Which folder should I use?', ['Alpha', 'Gamma']), false);
  assert.equal(questionNames(ASKED, 'Which folder should I use?', ['Beta', 'Alpha']), false);
  assert.equal(questionNames(ASKED, 'Which folder should I use?', ['Alpha', 'Beta', 'Gamma']), false);
  assert.equal(questionNames(['Which folder should I use?', '❯ 1. Alpha'], 'Which folder should I use?', ['Alpha', 'Beta']), false);
  assert.equal(questionNames([], 'Which folder should I use?', ['Alpha']), false);
});

// A multi-select question toggles an option per digit, so a typed choice would not answer it (S-3978), and
// two options with one label would type the first one's number: neither is a question stam answers.
test('a multi-select question, or one with a repeated label, is not a question stam answers', () => {
  const single = { question: 'Which folder?', options: [{ label: 'Alpha' }, { label: 'Beta' }] };
  assert.notEqual(dialogQuestion({ questions: [single] }), undefined);
  assert.equal(dialogQuestion({ questions: [{ ...single, multiSelect: true }] }), undefined);
  assert.notEqual(dialogQuestion({ questions: [{ ...single, multiSelect: false }] }), undefined);
  assert.equal(dialogQuestion({ questions: [{ question: 'Which folder?', options: [{ label: 'Alpha' }, { label: 'Alpha' }] }] }), undefined);
});
