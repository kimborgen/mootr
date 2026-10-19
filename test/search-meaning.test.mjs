#!/usr/bin/env node
// Unit tests for the palette's ordering across kinds (S-143): each kind's scores are scaled by that
// kind's best, so the top of every kind keeps its place and each kind keeps its own order. Run with
// `node --test test/search-meaning.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { scaleByKind, rankAndTrim } = await import('../src/search.ts');

const hit = (kind, id, score) => ({ kind, id, title: id, score });

test('each kind is divided by its own best score, so its top scores 1', () => {
  const out = scaleByKind([hit('agent', 'a', 13), hit('agent', 'b', 6.5), hit('thread', 't', 0.8), hit('thread', 'u', 0.2)]);
  assert.deepEqual(
    out.map((r) => [r.id, r.score]),
    [['a', 1], ['b', 0.5], ['t', 1], ['u', 0.25]],
  );
});

test('a kind keeps its own order after scaling', () => {
  const out = scaleByKind([hit('itsa', 'x', 0.3), hit('itsa', 'y', 0.9), hit('itsa', 'z', 0.6)]);
  assert.deepEqual(out.map((r) => r.id).sort(), ['x', 'y', 'z']);
  const by = Object.fromEntries(out.map((r) => [r.id, r.score]));
  assert.ok(by.y > by.z && by.z > by.x);
});

test('a low-scoring kind keeps its top hit in the trimmed list', () => {
  // Agent keyword ranks run to about 13; mail meaning scores stay under 1. Unscaled, the mail top
  // would sit below every agent. Scaled, it ties the agent top and makes the list.
  const all = [hit('agent', 'a1', 13), hit('agent', 'a2', 12), hit('agent', 'a3', 11), hit('thread', 't1', 0.7), hit('thread', 't2', 0.4)];
  const top = rankAndTrim(scaleByKind(all), 3).map((r) => r.id);
  assert.ok(top.includes('t1'), `mail's top hit was trimmed: ${top}`);
});

test('an empty list and a kind with no score are safe', () => {
  assert.deepEqual(scaleByKind([]), []);
  assert.deepEqual(scaleByKind([hit('setting', 's', 0)]).map((r) => r.score), [0]);
});
