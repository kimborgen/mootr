import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awaitFirstPrompt, firstPromptHook } from '../src/adapters/claude-first-prompt.ts';

// S-3454: the first UserPromptSubmit that isn't a stam channel push takes the first prompt. A
// channel push that starts a turn first (a restart's wrap-up to a launch still starting) must not.
test('a stam channel push does not take the first prompt; the next turn does', () => {
  const first = awaitFirstPrompt('a1');
  firstPromptHook('a1', '<channel source="stam" kind="mail">\n[stam] Wrap up before the restart\n</channel>');
  assert.equal(first.taken(), false);
  firstPromptHook('a1', 'ghost first: reply FIRST-DONE');
  assert.equal(first.taken(), true);
  first.done();
});

test('a channel push with leading whitespace is still a push', () => {
  const first = awaitFirstPrompt('a2');
  firstPromptHook('a2', '\n  <channel source="stam">wrap up</channel>');
  assert.equal(first.taken(), false);
  first.done();
});

test('a long multi-line prompt that Claude Code wraps in pasted_content takes the first prompt', () => {
  const first = awaitFirstPrompt('a3');
  firstPromptHook('a3', '<pasted_content id="1">line one\nline two\n…</pasted_content id="1">');
  assert.equal(first.taken(), true);
  first.done();
});

test('another channel source, and a hook with no string prompt, count as before', () => {
  const other = awaitFirstPrompt('a4');
  firstPromptHook('a4', '<channel source="other">hi</channel>');
  assert.equal(other.taken(), true);
  other.done();
  const none = awaitFirstPrompt('a5');
  firstPromptHook('a5', undefined);
  assert.equal(none.taken(), true);
  none.done();
});

test('a hook with no awaited launch, or after done, changes nothing', () => {
  firstPromptHook('a6', 'anything');
  const first = awaitFirstPrompt('a6');
  first.done();
  firstPromptHook('a6', 'anything');
  assert.equal(first.taken(), false);
});

test('a superseded launch cannot clear the entry a later launch set', () => {
  const old = awaitFirstPrompt('a7');
  const next = awaitFirstPrompt('a7');
  old.done();
  firstPromptHook('a7', 'stale second');
  assert.equal(next.taken(), true);
  next.done();
});
