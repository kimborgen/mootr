#!/usr/bin/env node
// Unit tests for the strict mail gate's rubric (S-985, src/mail-check.ts gateFailures), no daemon, no
// network: under humanMail.when 'necessary' a banned kind and fluff over STRICT_MAX_FLUFF fail, and the
// refusal names the kind and what to cut; under 'important' and 'everything' the old rubric holds.
// Run with `node --test test/mail-gate-strict.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-mail-gate-strict-');
process.env.STAM_HOME = home;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

const { threadQuestion, gateFailures, STRICT_MAX_FLUFF, GATE_MAX_FLUFF, STRICT_MIN_KIND_CONFIDENCE } = await import('../src/mail-check.ts');
const { settingsChanged } = await import('../src/settings.ts');
const when = (w) => {
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ humanMail: { when: w } }));
  settingsChanged();
};
const verdict = (over = {}) => ({ follows: true, score: 0.94, concise: 0.9, fluff: 0.1, value: 0.8, at: 'x', ...over });

test('necessary: decision, blocker, done and answer pass', () => {
  when('necessary');
  for (const kind of ['decision', 'blocker', 'done', 'answer']) assert.deepEqual(gateFailures(verdict({ kind, kind_confidence: 0.9 })), []);
});

test('necessary: update, acknowledgement and other fail, naming the kind', () => {
  when('necessary');
  const text = (kind) => gateFailures(verdict({ kind, kind_confidence: 0.9 })).join(' ');
  assert.match(text('update'), /progress update/);
  assert.match(text('acknowledgement'), /acknowledgement/);
  assert.match(text('other'), /none of a decision/);
  assert.match(text('update'), /a done note for work they asked for/);
});

test('necessary: a banned kind under the confidence floor passes', () => {
  when('necessary');
  assert.deepEqual(gateFailures(verdict({ kind: 'update', kind_confidence: STRICT_MIN_KIND_CONFIDENCE - 0.1 })), []);
});

test('necessary: fluff between the strict and the old limit fails', () => {
  const fluff = (STRICT_MAX_FLUFF + GATE_MAX_FLUFF) / 2;
  when('necessary');
  assert.equal(gateFailures(verdict({ fluff })).length, 1);
  when('important');
  assert.deepEqual(gateFailures(verdict({ fluff })), []);
});

test('important and everything: an update passes', () => {
  for (const w of ['important', 'everything']) {
    when(w);
    assert.deepEqual(gateFailures(verdict({ kind: 'update', kind_confidence: 0.95 })), []);
  }
});

test('necessary: a kind outside the criteria fails open', () => {
  when('necessary');
  assert.deepEqual(gateFailures(verdict({ kind: 'surprise', kind_confidence: 0.95 })), []);
});

// A thread as gateContext reads it: the human's message to the sender, then maybe the sender's reply.
const human = (body, to = ['sender']) => ({ from_id: 'human', body, recipients: to.map((id) => ({ id })) });
const agent = (body, to = ['human']) => ({ from_id: 'sender', body, recipients: to.map((id) => ({ id })) });

test('threadQuestion: a real question to the sender sets the flag', () => {
  assert.equal(threadQuestion([human('Does every harness have pre and post tool hooks?')], 'sender'), true);
  assert.equal(threadQuestion([human('Which one? And why?\nThanks.')], 'sender'), true);
  assert.equal(threadQuestion([human('Hooks?')], 'sender'), true);
});

test('threadQuestion: a decision reply that quotes the question does not', () => {
  assert.equal(threadQuestion([human('> Which token lifetime?\n\nChose **1 hour**.')], 'sender'), false);
});

test('threadQuestion: a URL query or code does not', () => {
  assert.equal(threadQuestion([human('See https://example.com/search?q=hooks and run it.')], 'sender'), false);
  assert.equal(threadQuestion([human('Run `git log --format=%s?` now.\n```\nis it x?\n```')], 'sender'), false);
});

test('threadQuestion: an answered question does not', () => {
  assert.equal(threadQuestion([human('Does it work?'), agent('Yes.')], 'sender'), false);
  // A comment to the agents only (not the human) doesn't answer it.
  assert.equal(threadQuestion([human('Does it work?'), agent('Checking.', ['peer'])], 'sender'), true);
});

test('threadQuestion: a question to someone else, or none, does not', () => {
  assert.equal(threadQuestion([human('Does it work?', ['peer'])], 'sender'), false);
  assert.equal(threadQuestion([agent('Hello?')], 'sender'), false);
  assert.equal(threadQuestion([], 'sender'), false);
});

test('threadQuestion: a question to everyone includes the sender', () => {
  assert.equal(threadQuestion([human('Who has hooks?', ['sender', 'peer'])], 'sender'), true);
});
