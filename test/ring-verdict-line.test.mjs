#!/usr/bin/env node
// A ring whose topic names a PR tells its prompts to post the verdict with the pr_review tool (S-580, S-1061);
// a ring with no PR gets no such line. Throwaway STAM_HOME, no daemon:
// `node --test test/ring-verdict-line.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempHome } from './tmphome.mjs';

process.env.STAM_HOME = tempHome('stam-ring-verdict-');
const ring = await import('../src/ring.ts');
const { render } = await import('../src/templates.ts');

const LINE = 'the pr_review tool (pr 42, approve or request_changes, a one-line summary, and head: the full sha of the PR\'s head the review checked)';

test('a topic naming a PR gets the pr_review line for that number', () => {
  assert.ok(ring.verdictLine('review PR 42 for the S-580 fix', false).includes(LINE));
  assert.ok(ring.verdictLine('Please review pull request #7', false).includes('(pr 7, '));
  assert.ok(ring.verdictLine('review pr#9', false).includes('(pr 9, '));
});

test('a topic without a PR gets no line', () => {
  assert.equal(ring.verdictLine('design the ring format', false), '');
  assert.equal(ring.verdictLine('the PR template needs a new field', false), '');
});

test('a topic naming two PRs gets no line, so the wrong one is never picked', () => {
  assert.equal(ring.verdictLine('follow-up to PR 291: review PR 294', false), '');
  assert.ok(ring.verdictLine('review PR 294 again, PR 294 is the same', false).includes('(pr 294, '));
});

test('a moderated ring has the moderator post; a moderator-less ring has the creator post', () => {
  assert.ok(ring.verdictLine('review PR 42', true).includes('the moderator runs this'));
  assert.ok(ring.verdictLine('review PR 42', false).includes("Members don't post the verdict"));
  assert.ok(ring.verdictLine('review PR 42', false).includes('its creator runs this'));
});

test('the finished mail carries the line for a PR review, and only then', () => {
  const r = (topic) => ({ name: 'r', format: 'rounds', round: 1, topic, moderator_id: null });
  assert.ok(ring.finishBody(r('review PR 42'), 'all members agreed', 'ok').includes(LINE));
  assert.ok(!ring.finishBody(r('design the ring format'), 'all members agreed', 'ok').includes('pr_review'));
});

test('an incomplete ring\'s finished mail names no verdict line (S-3862)', () => {
  const r = { name: 'r', format: 'rounds', round: 1, topic: 'review PR 42', moderator_id: null };
  assert.ok(!ring.finishBody(r, 'm1 never started, so the ring is incomplete', 'ok', ['m1']).includes('pr_review'));
});

test('the turn and moderation prompts carry the line only when the topic names a PR', () => {
  const vars = (topic) => ({ ring: 'r', ring_id: 'r1', format: 'rounds', round: 1, max_rounds: 3, member: 'a', members: 'a, b', topic, instructions: 'x', history: 'y', pr: ring.verdictLine(topic, false), decide: '' });
  assert.ok(render('ring-turn', vars('review PR 42')).includes(LINE));
  assert.ok(render('ring-moderate', vars('review PR 42')).includes(LINE));
  assert.ok(!render('ring-turn', vars('design the ring format')).includes('pr_review'));
  assert.ok(!render('ring-moderate', vars('design the ring format')).includes('pr_review'));
});
