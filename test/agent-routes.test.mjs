#!/usr/bin/env node
// The auth contract for the per-agent routes (S-1900): every `/api/agents/:id/...` route in src/daemon.ts has
// one auth decision in src/agent-routes.ts, and the `acting` gate and the OpenCode exemption come from it.
// Free; reads the sources, no daemon: `node --test test/agent-routes.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AGENT_ROUTES, matchActing, opencodeNamesAgent } from '../src/agent-routes.ts';

const AUTHS = ['acting', 'self', 'by', 'tree', 'human', 'peer', 'open'];
const src = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');

// Every route literal that starts with the agent id and directly follows its method: `['GET', /^...$/` or
// `'GET',\n /^...$/`.
const PREFIX = String.raw`/^\/api\/agents\/([\w-]+)`;
const MENTION = String.raw`\/api\/agents\/`;
const lineOf = (at) => src.slice(src.lastIndexOf('\n', at) + 1, src.indexOf('\n', at));
function daemonRoutes() {
  const found = [];
  for (let at = src.indexOf(PREFIX); at !== -1; at = src.indexOf(PREFIX, at + 1)) {
    const method = /'(GET|POST|PUT|PATCH|DELETE)',\s*$/.exec(src.slice(Math.max(0, at - 40), at));
    if (method) found.push(`${method[1]} ${src.slice(at + PREFIX.length, src.indexOf('$/', at))}`);
  }
  return found;
}

// Any other regex on a per-agent path must be known: the scan fails on a route written another way (a different
// id capture, a comment between the method and the regex), rather than skipping it.
test('the scan sees every regex on a per-agent path', () => {
  const others = [];
  for (let at = src.indexOf(MENTION); at !== -1; at = src.indexOf(MENTION, at + 1)) {
    const method = /'(GET|POST|PUT|PATCH|DELETE)',\s*$/.exec(src.slice(Math.max(0, at - 42), at - 2));
    if (!(method && src.startsWith(PREFIX, at - 2))) others.push(lineOf(at).trim());
  }
  assert.equal(others.length, 1, `a regex on a per-agent path that is not a recognized route literal:\n${others.join('\n')}`);
  assert.match(others[0], /^const am = path\.match\(/, 'the one known non-route regex is the relay match');
});

test('every per-agent route has an auth decision, and every decision has a route', () => {
  const routes = daemonRoutes().sort();
  const table = AGENT_ROUTES.map((r) => `${r.method} ${r.path}`).sort();
  assert.ok(routes.length >= 25, `the scan found only ${routes.length} routes`);
  assert.deepEqual(routes.filter((r) => !table.includes(r)), [], 'a route in src/daemon.ts with no entry in src/agent-routes.ts');
  assert.deepEqual(table.filter((r) => !routes.includes(r)), [], 'an entry in src/agent-routes.ts with no route in src/daemon.ts');
  assert.equal(new Set(table).size, table.length, 'two entries for one route');
});

test('every entry names a known auth and gives its reason', () => {
  for (const r of AGENT_ROUTES) {
    assert.ok(AUTHS.includes(r.auth), `${r.method} ${r.path}: unknown auth ${r.auth}`);
    assert.ok(r.why.trim().length > 10, `${r.method} ${r.path}: no reason`);
  }
});

test('the routes open to every agent token are listed here, each with its reason', () => {
  // Adding a route to this list is the decision that an unrelated agent's token may use it.
  assert.deepEqual(AGENT_ROUTES.filter((r) => r.auth === 'open').map((r) => `${r.method} ${r.path || '(the agent itself)'}`), ['GET (the agent itself)', 'GET \\/waits']);
});

test('the acting gate matches the acting routes only, and takes the agent id from group 1', () => {
  const path = (r) => `/api/agents/amy${r.path.replaceAll('\\/', '/').replace('([\\w-]+)', 'thread1').replace(/\((\w+)(\|[^)]*)?\)/, '$1')}`;
  for (const r of AGENT_ROUTES) {
    const hit = matchActing(r.method, path(r));
    if (r.auth === 'acting') assert.equal(hit?.[1], 'amy', `${r.method} ${r.path} isn't gated`);
    else if (r.path) assert.equal(hit, null, `${r.method} ${r.path} is gated but not acting`);
  }
  assert.equal(matchActing('GET', '/api/agents/amy'), null);
  assert.equal(matchActing('GET', '/api/agents/amy/files/x'), null);
  assert.equal(matchActing('POST', '/api/agents/amy/files'), null, 'the gate follows the method');
});

test('the OpenCode exemption covers the acting routes, workspace-share, and not an add-wait', () => {
  assert.ok(opencodeNamesAgent('POST', '/api/agents/amy/waits/done'));
  assert.ok(opencodeNamesAgent('POST', '/api/agents/amy/workspace-share'));
  assert.ok(opencodeNamesAgent('POST', '/api/agents/amy/threads/t1/archive'));
  assert.ok(!opencodeNamesAgent('POST', '/api/agents/amy/waits'), 'mayManageWaits reads a missing by as the human');
  assert.ok(!opencodeNamesAgent('POST', '/api/agents/amy/kill'));
  assert.ok(!opencodeNamesAgent('PUT', '/api/agents/amy/default-view'));
});
