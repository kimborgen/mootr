#!/usr/bin/env node
// MCP servers from settings.mcpServers reach every harness the same way, with a `headers`
// field for remote servers and an `enabled` switch. Runs against a throwaway STAM_HOME with
// no daemon and no model: it checks what each adapter writes (Claude Code's mcp-config file,
// OpenCode's config) or passes (Codex's app-server overrides and its own environment).
// `node --test test/mcp-servers.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-mcp-servers-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `mcp-servers-test-${process.pid}`;
// Nothing here talks to a daemon; drop pointers to the live one anyway.
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

// The agent's own identity and token, as Codex forwards them: each STAM_ name with its MOOTR_ twin (S-3345).
const AGENT_ENV_NAMES = ['STAM_AGENT_ID', 'MOOTR_AGENT_ID', 'STAM_URL', 'MOOTR_URL', 'STAM_TOKEN', 'MOOTR_TOKEN'];
const CTX_SECRET = 'ctx-secret-5f3a';
const REMOTE_SECRET = 'Bearer remote-secret-9b2c';
const OAUTH_SECRET = 'oauth-secret-7d1e';
writeFileSync(
  join(home, 'settings.json'),
  JSON.stringify({
    mcpServers: {
      ctx: { command: '/usr/bin/echo', args: ['hi'], env: { CTX_API_KEY: CTX_SECRET } },
      remote: { url: 'https://mcp.example.com/mcp', headers: { Authorization: REMOTE_SECRET } },
      auth: { url: 'https://mcp.example.com/oauth', auth: { type: 'oauth', client_id: 'cid', client_secret: OAUTH_SECRET } },
      off: { command: '/usr/bin/echo', args: ['no'], enabled: false, env: { LEAK: 'must-not-reach-anywhere' } },
    },
  }),
);

let db, instructions, claude, codex, opencode, STAM_BIN;
before(async () => {
  // Import the adapter index first, as codex-usage.test.mjs does: it keeps a module cycle
  // from seeing codex before it is initialized.
  await import('../src/adapters/index.ts');
  db = await import('../src/db.ts');
  instructions = await import('../src/instructions.ts');
  claude = (await import('../src/adapters/claude.ts')).claude;
  codex = await import('../src/adapters/codex.ts');
  opencode = await import('../src/adapters/opencode.ts');
  ({ STAM_BIN } = await import('../src/config.ts'));
});
after(() => rmSync(home, { recursive: true, force: true }));

let n = 0;
function agent(harness, session = null) {
  const id = `mcp-${harness}-${++n}`;
  db.createAgent({ id, name: id, role: 'test', machine: 'x', harness, model: null, effort: null, cwd: tmpdir(), parent_id: null, session_id: session });
  return db.getAgent(id);
}

test('settings.mcpServers > only enabled servers reach a harness', () => {
  assert.deepEqual(Object.keys(instructions.extraMcpServers()).sort(), ['auth', 'ctx', 'remote']);
});

test('claude > the mcp-config file gets every server, with headers and type, mode 0600', async () => {
  const a = agent('claude', 'claude-session-1');
  await claude.launch(a);
  const file = join(home, 'agents', a.id, 'claude-mcp.json');
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(cfg.mcpServers.ctx, { command: '/usr/bin/echo', args: ['hi'], env: { CTX_API_KEY: CTX_SECRET } });
  assert.deepEqual(cfg.mcpServers.remote, { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: REMOTE_SECRET } });
  assert.deepEqual(cfg.mcpServers.auth, { command: STAM_BIN, args: ['mcp-proxy', 'auth'] }, 'an auth server is the stdio proxy');
  assert.ok(!readFileSync(file, 'utf8').includes(OAUTH_SECRET), 'the client secret reaches Claude Code');
  assert.equal(cfg.mcpServers.off, undefined);
  assert.ok(cfg.mcpServers.stam, 'stam keeps its own server');
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('opencode > remote servers get headers; a disabled one stays out', () => {
  const servers = opencode.opencodeMcpServers();
  assert.deepEqual(servers.ctx, { type: 'local', command: ['/usr/bin/echo', 'hi'], environment: { CTX_API_KEY: CTX_SECRET } });
  assert.deepEqual(servers.remote, { type: 'remote', url: 'https://mcp.example.com/mcp', headers: { Authorization: REMOTE_SECRET } });
  assert.deepEqual(servers.auth, { type: 'local', command: [STAM_BIN, 'mcp-proxy', 'auth'] }, 'an auth server is the stdio proxy');
  assert.ok(!JSON.stringify(servers).includes(OAUTH_SECRET), 'the client secret reaches OpenCode');
  assert.equal(servers.off, undefined);
  assert.ok(servers.stam, 'stam keeps its own server');
});

test('codex > overrides carry names, the environment carries the values', () => {
  const { overrides, env } = codex.codexMcpServers();
  assert.deepEqual(overrides['mcp_servers.ctx'], { command: '/usr/bin/echo', args: ['hi'], env_vars: ['CTX_API_KEY'] });
  assert.deepEqual(overrides['mcp_servers.remote'], { url: 'https://mcp.example.com/mcp', env_http_headers: { Authorization: 'STAM_MCP_REMOTE_AUTHORIZATION' } });
  // Each STAM_ name carries its MOOTR_ twin (S-3345): the agent's own identity and token, nothing else.
  assert.deepEqual(overrides['mcp_servers.auth'], { command: STAM_BIN, args: ['mcp-proxy', 'auth'], env_vars: AGENT_ENV_NAMES }, 'an auth server is the stdio proxy');
  assert.equal(overrides['mcp_servers.off'], undefined);
  assert.deepEqual(env, { CTX_API_KEY: CTX_SECRET, STAM_MCP_REMOTE_AUTHORIZATION: REMOTE_SECRET });
  const onArgv = JSON.stringify(overrides);
  assert.ok(!onArgv.includes(CTX_SECRET) && !onArgv.includes(REMOTE_SECRET) && !onArgv.includes(OAUTH_SECRET), `a secret is on the command line: ${onArgv}`);
});

test('codex > the launch script puts the values in the app-server environment, not argv', async () => {
  const a = agent('codex');
  // A matching trust cache short-circuits hookTrust, so no Codex app-server is probed.
  writeFileSync(join(home, 'codex-hook-trust.json'), JSON.stringify({ version: codex.codex.version(), command: `${STAM_BIN} hook codex`, state: {} }));
  const spec = await codex.codex.launch(a);
  const script = readFileSync(join(home, 'agents', a.id, 'codex-launch.sh'), 'utf8');
  assert.ok(script.includes('mcp_servers.ctx=') && script.includes('mcp_servers.remote='), script);
  assert.ok(script.includes('mcp_servers.auth=') && script.includes('mcp-proxy'), 'an auth server reaches Codex as the stdio proxy');
  assert.ok(!script.includes(OAUTH_SECRET), 'the client secret reaches the Codex launch script');
  assert.ok(!script.includes('mcp_servers.off='), 'a disabled server reaches no harness');
  assert.ok(script.includes('"env_vars"=["CTX_API_KEY"]'), script);
  // stam's own server gets the agent's STAM_ names with their MOOTR_ twins (S-3345), and no other MOOTR_ name.
  const stamServer = script.match(/mcp_servers\.stam=\{[^}]*\}/)?.[0] ?? '';
  assert.ok(stamServer.includes(`"env_vars"=[${AGENT_ENV_NAMES.map((n) => `"${n}"`).join(',')}]`), stamServer);
  // Codex's default tool timeout is 60 s; pr_review waits up to 190 s, so stam's server gets more (S-3596).
  assert.ok(stamServer.includes('"tool_timeout_sec"=240'), stamServer);
  const mootrNames = script.match(/MOOTR_[A-Z_]+/g) ?? [];
  assert.ok(mootrNames.every((n) => AGENT_ENV_NAMES.includes(n)), `a MOOTR_ name beyond the agent's twins: ${mootrNames}`);
  assert.ok(script.includes('"env_http_headers"={"Authorization"="STAM_MCP_REMOTE_AUTHORIZATION"}'), script);
  // The values are the app-server's environment, set by this script and nothing else.
  assert.ok(script.includes(`CTX_API_KEY=${CTX_SECRET}`) || script.includes(`CTX_API_KEY='${CTX_SECRET}'`), script);
  assert.ok(script.includes(`STAM_MCP_REMOTE_AUTHORIZATION='${REMOTE_SECRET}'`) || script.includes(`STAM_MCP_REMOTE_AUTHORIZATION=${REMOTE_SECRET}`), script);
  // Nothing secret is inside the app-server's own command line, where `ps` would show it.
  const serverCmd = script.slice(script.indexOf('app-server --listen'));
  assert.ok(!serverCmd.includes(CTX_SECRET) && !serverCmd.includes(REMOTE_SECRET), `a secret is on the app-server command line: ${serverCmd}`);
  assert.equal(statSync(join(home, 'agents', a.id, 'codex-launch.sh')).mode & 0o777, 0o600);
  assert.deepEqual(spec.env, {}, 'nothing secret rides in tmux env or argv');
  assert.deepEqual(spec.argv, ['sh', join(home, 'agents', a.id, 'codex-launch.sh')]);
});
