#!/usr/bin/env node
// S-3329: an agent's identity (STAM_AGENT_ID, STAM_AGENT_NAME, STAM_TOKEN, and each MOOTR_ twin) reaches only the process it
// belongs to. A parent env that carries the identity is given to each spawn path, and the child's env is checked: agentExec's
// modes (file, fileSync, the compactor's shape, the session env the OpenCode server and an agent's own session use). Real child
// processes; no daemon, multiplexer or network: `node --test test/agent-identity.test.mjs`.
import './scrub-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentExec } from '../src/agent-exec.ts';
import * as env from '../src/env.ts';
import { sessionCommand } from '../src/tmux.ts';

// The parent's identity, as a daemon or agent shell carries it: both names of each variable.
const PARENT = { STAM_AGENT_ID: 'parent', MOOTR_AGENT_ID: 'parent', STAM_AGENT_NAME: 'parent', MOOTR_AGENT_NAME: 'parent', STAM_TOKEN: 'parent-tok', MOOTR_TOKEN: 'parent-tok' };
const PRINT = 'printf "%s|%s|%s" "${MOOTR_AGENT_ID-unset}" "${STAM_AGENT_ID-unset}" "${MOOTR_TOKEN-unset}"';

// Runs `PRINT` in a child started with `env` on top of a parent that holds PARENT, in the mode `mode` names.
async function childSees(mode, env) {
  const saved = { ...process.env };
  Object.assign(process.env, PARENT);
  try {
    if (mode === 'fileSync') return agentExec(['sh', '-c', PRINT], env, { mode: 'fileSync' });
    return (await agentExec(['sh', '-c', PRINT], env, { mode: 'file' })).stdout;
  } finally {
    for (const k of Object.keys(PARENT)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

test('the identity names are the STAM_ names and their MOOTR_ twins', () => {
  assert.deepEqual(env.AGENT_IDENTITY, ['STAM_AGENT_ID', 'STAM_AGENT_NAME', 'STAM_TOKEN']);
  assert.deepEqual(env.withMootrTwins(env.AGENT_IDENTITY), ['STAM_AGENT_ID', 'MOOTR_AGENT_ID', 'STAM_AGENT_NAME', 'MOOTR_AGENT_NAME', 'STAM_TOKEN', 'MOOTR_TOKEN']);
});

test('withoutIdentity drops both names of each identity variable the env does not set', () => {
  const base = { PATH: '/bin', ...PARENT, MOOTR_HOME: '/m' };
  assert.deepEqual(env.withoutIdentity(base, {}), { PATH: '/bin', MOOTR_HOME: '/m' });
  assert.deepEqual(env.withoutIdentity(base, { STAM_AGENT_ID: 'child', MOOTR_AGENT_ID: 'child' }), { PATH: '/bin', MOOTR_HOME: '/m', STAM_AGENT_ID: 'child', MOOTR_AGENT_ID: 'child' });
  // An explicit MOOTR_ name is the child's own, even without its STAM_ name.
  assert.deepEqual(env.withoutIdentity(base, { MOOTR_TOKEN: 'mine' }), { PATH: '/bin', MOOTR_HOME: '/m', MOOTR_TOKEN: 'mine' });
});

test('a file-mode child with no identity of its own does not inherit the parent\'s', async () => {
  assert.equal(await childSees('file', {}), 'unset|unset|unset');
});

test('a sync child with no identity of its own does not inherit the parent\'s', async () => {
  assert.equal(await childSees('fileSync', {}), 'unset|unset|unset');
});

test('the Claude compactor\'s blank identity blanks both names, and its token stays out', async () => {
  // src/adapters/claude.ts: `{ STAM_AGENT_ID: '', STAM_COMPACTOR }`; both names are empty, so no id reaches the compactor.
  assert.equal(await childSees('file', { STAM_AGENT_ID: '', STAM_COMPACTOR: 'a1:' }), '||unset');
});

test('a child given its own identity gets it under both names, and no inherited token', async () => {
  assert.equal(await childSees('file', { STAM_AGENT_ID: 'child' }), 'child|child|unset');
});

test('the OpenCode server\'s session drops the identity it does not set, under both names', () => {
  // src/adapters/opencode.ts startServer: a session env with no identity of its own.
  const cmd = sessionCommand('opencode', '/w', { OPENCODE_CONFIG_DIR: '/c', STAM_URL: 'http://x', STAM_TOKEN: 'tok' }, ['opencode', 'serve']);
  const shell = cmd.at(-1);
  assert.match(shell, /\/usr\/bin\/env .*-u STAM_AGENT_ID/);
  assert.match(shell, /-u MOOTR_AGENT_ID/);
  assert.match(shell, /-u STAM_AGENT_NAME/);
  assert.match(shell, /-u MOOTR_AGENT_NAME/);
  assert.ok(!shell.includes('-u MOOTR_TOKEN') && !shell.includes('-u STAM_TOKEN'), 'the token the server sets is kept');
  assert.ok(cmd.includes('MOOTR_TOKEN=tok'), 'the server\'s token reaches it under both names');
});

test('an agent session keeps its own identity under both names, and nothing is scrubbed for it', () => {
  // src/lifecycle.ts: `{ ...spec.env, STAM_AGENT_ID: a.id, STAM_URL, STAM_TOKEN }`.
  const cmd = sessionCommand('a1', '/w', { STAM_AGENT_ID: 'a1', STAM_URL: 'http://x', STAM_TOKEN: 'tok' }, ['claude']);
  assert.ok(cmd.includes('MOOTR_AGENT_ID=a1'), 'the twin is set');
  assert.ok(cmd.includes('MOOTR_TOKEN=tok'), 'the token twin is set');
  assert.ok(!cmd.at(-1).includes('-u MOOTR_AGENT_ID') && !cmd.at(-1).includes('-u STAM_AGENT_ID'), 'the agent\'s own id is not scrubbed');
});
