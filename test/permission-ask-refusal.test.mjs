#!/usr/bin/env node
// A permission request with a blank action (or a blank reason where it reaches the human) is refused when it is sent
// (S-3203): it reached the user as an empty ask. refusalFor (src/permissions.ts) routes the ask as requestPermission does and
// checks it; POST /api/permissions and requestPermission both run it first, so a refusal stores no permission row,
// sends no mail and makes no notice.
// Run with `node --test test/permission-ask-refusal.test.mjs`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-ask-refusal-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `ask-refusal-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), '{}');

let permissions;
let dbm;
before(async () => {
  permissions = await import('../src/permissions.ts');
  dbm = await import('../src/db.ts');
});

const requestCount = () => dbm.open().prepare('SELECT COUNT(*) AS n FROM permission_requests').get().n;
// An agent with no row, so no parent or chief of staff: a delegate ask reaches the human.
const orphan = () => ({ id: 'a-ask-refusal', name: 'refusal-dev' });

test('an empty action is refused, whatever the routing', () => {
  for (const toHuman of [true, false]) {
    const msg = permissions.askRefusal('', 'why', toHuman);
    assert.match(msg, /`action` is required/, `toHuman ${toHuman}`);
    assert.match(msg, /what you need to do, in one line/);
    assert.match(msg, /exact command in `details`/);
  }
});

test('a whitespace-only action is refused', () => {
  assert.match(permissions.askRefusal('   \n\t', 'why', true), /`action` is required/);
  assert.match(permissions.askRefusal(' ', 'why', false), /`action` is required/);
});

test('an action that is missing altogether is refused', () => {
  assert.match(permissions.askRefusal(undefined, 'why', true), /`action` is required/);
  assert.match(permissions.askRefusal(null, 'why', false), /`action` is required/);
});

test('an empty reason is refused when the request reaches the human, and names the field', () => {
  for (const reason of ['', '  ']) {
    assert.match(permissions.askRefusal('git push', reason, true), /`reason` is required when the request reaches your user/);
  }
});

test('an empty reason is still accepted when the request does not reach the human', () => {
  assert.equal(permissions.askRefusal('git push', '', false), null);
});

test('a delegate ask with a blank reason and no parent or chief of staff is refused, since it reaches the human', () => {
  assert.match(permissions.refusalFor(orphan(), 'git push', '  ', 'delegate'), /`reason` is required/);
  assert.match(permissions.refusalFor(orphan(), 'git push', '', undefined), /`reason` is required/);
});

test('a complete request is accepted', () => {
  assert.equal(permissions.refusalFor(orphan(), 'git push origin HEAD', 'the commit is blocked by auto mode', 'human'), null);
});

test('requestPermission refuses a blank action and stores nothing', async () => {
  const before = requestCount();
  await assert.rejects(permissions.requestPermission(orphan(), '', 'why', '', false, {}, 'human'), /`action` is required/);
  await assert.rejects(permissions.requestPermission(orphan(), '  ', 'why', '', false, {}, 'delegate'), /`action` is required/);
  assert.equal(requestCount(), before);
});

test('requestPermission refuses a blank reason where the ask reaches the human, and stores nothing', async () => {
  const before = requestCount();
  await assert.rejects(permissions.requestPermission(orphan(), 'git push', '', '', false, {}, 'human'), /`reason` is required/);
  await assert.rejects(permissions.requestPermission(orphan(), 'git push', '   ', '', false, {}, 'delegate'), /`reason` is required/);
  assert.equal(requestCount(), before);
});
