#!/usr/bin/env node
// Unit tests for the lines stam gives an agent when its permission request is answered (S-640):
// the line typed on approval (src/permissions.ts approvedTyped) names the request, its action (capped
// at 200 characters), and any note the user gave; the notice for a deny, or an approval that couldn't be
// typed (permission-answered), closes with what to do next. Neither says "try again".
// Run with `node --test test/permission-typed.test.mjs`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempDir } from './tmphome.mjs';

process.env.STAM_HOME = tempDir('stam-permission-typed-');
process.env.STAM_TMUX_SOCKET = `permission-typed-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let approvedTyped, answeredNext, render;
before(async () => {
  ({ approvedTyped, answeredNext } = await import('../src/permissions.ts'));
  ({ render } = await import('../src/templates.ts'));
});

test('an approval with no note names the request, says it is approved, and starts with "I authorize"', () => {
  const t = approvedTyped('p1a2b3', 'Run npm test', '');
  assert.equal(t, "I authorize p1a2b3: the user approved it (Run npm test). Go ahead with that action now; don't request it again.");
  assert.ok(t.startsWith('I authorize'));
  assert.ok(!/try again/i.test(t));
});

test('the default note "I authorize", in any case, adds nothing', () => {
  const plain = approvedTyped('p1a2b3', 'Run npm test', '');
  assert.equal(approvedTyped('p1a2b3', 'Run npm test', 'I authorize'), plain);
  assert.equal(approvedTyped('p1a2b3', 'Run npm test', 'i AUTHORIZE.'), plain);
});

test('a custom note is appended as the user\'s note, without its trailing punctuation doubled', () => {
  const t = approvedTyped('p1a2b3', 'Run npm test', 'only on the staging branch!');
  assert.equal(t, "I authorize p1a2b3: the user approved it (Run npm test). Go ahead with that action now; don't request it again. The user's note: only on the staging branch.");
  assert.ok(!/try again/i.test(t));
});

test('a long action is capped at 200 characters with an ellipsis', () => {
  const long = 'x'.repeat(500);
  const t = approvedTyped('p1a2b3', long, '');
  assert.ok(t.includes(`(${'x'.repeat(200)}…)`));
  assert.ok(!t.includes('x'.repeat(201)));
  const exact = 'y'.repeat(200);
  assert.ok(approvedTyped('p1a2b3', exact, '').includes(`(${exact}).`));
});

test('a denied notice closes with "Don\'t do it; continue without it."', () => {
  const t = render('permission-answered', { id: 'p1a2b3', action: 'Run npm test', verdict: 'denied', who: 'a3z4v', note: 'Denied', next: answeredNext(false) });
  assert.equal(t, '[stam] Your permission request p1a2b3 (Run npm test) was denied by a3z4v. Their words: "Denied" Don\'t do it; continue without it.');
  assert.ok(!/try again/i.test(t));
});

test('an approved notice that could not be typed closes with "Go ahead; don\'t request it again."', () => {
  const t = render('permission-answered', { id: 'p1a2b3', action: 'Run npm test', verdict: 'approved', who: 'your user (the human), in stam', note: 'I authorize', next: answeredNext(true) });
  assert.equal(t, '[stam] Your permission request p1a2b3 (Run npm test) was approved by your user (the human), in stam. Their words: "I authorize" Go ahead; don\'t request it again.');
  assert.ok(!/try again/i.test(t));
});
