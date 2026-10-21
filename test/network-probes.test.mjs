#!/usr/bin/env node
// Recovery's network probes (src/network-probes.ts): without the test override they are the three
// API hosts; in a test home STAM_TEST_NETWORK_PROBES points them elsewhere or skips them with `none`,
// and then networkUp makes no outside request. Elsewhere the variable is ignored. No daemon, no network.
// Run with `node --test test/network-probes.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NETWORK_PROBES, networkProbes, networkUp } from '../src/network-probes.ts';
import { testOnlyEnv, TEST_HOME_MARKER } from '../src/test-env.ts';

const calls = () => { const urls = []; return { urls, fetch: async (u) => { urls.push(u); return {}; } }; };

test('without the override the probes are the API hosts, and networkUp asks them', async () => {
  assert.deepEqual(networkProbes(undefined), NETWORK_PROBES);
  const c = calls();
  assert.equal(await networkUp(networkProbes(undefined), c.fetch), true);
  assert.deepEqual(c.urls, NETWORK_PROBES);
});

test('none skips the probes: no request at all', async () => {
  assert.deepEqual(networkProbes('none'), []);
  const c = calls();
  assert.equal(await networkUp(networkProbes('none'), c.fetch), true);
  assert.deepEqual(c.urls, []);
});

test('a list replaces the hosts; an empty one falls back to them', async () => {
  assert.deepEqual(networkProbes('http://127.0.0.1:1, http://127.0.0.1:2'), ['http://127.0.0.1:1', 'http://127.0.0.1:2']);
  assert.deepEqual(networkProbes(' , '), NETWORK_PROBES);
});

test('a failing probe list is not up', async () => {
  assert.equal(await networkUp(['http://x'], async () => { throw new Error('down'); }), false);
});

test('the variable counts only in a test home', () => {
  const root = mkdtempSync(join(tmpdir(), 'netprobe-'));
  try {
    const home = join(root, 'home'); mkdirSync(home);
    const env = { STAM_TEST_NETWORK_PROBES: 'none' };
    assert.equal(testOnlyEnv('STAM_TEST_NETWORK_PROBES', env, home, false), undefined);
    writeFileSync(join(home, TEST_HOME_MARKER), '');
    writeFileSync(join(root, 'owner'), 'x\n');
    assert.equal(testOnlyEnv('STAM_TEST_NETWORK_PROBES', env, home, false), 'none');
    assert.equal(testOnlyEnv('STAM_TEST_NETWORK_PROBES', env, home, true), undefined, 'the live home never');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
