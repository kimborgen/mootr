#!/usr/bin/env node
// The resident-memory split behind `daemon status` (S-4390): on Linux the anonymous and file-backed RSS are read from
// /proc/self/status and are positive, and the split can't exceed the RSS. Elsewhere there is no split: undefined.
// No daemon: `node --test test/memory-report.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { residentMemory } from '../src/memory.ts';

test('the RSS split is read from /proc on Linux, and is undefined elsewhere', () => {
  const m = residentMemory();
  if (process.platform !== 'linux') return assert.equal(m, undefined);
  assert.ok(m, 'a Linux /proc/self/status has RssAnon and RssFile');
  assert.ok(m.anon > 0 && m.file >= 0);
  assert.ok(m.anon + m.file <= process.memoryUsage().rss + 1024 * 1024, 'the split is part of the RSS');
});
