#!/usr/bin/env node
// Unit tests for src/page-liveness.ts (S-1626): which web pages are live for the image-tab sweep. Time comes in
// as `now`, so there are no timers. Run with `node --test test/page-liveness.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAGE_GRACE, PageLiveness } from '../src/page-liveness.ts';

test('a page with two streams stays live while one of them is open', () => {
  const p = new PageLiveness(0);
  p.open('a');
  p.open('a');
  p.close('a', 1000);
  assert.equal(p.live('a', 1000 + PAGE_GRACE * 10), true);
});

test('a page whose streams all closed is live until the grace ends, then dead', () => {
  const p = new PageLiveness(0);
  p.open('a');
  p.open('a');
  p.close('a', 1000);
  p.close('a', 2000);
  assert.equal(p.live('a', 2000 + PAGE_GRACE - 1), true);
  assert.equal(p.live('a', 2000 + PAGE_GRACE), false);
});

test('a restart gives unseen pages the grace from the start, then they are dead', () => {
  const p = new PageLiveness(5000);
  assert.equal(p.live('never', 5000 + PAGE_GRACE - 1), true);
  assert.equal(p.live('never', 5000 + PAGE_GRACE), false);
});

test('a reconnect within the grace keeps the page live, and its old close no longer counts', () => {
  const p = new PageLiveness(0);
  p.open('a');
  p.close('a', 1000);
  p.open('a');
  assert.equal(p.live('a', 1000 + PAGE_GRACE * 5), true);
});

test('prune forgets a closed page once its grace is over, and never a page with an open stream', () => {
  const p = new PageLiveness(0);
  p.open('closed');
  p.close('closed', 1000);
  p.open('open');
  p.prune(1000 + PAGE_GRACE - 1);
  assert.equal(p.size, 2, 'the grace is not over yet');
  p.prune(1000 + PAGE_GRACE);
  assert.equal(p.size, 1, 'the closed page is forgotten');
  p.prune(10 * PAGE_GRACE);
  assert.equal(p.live('open', 10 * PAGE_GRACE), true, 'a page with an open stream is never pruned');
  assert.equal(p.live('closed', 1000 + PAGE_GRACE), false, 'a forgotten page is still dead');
});

test('prune keeps a page that closed, reconnected, and has an open stream again', () => {
  const p = new PageLiveness(0);
  p.open('back');
  p.close('back', 1000);
  p.open('back');
  const before = p.size;
  p.prune(10 * PAGE_GRACE);
  assert.equal(p.size, before, 'its record is kept while its stream is open');
  assert.equal(p.live('back', 10 * PAGE_GRACE), true);
});
