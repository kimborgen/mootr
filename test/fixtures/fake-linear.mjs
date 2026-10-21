// A fake Linear MCP server for the Linear poller tests (S-56), free and local. It speaks the
// streamable-HTTP MCP methods src/sources/mcp-client.ts uses (initialize, notifications, and
// tools/call for `get_issue`, `list_comments`, and `list_issues`, the team's issues changed
// since `updatedAt`, paged by `after`), requires the bearer `good` (any other gets a 401, so a
// test can prove the refresh path), serves the issues and comments it is given, and answers
// `throttle` calls with HTTP 429. The real Linear tool names and result shapes are unverified until the user logs in; these
// are the shapes the poller parses defensively. `startFakeLinear({ port })` returns the server,
// its url, `update(patch)`, and `close()`. Run as a script, it prints `URL=...` and takes the
// same patches over `POST /_control`. See test/linear-poller.test.mjs and
// test/e2e-linear-poller.sh.
import { createServer } from 'node:http';
import { isMain } from '../../scripts/main-guard.mjs';

const TOKEN = 'good';

function merge(target, patch) {
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) merge(target[k], v);
    else target[k] = v;
  }
  return target;
}

export function startFakeLinear(opts = {}) {
  const data = {
    // Keyed by the identifier, such as ENG-1.
    issues: {},
    comments: {},
    ...opts.data,
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };

    if (req.method === 'POST' && url.pathname === '/_control') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        try {
          merge(data, JSON.parse(raw || '{}'));
          json(200, { ok: true });
        } catch (e) {
          json(400, { error: String(e) });
        }
      });
      return;
    }

    if (url.pathname !== '/mcp') return json(404, { error: 'not found' });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: 'unauthorized' });
    if (req.method !== 'POST') return json(405, { error: 'POST only' });

    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const msg = JSON.parse(raw || '{}');
      if (msg.method === 'notifications/initialized' || msg.id === undefined) {
        res.writeHead(202);
        return res.end();
      }
      const reply = (result) => json(200, { jsonrpc: '2.0', id: msg.id, result }, { 'mcp-session-id': 'fake-linear-session' });
      if (msg.method === 'initialize') {
        return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-linear', version: '1' } });
      }
      if (msg.method === 'tools/call') {
        const args = msg.params?.arguments ?? {};
        const id = String(args.id ?? args.issueId ?? '');
        const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
        if (msg.params?.name === 'get_issue') {
          const issue = data.issues[id];
          if (!issue) return reply({ isError: true, content: [{ type: 'text', text: `no issue ${id}` }] });
          return reply(text(issue));
        }
        if (msg.params?.name === 'list_comments') {
          return reply(text({ comments: data.comments[id] ?? [] }));
        }
        if (msg.params?.name === 'list_issues') {
          // The team's issues changed since `updatedAt`, oldest first, a page at a time; `after` is
          // the offset the last page ended at. `throttle` answers that many calls with HTTP 429.
          if (data.throttle > 0) {
            data.throttle--;
            res.writeHead(429, { 'content-type': 'text/plain' });
            return res.end('rate limited');
          }
          const limit = Number(args.limit ?? 50);
          const from = data.ignoreAfter ? 0 : Number(args.after ?? 0);
          const all = Object.values(data.issues)
            .filter((i) => String(i.identifier ?? i.id).split('-')[0] === args.team && (!args.updatedAt || String(i.updatedAt) >= args.updatedAt))
            .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
          // `teamOrder: 'desc'` lists newest first, to prove the poller does not depend on the order.
          const ordered = data.teamOrder === 'desc' ? all.slice().reverse() : all;
          const nodes = ordered.slice(from, from + limit);
          // `ignoreAfter` answers the first page whatever `after` says; `endless` always has another page.
          const hasNextPage = data.endless || from + limit < ordered.length;
          return reply(text({ nodes, pageInfo: { hasNextPage, endCursor: hasNextPage ? String(from + limit) : null } }));
        }
        return json(200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `no tool ${msg.params?.name}` } });
      }
      return json(200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `no method ${msg.method}` } });
    });
  });

  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        update: (patch) => merge(data, patch),
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

// Run as a script: print the url, then serve until killed (the e2e kills it by PID).
if (isMain(import.meta.url)) {
  const port = Number(process.env.STAM_FAKE_LINEAR_PORT ?? 0);
  const fake = await startFakeLinear({ port });
  console.log(`URL=${fake.url}`);
  const shutdown = () => fake.close().finally(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
