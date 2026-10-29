#!/usr/bin/env node
// ring_submit refuses a parameter it doesn't know (a `body` for `text`) and a submission with no
// findings text, at the MCP tool and at the ring itself (S-1919). A fake daemon on loopback records
// the calls; the ring check runs with a throwaway STAM_HOME. Free, no model.
// `node --test test/mcp-ring-submit.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-mcp-ring-submit-');
process.env.STAM_HOME = home;
for (const k of ['STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

const calls = [];
const daemon = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    calls.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : undefined });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ result: 'Submitted. Waiting for the other members.' }));
  });
});
let mcp;
let ring;
let db;
before(async () => {
  await new Promise((r) => daemon.listen(0, '127.0.0.1', r));
  process.env.STAM_URL = `http://127.0.0.1:${daemon.address().port}`;
  mcp = await import('../src/mcp.ts');
  ring = await import('../src/ring.ts');
  db = await import('../src/db.ts');
});
after(() => {
  daemon.close();
  rmSync(home, { recursive: true, force: true });
});

const self = 'agent-ring-submit';
const base = { self, ring: 'rev-613e', agree: false, verdict: 'request_changes' };
const BLANK = { message: 'text is required: your findings for the ring, as a non-empty string' };

test('a body for text is refused, names text, and makes no call', async () => {
  calls.length = 0;
  await assert.rejects(mcp.callTool('ring_submit', { ...base, body: 'Two findings.' }), { message: 'ring_submit has no parameter body: put your findings in text' });
  assert.equal(calls.length, 0);
});

test('a missing, empty or blank text is refused and makes no call', async () => {
  calls.length = 0;
  await assert.rejects(mcp.callTool('ring_submit', { ...base }), BLANK);
  await assert.rejects(mcp.callTool('ring_submit', { ...base, text: '' }), BLANK);
  await assert.rejects(mcp.callTool('ring_submit', { ...base, text: ' \n\t ' }), BLANK);
  await assert.rejects(mcp.callTool('ring_submit', { ...base, text: 42 }), BLANK);
  assert.equal(calls.length, 0);
});

test('a submission with text posts it to the ring and returns the daemon result', async () => {
  calls.length = 0;
  const out = await mcp.callTool('ring_submit', { ...base, text: 'Finding 1: the cap is off by one.' });
  assert.equal(out.content[0].text, 'Submitted. Waiting for the other members.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, '/api/rings/rev-613e/submit');
  assert.deepEqual(calls[0].body, { by: self, text: 'Finding 1: the cap is off by one.', agree: false, verdict: 'request_changes' });
});

test('the round the prompt showed goes to the daemon with the submission (S-2646)', async () => {
  calls.length = 0;
  await mcp.callTool('ring_submit', { ...base, text: 'Round two findings.', round: 2 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.round, 2);
});

test('the ring refuses blank text before it looks the ring up', () => {
  assert.throws(() => ring.submit('no-such-ring', 'agent', '  ', false), BLANK);
  assert.throws(() => ring.submit('no-such-ring', 'agent', '', true), BLANK);
});

test('the seat the text is for goes to the daemon with the submission (S-2760)', async () => {
  calls.length = 0;
  await mcp.callTool('ring_submit', { ...base, text: 'For the predecessor.', seat: 'pred-seat' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.seat, 'pred-seat');
});

// A member holding its own seat and its predecessor's (cost_switch's takeover, S-2485) in a rounds ring.
// The ring is real, with a throwaway STAM_HOME and no daemon, so each refusal is the ring's own (S-2760).
const agent = (name) => db.createAgent({ id: db.newAgentId(), name, role: '', machine: 'test', harness: 'fake', model: null, effort: null, cwd: home, parent_id: null, session_id: null });
const seatRing = (n) => {
  const pred = agent(`pred-${n}`);
  const own = agent(`own-${n}`);
  db.updateAgent(pred.id, { forwarded_to: own.id });
  const r = ring.createRing({ name: `seat-${n}`, format: 'rounds', topic: 'review the change', members: [pred.name, own.name], maxRounds: 2, createdBy: 'human' });
  return { r, pred, own };
};
const seatRow = (r, agentId) => ring.status(r.id).submissions.find((s) => s.agent_id === agentId);

test('two open seats and no seat: refused, naming both, nothing written (S-2760)', () => {
  const { r, pred, own } = seatRing(1);
  assert.throws(() => ring.submit(r.id, own.id, 'Findings.', true), {
    message: `you hold 2 open seats, so pass seat, the member's name, for whose text this is: your open seats in ${r.name} are ${own.name}, ${pred.name}`,
  });
  assert.equal(ring.status(r.id).submissions.length, 0);
});

test('a seat the caller does not hold is refused, naming the open seats (S-2760)', () => {
  const { r, pred, own } = seatRing(2);
  const other = agent('stranger-2');
  assert.throws(() => ring.submit(r.id, own.id, 'Findings.', true, undefined, undefined, other.name), {
    message: `you do not hold the seat ${other.name}: your open seats in ${r.name} are ${own.name}, ${pred.name}`,
  });
  assert.equal(ring.status(r.id).submissions.length, 0);
});

test('a seat already filled this round is rewritten, and the other seat still takes its text (S-2955)', () => {
  const { r, pred, own } = seatRing(3);
  assert.equal(ring.submit(r.id, own.id, 'Own findings.', false, undefined, undefined, own.name), 'Submitted. Waiting for the other members.');
  assert.equal(ring.submit(r.id, own.id, 'Own revised.', true, undefined, undefined, own.name), 'Submitted. Waiting for the other members.');
  assert.equal(seatRow(r, own.id).text, 'Own revised.', 'the rewrite replaced the text');
  assert.equal(ring.status(r.id).submissions.length, 1);
  ring.submit(r.id, own.id, 'For the predecessor.', false, undefined, undefined, pred.name);
  assert.equal(seatRow(r, pred.id).text, 'For the predecessor.', 'the text lands under the predecessor\'s name');
  assert.equal(seatRow(r, own.id).text, 'Own revised.');
});

test('a rewrite does not complete or advance the round, and the round completes once (S-2955)', () => {
  const { r, pred, own } = seatRing(5);
  ring.submit(r.id, own.id, 'v1', false, undefined, 1, own.name);
  ring.submit(r.id, own.id, 'v2', false, undefined, 1, own.name);
  assert.equal(ring.status(r.id).round, 1);
  assert.equal(ring.submit(r.id, own.id, 'pred', false, undefined, 1, pred.name), 'Submitted. The round is complete.');
  assert.equal(ring.status(r.id).round, 2);
  assert.throws(() => ring.submit(r.id, own.id, 'stale', false, undefined, 1, own.name), /is on round 2, not 1/);
  assert.equal(ring.status(r.id).round, 2);
});

test('a named seat already filled in a fire ring is refused by the turn check (S-2955)', () => {
  const [a, b] = [agent('fire-a-6'), agent('fire-b-6')];
  const r = ring.createRing({ name: 'seat-6', format: 'fire', topic: 'review the change', members: [a.name, b.name], maxRounds: 2, createdBy: 'human' });
  ring.submit(r.id, a.id, 'First.', false, undefined, undefined, a.name);
  assert.throws(() => ring.submit(r.id, a.id, 'Again.', false, undefined, undefined, a.name), { message: `it is ${b.name}'s turn` });
  assert.equal(seatRow(r, a.id).text, 'First.');
  assert.equal(ring.status(r.id).turn, 1);
});

test('a rendered turn prompt names the seat and round (S-2955)', () => {
  const { r, own } = seatRing(7);
  const p = ring.turnPrompt(r, own.id);
  assert.ok(p.includes(`seat: ${own.name}, round: 1)`), p);
});

test('one open seat and no seat: the text goes to that seat, as before (S-2760)', () => {
  const [a, b] = [agent('solo-a-4'), agent('solo-b-4')];
  const r = ring.createRing({ name: 'seat-4', format: 'rounds', topic: 'review the change', members: [a.name, b.name], maxRounds: 2, createdBy: 'human' });
  assert.equal(ring.submit(r.id, a.id, 'Solo findings.', true), 'Submitted. Waiting for the other members.');
  assert.equal(seatRow(r, a.id).text, 'Solo findings.');
});
