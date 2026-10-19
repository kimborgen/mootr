#!/usr/bin/env node
// Unit tests for the decision-block scanner (src/decision-mail.ts hasDecisionBlock), which reads a
// mail body the way the web's marked does (web/src/mail/mailblocks.ts): CommonMark fences, possibly
// quoted, with the info string exactly a decision tag. Run with `node --test test/decision-fence.test.mjs`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

process.env.STAM_HOME = tempHome('stam-decision-fence-');
process.env.STAM_TMUX_SOCKET = `decision-fence-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let hasDecisionBlock, isDeferralOnly;
before(async () => {
  ({ hasDecisionBlock, isDeferralOnly } = await import('../src/decision-mail.ts'));
});

test('a decision tag fence counts, in any case and quoted or tilde-fenced', () => {
  assert.equal(hasDecisionBlock('Which?\n\n```pick\nship\nhold\n```'), true);
  assert.equal(hasDecisionBlock('```DECISION\nx\n```'), true);
  assert.equal(hasDecisionBlock('~~~decision\nx\n~~~'), true);
  assert.equal(hasDecisionBlock('> ```decision\n> x\n> ```'), true);
  assert.equal(hasDecisionBlock('> > ```rank\n> > x\n> > ```'), true);
  assert.equal(hasDecisionBlock('  ```yesno\nok?\n  ```'), true);
  assert.equal(hasDecisionBlock('```pick\r\nship\r\n```'), true);
  assert.equal(hasDecisionBlock('```pick\nship'), true, 'an unclosed fence runs to the end, as the web reads it');
});

test('a decision fence inside another open fence does not count', () => {
  assert.equal(hasDecisionBlock('````text\n```decision\nx\n```\n````'), false);
  assert.equal(hasDecisionBlock('```text\n~~~\n```decision\nx\n```'), false, 'a tilde line does not close a backtick fence');
});

test('the info string must be exactly the tag, as the web matches it', () => {
  assert.equal(hasDecisionBlock('```decision extra\nx\n```'), false, 'the web reads the whole info string as the language');
  assert.equal(hasDecisionBlock('```decisions\nx\n```'), false);
  assert.equal(hasDecisionBlock('```text\ndecision\n```'), false);
});

test('an indented or inline mention is not a fence', () => {
  assert.equal(hasDecisionBlock('    ```decision\n    x\n    ```'), false, 'four spaces is indented code');
  assert.equal(hasDecisionBlock('```decision`x\nx\n```'), false, 'a backtick fence cannot have a backtick in its info string');
  assert.equal(hasDecisionBlock('Use a `decision` block to ask.'), false);
  assert.equal(hasDecisionBlock('No block here.'), false);
});

test('a decision fence inside a list item counts (S-465)', () => {
  assert.equal(hasDecisionBlock('- ```decision\n  x\n  ```'), true);
  assert.equal(hasDecisionBlock('1. Choose:\n\n   ```pick\n   a\n   ```'), true);
  assert.equal(hasDecisionBlock('- a\n  - ```yesno\n    ok?\n    ```'), true);
  assert.equal(hasDecisionBlock('> - ```rank\n>   x\n>   ```'), true);
  assert.equal(hasDecisionBlock('- a\nlazy\n    ```decision\n    x\n    ```'), true, 'a lazy line keeps the item open');
  assert.equal(hasDecisionBlock('- ```text\n  ```decision\n  ```'), false, 'inside another open fence');
  assert.equal(hasDecisionBlock('-     ```decision\n      x'), false, 'indented code in an item');
});

test('an unclosed fence ends with its quote or list item (S-465)', () => {
  assert.equal(hasDecisionBlock('> ```text\n> x\n\n```decision\nx\n```'), true);
  assert.equal(hasDecisionBlock('> ```text\n> x\n```decision\nx\n```'), true, 'no lazy lines in a fence');
  assert.equal(hasDecisionBlock('- ```text\n  x\n\n```decision\nx\n```'), true);
  assert.equal(hasDecisionBlock('- ```text\n  x\n\n  ```\n```decision\nx\n```'), true);
  assert.equal(hasDecisionBlock('> ```text\n> ```decision\n> x'), false, 'still inside the open fence');
  assert.equal(hasDecisionBlock('- ```text\n\n  ```decision\n  x'), false, 'a blank line keeps the item open');
});

test('a reply that only defers its answers defers the thread (S-353)', () => {
  // The texts web/src/mail/mailblocks.ts writes for "Decide later".
  assert.equal(isDeferralOnly("Deferring this one: still open, I'll decide later. Keep working on what doesn't depend on it."), true);
  assert.equal(isDeferralOnly("> Which one?\n\nDeferring this one. Go with your recommendation, **A**, for now."), true);
  assert.equal(isDeferralOnly("> Which one?\n\nDeferring this one: still open, I'll decide later.\n\n> Pick two?\n\nDeferring this one: still open, I'll decide later."), true);
  assert.equal(isDeferralOnly("> Which one?\n\nDeferring this one: still open, I'll decide later.\n\nNote: check with Sam."), false, 'a note is not a deferral');
  assert.equal(isDeferralOnly('Note: not yet, ask me Monday.'), false, 'a note alone is an answer, not a deferral');
  assert.equal(isDeferralOnly("Deferring this one: still open, I'll decide later.", 1), false, 'a deferral with an attachment is not a deferral');
  assert.equal(isDeferralOnly("> Which one?\n\nDeferring this one: still open, I'll decide later.\n\nChose **A**."), false, 'a choice beside a deferral answers the thread');
  assert.equal(isDeferralOnly('Deferring this one. But ship A.'), false, 'free text after the deferral is an answer');
  assert.equal(isDeferralOnly('Ship it.'), false);
  assert.equal(isDeferralOnly('> Which one?\n\n'), false, 'a reply with only the quoted question defers nothing');
});
