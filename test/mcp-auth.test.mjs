#!/usr/bin/env node
// Shared MCP OAuth logins (S-50), free: no daemon, no model. A fake OAuth + MCP server in
// this process plays a service whose protected-resource metadata comes from a 401's
// `WWW-Authenticate`, whose authorization server supports dynamic client registration, and
// whose token endpoint checks PKCE S256. Checks discovery, registration, the authorize URL,
// the code exchange, a single-use state, refresh near expiry, the store's 0600 mode, and a
// `gh` login through a fake `gh`.
//   node --test test/mcp-auth.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-mcp-auth-');
process.env.STAM_HOME = home;
// The fake OAuth and MCP servers are http on loopback; only a test allows that.
process.env.STAM_MCP_AUTH_INSECURE = '1';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
// A fake `gh` on PATH gives the `gh` login a deterministic token.
mkdirSync(join(home, 'bin'), { recursive: true });
writeFileSync(join(home, 'bin', 'gh'), '#!/bin/sh\necho GH-TOKEN-1\n', { mode: 0o755 });
chmodSync(join(home, 'bin', 'gh'), 0o755);
process.env.PATH = `${join(home, 'bin')}:${process.env.PATH}`;

const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b)); });

let server, origin, mcpAuth;
// What the fake server recorded, to assert the client's requests.
const fake = { registered: null, challenges: new Map(), exchanges: [], refreshCount: 0 };

before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, obj, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'POST' && ['/mcp', '/mcp2', '/badmcp', '/goodmcp'].includes(url.pathname)) {
      if (req.headers.authorization !== 'Bearer GOOD') {
        // Only /mcp names its metadata in the 401; the others force the well-known fallback.
        const h = url.pathname === '/mcp' ? { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` } : {};
        return send(401, { error: 'unauthorized' }, h);
      }
      return send(200, { jsonrpc: '2.0', id: JSON.parse(await readBody(req)).id, result: { protocolVersion: '2025-06-18' } });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      const path = url.pathname.replace('/.well-known/oauth-protected-resource', '');
      // Two deliberately broken documents: a resource on another host, and an authorization
      // server whose metadata will claim a different issuer.
      if (path === '/goodmcp') return send(200, { resource: 'https://other.example/mcp', authorization_servers: [origin] });
      if (path === '/badmcp') return send(200, { resource: `${origin}/badmcp`, authorization_servers: [`${origin}/bad`] });
      return send(200, { resource: path ? `${origin}${path}` : origin, authorization_servers: [origin], scopes_supported: ['read', 'write'] });
    }
    if (req.method === 'GET' && url.pathname === '/bad/.well-known/oauth-authorization-server') {
      return send(200, { issuer: 'https://evil.example', authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token` });
    }
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      return send(200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        scopes_supported: ['read', 'write'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    }
    if (req.method === 'POST' && url.pathname === '/register') {
      fake.registered = JSON.parse((await readBody(req)) || '{}');
      return send(200, { client_id: 'stam-client-1' });
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      const form = new URLSearchParams(await readBody(req));
      if (form.get('grant_type') === 'authorization_code') {
        const challenge = fake.challenges.get(form.get('code'));
        const ok = Boolean(challenge) && createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === challenge;
        fake.exchanges.push({ code: form.get('code'), resource: form.get('resource'), redirect_uri: form.get('redirect_uri'), client_id: form.get('client_id'), verifier: form.get('code_verifier'), ok });
        if (!ok) return send(400, { error: 'invalid_grant', error_description: 'PKCE failed' });
        // CODE-2 models a provider that issues no refresh_token, so the previous grant's
        // refresh token must not survive the new login.
        return send(200, { access_token: 'ACCESS-1', ...(form.get('code') === 'CODE-2' ? {} : { refresh_token: 'REFRESH-1' }), expires_in: 3600 });
      }
      if (form.get('grant_type') === 'refresh_token') {
        fake.refreshCount++;
        fake.refreshedWith = form.get('refresh_token');
        return send(200, { access_token: 'ACCESS-2', refresh_token: 'REFRESH-2', expires_in: 3600 });
      }
    }
    send(404, { error: 'not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(
    join(home, 'settings.json'),
    JSON.stringify({
      mcpServers: {
        linear: { url: `${origin}/mcp`, auth: { type: 'oauth' } },
        other: { url: `${origin}/mcp2`, auth: { type: 'oauth', scopes: ['read'] } },
        move: { url: `${origin}/mcp`, auth: { type: 'oauth' } },
        issuerbad: { url: `${origin}/badmcp`, auth: { type: 'oauth' } },
        badresource: { url: `${origin}/goodmcp`, auth: { type: 'oauth' } },
        github: { url: `${origin}/mcp`, auth: { type: 'gh' } },
      },
    }),
  );
  mcpAuth = await import('../src/mcp-auth.ts');
});

after(() => {
  server?.close();
  rmSync(home, { recursive: true, force: true });
});

test('oauth > discovery from a 401, DCR, PKCE, and the exchange', async () => {
  const r = await mcpAuth.startLogin('linear', `${origin}/oauth/callback`);
  const u = new URL(r.url);
  assert.equal(u.origin + u.pathname, `${origin}/authorize`);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('resource'), `${origin}/mcp`);
  assert.equal(u.searchParams.get('redirect_uri'), `${origin}/oauth/callback`);
  assert.equal(u.searchParams.get('scope'), 'read write', 'scopes come from the metadata');
  // No client_id was configured, so stam registered dynamically.
  assert.equal(fake.registered.client_name, 'stam');
  assert.deepEqual(fake.registered.redirect_uris, [`${origin}/oauth/callback`]);
  assert.equal(fake.registered.token_endpoint_auth_method, 'none');
  assert.deepEqual(fake.registered.grant_types, ['authorization_code', 'refresh_token']);

  const state = u.searchParams.get('state');
  fake.challenges.set('CODE-1', u.searchParams.get('code_challenge'));
  const done = await mcpAuth.finishLogin('CODE-1', state);
  assert.equal(done.name, 'linear');
  assert.equal(fake.exchanges[0].ok, true, 'the fake verified the S256 challenge');
  assert.equal(fake.exchanges[0].client_id, 'stam-client-1');
  assert.equal(fake.exchanges[0].resource, `${origin}/mcp`);
  assert.equal(fake.exchanges[0].redirect_uri, `${origin}/oauth/callback`);

  assert.equal(statSync(join(home, 'mcp-auth.json')).mode & 0o777, 0o600, 'the token store is 0600');
  assert.equal(mcpAuth.store().linear.access_token, 'ACCESS-1');
  assert.equal(mcpAuth.store().linear.refresh_token, 'REFRESH-1');
  assert.ok(mcpAuth.store().linear.expires_at > Date.now(), 'expires_at comes from expires_in');
});

test('oauth > the state is single use', async () => {
  const r = await mcpAuth.startLogin('linear', `${origin}/oauth/callback`);
  const state = new URL(r.url).searchParams.get('state');
  // The unknown code fails PKCE at the token endpoint, but the state is spent regardless.
  await assert.rejects(() => mcpAuth.finishLogin('CODE-X', state), /HTTP 400/);
  await assert.rejects(() => mcpAuth.finishLogin('CODE-X', state), /already used/);
});

test('oauth > the well-known path is the fallback when the 401 names no metadata', async () => {
  const r = await mcpAuth.startLogin('other', `${origin}/oauth/callback`);
  const u = new URL(r.url);
  assert.equal(u.searchParams.get('resource'), `${origin}/mcp2`);
  assert.equal(u.searchParams.get('scope'), 'read', 'a configured scope wins');
});

test('oauth > refreshes with the refresh_token near expiry', async () => {
  const s = mcpAuth.store();
  s.linear.expires_at = Date.now() + 10_000; // inside the 60 s window
  mcpAuth.writeStore(s);
  assert.equal(statSync(join(home, 'mcp-auth.json')).mode & 0o777, 0o600, 'a rewrite keeps 0600');
  assert.equal(await mcpAuth.token('linear'), 'ACCESS-2');
  assert.equal(fake.refreshCount, 1);
  assert.equal(fake.refreshedWith, 'REFRESH-1');
  assert.equal(mcpAuth.store().linear.access_token, 'ACCESS-2');
});

test('oauth > a new login replaces the whole grant, never the old refresh_token', async () => {
  // linear holds REFRESH-2 from the refresh test; a fresh login with no refresh_token must
  // not leave a token that would be sent to a possibly different endpoint.
  const r = await mcpAuth.startLogin('linear', `${origin}/oauth/callback`);
  const u = new URL(r.url);
  fake.challenges.set('CODE-2', u.searchParams.get('code_challenge'));
  await mcpAuth.finishLogin('CODE-2', u.searchParams.get('state'));
  assert.equal(mcpAuth.store().linear.access_token, 'ACCESS-1');
  assert.equal(mcpAuth.store().linear.refresh_token, undefined, 'the previous grant refresh token survived a new login');
});

test('oauth > a changed server url needs a new login', async () => {
  const settingsFile = join(home, 'settings.json');
  const readSettings = () => JSON.parse(readFileSync(settingsFile, 'utf8'));
  const r = await mcpAuth.startLogin('move', `${origin}/oauth/callback`);
  const u = new URL(r.url);
  fake.challenges.set('CODE-M', u.searchParams.get('code_challenge'));
  await mcpAuth.finishLogin('CODE-M', u.searchParams.get('state'));
  assert.equal(await mcpAuth.token('move'), 'ACCESS-1');
  // Point the same name at another host: the stored bearer must not follow it.
  const s = readSettings();
  s.mcpServers.move.url = `${origin}/mcp2`;
  writeFileSync(settingsFile, JSON.stringify(s));
  await assert.rejects(() => mcpAuth.token('move'), /log in again/);
});

test('security > http and private endpoints are refused unless a test opts out', async () => {
  delete process.env.STAM_MCP_AUTH_INSECURE;
  try {
    await assert.rejects(() => mcpAuth.assertEndpoint('http://example.com/mcp'), /https/);
    await assert.rejects(() => mcpAuth.assertEndpoint('https://127.0.0.1/mcp'), /private|refuses/);
    await assert.rejects(() => mcpAuth.assertEndpoint('https://10.0.0.1/mcp'), /refuses/);
    await assert.rejects(() => mcpAuth.assertEndpoint('https://169.254.1.1/mcp'), /refuses/);
  } finally {
    process.env.STAM_MCP_AUTH_INSECURE = '1';
  }
  await mcpAuth.assertEndpoint('http://127.0.0.1:1/mcp');
});

test('security > the authorization-server issuer must match the URL it was fetched for', async () => {
  await assert.rejects(() => mcpAuth.startLogin('issuerbad', `${origin}/oauth/callback`), /issuer/);
});

test('security > the protected resource must match the server url', async () => {
  await assert.rejects(() => mcpAuth.startLogin('badresource', `${origin}/oauth/callback`), /protected-resource/);
});

test('oauth > a server with no login throws', async () => {
  await assert.rejects(() => mcpAuth.token('other'), /not logged in/);
});

test('gh > the token comes from `gh auth token`', async () => {
  assert.equal(await mcpAuth.token('github'), 'GH-TOKEN-1');
  const rows = await mcpAuth.status();
  assert.deepEqual(rows.find((r) => r.name === 'github'), { name: 'github', type: 'gh', logged_in: true, expires_at: null });
});

test('logout > forgets the stored tokens', async () => {
  mcpAuth.logout('linear');
  assert.equal(mcpAuth.store().linear, undefined);
  const rows = await mcpAuth.status();
  assert.equal(rows.find((r) => r.name === 'linear').logged_in, false);
});
