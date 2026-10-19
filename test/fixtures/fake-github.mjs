// A fake GitHub REST API for the poller tests (S-55), free and local. It serves the handful
// of endpoints src/sources/github.ts calls, with ETags and 304s and rate-limit headers, so
// no test touches real GitHub. `startFakeGithub({ data })` returns the server, its url, and
// `update(patch)` to change what it serves; run as a script, it prints `URL=...` and takes
// the same patches over `POST /_control`. See test/github-poller.test.mjs and
// test/e2e-github-poller.sh.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const key = (o, r, n) => `${o}/${r}#${n}`;
const repoKey = (o, r) => `${o}/${r}`;

// A hash of a body, as an ETag. The same body gives the same tag, so a repeat poll 304s.
const etagOf = (body) => 'W/"' + createHash('sha1').update(JSON.stringify(body)).digest('hex') + '"';

function merge(target, patch) {
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) merge(target[k], v);
    else target[k] = v;
  }
  return target;
}

export function startFakeGithub(opts = {}) {
  const data = {
    // Rate-limit headers; a test lowers `remaining` to reach the back-off path.
    rate: { remaining: 5000, limit: 5000, reset: Math.floor(Date.now() / 1000) + 3600 },
    issues: {},
    pulls: {},
    checkRuns: {},
    statuses: {},
    reviews: {},
    comments: {},
    events: {},
    // Events per page at most (GitHub caps per_page at 100); a test lowers it to get several pages.
    pageSize: 100,
    ...opts.data,
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, body, headers = {}) => {
      const rl = data.rate;
      res.writeHead(status, {
        'content-type': 'application/json',
        'x-ratelimit-limit': String(rl.limit),
        'x-ratelimit-remaining': String(rl.remaining),
        'x-ratelimit-reset': String(rl.reset),
        ...headers,
      });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };

    // Control: apply a patch to what this fake serves (from the e2e's shell).
    if (req.method === 'POST' && url.pathname === '/_control') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        try {
          merge(data, JSON.parse(raw || '{}'));
          send(200, { ok: true });
        } catch (e) {
          send(400, { error: String(e) });
        }
      });
      return;
    }

    calls.push(`${req.method} ${url.pathname}${url.search}`);
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
    let body = route(url, parts, data);
    if (body === undefined) return send(404, { message: 'Not Found' });
    // The events list pages like GitHub's: per_page capped at pageSize, and a Link header while more follow.
    let link = {};
    if (parts.at(-1) === 'events' && Array.isArray(body)) {
      const size = Math.min(Number(url.searchParams.get('per_page') ?? 30), data.pageSize);
      const page = Number(url.searchParams.get('page') ?? 1);
      if (page * size < body.length) link = { link: `<${url.origin}${url.pathname}?page=${page + 1}>; rel="next"` };
      body = body.slice((page - 1) * size, page * size);
    }
    const tag = etagOf(body);
    if (req.headers['if-none-match'] === tag) return send(304, undefined, { etag: tag });
    send(200, body, { etag: tag, ...link });
  });

  const calls = [];

  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        data,
        calls,
        update: (patch) => merge(data, patch),
        close: () => new Promise((r) => server.close(r)),
        server,
      });
    });
  });
}

// The served body for a request, or undefined for a 404.
function route(url, parts, data) {
  if (parts[0] !== 'repos' || parts.length < 3) return undefined;
  const [, owner, repo, ...rest] = parts;
  const rk = repoKey(owner, repo);

  // /repos/:o/:r/events
  if (rest.length === 1 && rest[0] === 'events') return data.events[rk] ?? [];

  if (rest[0] === 'issues' && rest.length === 3 && rest[2] === 'comments') {
    const list = data.comments[key(owner, repo, rest[1])] ?? [];
    const since = url.searchParams.get('since');
    return since ? list.filter((c) => String(c.updated_at ?? c.created_at ?? '') > since) : list;
  }
  if (rest[0] === 'issues' && rest.length === 2) return data.issues[key(owner, repo, rest[1])];
  if (rest[0] === 'pulls' && rest.length === 3 && rest[2] === 'reviews') return data.reviews[key(owner, repo, rest[1])] ?? [];
  if (rest[0] === 'pulls' && rest.length === 2) return data.pulls[key(owner, repo, rest[1])];
  if (rest[0] === 'commits' && rest.length === 3 && rest[2] === 'check-runs') return { total_count: (data.checkRuns[`${rk}@${rest[1]}`] ?? []).length, check_runs: data.checkRuns[`${rk}@${rest[1]}`] ?? [] };
  if (rest[0] === 'commits' && rest.length === 3 && rest[2] === 'status') return data.statuses[`${rk}@${rest[1]}`] ?? { state: 'pending', statuses: [] };
  return undefined;
}

// Run as a script: print the url, then serve until killed (the e2e kills it by PID).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.STAM_FAKE_GITHUB_PORT ?? 0);
  const fake = await startFakeGithub({ port });
  console.log(`URL=${fake.url}`);
  const shutdown = () => fake.close().finally(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
