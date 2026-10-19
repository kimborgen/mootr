#!/usr/bin/env node
// A fake remote MCP server for test/e2e-mcp-proxy.sh. It is both the protected resource
// (POST /mcp) and the OAuth token endpoint (POST /token), so the daemon can refresh through
// it, and it logs what it saw. Env:
//   FAKE_PORT       port to bind on 127.0.0.1
//   FAKE_READY      file to write once listening (holds the port)
//   FAKE_LOG        file to append one word per notable request: 401, initialize, tools/list,
//                   notification, refresh
//   GOOD_TOKEN      the only accepted bearer
//   REFRESH_TOKEN   the refresh_token /token accepts
import { createServer } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';

const PORT = Number(process.env.FAKE_PORT);
const GOOD = process.env.GOOD_TOKEN;
const REFRESH = process.env.REFRESH_TOKEN;
const log = (w) => appendFileSync(process.env.FAKE_LOG, w + '\n');
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b)); });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (status, obj, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'POST' && url.pathname === '/mcp') {
    if (req.headers.authorization !== `Bearer ${GOOD}`) {
      log('401');
      return json(401, { error: 'invalid_token' }, { 'www-authenticate': `Bearer resource_metadata="http://127.0.0.1:${PORT}/.well-known/oauth-protected-resource/mcp"` });
    }
    const msg = JSON.parse(await readBody(req));
    if (msg.id === undefined) {
      log('notification');
      res.writeHead(202).end();
      return;
    }
    if (msg.method === 'initialize') {
      log('initialize');
      return json(200, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'fake', version: '1' } } }, { 'mcp-session-id': 'sess-1' });
    }
    // Everything after initialize must carry the session id the server handed out.
    if (req.headers['mcp-session-id'] !== 'sess-1') return json(400, { error: 'no session' });
    if (msg.method === 'tools/list') {
      log('tools/list');
      // SSE, to prove the proxy understands a streamed answer.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'ping' }] } })}\n\n`);
      return;
    }
    return json(200, { jsonrpc: '2.0', id: msg.id, result: {} });
  }
  if (req.method === 'GET' && url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
    return json(200, { resource: `http://127.0.0.1:${PORT}/mcp`, authorization_servers: [`http://127.0.0.1:${PORT}`], scopes_supported: ['read'] });
  }
  if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
    return json(200, { issuer: `http://127.0.0.1:${PORT}`, authorization_endpoint: `http://127.0.0.1:${PORT}/authorize`, token_endpoint: `http://127.0.0.1:${PORT}/token`, registration_endpoint: `http://127.0.0.1:${PORT}/register`, code_challenge_methods_supported: ['S256'] });
  }
  if (req.method === 'POST' && url.pathname === '/register') {
    await readBody(req);
    return json(200, { client_id: 'dyn-1' });
  }
  if (req.method === 'POST' && url.pathname === '/token') {
    const form = new URLSearchParams(await readBody(req));
    if (form.get('grant_type') !== 'refresh_token' || form.get('refresh_token') !== REFRESH) return json(400, { error: 'invalid_grant' });
    log('refresh');
    return json(200, { access_token: GOOD, refresh_token: REFRESH, expires_in: 3600 });
  }
  json(404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => writeFileSync(process.env.FAKE_READY, String(PORT)));
