#!/usr/bin/env node
// Agent rows leave the daemon through an allowlist (S-2519): token_hash never goes out, and a
// column added to the table later isn't served until it is listed on purpose. Throwaway
// STAM_HOME, no daemon, no model. `node --test test/agent-public.test.mjs`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { tempHome } from './tmphome.mjs';

process.env.STAM_HOME = tempHome('stam-agent-public-');
delete process.env.STAM_TOKEN;

let db, pub;
before(async () => {
  db = await import('../src/db.ts');
  pub = await import('../src/agent-public.ts');
});

const SECRET = /token|secret|password|key_hash/i;
// Keys that match SECRET and are served on purpose.
const ON_PURPOSE = new Set(['context_tokens', 'tokens_after_compaction', 'token']);

function seed(name) {
  const a = db.createAgent({ id: `id-${name}`, name, role: '', machine: 'm1', harness: 'claude-code', model: null, effort: null, cwd: '/tmp/x', parent_id: null, session_id: null });
  db.setTokenHash(a.id, 'a'.repeat(64));
  return a.id;
}

test('the allowlist has no secret-looking key except those named on purpose', () => {
  for (const k of [...pub.PUBLIC_AGENT_COLUMNS, ...pub.PUBLIC_AGENT_EXTRAS]) {
    if (SECRET.test(k)) assert.ok(ON_PURPOSE.has(k), `${k} looks secret and isn't on purpose`);
  }
  assert.ok(!pub.PUBLIC_AGENT_COLUMNS.includes('token_hash'));
});

test('a stored row has token_hash, and publicAgent drops it', () => {
  const id = seed('alpha');
  const row = db.getAgent(id);
  assert.equal(row.token_hash, 'a'.repeat(64), 'the daemon keeps it for auth');
  const out = pub.publicAgent(row);
  assert.equal(out.id, id);
  assert.equal(out.name, 'alpha');
  assert.ok(!('token_hash' in out));
  assert.ok(!JSON.stringify(out).includes('a'.repeat(64)));
});

test('a new column on the row is not served', () => {
  const id = seed('beta');
  const row = { ...db.getAgent(id), api_secret: 'hunter2', future_col: 1, token_hash: 'x' };
  const out = pub.publicAgent(row);
  for (const k of Object.keys(out)) assert.ok(!SECRET.test(k) || ON_PURPOSE.has(k), `${k} served`);
  assert.ok(!('api_secret' in out) && !('future_col' in out));
});

test('every column of the real table is allowlisted or deliberately withheld', () => {
  const id = seed('gamma');
  const cols = Object.keys(db.getAgent(id));
  const withheld = cols.filter((c) => !pub.PUBLIC_AGENT_COLUMNS.includes(c));
  assert.deepEqual(withheld, ['token_hash'], 'a new column must be added to PUBLIC_AGENT_COLUMNS or consciously withheld here');
});

test('scrubAgents cleans rows anywhere in a reply: lists, nested, and spread extras', () => {
  const id = seed('delta');
  const row = db.getAgent(id);
  const reply = { agent: row, members: [row, { ...row, view: { can_send: true }, blockers: [] }], other: { id: 'x', name: 'n' }, n: 3 };
  const json = JSON.stringify(pub.scrubAgents(reply));
  assert.ok(!/token_hash|a{64}/.test(json));
  const back = JSON.parse(json);
  assert.deepEqual(back.members[1].view, { can_send: true });
  assert.deepEqual(back.other, { id: 'x', name: 'n' });
  assert.equal(back.n, 3);
});

test('a list row sends first_prompt as null and keeps every other public key (S-3808)', () => {
  const id = seed('epsilon');
  db.updateAgent(id, { first_prompt: 'the whole spawn brief' });
  const row = db.getAgent(id);
  const listed = pub.listedAgent(row);
  assert.equal(listed.first_prompt, null);
  assert.deepEqual(Object.keys(listed), Object.keys(pub.publicAgent(row)));
  assert.ok(!('token_hash' in listed));
  assert.equal(pub.publicAgent(row).first_prompt, 'the whole spawn brief', 'the detail shape keeps it');
});

test('the list keeps live agents by default; state and ids ask for others (S-3816)', () => {
  const rows = [
    { id: 'a', name: 'act', lifecycle: 'active' },
    { id: 'p', name: 'pau', lifecycle: 'paused' },
    { id: 's', name: 'stop', lifecycle: 'shut_down' },
    { id: 'x', name: 'arch', lifecycle: 'archived' },
  ];
  const ids = (state, want) => rows.filter(pub.listFilter(state, want)).map((r) => r.id);
  assert.deepEqual(ids(null, null), ['a', 'p']);
  assert.deepEqual(ids('stopped', null), ['s']);
  assert.deepEqual(ids('live,archived', null), ['a', 'p', 'x']);
  assert.deepEqual(ids('all', null), ['a', 'p', 's', 'x']);
  assert.deepEqual(ids(null, 'x,stop'), ['s', 'x'], 'ids alone lists only those, by id or name, in any state');
  assert.deepEqual(ids('live', 'x'), ['a', 'p', 'x'], 'ids add to a state');
  assert.deepEqual(ids('', null), ['a', 'p'], 'an empty state is the default');
  assert.equal(pub.listFilter('gone', null), null);
});
