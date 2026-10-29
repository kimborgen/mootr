#!/usr/bin/env node
// The MCP lease (S-3176), free: no daemon, no network. The lease token's file and rotation, the refusals
// of leaseFor (each with its own status and message), the status rows for the shared servers, and the
// constant-time compare. A grant is seeded with a fresh access token, so no refresh (and no request) happens.
//   node --test test/mcp-lease.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync, rmSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-mcp-lease-');
process.env.STAM_HOME = home;
// The loopback url is allowed only for a test; nothing is fetched, since every grant is fresh.
process.env.STAM_MCP_AUTH_INSECURE = '1';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

const url = 'http://127.0.0.1:9/mcp';
const token_endpoint = 'http://127.0.0.1:9/token';
const fresh = Date.now() + 3_600_000;
const ACCESS = 'LEASE-ACCESS-1';
const grant = (access_token, extra = {}) => ({ server_url: url, client_id: 'stam-client', token_endpoint, resource: url, access_token, refresh_token: 'REFRESH-1', ...extra });

let config, mcpAuth, refreshServer, origin;
let flakyFails = 0;
// The stub token endpoint: a refresh returns a new access token with no expires_in.
const refreshCalls = [];

before(async () => {
  refreshServer = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      refreshCalls.push(body);
      // REFRESH-GOOD gets a lifetime; any other refresh token gets none. The answer waits, so two callers overlap.
      // REFRESH-FLAKY fails once, then answers like REFRESH-GOOD, to show a failed refresh is retried.
      if (body.includes('refresh_token=REFRESH-FLAKY') && flakyFails++ === 0) {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end('{}');
      }
      // REFRESH-LONG gets a 30-day lifetime, which a peer must not be leased.
      const answer = body.includes('refresh_token=REFRESH-LONG')
        ? { access_token: 'LONG-REFRESHED', refresh_token: 'REFRESH-LONG-2', expires_in: 2592000 }
        : body.includes('refresh_token=REFRESH-GOOD') || body.includes('refresh_token=REFRESH-FLAKY')
          ? { access_token: 'ROTATED-WITH-LIFETIME', refresh_token: 'REFRESH-GOOD-2', expires_in: 3600 }
          : { access_token: 'REFRESHED-NO-LIFETIME', refresh_token: 'REFRESH-2' };
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer));
      }, 50);
    });
  });
  await new Promise((r) => refreshServer.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${refreshServer.address().port}`;
  writeFileSync(
    join(home, 'settings.json'),
    JSON.stringify({
      mcpServers: {
        shared: { url, auth: { type: 'oauth' }, shareWithPeers: true },
        private: { url, auth: { type: 'oauth' } },
        github: { url, auth: { type: 'gh' }, shareWithPeers: true },
        forever: { url, auth: { type: 'oauth' }, shareWithPeers: true },
        nologin: { url, auth: { type: 'oauth' }, shareWithPeers: true },
        refreshes: { url: `${origin}/mcp`, auth: { type: 'oauth' }, shareWithPeers: true },
        refreshnow: { url: `${origin}/mcp`, auth: { type: 'oauth' }, shareWithPeers: true },
        rotates: { url: `${origin}/mcp`, auth: { type: 'oauth' }, shareWithPeers: true },
        soon: { url, auth: { type: 'oauth' }, shareWithPeers: true },
        long: { url, auth: { type: 'oauth' }, shareWithPeers: true },
        undercap: { url, auth: { type: 'oauth' }, shareWithPeers: true },
        overcap: { url, auth: { type: 'oauth' }, shareWithPeers: true },
        twohour: { url, auth: { type: 'oauth' }, shareWithPeers: true, leaseMaxSeconds: 7200 },
        tight: { url, auth: { type: 'oauth' }, shareWithPeers: true, leaseMaxSeconds: 600 },
        badcap: { url, auth: { type: 'oauth' }, shareWithPeers: true, leaseMaxSeconds: 'soon' },
        badzero: { url, auth: { type: 'oauth' }, shareWithPeers: true, leaseMaxSeconds: 0 },
        hugecap: { url, auth: { type: 'oauth' }, shareWithPeers: true, leaseMaxSeconds: 1e21 },
        fraccap: { url, auth: { type: 'oauth' }, shareWithPeers: true, leaseMaxSeconds: 1.5 },
        negcap: { url, auth: { type: 'oauth' }, shareWithPeers: true, leaseMaxSeconds: -5 },
        overforce: { url: `${origin}/mcp`, auth: { type: 'oauth' }, shareWithPeers: true },
        longrefresh: { url: `${origin}/mcp`, auth: { type: 'oauth' }, shareWithPeers: true },
        overlap: { url: `${origin}/mcp`, auth: { type: 'oauth' }, shareWithPeers: true },
        flaky: { url: `${origin}/mcp`, auth: { type: 'oauth' }, shareWithPeers: true },
      },
    }),
  );
  writeFileSync(
    join(home, 'mcp-auth.json'),
    JSON.stringify({
      shared: grant(ACCESS, { expires_at: fresh }),
      private: grant('PRIVATE-ACCESS-1', { expires_at: fresh }),
      // A grant the provider never expires: no expires_at, so it is never leased.
      forever: grant('FOREVER-ACCESS-1'),
      github: grant('GITHUB-ACCESS-1', { expires_at: fresh }),
      // Stale, so a lease refreshes it; the stub's refresh gives no expires_in.
      refreshes: { ...grant('OLD-ACCESS-1', { expires_at: Date.now() - 1000, token_endpoint: `${origin}/token`, server_url: `${origin}/mcp`, resource: `${origin}/mcp` }) },
      // Still fresh, so only ?refresh=1 refreshes it; the stub's refresh gives no lifetime.
      // Ends in 30 s with no refresh token: a lease would outlive it by little, so it is refused.
      soon: { server_url: url, client_id: 'stam-client', token_endpoint, resource: url, access_token: 'SOON-ACCESS-1', expires_at: Date.now() + 30_000 },
      // A 30-day token, over the default cap of 3600 s.
      long: { server_url: url, client_id: 'stam-client', token_endpoint, resource: url, access_token: 'LONG-ACCESS-1', expires_at: Date.now() + 30 * 86_400_000 },
      // Under and over the default cap, by 100 s either side of the boundary.
      undercap: { server_url: url, client_id: 'stam-client', token_endpoint, resource: url, access_token: 'UNDER-ACCESS-1', expires_at: Date.now() + 3_500_000 },
      overcap: { server_url: url, client_id: 'stam-client', token_endpoint, resource: url, access_token: 'OVER-ACCESS-1', expires_at: Date.now() + 3_700_000 },
      // Two hours, leased only where the server's leaseMaxSeconds allows it.
      twohour: { server_url: url, client_id: 'stam-client', token_endpoint, resource: url, access_token: 'TWOHOUR-ACCESS-1', expires_at: Date.now() + 7_200_000 },
      // 3500 s under a per-server cap of 600 s.
      tight: { server_url: url, client_id: 'stam-client', token_endpoint, resource: url, access_token: 'TIGHT-ACCESS-1', expires_at: Date.now() + 3_500_000 },
      // Fresh, but the server's leaseMaxSeconds is invalid, so the lease is refused before anything is minted.
      badcap: grant('BADCAP-ACCESS-1', { expires_at: fresh }),
      badzero: grant('BADZERO-ACCESS-1', { expires_at: fresh }),
      hugecap: grant('HUGE-ACCESS-1', { expires_at: fresh }),
      fraccap: grant('FRAC-ACCESS-1', { expires_at: fresh }),
      negcap: grant('NEG-ACCESS-1', { expires_at: fresh }),
      // Over the default cap by 30 days, with a refresh token whose refresh answers with another 30 days.
      overforce: grant('OVER-FORCE-1', { expires_at: Date.now() + 30 * 86_400_000, refresh_token: 'REFRESH-LONG', token_endpoint: `${origin}/token`, server_url: `${origin}/mcp`, resource: `${origin}/mcp` }),
      // Stale, and its refresh answers with a 30-day lifetime.
      longrefresh: grant('OLD-ACCESS-4', { expires_at: Date.now() - 1000, refresh_token: 'REFRESH-LONG', token_endpoint: `${origin}/token`, server_url: `${origin}/mcp`, resource: `${origin}/mcp` }),
      // Stale, and its refresh answers with a one-hour lifetime, which is exactly the default cap.
      overlap: grant('OLD-ACCESS-5', { expires_at: Date.now() - 1000, refresh_token: 'REFRESH-GOOD', token_endpoint: `${origin}/token`, server_url: `${origin}/mcp`, resource: `${origin}/mcp` }),
      // Stale, with a refresh token whose first refresh fails.
      flaky: grant('OLD-ACCESS-3', { expires_at: Date.now() - 1000, refresh_token: 'REFRESH-FLAKY', token_endpoint: `${origin}/token`, server_url: `${origin}/mcp`, resource: `${origin}/mcp` }),
      refreshnow: grant('FRESH-ACCESS-1', { expires_at: fresh, token_endpoint: `${origin}/token`, server_url: `${origin}/mcp`, resource: `${origin}/mcp` }),
      // Stale, with the refresh token the stub answers with a lifetime.
      rotates: grant('OLD-ACCESS-2', { expires_at: Date.now() - 1000, refresh_token: 'REFRESH-GOOD', token_endpoint: `${origin}/token`, server_url: `${origin}/mcp`, resource: `${origin}/mcp` }),
    }),
    { mode: 0o600 },
  );
  config = await import('../src/config.ts');
  mcpAuth = await import('../src/mcp-auth.ts');
});

after(() => {
  refreshServer?.close();
  rmSync(home, { recursive: true, force: true });
});

test('the lease token is a 0600 file, kept across calls, and rotated in place', () => {
  const file = join(home, 'mcp-lease-token');
  config.ensureLeaseToken();
  assert.equal(statSync(file).mode & 0o777, 0o600, 'the lease token is 0600');
  const first = config.readLeaseToken();
  assert.ok(first && first.length >= 16, 'a token was made');
  config.ensureLeaseToken();
  assert.equal(config.readLeaseToken(), first, 'an existing token is kept, not replaced');

  config.rotateLeaseToken();
  const second = config.readLeaseToken();
  assert.notEqual(second, first, 'a rotation makes a new token');
  assert.equal(statSync(file).mode & 0o777, 0o600, 'the rotated token is 0600');
  assert.deepEqual(
    readdirSync(home).filter((f) => f.startsWith('mcp-lease-token.')),
    [],
    'the rotation leaves no temp file behind',
  );
});

test('a missing lease token file reads as no token, so every lease is refused', () => {
  const file = join(home, 'mcp-lease-token');
  const kept = readFileSync(file, 'utf8');
  rmSync(file);
  assert.equal(config.readLeaseToken(), undefined);
  writeFileSync(file, kept, { mode: 0o600 });
  assert.equal(config.readLeaseToken(), kept.trim());
});

test('a shared, logged-in, expiring grant is leased with its url, token and expiry', async () => {
  const got = await mcpAuth.leaseFor('shared');
  assert.deepEqual(Object.keys(got).sort(), ['access_token', 'expires_at', 'url']);
  assert.equal(got.url, url);
  assert.equal(got.access_token, ACCESS);
  assert.equal(got.expires_at, fresh);
});

test('a refresh that brings a new access token with no lifetime is refused, never leased', async () => {
  await assert.rejects(mcpAuth.leaseFor('refreshes'), (e) => {
    assert.ok(e instanceof mcpAuth.LeaseError, 'a LeaseError');
    assert.equal(e.status, 409);
    assert.match(e.message, /never expires/);
    assert.ok(!e.message.includes('REFRESHED'), 'no token in the message');
    return true;
  });
  assert.equal(refreshCalls.length, 1, 'the lease refreshed the stale grant once');
  assert.equal(mcpAuth.store().refreshes.expires_at, undefined, 'the grant keeps no expiry from the old token');
});

test('a forced refresh with no lifetime is refused too, and the lease never reaches the old expiry', async () => {
  const before = refreshCalls.length;
  await assert.rejects(mcpAuth.leaseFor('refreshnow', { refresh: true }), (e) => {
    assert.equal(e.status, 409);
    assert.match(e.message, /never expires/);
    return true;
  });
  assert.equal(refreshCalls.length - before, 1, 'the forced refresh ran once');
});

test('a grant that ends within a minute is refused: the peer would hold a lease that is gone at once', async () => {
  await assert.rejects(mcpAuth.leaseFor('soon'), (e) => {
    assert.equal(e.status, 409);
    assert.match(e.message, /ends within a minute/);
    assert.ok(!e.message.includes('SOON'), 'no token in the message');
    return true;
  });
});

test('a 30-day token is refused under the default cap, and the message names the cap', async () => {
  await assert.rejects(mcpAuth.leaseFor('long'), (e) => {
    assert.equal(e.status, 409);
    assert.match(e.message, /over the 3600 s cap/);
    assert.match(e.message, /longer-lived tokens than peers accept/);
    assert.match(e.message, /mcpServers\.long\.leaseMaxSeconds/);
    assert.ok(!e.message.includes('LONG-ACCESS'), 'no token in the message');
    return true;
  });
});

test('a refresh that answers with a 30-day lifetime is refused, not shortened', async () => {
  await assert.rejects(mcpAuth.leaseFor('longrefresh'), (e) => {
    assert.equal(e.status, 409);
    assert.match(e.message, /over the 3600 s cap/);
    assert.ok(!e.message.includes('LONG-REFRESHED'), 'no token in the message');
    return true;
  });
});

test('the default cap is a boundary: 3500 s is leased, 3700 s is refused', async () => {
  const under = await mcpAuth.leaseFor('undercap');
  assert.equal(under.access_token, 'UNDER-ACCESS-1');
  await assert.rejects(mcpAuth.leaseFor('overcap'), (e) => {
    assert.equal(e.status, 409);
    assert.match(e.message, /over the 3600 s cap/);
    return true;
  });
});

test('a higher per-server leaseMaxSeconds lets a 2 h token through', async () => {
  const got = await mcpAuth.leaseFor('twohour');
  assert.equal(got.access_token, 'TWOHOUR-ACCESS-1');
  assert.ok(got.expires_at - Date.now() > 3_600_000, 'it is over the default cap');
});

test('a lower per-server leaseMaxSeconds is honoured', async () => {
  await assert.rejects(mcpAuth.leaseFor('tight'), (e) => {
    assert.equal(e.status, 409);
    assert.match(e.message, /over the 600 s cap/);
    assert.match(e.message, /mcpServers\.tight\.leaseMaxSeconds/);
    return true;
  });
});

test('an invalid leaseMaxSeconds refuses the lease, never falls back to no cap', async () => {
  for (const name of ['badcap', 'badzero', 'hugecap', 'fraccap', 'negcap']) {
    await assert.rejects(mcpAuth.leaseFor(name), (e) => {
      assert.equal(e.status, 409, name);
      assert.match(e.message, /leaseMaxSeconds must be a positive integer/, name);
      assert.ok(!e.message.includes('ACCESS'), `${name}'s message carries no token`);
      return true;
    });
  }
});

test('a forced lease on a grant already over the cap is refused without calling the provider', async () => {
  const before = refreshCalls.length;
  for (let i = 0; i < 3; i++) {
    await assert.rejects(mcpAuth.leaseFor('overforce', { refresh: true }), (e) => {
      assert.equal(e.status, 409);
      assert.match(e.message, /over the 3600 s cap/);
      assert.ok(!e.message.includes('OVER-FORCE'), 'no token in the message');
      return true;
    });
  }
  assert.equal(refreshCalls.length - before, 0, 'no forced refresh reached the token endpoint');
});

test('a forced lease that overlaps a running refresh shares that refresh', async () => {
  const before = refreshCalls.length;
  const [plain, forced] = await Promise.all([mcpAuth.leaseFor('overlap'), mcpAuth.leaseFor('overlap', { refresh: true })]);
  assert.equal(refreshCalls.length - before, 1, 'the forced caller joined the refresh already running');
  assert.equal(plain.access_token, 'ROTATED-WITH-LIFETIME');
  assert.equal(forced.access_token, 'ROTATED-WITH-LIFETIME');
});

test('a refresh that fails is retried by the next lease, which then recovers', async () => {
  const before = refreshCalls.length;
  await assert.rejects(mcpAuth.leaseFor('flaky'), 'the first refresh fails, so the lease fails');
  const got = await mcpAuth.leaseFor('flaky');
  assert.equal(got.access_token, 'ROTATED-WITH-LIFETIME');
  assert.equal(refreshCalls.length - before, 2, 'each lease tried the refresh once');
});

test('two concurrent leases on a stale grant share one refresh and one token', async () => {
  const before = refreshCalls.length;
  const [a, b] = await Promise.all([mcpAuth.leaseFor('rotates'), mcpAuth.leaseFor('rotates')]);
  assert.equal(refreshCalls.length - before, 1, 'one token-endpoint call for two leases');
  assert.equal(a.access_token, 'ROTATED-WITH-LIFETIME');
  assert.equal(b.access_token, 'ROTATED-WITH-LIFETIME');
  assert.ok(a.expires_at > Date.now() + 60_000, 'the lease outlives the one-minute floor');
});

test('each refusal has its own status and message, and none names the access token', async () => {
  const cases = [
    ['nosuch', 404, /no MCP server named nosuch/],
    ['private', 403, /not shared with peers/],
    ['github', 400, /uses gh/],
    ['nologin', 409, /not logged in on this home/],
    ['forever', 409, /never expires/],
  ];
  const messages = new Set();
  for (const [name, status, message] of cases) {
    await assert.rejects(mcpAuth.leaseFor(name), (e) => {
      assert.ok(e instanceof mcpAuth.LeaseError, `${name} is a LeaseError`);
      assert.equal(e.status, status, `${name} status`);
      assert.match(e.message, message);
      assert.ok(!e.message.includes('ACCESS'), `${name}'s message carries no token`);
      messages.add(e.message);
      return true;
    });
  }
  assert.equal(messages.size, cases.length, 'the refusals have distinct messages');
});

test('the status rows are the shared servers only, and carry no token', async () => {
  const rows = await mcpAuth.sharedStatus();
  const names = rows.map((r) => r.name);
  assert.ok(names.includes('shared') && names.includes('twohour'), 'the shared servers are listed');
  assert.ok(!names.includes('private'), 'an unshared server is not listed');
  assert.ok(!JSON.stringify(rows).includes('ACCESS'), 'no access token in the status');
  assert.ok(!JSON.stringify(rows).includes('REFRESH'), 'no refresh token in the status');
  const shared = rows.find((r) => r.name === 'shared');
  assert.equal(shared.logged_in, true);
  assert.equal(shared.expires_at, fresh);
});

test('the secret compare is exact and constant-time in shape', () => {
  assert.equal(mcpAuth.sameSecret('abc123', 'abc123'), true);
  assert.equal(mcpAuth.sameSecret('abc123', 'abc124'), false);
  assert.equal(mcpAuth.sameSecret('abc', 'abc123'), false, 'a prefix is not the secret');
  assert.equal(mcpAuth.sameSecret('', 'abc123'), false, 'an empty bearer is not the secret');
});
