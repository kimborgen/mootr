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

test('a bash-mode command that takes minutes is still waited for (S-3188)', async () => {
  const { BASH_EXPECT_MS } = await import('../src/permissions.ts');
  const { bashInputRecorded } = await import('../src/adapters/claude-input.ts');
  const { readFileSync } = await import('node:fs');
  const slow = readFileSync(new URL('fixtures/claude-input/bash-input-slow.jsonl', import.meta.url), 'utf8');
  const cmd = '! cd /work/web && sudo -n env "PATH=$PATH" npx tool install-deps 2>&1 | tail -5; df -h / | tail -1';
  // The record shows 80 s after Enter and the command is the typed one, with a leading space.
  assert.equal(bashInputRecorded(slow, cmd), 'match');
  // A different command, or a row that has not been appended yet, is not a match.
  assert.equal(bashInputRecorded(slow, '! pwd'), 'other');
  assert.equal(bashInputRecorded(slow.split('\n').slice(0, 2).join('\n'), cmd), 'none');
  // The check waits past the incident's 82 s and past a long install, not the typed-prompt bound.
  assert.ok(BASH_EXPECT_MS >= 10 * 60_000, `${BASH_EXPECT_MS}`);
});

test('the transcript poll reads only new bytes, and a row split across two reads is returned once whole (S-3188)', async () => {
  const { tailRows } = await import('../src/permissions.ts');
  const { bashInputRecorded } = await import('../src/adapters/claude-input.ts');
  const { writeFileSync, appendFileSync } = await import('node:fs');
  const file = join(mkdtempSync(join(tmpdir(), 'tail-rows-')), 't.jsonl');
  writeFileSync(file, 'old\n');
  const tail = { pos: 4, carry: Buffer.alloc(0) };
  assert.equal(tailRows(file, tail), '');
  const row = JSON.stringify({ type: 'user', message: { content: '<bash-input> ls</bash-input>' } });
  appendFileSync(file, row.slice(0, 20));
  assert.equal(tailRows(file, tail), '');
  appendFileSync(file, `${row.slice(20)}\nnext`);
  const rows = tailRows(file, tail);
  assert.equal(rows, `${row}\n`);
  assert.equal(bashInputRecorded(rows, '! ls'), 'match');
  assert.equal(tailRows(file, tail), '');
  appendFileSync(file, '\n');
  assert.equal(tailRows(file, tail), 'next\n');
});
