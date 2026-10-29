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

let server, origin, mcpAuth, secrets, settings;
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
      return send(200, { client_id: 'stam-client-1', client_secret: 'DCR-SECRET-1' });
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      const form = new URLSearchParams(await readBody(req));
      if (form.get('grant_type') === 'authorization_code') {
        const challenge = fake.challenges.get(form.get('code'));
        const ok = Boolean(challenge) && createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === challenge;
        fake.exchanges.push({ code: form.get('code'), resource: form.get('resource'), redirect_uri: form.get('redirect_uri'), client_id: form.get('client_id'), client_secret: form.get('client_secret'), verifier: form.get('code_verifier'), ok });
        if (!ok) return send(400, { error: 'invalid_grant', error_description: 'PKCE failed' });
        // CODE-2 models a provider that issues no refresh_token, so the previous grant's
        // refresh token must not survive the new login.
        return send(200, { access_token: 'ACCESS-1', ...(form.get('code') === 'CODE-2' ? {} : { refresh_token: 'REFRESH-1' }), expires_in: 3600 });
      }
      if (form.get('grant_type') === 'refresh_token') {
        fake.refreshCount++;
        fake.refreshedWith = form.get('refresh_token');
        fake.refreshedSecret = form.get('client_secret');
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
        slack: { url: `${origin}/mcp`, auth: { type: 'oauth', client_id: 'slack-id', client_secret: 'PLAIN-SLACK' } },
        oldslack: { url: `${origin}/mcp`, auth: { type: 'oauth' } },
        // A secret the store can't hold (it has a space), to see a login refuse it before any exchange.
        badsecret: { url: `${origin}/mcp`, auth: { type: 'oauth', client_id: 'bad-id', client_secret: 'has a space' } },
      },
    }),
  );
  mcpAuth = await import('../src/mcp-auth.ts');
  secrets = await import('../src/secrets.ts');
  settings = await import('../src/settings.ts');
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
  // The registered client secret goes to the secret store; the token file holds only its name.
  assert.equal(fake.exchanges[0].client_secret, 'DCR-SECRET-1', 'the exchange sent the registered secret');
  assert.deepEqual(mcpAuth.store().linear.client_secret, { secret: secrets.mcpClientSecretName('linear') });
  assert.equal(secrets.getSecret(secrets.mcpClientSecretName('linear')), 'DCR-SECRET-1');
  assert.ok(!readFileSync(join(home, 'mcp-auth.json'), 'utf8').includes('DCR-SECRET-1'), 'the token file holds no secret value');
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
  assert.equal(fake.refreshedSecret, 'DCR-SECRET-1', 'the refresh reads the secret from the store');
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
  const { servers: rows } = await mcpAuth.status();
  assert.deepEqual(rows.find((r) => r.name === 'github'), { name: 'github', type: 'gh', logged_in: true, expires_at: null });
});

test('logout > forgets the stored tokens', async () => {
  mcpAuth.logout('linear');
  assert.equal(mcpAuth.store().linear, undefined);
  const { servers: rows } = await mcpAuth.status();
  assert.equal(rows.find((r) => r.name === 'linear').logged_in, false);
});

test('secrets > a plain-text client secret moves into the store once, and refresh still finds it', async () => {
  const settingsFile = join(home, 'settings.json');
  const tokenFile = join(home, 'mcp-auth.json');
  const readSettingsText = () => readFileSync(settingsFile, 'utf8');
  // Plain text in settings (slack) and in the token file (oldslack), as before S-2736.
  const s = JSON.parse(readSettingsText());
  s.mcpServers.slack.auth.client_secret = 'PLAIN-SLACK';
  writeFileSync(settingsFile, JSON.stringify(s));
  mcpAuth.writeStore({
    ...mcpAuth.store(),
    oldslack: { server_url: `${origin}/mcp`, client_id: 'old-id', client_secret: 'PLAIN-TOKEN', access_token: 'ACCESS-OLD', refresh_token: 'REFRESH-OLD', expires_at: Date.now() - 1000, token_endpoint: `${origin}/token`, resource: `${origin}/mcp` },
  });

  mcpAuth.migrateClientSecrets();
  assert.deepEqual(JSON.parse(readSettingsText()).mcpServers.slack.auth.client_secret, { secret: secrets.mcpClientSecretName('slack') });
  assert.equal(secrets.getSecret(secrets.mcpClientSecretName('slack')), 'PLAIN-SLACK');
  assert.deepEqual(mcpAuth.store().oldslack.client_secret, { secret: secrets.mcpClientSecretName('oldslack') });
  assert.equal(secrets.getSecret(secrets.mcpClientSecretName('oldslack')), 'PLAIN-TOKEN');
  assert.ok(!readSettingsText().includes('PLAIN-SLACK'), 'the plain text left settings');
  assert.ok(!readFileSync(tokenFile, 'utf8').includes('PLAIN-TOKEN'), 'the plain text left the token file');
  assert.equal(statSync(join(home, 'secrets.json')).mode & 0o777, 0o600, 'the store is 0600');

  // Idempotent: a second run changes neither file.
  const once = [readSettingsText(), readFileSync(tokenFile, 'utf8')];
  mcpAuth.migrateClientSecrets();
  assert.deepEqual([readSettingsText(), readFileSync(tokenFile, 'utf8')], once);

  // Refresh after the move: the reference resolves from the store.
  assert.equal(await mcpAuth.token('oldslack'), 'ACCESS-2');
  assert.equal(fake.refreshedSecret, 'PLAIN-TOKEN');
});

test('secrets > a broken store moves nothing and loses no setting; a later start moves it', async () => {
  const settingsFile = join(home, 'settings.json');
  const readSettingsText = () => readFileSync(settingsFile, 'utf8');
  const s = JSON.parse(readSettingsText());
  s.mcpServers.slack.auth.client_secret = 'PLAIN-SLACK-2';
  writeFileSync(settingsFile, JSON.stringify(s));
  writeFileSync(join(home, 'secrets.json'), '{not json');

  mcpAuth.migrateClientSecrets();
  assert.equal(JSON.parse(readSettingsText()).mcpServers.slack.auth.client_secret, 'PLAIN-SLACK-2', 'the setting kept its value');

  rmSync(join(home, 'secrets.json'));
  mcpAuth.migrateClientSecrets();
  assert.deepEqual(JSON.parse(readSettingsText()).mcpServers.slack.auth.client_secret, { secret: secrets.mcpClientSecretName('slack') });
  assert.equal(secrets.getSecret(secrets.mcpClientSecretName('slack')), 'PLAIN-SLACK-2');
});

test('secrets > names that sanitize alike get separate secrets, and a login never overwrites another server\'s', () => {
  const a = secrets.mcpClientSecretName('a b');
  const b = secrets.mcpClientSecretName('a-b');
  assert.notEqual(a, b, 'two servers never share a store name');
  assert.ok(secrets.NAME_RE.test(a) && secrets.NAME_RE.test(b), 'both names fit the store rule');
  assert.equal(secrets.mcpClientSecretName('a b'), a, 'the name is stable for one server');
  secrets.set(a, { value: 'SECRET-A' });
  secrets.set(b, { value: 'SECRET-B' });
  assert.equal(secrets.getSecret(a), 'SECRET-A');
  assert.equal(secrets.getSecret(b), 'SECRET-B');
});

test('secrets > settings show the secret name to an agent, never the value', () => {
  const shown = settings.redactValue({ mcpServers: { slack: { url: 'https://x', auth: { type: 'oauth', client_secret: { secret: 'mcp-slack-client' } } } } });
  assert.deepEqual(shown.mcpServers.slack.auth.client_secret, { secret: 'mcp-slack-client' });
  const plain = settings.redactValue({ mcpServers: { x: { auth: { type: 'oauth', client_secret: 'PLAIN-X' } } } });
  assert.equal(plain.mcpServers.x.auth.client_secret, '[redacted]');
});

test('settings > a login with a settings reference sends the stored secret, and the grant keeps the reference', async () => {
  const name = secrets.mcpClientSecretName('slack');
  const r = await mcpAuth.startLogin('slack', `${origin}/oauth/callback`);
  const u = new URL(r.url);
  fake.challenges.set('CODE-S', u.searchParams.get('code_challenge'));
  await mcpAuth.finishLogin('CODE-S', u.searchParams.get('state'));
  const ex = fake.exchanges.at(-1);
  assert.equal(ex.ok, true);
  assert.equal(ex.client_secret, 'PLAIN-SLACK-2', 'the exchange sent the value the store holds');
  assert.deepEqual(mcpAuth.store().slack.client_secret, { secret: name });
  assert.ok(!readFileSync(join(home, 'mcp-auth.json'), 'utf8').includes('PLAIN-SLACK-2'), 'the token file holds no value');
});

test('settings > logout removes a registration secret, and keeps one the settings name', () => {
  const slackName = secrets.mcpClientSecretName('slack');
  mcpAuth.logout('slack');
  assert.equal(secrets.getSecret(slackName), 'PLAIN-SLACK-2', 'a settings-named secret stays');
  const oldName = secrets.mcpClientSecretName('oldslack');
  secrets.set(oldName, { value: 'PLAIN-TOKEN', provider: 'mcp' });
  assert.equal(mcpAuth.store().oldslack.client_secret.secret, oldName, 'the grant names it');
  mcpAuth.logout('oldslack');
  assert.equal(secrets.getSecret(oldName), undefined, 'a registration-style secret goes with its grant');
});

test('secrets > a migration never overwrites a value the store holds under the name', () => {
  const settingsFile = join(home, 'settings.json');
  const s = JSON.parse(readFileSync(settingsFile, 'utf8'));
  s.mcpServers.slack.auth.client_secret = 'PLAIN-DIFF';
  writeFileSync(settingsFile, JSON.stringify(s));
  mcpAuth.migrateClientSecrets();
  assert.equal(JSON.parse(readFileSync(settingsFile, 'utf8')).mcpServers.slack.auth.client_secret, 'PLAIN-DIFF', 'the plain text stays in place');
  assert.equal(secrets.getSecret(secrets.mcpClientSecretName('slack')), 'PLAIN-SLACK-2', 'the stored value is unchanged');
});

test('oauth > a client secret the store refuses fails the login before any exchange', async () => {
  const before = fake.exchanges.length;
  await assert.rejects(() => mcpAuth.startLogin('badsecret', `${origin}/oauth/callback`), /client secret/);
  assert.equal(fake.exchanges.length, before, 'no exchange was sent');
});

test('settings > a client secret written through settings moves into the store, the file keeps the reference', () => {
  const settingsFile = join(home, 'settings.json');
  const servers = JSON.parse(readFileSync(settingsFile, 'utf8')).mcpServers;
  delete servers.badsecret; // a value the store refuses; the test below covers it
  servers.slack.auth.client_secret = 'TYPED-NEW';
  const r = settings.patchSettings({ mcpServers: servers });
  assert.ok('text' in r, 'the patch was written');
  const text = readFileSync(settingsFile, 'utf8');
  assert.ok(!text.includes('TYPED-NEW'), 'the value never reached settings.json');
  assert.deepEqual(JSON.parse(text).mcpServers.slack.auth.client_secret, { secret: secrets.mcpClientSecretName('slack') });
  assert.equal(secrets.getSecret(secrets.mcpClientSecretName('slack')), 'TYPED-NEW');
  // A whole-file save takes the same path.
  const whole = JSON.parse(readFileSync(settingsFile, 'utf8'));
  whole.mcpServers.slack.auth.client_secret = 'TYPED-FILE';
  settings.writeSettingsText(JSON.stringify(whole));
  assert.ok(!readFileSync(settingsFile, 'utf8').includes('TYPED-FILE'), 'a whole-file save moves it too');
  assert.equal(secrets.getSecret(secrets.mcpClientSecretName('slack')), 'TYPED-FILE');
});

test('settings > a patch refused for cost leaves the stored secret and the file as they were (S-2767)', () => {
  const settingsFile = join(home, 'settings.json');
  const name = secrets.mcpClientSecretName('slack');
  const old = secrets.getSecret(name);
  assert.ok(old, 'the slack secret is stored');
  const text = readFileSync(settingsFile, 'utf8');
  const servers = JSON.parse(text).mcpServers;
  servers.slack.auth.client_secret = 'TYPED-REFUSED';
  const cost = { accounts: { a: { match: { harness: 'claude' } }, b: { match: { harness: 'claude' } } } };
  const r = settings.patchSettings({ mcpServers: servers, cost });
  assert.equal(r.field, 'cost');
  assert.match(r.problem, /both match/);
  assert.equal(secrets.getSecret(name), old, 'the store keeps the old value');
  assert.equal(readFileSync(settingsFile, 'utf8'), text, 'nothing was written');
});

test('settings > a value the store refuses writes nothing, the stored secret stays (S-2767)', () => {
  const settingsFile = join(home, 'settings.json');
  const name = secrets.mcpClientSecretName('slack');
  const old = secrets.getSecret(name);
  const text = readFileSync(settingsFile, 'utf8');
  const servers = JSON.parse(text).mcpServers;
  servers.slack.auth.client_secret = 'has a space';
  assert.throws(() => settings.patchSettings({ mcpServers: servers }), /no spaces/);
  assert.equal(secrets.getSecret(name), old, 'the store keeps the old value');
  assert.equal(readFileSync(settingsFile, 'utf8'), text, 'nothing was written');
});

// A reference to a store entry that isn't tagged `mcp` is refused before any exchange, and the error never shows its value (S-2767).
async function refusesRef(entry, provider, value) {
  const settingsFile = join(home, 'settings.json');
  const original = JSON.parse(readFileSync(settingsFile, 'utf8')).mcpServers;
  secrets.set(entry, { value, provider });
  try {
    const servers = structuredClone(original);
    servers.wrongref = { url: `${origin}/mcp`, auth: { type: 'oauth', client_id: 'wrong-id', client_secret: { secret: entry } } };
    settings.patchSettings({ mcpServers: servers });
    const sent = fake.exchanges.length;
    await assert.rejects(
      () => mcpAuth.startLogin('wrongref', `${origin}/oauth/callback`),
      (e) => {
        assert.match(e.message, new RegExp(`${entry} is not an MCP client secret`));
        assert.ok(!e.message.includes(value), 'the error never shows the value');
        return true;
      },
    );
    assert.equal(fake.exchanges.length, sent, 'no exchange was sent');
  } finally {
    settings.patchSettings({ mcpServers: original });
    secrets.remove(entry);
  }
}

test('oauth > a client secret naming a provider key is refused before any exchange (S-2767)', async () => {
  await refusesRef('openrouter', 'openrouter', 'OR-KEY-LEAK-1');
});

test('oauth > a client secret naming an untagged store entry is refused before any exchange (S-2767)', async () => {
  await refusesRef('untagged-key', '', 'UNTAGGED-KEY-LEAK-1');
});

test('oauth > a peer refuses a login and names the home that keeps the logins', async () => {
  const settingsFile = join(home, 'settings.json');
  const s = JSON.parse(readFileSync(settingsFile, 'utf8'));
  s.home = 'some-other-machine';
  s.mcpServers.peer = { url: `${origin}/mcp`, auth: { type: 'oauth', client_id: 'peer-id', client_secret: { secret: 'mcp-peer-client' } } };
  writeFileSync(settingsFile, JSON.stringify(s));
  await assert.rejects(() => mcpAuth.startLogin('peer', `${origin}/oauth/callback`), /log in on some-other-machine, which keeps the MCP logins/);
  assert.throws(() => mcpAuth.logout('peer'), /some-other-machine/);
});

// A provider's `error` is echoed only when it is one of the OAuth and Slack codes (Go's providerCodes, S-3503). A token
// in any other error, or in a non-string one, never reaches the error or the log.
test('tokenResponse > only an allowlisted provider code is echoed; a token-shaped error never reaches the error or the log (S-3503)', () => {
  const leak = 'Sentinel0Tk9Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2Yz3Lk4';
  const logged = [];
  const saved = ['log', 'warn', 'error', 'info'].map((k) => [k, console[k]]);
  for (const [k] of saved) console[k] = (...a) => logged.push(a.map(String).join(' '));
  try {
    const refused = (tok) => {
      try {
        mcpAuth.tokenResponse(tok);
      } catch (e) {
        return e.message;
      }
      assert.fail('tokenResponse answered an ok:false');
    };
    const codes = ['invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client', 'unsupported_grant_type', 'invalid_scope', 'access_denied', 'server_error', 'temporarily_unavailable', 'invalid_code', 'invalid_refresh_token', 'token_revoked', 'not_authed'];
    for (const code of codes) assert.equal(refused({ ok: false, error: code }), `the token endpoint refused: ${code}`);
    const fixed = 'the token endpoint refused: unknown error';
    assert.equal(refused({ ok: false, error: leak }), fixed);
    assert.equal(refused({ ok: false, error: `invalid_grant ${leak}` }), fixed);
    assert.equal(refused({ ok: false, error: `${leak}${'x'.repeat(200)}` }), fixed);
    assert.equal(refused({ ok: false, error: { detail: leak } }), fixed);
    assert.equal(refused({ ok: false, error: ['invalid_grant', leak] }), fixed);
    assert.equal(refused({ ok: false, error: leak, access_token: leak }), fixed);
    assert.equal(refused({ ok: false }), fixed);
    assert.ok(!logged.some((line) => line.includes(leak)), 'no log line carries the token');
  } finally {
    for (const [k, fn] of saved) console[k] = fn;
  }
});

// The allowlist is kept in step with Go's providerCodes (S-3503): a code added to only one list fails here, both ways.
test('tokenResponse > the provider code list is the same set as Go’s providerCodes (S-3503)', () => {
  const goSrc = readFileSync(new URL('../go/internal/mcpauth/mcpauth.go', import.meta.url), 'utf8');
  const block = goSrc.slice(goSrc.indexOf('var providerCodes = map[string]bool{'), goSrc.indexOf('\n}\n', goSrc.indexOf('var providerCodes')));
  const goCodes = [...block.matchAll(/"([a-z_]+)": true/g)].map((m) => m[1]).sort();
  assert.ok(goCodes.length > 40, 'the Go list was read');
  assert.deepEqual([...mcpAuth.providerCodes].sort(), goCodes);
});
