#!/usr/bin/env node
// A ring member's first prompt (S-4019): its task is the ring topic, which the creator wrote from a manager block that
// asks a reviewer's task for the pr_review verdict sentence. The ring's steps override that sentence (members don't post
// a verdict), so the rendered prompt carries the override whenever the task has the sentence. A plain reviewer's brief has
// no override and keeps its verdict. The composition mirrors ringSpawnBrief in src/daemon.ts (not exported).
// Throwaway STAM_HOME, no daemon: `node --test test/ring-member-brief.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempHome } from './tmphome.mjs';

process.env.STAM_HOME = tempHome('stam-ring-member-brief-');
const { render } = await import('../src/templates.ts');
const { agentType, renderBrief } = await import('../src/agent-types.ts');

const VERDICT = 'give your verdict with the `pr_review` tool';
const OVERRIDE = 'This overrides any instruction in the review task above to post a verdict with `pr_review`';
// The sentence the manager block requires in a reviewer's PR task, verbatim.
const SENTENCE = 'When the review is of a PR, watch it with `watch_pr`, and give your verdict with the `pr_review` tool (PR number, approve or request_changes, a one-line summary, and head: the full sha of the commit you reviewed).';
const TOPIC = `review PR 42 for the S-4019 fix. ${SENTENCE}`;

// ringSpawnBrief's first prompt for a ring member or moderator: the reviewer type's brief, the topic as its task, and the
// ring's steps as its next_steps.
const memberBrief = (what) => renderBrief(agentType('reviewer'), {
  task: TOPIC,
  next_steps: render('ring-member-steps', { role: what.toLowerCase(), ring: 'r' }),
  cwd: '/work',
  parent: 'creator',
});

test('a ring member first prompt carries the override for a task with the pr_review sentence', () => {
  const brief = memberBrief('Reviewer');
  assert.ok(brief.includes(SENTENCE));
  assert.ok(brief.includes(OVERRIDE));
});

test('the moderator of a ring gets the same override', () => {
  assert.ok(memberBrief('Moderator').includes(OVERRIDE));
});

test('the ring steps still say not to post a verdict, and the invariant check is there', () => {
  const steps = render('ring-member-steps', { role: 'reviewer', ring: 'r' });
  assert.ok(steps.includes("don't post a verdict with `pr_review`"));
  assert.ok(steps.includes('check it against the others'));
  assert.ok(steps.includes("raise it with the ring's creator"));
});

test('a plain reviewer spawn has no override and keeps its verdict', () => {
  const brief = renderBrief(agentType('reviewer'), { task: TOPIC, cwd: '/work', parent: 'creator', type: 'reviewer' });
  assert.ok(brief.includes(VERDICT));
  assert.ok(!brief.includes('This overrides any instruction'));
});
