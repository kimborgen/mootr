#!/usr/bin/env node
// The MCP settings page's status (S-3178), free: no daemon. A peer's status is its own rows plus the home's
// shared rows; with the home down it keeps its own rows and says so. On the home, a server is shared only when
// its shareWithPeers is on.
//   node --test test/mcp-peer-page.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-mcp-peer-page-');
process.env.STAM_HOME = home;
process.env.STAM_MACHINE = 'peer-box';
// The loopback urls are allowed only for a test; no provider is contacted.
process.env.STAM_MCP_AUTH_INSECURE = '1';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

const HOME_NAME = 'home-box';
const LEASE_TOKEN = 'LEASE-PAGE';
const B = 'http://203.0.113.9/remote';
const LOCAL_ACCESS = 'LOCAL-ACCESS-PAGE';
const LOCAL_REFRESH = 'LOCAL-REFRESH-PAGE';

let mcpAuth, server, homeUrl;
// The rows the home answers with on its status route; a request with another lease token is refused.
let homeRows = [];
let homeAnswers = 200;

const writeSettings = (homeAddress) =>
  writeFileSync(
    join(home, 'settings.json'),
    JSON.stringify({
      home: HOME_NAME,
      peers: [{ name: HOME_NAME, url: homeAddress, token: 'shared-token', leaseToken: LEASE_TOKEN }],
      mcpServers: {
        remote: { url: B, auth: { type: 'oauth' } },
        private: { url: 'http://203.0.113.10/private', auth: { type: 'oauth' } },
        gh: { url: 'http://203.0.113.11/gh', auth: { type: 'gh' } },
      },
    }),
  );

before(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== `Bearer ${LEASE_TOKEN}`) {
      res.writeHead(403);
      return res.end(JSON.stringify({ error: 'not the lease token' }));
    }
    res.writeHead(homeAnswers);
    res.end(JSON.stringify(homeAnswers === 200 ? { servers: homeRows } : { error: 'the lease token is over its cap' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  homeUrl = `http://127.0.0.1:${server.address().port}`;
  // A grant the peer still holds from before the lease (S-3177): it must show as a local grant, never as logged in.
  writeFileSync(
    join(home, 'mcp-auth.json'),
    JSON.stringify({ remote: { server_url: B, client_id: 'stam', token_endpoint: `${homeUrl}/token`, resource: B, access_token: LOCAL_ACCESS, refresh_token: LOCAL_REFRESH, expires_at: Date.now() + 3_600_000 } }),
  );
  writeSettings(homeUrl);
  mcpAuth = await import('../src/mcp-auth.ts');
});

after(() => {
  server?.close();
  rmSync(home, { recursive: true, force: true });
});

test('peer > the page lists its own gh row and the home’s rows, each marked leased from the home', async () => {
  writeSettings(homeUrl);
  homeAnswers = 200;
  homeRows = [{ name: 'remote', type: 'oauth', logged_in: true, expires_at: null }];
  const page = await mcpAuth.status();
  assert.deepEqual(page.home, { name: HOME_NAME, reachable: true });
  const leased = page.servers.find((r) => r.name === 'remote' && r.leased_from);
  assert.equal(leased?.leased_from, HOME_NAME);
  assert.equal(leased?.logged_in, true);
  assert.ok(page.servers.some((r) => r.name === 'gh' && r.type === 'gh'), 'the peer keeps its gh row');
  const own = page.servers.find((r) => r.name === 'remote' && r.local_grant);
  assert.equal(own?.logged_in, false, 'an old local grant is never shown as logged in');
});

test('peer > the status carries no access, refresh or lease token', async () => {
  const text = JSON.stringify(await mcpAuth.status());
  assert.ok(!text.includes(LOCAL_ACCESS), 'no local access token');
  assert.ok(!text.includes(LOCAL_REFRESH), 'no local refresh token');
  assert.ok(!text.includes(LEASE_TOKEN), 'no lease token');
});

test('peer > with the home down, the status keeps the own rows and says HOME unreachable', async () => {
  // Nothing listens on this port, so the home's route can't be reached.
  writeSettings('http://127.0.0.1:1');
  const page = await mcpAuth.status();
  assert.equal(page.home.reachable, false);
  assert.match(page.home.error, /home-box is unreachable/);
  assert.ok(page.servers.some((r) => r.name === 'gh' && r.type === 'gh'), 'the gh row stays');
  assert.ok(page.servers.some((r) => r.name === 'remote' && r.local_grant), 'the own grant stays, as a grant');
  assert.ok(!page.servers.some((r) => r.leased_from), 'no home row, so no stale logged in');
  assert.ok(!page.servers.some((r) => r.logged_in === true && !r.type.includes('gh')), 'no oauth row is logged in');
});

test('peer > a home that refuses the lease token is reported with the refusal, not as logged in', async () => {
  writeSettings(homeUrl);
  homeAnswers = 403;
  try {
    const page = await mcpAuth.status();
    assert.equal(page.home.reachable, false);
    assert.match(page.home.error, /refused the lease token/);
    assert.ok(!page.servers.some((r) => r.leased_from), 'no leased row');
  } finally {
    homeAnswers = 200;
  }
});

test('home > a server is shared only when shareWithPeers is on', async () => {
  // This daemon is the home: its own name is the settings home, and its shared rows are the flagged servers.
  writeFileSync(
    join(home, 'settings.json'),
    JSON.stringify({
      home: 'peer-box',
      mcpServers: {
        remote: { url: B, auth: { type: 'oauth' }, shareWithPeers: true, leaseMaxSeconds: 900 },
        private: { url: 'http://203.0.113.10/private', auth: { type: 'oauth' } },
      },
    }),
  );
  const rows = await mcpAuth.sharedStatus();
  assert.deepEqual(rows.map((r) => r.name), ['remote'], 'only the flagged server is shared');
});

test('home > the status page has no home state, so the page shows the login buttons', async () => {
  const page = await mcpAuth.status();
  assert.equal(page.home, null);
});
