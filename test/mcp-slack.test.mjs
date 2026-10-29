#!/usr/bin/env node
// Slack's token endpoint, as the MCP OAuth code reads it (S-57), free: no daemon, no model. A
// fake Slack-shaped token endpoint answers HTTP 200 with `ok: false` for a refused grant, and
// with the user token under `authed_user` (no top-level access_token). Checks the response
// mapping, the refresh that stores the rotated token, a refused refresh's error (which must not
// echo a token), and that the client secret is sent in the form body (client_secret_post).
//   node --test test/mcp-slack.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-mcp-slack-');
process.env.STAM_HOME = home;
// The fake endpoints are http on loopback; only a test allows that.
process.env.STAM_MCP_AUTH_INSECURE = '1';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let server, origin, mcpAuth;
const seen = [];

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const form = new URLSearchParams(body);
      seen.push(Object.fromEntries(form));
      const json = (obj) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url !== '/token') return json({ ok: false, error: 'not_found' });
      if (form.get('refresh_token') === 'r-html') {
        // A 200 that isn't JSON, and starts with a token-shaped string (S-3503).
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('Bearer NONJSON-LEAK-7f3a9c1e5b2d8g4h6j0k2m4n6p8q1r3s5t7u9v rest of the body');
      }
      if (form.get('refresh_token') === 'r-ok') {
        return json({ ok: true, token_type: 'bearer', authed_user: { id: 'U1', access_token: 'xoxe.xoxp-new', refresh_token: 'r-2', expires_in: 43200, token_type: 'user' } });
      }
      return json({ ok: false, error: 'invalid_refresh_token' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ mcpServers: { slack: { url: `${origin}/mcp`, auth: { type: 'oauth', client_id: 'cid', client_secret: 'sec' } } } }, null, 2));
  mcpAuth = await import('../src/mcp-auth.ts');
});
after(async () => {
  await new Promise((r) => server.close(r));
  rmSync(home, { recursive: true, force: true });
});

const seed = (refreshToken) => {
  const store = { slack: { server_url: `${origin}/mcp`, client_id: 'cid', client_secret: 'sec', access_token: 'xoxe.xoxp-old', refresh_token: refreshToken, expires_at: Date.now() - 1000, token_endpoint: `${origin}/token`, resource: `${origin}/mcp` } };
  writeFileSync(join(home, 'mcp-auth.json'), JSON.stringify(store, null, 2));
};

test('tokenResponse: a top-level access_token passes through; authed_user stands in when it is missing', () => {
  const plain = { access_token: 'a', refresh_token: 'r', expires_in: 3600 };
  assert.equal(mcpAuth.tokenResponse(plain), plain);
  assert.deepEqual(mcpAuth.tokenResponse({ ok: true, authed_user: { access_token: 'u', refresh_token: 'ur', expires_in: 60 } }), { access_token: 'u', refresh_token: 'ur', expires_in: 60 });
});

test('tokenResponse: ok:false is an error with Slack’s error field, and no token in it', () => {
  assert.throws(() => mcpAuth.tokenResponse({ ok: false, error: 'invalid_code', access_token: 'must-not-echo' }), (e) => /invalid_code/.test(e.message) && !/must-not-echo/.test(e.message));
});

test('refresh: a Slack refresh stores the rotated user token from authed_user', async () => {
  seed('r-ok');
  assert.equal(await mcpAuth.token('slack'), 'xoxe.xoxp-new');
  const stored = JSON.parse(readFileSync(join(home, 'mcp-auth.json'), 'utf8')).slack;
  assert.equal(stored.access_token, 'xoxe.xoxp-new');
  assert.equal(stored.refresh_token, 'r-2', 'the rotated refresh token is kept');
  assert.ok(stored.expires_at > Date.now() + 3_000_000, 'the expiry follows expires_in');
});

test('refresh: the client secret goes in the form body (client_secret_post)', () => {
  const last = seen.filter((f) => f.grant_type === 'refresh_token').at(-1);
  assert.equal(last.client_secret, 'sec');
  assert.equal(last.client_id, 'cid');
});

test('refresh: a 200 that is not JSON gives a fixed message, never the body (S-3503)', async () => {
  seed('r-html');
  await assert.rejects(mcpAuth.token('slack', { refresh: true }), (e) => e.message === `an OAuth endpoint answered non-JSON from ${origin}/token` && !/LEAK|Bearer/.test(e.message));
});

test('refresh: a refused refresh names Slack’s error, never the refresh token', async () => {
  seed('r-bad');
  await assert.rejects(mcpAuth.token('slack', { refresh: true }), (e) => /invalid_refresh_token/.test(e.message) && !/r-bad/.test(e.message));
});
