#!/usr/bin/env node
// The MCP config parsers and the connection test (S-51). Free: a throwaway STAM_HOME, a
// small stdio MCP server the test writes, and a streamable-HTTP MCP server in process.
// `node --test test/mcp-config.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-mcp-config-');
process.env.STAM_HOME = home;
// The fake servers are http on loopback; mcp-auth's trust boundary allows it only in tests.
process.env.STAM_MCP_AUTH_INSECURE = '1';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let parseMcpConfig, testServer;
before(async () => ({ parseMcpConfig, testServer } = await import('../src/mcp-config.ts')));

// A stdio MCP server: answers initialize and tools/list, and names a tool after the
// environment value stam passed, so the test proves the env travels.
const STDIO = `
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18' } }) + '\\n');
    else if (m.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'alpha-' + (process.env.FOO || 'none') }, { name: 'beta' }] } }) + '\\n');
  }
});
`;
const stdioPath = join(home, 'stdio-mcp.mjs');
writeFileSync(stdioPath, STDIO);
const failPath = join(home, 'fail-mcp.mjs');
writeFileSync(failPath, `process.stderr.write('no such server\\n'); process.exit(1);\n`);

// A streamable-HTTP MCP server: initialize hands out a session id, a notification is a 202,
// and tools/list streams its answer over SSE. It records the bearer it saw.
const seen = [];
let httpPort = 0;
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const msg = JSON.parse(body || '{}');
    if (msg.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18' } }));
      return;
    }
    if (msg.id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }
    if (msg.method === 'tools/list') {
      if (req.headers['mcp-session-id'] !== 's1') return res.writeHead(400).end();
      seen.push(req.headers.authorization ?? '');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'ping' }, { name: 'pong' }] } })}\n\n`);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
  });
});
before(() => new Promise((r) => fake.listen(0, '127.0.0.1', () => { httpPort = fake.address().port; r(); })));
after(() => { fake.close(); rmSync(home, { recursive: true, force: true }); });

test('Claude Code JSON: mcpServers, http and stdio', () => {
  const { servers, notes } = parseMcpConfig(JSON.stringify({ mcpServers: {
    remote: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer z' } },
    local: { command: 'npx', args: ['-y', 'srv'], env: { KEY: 'v' } },
  } }));
  assert.deepEqual(servers.remote, { url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer z' } });
  assert.deepEqual(servers.local, { command: 'npx', args: ['-y', 'srv'], env: { KEY: 'v' } });
  assert.deepEqual(notes, []);
});

test('a bare { name: server } map is Claude Code without the wrapper', () => {
  const { servers } = parseMcpConfig(JSON.stringify({ srv: { command: 'node', args: ['s.js'] } }));
  assert.deepEqual(servers.srv, { command: 'node', args: ['s.js'] });
});

test('a bare map with an sse url and a disabled server', () => {
  const { servers } = parseMcpConfig(JSON.stringify({ a: { type: 'sse', url: 'https://x/sse' }, b: { command: 'x', enabled: false } }));
  assert.deepEqual(servers.a, { url: 'https://x/sse' });
  assert.equal(servers.b.enabled, false);
});

test('OpenCode JSON: mcp, local arrays and remote headers', () => {
  const { servers } = parseMcpConfig(JSON.stringify({ $schema: 'x', mcp: {
    local: { type: 'local', command: ['node', 's.js'], environment: { KEY: 'v' } },
    remote: { type: 'remote', url: 'https://mcp.example.com/mcp', headers: { A: 'b' } },
  } }));
  assert.deepEqual(servers.local, { command: 'node', args: ['s.js'], env: { KEY: 'v' } });
  assert.deepEqual(servers.remote, { url: 'https://mcp.example.com/mcp', headers: { A: 'b' } });
});

test('OpenCode JSON: also servers under mcp.servers', () => {
  const { servers } = parseMcpConfig(JSON.stringify({ mcp: { servers: { s: { type: 'remote', url: 'https://y' } } } }));
  assert.deepEqual(servers.s, { url: 'https://y' });
});

test('Codex TOML: tables, args, env, http_headers, and env-var notes', () => {
  const { servers, notes } = parseMcpConfig(`
# a server
[mcp_servers.local]
command = "npx"
args = ["-y", "server"]
env = { API_KEY = "secret" }

[mcp_servers.remote]
url = "https://mcp.example.com/mcp"
http_headers = { Authorization = "Bearer z" }
bearer_token_env_var = "TOKEN"

[mcp_servers.envhdr]
url = "https://y"
env_http_headers = { X_Token = "ENV_X" }
`);
  assert.deepEqual(servers.local, { command: 'npx', args: ['-y', 'server'], env: { API_KEY: 'secret' } });
  assert.deepEqual(servers.remote, { url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer z' } });
  assert.deepEqual(servers.envhdr, { url: 'https://y' });
  assert.ok(notes.some((n) => n.includes('TOKEN')), `no note for bearer_token_env_var: ${notes}`);
  assert.ok(notes.some((n) => n.includes('X_Token')), `no note for env_http_headers: ${notes}`);
});

test('Codex TOML: a whole config.toml pastes, other tables ignored', () => {
  const { servers } = parseMcpConfig(`
model = "gpt-5"
[mcp_servers.docs]
url = "https://docs.example.com/mcp"
[projects."/work"]
trust_level = "trusted"
`);
  assert.deepEqual(servers.docs, { url: 'https://docs.example.com/mcp' });
  assert.deepEqual(Object.keys(servers), ['docs']);
});

test('TOML: literal strings, quoted keys, and dotted keys', () => {
  const { servers } = parseMcpConfig(`
mcp_servers.other.url = "https://z"

[mcp_servers."my server"]
command = 'node'
args = ["a", "b"]
`);
  assert.deepEqual(servers['my server'], { command: 'node', args: ['a', 'b'] });
  assert.deepEqual(servers.other, { url: 'https://z' });
});

test('a config with no servers is refused with a reason', () => {
  assert.throws(() => parseMcpConfig(''), /Paste/);
  assert.throws(() => parseMcpConfig('{"foo": 1}'), /No MCP servers/);
  assert.throws(() => parseMcpConfig('not json or toml'), /neither JSON/);
  assert.throws(() => parseMcpConfig('[model_providers.x]\nurl = "y"'), /No mcp_servers/);
});

test('testServer: a stdio server is spawned with its env and lists its tools', async () => {
  const r = await testServer('echo', { command: process.execPath, args: [stdioPath], env: { FOO: 'bar' } });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.tools, ['alpha-bar', 'beta']);
});

test('testServer: a stdio server that fails reports its stderr', async () => {
  const r = await testServer('bad', { command: process.execPath, args: [failPath] });
  assert.equal(r.ok, false);
  assert.match(r.error, /no such server/);
});

test('testServer: a remote server gets initialize, the session id, and tools/list', async () => {
  seen.length = 0;
  const r = await testServer('remote', { url: `http://127.0.0.1:${httpPort}/mcp` });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.tools, ['ping', 'pong']);
  assert.deepEqual(seen, ['']);
});

test('testServer: an auth server sends the stored bearer', async () => {
  const url = `http://127.0.0.1:${httpPort}/mcp`;
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ mcpServers: { secured: { url, auth: { type: 'oauth' } } } }));
  writeFileSync(join(home, 'mcp-auth.json'), JSON.stringify({ secured: {
    server_url: url, client_id: 'cid', access_token: 'tok-123', expires_at: Date.now() + 3_600_000,
    token_endpoint: `http://127.0.0.1:${httpPort}/token`, resource: url,
  } }));
  seen.length = 0;
  const r = await testServer('secured', { url, auth: { type: 'oauth' } });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.tools, ['ping', 'pong']);
  assert.deepEqual(seen, ['Bearer tok-123']);
  rmSync(join(home, 'settings.json'));
  rmSync(join(home, 'mcp-auth.json'));
});

test('testServer: a server with neither command nor url is refused', async () => {
  const r = await testServer('none', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /no command or url/);
});
