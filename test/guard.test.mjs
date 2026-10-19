#!/usr/bin/env node
// Unit tests for src/guard.ts: the broad-kill matcher refuses pkill, killall, and kills fed
// by a pgrep or ps lookup, and allows kills by PID or %job and unrelated Bash. Deterministic,
// no daemon. Run with `node --test test/guard.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBroadKill, guardOutput } from '../src/guard.ts';

const refused = [
  'pkill -f web/check/daemon.sh',
  'pkill daemon',
  'pkill -9 -f stam',
  'killall node',
  'sudo killall -9 chromium',
  'echo ok; pkill -f x',
  'true && pkill -f x',
  'false || killall node',
  'sudo pkill -f x',
  'env FOO=1 pkill x',
  'xargs pkill x',
  'bash -c "pkill -f x"',
  'echo $(pkill x)',
  'echo `killall node`',
  'pgrep -f daemon.sh | xargs kill',
  'pgrep -f daemon.sh | xargs -r kill -9',
  'pgrep -f daemon.sh | sudo xargs kill',
  'pidof node | xargs kill',
  'kill $(pgrep -f daemon.sh)',
  'kill `pgrep daemon`',
  'kill "$(pgrep -f daemon.sh)"',
  'for p in $(pgrep -f daemon.sh); do kill $p; done',
  'for p in $(pgrep -f daemon.sh); do\n  kill "$p"\ndone',
  'ps aux | grep daemon | awk \'{print $2}\' | xargs kill',
  'kill $(ps -ef | grep web/check | awk \'{print $2}\')',
];

const allowed = [
  'kill 1234',
  'kill -9 1234',
  'kill -TERM 4321',
  'kill %1',
  'kill $!',
  'kill "$PID"',
  'kill -0 1234',
  'kill -s 0 1234',
  'kill -0 $(pgrep -f x)',
  'kill $(cat /tmp/x/daemon.pid)',
  'kill -l',
  'ps -p 1234 -o pid,cmd',
  'pgrep -f daemon.sh',
  'ps -p 1234 -o cmd; kill -0 1234',
  'ps aux | grep node; kill "$PID"',
  'ps -p "$PID"; kill %1',
  'ps aux | grep " kill "',
  'echo $(pgrep x); kill 1234',
  'echo "Use pkill -f only in examples"',
  'rg "avoid killall node" docs',
  'git commit -m "Block pkill -f in agents"',
  'echo hi # pkill -f x',
  'cat <<EOF > notes.txt\npkill -f x\nkillall node\nEOF\nls',
  'cat <<\'EOF\'\nkill $(pgrep x) | xargs kill\nEOF',
  'echo npkill is fine',
  'node web/check/daemon.sh & echo $! > x.pid',
  'ls -la',
  'echo "unterminated',
];

for (const c of refused) test(`refuses: ${c}`, () => assert.equal(isBroadKill(c), true));
for (const c of allowed) test(`allows: ${c}`, () => assert.equal(isBroadKill(c), false));

test('guardOutput denies a broad kill on Bash with a PID-only message', () => {
  const out = JSON.parse(guardOutput({ tool_name: 'Bash', tool_input: { command: 'pkill -f daemon.sh' } }));
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /Kill only by PID/);
});

test('guardOutput says nothing for allowed kills, other tools, and missing input', () => {
  assert.equal(guardOutput({ tool_name: 'Bash', tool_input: { command: 'kill 1234' } }), '');
  assert.equal(guardOutput({ tool_name: 'Edit', tool_input: { command: 'pkill x' } }), '');
  assert.equal(guardOutput({ tool_name: 'Bash', tool_input: {} }), '');
});
