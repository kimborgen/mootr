#!/usr/bin/env node
// The phone check's touch-target hit-test (S-1944): web/check/hit-classify.mjs decides which sampled
// points fail and which the S-2249 allow-list names. Run with `node --test test/hit-classify.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, failing, knownKey } from '../web/check/hit-classify.mjs';

const ok = (edge) => ({ edge, inside: true });
const cover = (edge, by, extra = {}) => ({ edge, inside: false, by, ...extra });
const clean = ['centre', 'top', 'bottom', 'left', 'right'].map(ok);
const withEdges = (...bad) => clean.map((s) => bad.find((b) => b.edge === s.edge) ?? s);

test('a target hit on itself everywhere passes', () => {
  assert.deepEqual(classify('s', 'button.a', clean, []), { fresh: [], known: [] });
});

test('a covered edge fails and names the edge and the coverer', () => {
  const r = classify('s', 'a.pr-gh', withEdges(cover('right', 'span.text')), []);
  assert.deepEqual(r.fresh, [{ target: 'a.pr-gh', edge: 'right', by: 'span.text' }]);
});

test('a fully occluded target fails, centre included', () => {
  const all = clean.map((s) => cover(s.edge, 'div.card'));
  assert.equal(classify('s', 'button.a', all, []).fresh.length, 5);
});

test('a covered centre alone fails', () => {
  assert.equal(classify('s', 'button.a', withEdges(cover('centre', 'div.x')), []).fresh.length, 1);
});

test('a known overlap passes and is reported as known, with its key seen', () => {
  const seen = new Set();
  const known = [knownKey('s', 'button.a', cover('bottom', 'footer'))];
  const r = classify('s', 'button.a', withEdges(cover('bottom', 'footer')), known, seen);
  assert.equal(r.fresh.length, 0);
  assert.equal(r.known.length, 1);
  assert.deepEqual([...seen], known);
});

test('a known bottom overlap plus a new right overlap fails', () => {
  const known = [knownKey('s', 'button.a', cover('bottom', 'footer'))];
  const r = classify('s', 'button.a', withEdges(cover('bottom', 'footer'), cover('right', 'span.t')), known);
  assert.deepEqual(r.fresh.map((c) => c.edge), ['right']);
  assert.equal(r.known.length, 1);
});

test('the same target and edge under another coverer, or in another step, is not known', () => {
  const known = [knownKey('s', 'button.a', cover('bottom', 'footer'))];
  assert.equal(classify('s', 'button.a', withEdges(cover('bottom', 'header')), known).fresh.length, 1);
  assert.equal(classify('t', 'button.a', withEdges(cover('bottom', 'footer')), known).fresh.length, 1);
});

test('two controls of one class: only the listed one is known', () => {
  const known = [knownKey('s', 'button.w-agent[helper]', cover('bottom', 'span.l'))];
  const s = withEdges(cover('bottom', 'span.l'));
  assert.equal(classify('s', 'button.w-agent[helper]', s, known).fresh.length, 0);
  assert.equal(classify('s', 'button.w-agent[kid]', s, known).fresh.length, 1);
});

test('a pinned bar over a control that does not scroll fails', () => {
  const s = withEdges(cover('top', 'header.bar', { pinned: true, scrollsUnder: false }));
  assert.equal(failing(s).length, 1);
});

test('a pinned bar over a control scrolled under it is exempt', () => {
  const s = withEdges(cover('top', 'header.bar', { pinned: true, scrollsUnder: true }));
  assert.equal(failing(s).length, 0);
});

test('a scroller that can scroll does not exempt a coverer that is not pinned', () => {
  const s = withEdges(cover('bottom', 'span.t', { pinned: false, scrollsUnder: true }));
  assert.equal(failing(s).length, 1);
});

test('off-screen, clipped and inert points are exempt', () => {
  for (const flag of ['offscreen', 'inert', 'overlay', 'clipped']) {
    assert.equal(failing(withEdges(cover('bottom', 'x', { [flag]: true }))).length, 0, flag);
  }
});
