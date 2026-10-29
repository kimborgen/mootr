#!/usr/bin/env node
// The change line for an ITSA's fields, shared by the MCP tool and the CLI (S-2786): key=value pairs,
// a cleared or unset value as (none), never "[object Object]". Pure, no daemon.
// `node --test test/itsa-fields-line.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fieldsChange, fieldsLine } from '../src/itsa-fields-line.ts';

test('fieldsLine: key=value pairs, a null or unset value as (none), an object as JSON', () => {
  assert.equal(fieldsLine({ stage: 'review', n: 3 }), 'stage=review n=3');
  assert.equal(fieldsLine({ stage: null }), 'stage=(none)');
  assert.equal(fieldsLine({ tags: ['a', 'b'] }), 'tags=["a","b"]');
  assert.equal(fieldsLine(undefined), '');
});

test('fieldsChange: from -> to as key=value pairs', () => {
  assert.equal(fieldsChange({ from: { stage: 'review' }, to: { stage: 'done' } }), 'fields: stage=review -> stage=done');
  assert.equal(fieldsChange({ from: { stage: 'plan' }, to: { stage: null } }), 'fields: stage=plan -> stage=(none)');
  assert.equal(fieldsChange({ from: { stage: null }, to: { stage: 'code' } }), 'fields: stage=(none) -> stage=code');
});
