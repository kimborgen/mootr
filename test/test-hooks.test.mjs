import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { testHooksAllowed } from '../src/test-hooks.ts';

const live = join(homedir(), '.local', 'share', 'stam');
const on = { STAM_TEST_COST_HOOKS: '1', STAM_HOME: '/tmp/stam-test.x/main' };

test('the cost test hooks are on only for an isolated test daemon', () => {
  assert.equal(testHooksAllowed(on, '/tmp/stam-test.x/main', 'stam-test-x-main'), true);
});
test('off by default and for any value but 1', () => {
  assert.equal(testHooksAllowed({ STAM_HOME: on.STAM_HOME }, on.STAM_HOME, 'stam-test-x'), false);
  for (const v of ['0', '', 'true', '2']) assert.equal(testHooksAllowed({ ...on, STAM_TEST_COST_HOOKS: v }, on.STAM_HOME, 'stam-test-x'), false);
});
test('refused on the default home and the default socket', () => {
  assert.equal(testHooksAllowed({ STAM_TEST_COST_HOOKS: '1' }, live, 'stam-test-x'), false);
  assert.equal(testHooksAllowed({ ...on, STAM_HOME: live }, live, 'stam-test-x'), false);
  assert.equal(testHooksAllowed(on, on.STAM_HOME, 'stam'), false);
});

// S-1732: one gate for every /api/test/* route, in the dispatcher, on the prefix.
const daemon = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
const cost = readFileSync(new URL('./e2e-cost.sh', import.meta.url), 'utf8');
const names = [...daemon.matchAll(/\/\^\\\/api\\\/test\\\/([\w-]+)\$\//g)].map((m) => m[1]);

test('the dispatcher gates the /api/test/ prefix before it matches a route', () => {
  const gate = daemon.indexOf("path.startsWith('/api/test/')");
  const loop = daemon.indexOf('for (const [method, re, handler] of routes)');
  assert.ok(gate > 0 && gate < loop, 'the prefix gate must come before the route loop');
  const block = daemon.slice(gate, loop);
  assert.match(block, /testHooksAllowed\(/);
  assert.match(block, /notAgentToken\(caller/);
});
test('no /api/test handler carries its own gate', () => {
  for (const n of names) {
    const at = daemon.search(new RegExp(String.raw`/\^\\/api\\/test\\/${n}\$/`));
    const handler = daemon.slice(at, at + 400);
    assert.doesNotMatch(handler.split(/\n    \[|\n    \/\//)[0], /testHooksAllowed|notAgentToken/, `${n} gates itself`);
  }
});
test('e2e-cost.sh sends an agent token to every /api/test route and expects a refusal', () => {
  assert.ok(names.length >= 7, `found ${names.length} routes`);
  for (const n of names) {
    const re = n === 'cost' ? /hooks_code "\$W1_TOKEN"\)" = 403/ : new RegExp(`hook_code "\\$W1_TOKEN" ${n} .*= 403`);
    assert.match(cost, re, `no agent-token refusal check for /api/test/${n}`);
  }
  assert.match(cost, /hook_code "\$W1_TOKEN" no-such-hook .*= 403/);
});
