#!/usr/bin/env node
// S-3508, through the route: POST /api/subscriptions, the call watch_pr makes, on a real daemon (runDaemon, as
// daemon-lock.test.mjs starts one). A reviewer agent that watches a PR joins the ITSA whose github link names it, as a
// participant with the owner unchanged; a developer that watches the same PR joins nothing. The agents are written to the
// home's database before the daemon starts, with the types a spawn would give them. Free: no model, no harness.
// `node --test test/watch-pr-route.test.mjs`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmphome.mjs';
import { killTmuxServer } from '../src/tmux-socket.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const NAME = 'routehome';
const TOKEN = `token-${NAME}`;
const PR = 'github:example/stam#42';
const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// A throwaway home shaped as daemon-lock.test.mjs's testHome makes one: its own port, tmux socket, and token.
const home = tempDir('stam-watch-route-');
writeFileSync(join(home, '.stam-test-home'), '');
writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [], itsa: { home: NAME } }) + '\n');
writeFileSync(join(home, 'token'), `${TOKEN}\n`, { mode: 0o600 });
writeFileSync(join(home, 'peer-token'), `peer-${NAME}\n`, { mode: 0o600 });
mkdirSync(join(home, 'opencode-data'));
writeFileSync(join(home, 'opencode.env'), `XDG_DATA_HOME=${join(home, 'opencode-data')}\n`, { mode: 0o600 });
const port = await freePort();
const socket = `stam-test-watch-route-${process.pid}`;
const URL_BASE = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  STAM_HOME: home,
  STAM_PORT: String(port),
  STAM_URL: URL_BASE,
  STAM_TMUX_SOCKET: socket,
  STAM_MACHINE: NAME,
  STAM_BIND: '127.0.0.1',
  STAM_OPENCODE_PORT: String(await freePort()),
  STAM_AGENTS_SKILLS: join(home, 'agents-skills'),
  STAM_EMBEDDER: 'stub',
};
for (const k of ['STAM_AGENT_ID', 'STAM_TOKEN']) delete env[k];

// The agents, written before the daemon starts: a reviewer and a developer, typed as a spawn types them.
process.env.STAM_HOME = home;
process.env.STAM_MACHINE = NAME;
const db = await import('../src/db.ts');
db.open();
const agent = (id, name, type) => {
  db.createAgent({ id, name, role: type, machine: NAME, harness: 'opencode', model: null, effort: null, cwd: home, parent_id: null, session_id: null });
  db.updateAgent(id, { type });
};
agent('rv-route', 'route-reviewer', 'reviewer');
agent('dv-route', 'route-developer', 'developer');

// The daemon, started as a script that calls runDaemon() does (daemon-lock.test.mjs).
const wrapper = join(tempDir('stam-watch-route-wrapper-'), 'wrapper.mjs');
writeFileSync(wrapper, `const { runDaemon } = await import(${JSON.stringify(`${root}src/daemon.ts`)});\nawait runDaemon();\n`);
const child = spawn('node', ['--no-warnings', wrapper], { env, stdio: ['ignore', 'ignore', 'pipe'] });
after(() => {
  child.kill('SIGKILL');
  killTmuxServer(socket);
});

const api = async (method, path, body) => {
  const r = await fetch(`${URL_BASE}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'x-stam-human': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const answers = async () => (await fetch(`${URL_BASE}/api/health`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.ok, () => false));
const until = async (cond, what) => {
  for (let i = 0; i < 150; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.fail(`timed out waiting for ${what}`);
};

test('watch_pr through POST /api/subscriptions joins a reviewer to the linked ITSA as a participant, and not a developer (S-3508)', async () => {
  await until(answers, 'the daemon to answer');
  const made = await api('POST', '/api/itsas', { title: 'Route linked PR', by: 'human', owner: 'human' });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const key = made.data.key;
  const link = await api('POST', `/api/itsas/${key}/links`, { system: 'github', url: 'https://github.com/example/stam/pull/42', external_id: '42' });
  assert.equal(link.status, 200, JSON.stringify(link.data));

  const watch = (agentId) => api('POST', '/api/subscriptions', { subscriber_kind: 'agent', subscriber_id: agentId, filter: { source: 'github', subjects: [PR], types: ['pull_request.closed'] }, by: 'human', note: 'PR #42 watch' });
  const participants = async () => (await api('GET', `/api/itsas/${key}`)).data.participants ?? [];

  assert.equal((await watch('dv-route')).status, 200);
  assert.ok(!(await participants()).includes('dv-route'), 'a developer that watches the PR joined the ITSA');

  assert.equal((await watch('rv-route')).status, 200);
  const got = await participants();
  assert.ok(got.includes('rv-route'), `the reviewer did not join: ${JSON.stringify(got)}`);
  assert.equal((await api('GET', `/api/itsas/${key}`)).data.owner, 'human', 'the owner moved');
});
