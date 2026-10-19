#!/usr/bin/env node
// Unit test for src/compress.ts (S-391): a big body is compressed at the fastest level, and every
// body round-trips. `node --test test/compress.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { encodeBody, FAST_BYTES } from '../src/compress.ts';

const json = (n) => Buffer.from(JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: `agent-${i}`, name: `name ${i % 97}`, cost: i * 1.5 }))));

test('small and big bodies both round-trip', () => {
  for (const body of [json(50), json(Math.ceil(FAST_BYTES / 40))]) {
    assert.deepEqual(brotliDecompressSync(encodeBody(body, 'br')), body);
    assert.deepEqual(gunzipSync(encodeBody(body, 'gzip')), body);
  }
});

test('a body over FAST_BYTES still shrinks by more than half', () => {
  const big = json(Math.ceil(FAST_BYTES / 20));
  assert.ok(big.length >= FAST_BYTES);
  assert.ok(encodeBody(big, 'br').length < big.length / 2);
  assert.ok(encodeBody(big, 'gzip').length < big.length / 2);
});
