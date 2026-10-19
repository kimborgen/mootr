#!/usr/bin/env node
// Unit test for S-1171: the notice after a deploy names added, removed and changed tools, and tells a
// Claude Code agent only that a changed tool's listed schema may be stale. No daemon.
// Run with `node --test test/tool-changes.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempHome } from './tmphome.mjs';
import { rmSync } from 'node:fs';

const home = tempHome('stam-tool-changes-');
process.env.STAM_HOME = home;
const tc = await import('../src/tool-changes.ts');

const tool = (name, props = {}) => ({ name, description: `d ${name}`, inputSchema: { type: 'object', properties: props } });

test('a parameter added to a tool shows as changed, and the notice names it and says its listed schema may be stale', () => {
  const before = tc.catalog([tool('send_mail', { body: {} }), tool('read_mail')]);
  const after = tc.catalog([tool('send_mail', { body: {}, override: {} }), tool('read_mail')]);
  const d = tc.diff(before, after);
  assert.deepEqual(d, { added: [], removed: [], changed: ['send_mail'] });
  const text = tc.noticeText(d, 'claude');
  assert.match(text, /changed: send_mail/);
  assert.match(text, /may be stale/);
  assert.doesNotMatch(text, /reconnect_mcp/);
});

test('added and removed tools are named without the stale-schema hint; no change gives no notice', () => {
  const text = tc.noticeText({ added: ['a'], removed: ['b'], changed: [] });
  assert.match(text, /new: a; removed: b\./);
  assert.doesNotMatch(text, /reconnect_mcp/);
  assert.equal(tc.noticeText({ added: [], removed: [], changed: [] }), undefined);
});

test('only a claude agent gets the stale-schema hint for a changed tool; codex and opencode get the list alone', () => {
  const d = { added: [], removed: [], changed: ['send_mail'] };
  const claude = tc.noticeText(d, 'claude');
  assert.match(claude, /changed: send_mail/);
  assert.match(claude, /may be stale/);
  for (const harness of ['codex', 'opencode']) {
    const text = tc.noticeText(d, harness);
    assert.match(text, /changed: send_mail/);
    assert.doesNotMatch(text, /may be stale/);
  }
  assert.equal(tc.noticeText({ added: [], removed: [], changed: [] }, 'claude'), undefined);
});

test.after(() => rmSync(home, { recursive: true, force: true }));
