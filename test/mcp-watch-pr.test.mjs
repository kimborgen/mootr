#!/usr/bin/env node
// watch_pr and unwatch_pr (S-446) in src/mcp.ts: a PR named as a number, OWNER/REPO#N, or a url
// becomes one subscription on its subject, with the event presets as types and a merge or close
// as the ending types; watching again replaces the earlier watch; unwatch_pr removes it. A fake
// daemon on loopback keeps the subscriptions, so the test checks what the tool posts and deletes.
// Free, no model. `node --test test/mcp-watch-pr.test.mjs`.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-mcp-watch-pr-');
process.env.STAM_HOME = home;
for (const k of ['STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

// The fake's subscriptions, and every call the tool made.
let subs = [];
const calls = [];
let seq = 0;
// What the ITSA home says the default repo is (null: it has none, S-614). The tool asks the daemon, never reads settings.
let homeRepo = 'example/stam';
const daemon = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const data = body ? JSON.parse(body) : undefined;
    calls.push({ method: req.method, path: req.url, body: data });
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const by = new URL(req.url, 'http://x').searchParams.get('by');
    if (req.method === 'GET' && req.url.startsWith('/api/subscriptions')) return send(200, subs.filter((s) => s.created_by === by || s.subscriber_id === by));
    if (req.method === 'POST' && req.url === '/api/subscriptions') {
      // As the daemon does: an agent named by name is stored by its id; an unknown one is refused.
      if (data.subscriber_kind === 'agent' && data.subscriber_id === 'nobody') return send(400, { error: 'no agent nobody' });
      const resolved = data.subscriber_id === 'agent-reviewer' ? 'a-rev' : data.subscriber_id;
      const sub = { id: `es-${++seq}`, subscriber_kind: data.subscriber_kind, subscriber_id: resolved, filter: data.filter, note: data.note, created_by: data.by };
      subs.push(sub);
      return send(200, sub);
    }
    if (req.method === 'DELETE' && req.url.startsWith('/api/subscriptions/')) {
      const id = decodeURIComponent(req.url.split('/').pop());
      subs = subs.filter((s) => s.id !== id);
      return send(200, { ok: true });
    }
    if (req.method === 'GET' && req.url === '/api/pr/github-repo') return send(200, { github: homeRepo });
    send(404, { error: 'not here' });
  });
});
let mcp;
before(async () => {
  await new Promise((r) => daemon.listen(0, '127.0.0.1', r));
  process.env.STAM_URL = `http://127.0.0.1:${daemon.address().port}`;
  mcp = await import('../src/mcp.ts');
});
after(() => {
  daemon.close();
  rmSync(home, { recursive: true, force: true });
});
beforeEach(() => {
  subs = [];
  homeRepo = 'example/stam';
  calls.length = 0;
});

const self = 'agent-watch-pr';
const ALL = ['checks.completed', 'review.submitted', 'comment.created', 'pull_request.synchronize', 'pull_request.merged', 'pull_request.closed'];
const posted = () => calls.filter((c) => c.method === 'POST' && c.path === '/api/subscriptions').map((c) => c.body);
const deleted = () => calls.filter((c) => c.method === 'DELETE').map((c) => c.path);

test('watch_pr with a number watches that PR in the default repo, for every event', async () => {
  await mcp.callTool('watch_pr', { self, pr: 1234 });
  assert.equal(posted().length, 1);
  const b = posted()[0];
  assert.equal(b.subscriber_kind, 'agent');
  assert.equal(b.subscriber_id, self);
  assert.equal(b.by, self);
  assert.equal(b.note, 'PR #1234 watch');
  assert.deepEqual(b.filter.subjects, ['github:example/stam#1234']);
  assert.equal(b.filter.source, 'github');
  assert.deepEqual([...b.filter.types].sort(), [...ALL].sort());
  assert.deepEqual(b.filter.ends_on, ['pull_request.merged', 'pull_request.closed']);
  assert.ok(b.filter.since && !Number.isNaN(Date.parse(b.filter.since)), 'the watch starts now, so older changes are not replayed (S-795)');
});

test('watch_pr takes OWNER/REPO#N and a pull request url, and a bare #N', async () => {
  await mcp.callTool('watch_pr', { self, pr: 'o/r#5' });
  await mcp.callTool('watch_pr', { self, pr: 'https://github.com/x/y/pull/7/files' });
  await mcp.callTool('watch_pr', { self, pr: '#9' });
  assert.deepEqual(posted().map((b) => b.filter.subjects[0]), ['github:o/r#5', 'github:x/y#7', 'github:example/stam#9']);
});

test('watch_pr narrows to the presets chosen, and a merge or close still ends and is delivered', async () => {
  await mcp.callTool('watch_pr', { self, pr: 1, events: ['checks', 'reviews'] });
  assert.deepEqual([...posted()[0].filter.types].sort(), ['checks.completed', 'pull_request.closed', 'pull_request.merged', 'review.submitted'].sort());
  await mcp.callTool('watch_pr', { self, pr: 2, events: ['pushes'] });
  assert.ok(posted()[1].filter.types.includes('pull_request.synchronize'));
  assert.ok(posted()[1].filter.types.includes('pull_request.merged'), 'the merge is delivered even when it is not picked');
});

test('watch_pr for another agent subscribes that agent; for human subscribes the human', async () => {
  await mcp.callTool('watch_pr', { self, pr: 3, for: 'agent-reviewer' });
  await mcp.callTool('watch_pr', { self, pr: 4, for: 'human' });
  assert.equal(posted()[0].subscriber_id, 'agent-reviewer', 'the request names the reviewer');
  assert.equal(posted()[0].subscriber_kind, 'agent');
  assert.equal(posted()[1].subscriber_kind, 'human');
  assert.equal(posted()[1].subscriber_id, 'human');
});

test('watching again replaces the earlier watch, so one PR has one subscription', async () => {
  await mcp.callTool('watch_pr', { self, pr: 1 });
  assert.equal(subs.length, 1);
  await mcp.callTool('watch_pr', { self, pr: 1, events: ['checks'] });
  assert.equal(subs.length, 1, 'the earlier one is gone');
  assert.equal(deleted().length, 1);
  assert.deepEqual(subs[0].filter.types.includes('checks.completed'), true);
});

test('unwatch_pr removes the watch; with none it says so', async () => {
  await mcp.callTool('watch_pr', { self, pr: 1 });
  await mcp.callTool('watch_pr', { self, pr: 2 });
  const out = await mcp.callTool('unwatch_pr', { self, pr: 1 });
  assert.match(JSON.stringify(out), /Stopped watching PR #1/);
  assert.deepEqual(subs.map((s) => s.filter.subjects[0]), ['github:example/stam#2'], 'PR 2 is still watched');
  const none = await mcp.callTool('unwatch_pr', { self, pr: 1 });
  assert.match(JSON.stringify(none), /No watch on PR #1/);
});

test('a pr that is none of the three forms, or an unknown event, is refused', async () => {
  await assert.rejects(mcp.callTool('watch_pr', { self, pr: 'not a pr' }), /pr must be a number/);
  await assert.rejects(mcp.callTool('watch_pr', { self, pr: 1, events: ['deploys'] }), /no PR event deploys/);
  assert.equal(posted().length, 0, 'nothing was posted');
});

test('watching again for a name replaces the watch: the daemon stores the id, so the earlier one is found', async () => {
  await mcp.callTool('watch_pr', { self, pr: 3, for: 'agent-reviewer' });
  await mcp.callTool('watch_pr', { self, pr: 3, for: 'agent-reviewer', events: ['checks'] });
  const onPr = subs.filter((x) => x.filter.subjects[0] === 'github:example/stam#3');
  assert.equal(onPr.length, 1, 'one watch on PR 3 for the reviewer');
  assert.equal(onPr[0].subscriber_id, 'a-rev');
  assert.deepEqual(onPr[0].filter.types.includes('checks.completed'), true);
});

test('a refused for leaves the earlier watch in place', async () => {
  await mcp.callTool('watch_pr', { self, pr: 5 });
  await assert.rejects(mcp.callTool('watch_pr', { self, pr: 5, for: 'nobody' }), /no agent nobody/);
  assert.equal(subs.length, 1, 'the earlier watch is still there');
  assert.equal(subs[0].subscriber_id, self);
  assert.equal(deleted().length, 0, 'nothing was removed');
});

test('a bare number takes the ITSA home\'s default repo; with none known it asks for OWNER/REPO#N, and a full ref needs no lookup', async () => {
  homeRepo = 'acme/tool';
  await mcp.callTool('watch_pr', { self, pr: 5 });
  assert.equal(posted()[0].filter.subjects[0], 'github:acme/tool#5');
  homeRepo = null;
  await assert.rejects(mcp.callTool('watch_pr', { self, pr: 6 }), /no default GitHub repo/);
  calls.length = 0;
  await mcp.callTool('watch_pr', { self, pr: 'o/r#7' });
  assert.equal(calls.some((c) => c.path === '/api/pr/github-repo'), false);
});
