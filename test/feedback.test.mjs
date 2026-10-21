#!/usr/bin/env node
// Unit tests for src/feedback.ts (S-156): the standing Feedback parent (created on first use,
// under the root of S-1's tree when S-1 exists), filing a report as a backlog ITSA with the
// reporter as participant, the duplicate guard (same tool and normalized summary: a comment,
// not a new ITSA), and the one quiet mail to the chief of staff. A fake API stands in for the
// daemon, so no daemon or network. Run with `node --test test/feedback.test.mjs`.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { report, feedbackParent, normalize } = await import('../src/feedback.ts');

// An in-memory stand-in for the daemon routes the feedback module calls.
// `agents` is the agent list; `events` maps `agentId type` to its event rows, or to a status a read is refused with.
function fakeApi({ s1 = null, cos = 'cos', agents = [], events = {} } = {}) {
  const itsas = [];
  const comments = [];
  const mails = [];
  let n = 0;
  const seen = [];
  const api = async (method, path, body) => {
    seen.push(`${method} ${path}`);
    if (method === 'GET' && path.startsWith('/api/itsas?kind=')) return itsas.filter((x) => x.kind === 'feedback');
    if (method === 'GET' && path === '/api/itsas/S-1') {
      if (!s1) throw new Error('404 no such ITSA');
      return s1;
    }
    if (method === 'GET' && path.startsWith('/api/itsas?parent=')) {
      const parent = path.match(/parent=([^&]+)/)[1];
      return itsas.filter((x) => x.parent_id === parent && x.kind === 'feedback-report');
    }
    if (method === 'GET' && path.startsWith('/api/itsas/')) {
      const id = path.split('/').pop();
      return itsas.find((x) => x.id === id);
    }
    if (method === 'POST' && path === '/api/itsas') {
      n += 1;
      // Reports are S-101, S-102, ...; the parent is F-1, so the keys in the asserts hold.
      const key = body.kind === 'feedback' ? 'F-1' : `S-${100 + itsas.filter((x) => x.kind === 'feedback-report').length + 1}`;
      const row = { id: `id${n}`, key, closed_at: null, participants: [], ...body, parent_id: body.parent ?? null };
      if (!('body' in row)) row.body = null;
      delete row.by;
      itsas.push(row);
      return row;
    }
    if (method === 'POST' && path.endsWith('/post')) {
      comments.push({ id: path.split('/')[3], body: body.body, by: body.by });
      return {};
    }
    if (method === 'GET' && path === '/api/chief-of-staff') return { chiefOfStaff: cos };
    if (method === 'POST' && path === '/api/mail') {
      mails.push(body);
      return {};
    }
    if (method === 'GET' && path === '/api/agents') return agents;
    const ev = path.match(/^\/api\/agents\/([^/]+)\/events\?type=([^&]+)&limit=1$/);
    if (method === 'GET' && ev) {
      const got = events[`${ev[1]} ${ev[2]}`];
      if (typeof got === 'number') throw Object.assign(new Error(`agent rev-816 can't act as ${ev[1]}`), { status: got });
      return got ?? [];
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { api, itsas, comments, mails, seen };
}

const sends = (f) => f.seen.filter((s) => s === 'POST /api/itsas').length;

let f;
beforeEach(() => {
  f = fakeApi();
});

test('normalize drops case, punctuation and spacing', () => {
  assert.equal(normalize('  Send_MAIL drops\nreply_to!! '), 'send mail drops reply to');
});

test('the standing parent is a root when S-1 does not exist, and is reused', async () => {
  const a = await feedbackParent(f.api, 'alice');
  const b = await feedbackParent(f.api, 'alice');
  assert.equal(a.title, 'Feedback');
  assert.equal(a.kind, 'feedback');
  assert.equal(a.parent_id, null);
  assert.equal(b.id, a.id);
  assert.equal(sends(f), 1, 'the parent is created once');
});

test('the parent goes under the root of S-1 when S-1 exists', async () => {
  const g = fakeApi({ s1: { id: 'mid', parent_chain: [{ id: 'root', key: 'S-0', title: 'Root', status: 'ready' }] } });
  const p = await feedbackParent(g.api, 'alice');
  assert.equal(p.parent_id, 'root');
  const h = fakeApi({ s1: { id: 's1-id', parent_chain: [] } });
  assert.equal((await feedbackParent(h.api, 'alice')).parent_id, 's1-id');
});

test('a report becomes a backlog ITSA under the parent, with the reporter and one quiet mail to the chief of staff', async () => {
  const text = await report(f.api, 'alice', { kind: 'bug', summary: 'send_mail drops reply_to', details: 'It ignored reply_to.', tool: 'send_mail' });
  const parent = f.itsas.find((x) => x.title === 'Feedback');
  const r = f.itsas.find((x) => x.kind === 'feedback-report');
  assert.match(text, /^Filed S-101 /);
  assert.equal(r.parent_id, parent.id);
  assert.equal(r.title, 'send_mail drops reply_to');
  assert.deepEqual(r.participants, ['alice']);
  assert.match(r.body, /^Kind: bug\nTool: send_mail\nReporter: alice\n\nIt ignored reply_to\.$/);
  assert.equal(f.mails.length, 1);
  assert.deepEqual(f.mails[0].to, ['cos']);
  assert.equal(f.mails[0].itsa, 'S-101');
  assert.equal(f.mails[0].from, 'alice');
});

test('a repeat of an open report with the same tool and summary becomes a comment, not a new ITSA or mail', async () => {
  await report(f.api, 'alice', { kind: 'bug', summary: 'send_mail drops reply_to', details: 'first', tool: 'send_mail' });
  const text = await report(f.api, 'bob', { kind: 'bug', summary: 'Send mail drops: reply to', details: 'again', tool: 'send_mail' });
  assert.match(text, /^Already reported as S-101/);
  assert.equal(f.itsas.filter((x) => x.kind === 'feedback-report').length, 1);
  assert.equal(f.mails.length, 1);
  assert.equal(f.comments.length, 1);
  assert.equal(f.comments[0].by, 'bob');
  assert.match(f.comments[0].body, /again/);
});

test('a different tool, or a closed report, is a new report', async () => {
  await report(f.api, 'alice', { kind: 'bug', summary: 'drops reply_to', details: 'a', tool: 'send_mail' });
  await report(f.api, 'alice', { kind: 'bug', summary: 'drops reply_to', details: 'b', tool: 'itsa_set' });
  assert.equal(f.itsas.filter((x) => x.kind === 'feedback-report').length, 2);
  f.itsas.find((x) => x.key === 'S-101').closed_at = '2026-10-12T10:00:00Z';
  await report(f.api, 'alice', { kind: 'bug', summary: 'drops reply_to', details: 'c', tool: 'send_mail' });
  assert.equal(f.itsas.filter((x) => x.kind === 'feedback-report').length, 3);
});

test('no tool is recorded as none, and no chief of staff means no mail', async () => {
  const g = fakeApi({ cos: null });
  const text = await report(g.api, 'alice', { kind: 'missing_feature', summary: 'a  bulk archive', details: 'x' });
  assert.match(text, /^Filed S-101 .* under Feedback\.$/);
  assert.match(g.itsas.find((x) => x.kind === 'feedback-report').body, /^Kind: missing_feature\nTool: none\n/);
  assert.equal(g.mails.length, 0);
});

test('a bad kind or an empty summary is refused before anything is filed', async () => {
  await assert.rejects(report(f.api, 'alice', { kind: 'gripe', summary: 'x', details: 'y' }), /kind must be one of/);
  await assert.rejects(report(f.api, 'alice', { kind: 'bug', summary: '  \n ', details: 'y' }), /summary is required/);
  assert.equal(f.itsas.length, 0);
});

// S-2679: a report that names a screen event carries that agent's latest screen, read with the reporter's token.
const screenRow = (data, ts = '2026-10-20T11:29:01Z') => [{ id: 9, ts, type: 'first-prompt:screen', data: JSON.stringify(data) }];
const go = { id: 'agrtq', name: 'go-mgr' };
const details = 'go-mgr hit `first-prompt:screen` on resume: the prompt showed twice.';

test('a report naming a screen event attaches the latest screen of the agent it names, in a bounded fenced block', async () => {
  const g = fakeApi({ agents: [go, { id: 'rev', name: 'rev-816' }], events: { 'agrtq first-prompt:screen': screenRow({ error: 'x', screen: ['> resume prompt', '', 'Next: when #743 merges'] }) } });
  await report(g.api, 'rev', { kind: 'bug', summary: 'resume prompt shows twice', details });
  const r = g.itsas.find((x) => x.kind === 'feedback-report');
  assert.match(r.body, /^Kind: bug\nTool: none\nReporter: rev\n\ngo-mgr hit/);
  assert.match(r.body, /Screen of first-prompt:screen on go-mgr \(event at 2026-10-20T11:29:01Z, latest\):\n\n```text\n> resume prompt\n\nNext: when #743 merges\n```$/);
  assert.equal(g.mails.length, 1, 'the report still goes to the chief of staff');
});

test('a screen named by no known agent, or with no such event, files the report with a line saying why', async () => {
  const g = fakeApi({ agents: [go] });
  await report(g.api, 'rev', { kind: 'bug', summary: 'a', details: 'input:screen on nobody-here' });
  const none = g.itsas.find((x) => x.kind === 'feedback-report').body;
  assert.match(none, /Screen not attached: the report names no agent this daemon knows\./);
  const h = fakeApi({ agents: [go] });
  await report(h.api, 'rev', { kind: 'bug', summary: 'b', details: 'go-mgr, input:screen' });
  assert.match(h.itsas.find((x) => x.kind === 'feedback-report').body, /Screen not attached: no input:screen event for go-mgr\./);
});

test("another tree's agent is refused by the daemon: no screen attached, the note says it isn't in the reporter's tree", async () => {
  const g = fakeApi({ agents: [go], events: { 'agrtq first-prompt:screen': 403 } });
  const text = await report(g.api, 'rev', { kind: 'bug', summary: 'refused', details });
  assert.match(text, /^Filed S-101 /);
  const body = g.itsas.find((x) => x.kind === 'feedback-report').body;
  assert.doesNotMatch(body, /```text/);
  assert.match(body, /Screen not attached: first-prompt:screen on go-mgr, not in your tree \(agent rev-816 can't act as agrtq\)\./);
});

test('a read that fails files the report without the screen', async () => {
  const g = fakeApi({ agents: [go], events: { 'agrtq first-prompt:screen': 500 } });
  const text = await report(g.api, 'rev', { kind: 'bug', summary: 'failed read', details });
  assert.match(text, /^Filed S-101 /);
  assert.match(g.itsas.find((x) => x.kind === 'feedback-report').body, /the read failed/);
});

test('the screen is redacted of credentials and ANSI colour, and a long one keeps only its last lines', async () => {
  const token = 'ghp' + '_abcdefghijklmnopqrstuvwxyz0123456789';
  const lines = [...Array.from({ length: 60 }, (_, i) => `line ${i}`), `\u001b[31mtoken ${token}\u001b[0m`, 'password=hunter2', 'key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV'];
  const g = fakeApi({ agents: [go], events: { 'agrtq first-prompt:screen': screenRow({ error: 'x', screen: lines }) } });
  await report(g.api, 'rev', { kind: 'bug', summary: 'secrets', details });
  const body = g.itsas.find((x) => x.kind === 'feedback-report').body;
  assert.doesNotMatch(body, /ghp_|hunter2|sk-ant-|\u001b/);
  assert.match(body, /token \[redacted\]/);
  // The token line ends in a redaction, so the next line's leading run (`password=`) is redacted too; the value stays hidden.
  assert.match(body, /\[redacted\]\[redacted\]/);
  assert.doesNotMatch(body, /password=/);
  assert.match(body, /truncated to its last lines/);
  assert.doesNotMatch(body, /line 22\n/);
  assert.match(body, /line 23\n/);
});

test('redaction fails closed: wrapped keys, JSON and flag values, bearer headers, provider keys and bare stam tokens', async () => {
  const { redactScreen, boundedScreen } = await import('../src/feedback-screen.ts');
  const stamToken = 'Zk3pQ9vL2m' + 'Xc7nB4hR8sT1yU6wE0aJ5d';
  assert.equal(redactScreen(`Authorization: Bearer abcdefghijklmnopqrstuvwxyz`), 'Authorization: [redacted]');
  assert.equal(redactScreen('key sk-or' + '-v1-abcdefghijklmnopqrstuvwxyz012345'), 'key [redacted]');
  assert.equal(redactScreen('{"token": "hunter2value"}'), '{"token": "[redacted]');
  assert.equal(redactScreen('run tool --token hunter2value now'), 'run tool --token [redacted] now');
  assert.equal(redactScreen(`agent ${stamToken} up`), 'agent [redacted] up');
  // A key split across two capture lines: the tail line is redacted too.
  const { text } = boundedScreen(['key=', stamToken]);
  assert.doesNotMatch(text, /Zk3pQ9/);
});

test('a key wrapped onto the next line is redacted through its short tail, and a line after a clean break is not', async () => {
  const { boundedScreen } = await import('../src/feedback-screen.ts');
  // The tail is about ten characters: the next line's leading run is redacted because the first line's redaction reached its end.
  const wrapped = boundedScreen(['token=Zk3pQ9vL2m' + 'Xc7nB4hR8s', 'T1yU6wE0aJ and more']).text;
  assert.doesNotMatch(wrapped, /T1yU6w/);
  assert.match(wrapped, /\[redacted\] and more/);
  // A line that ends in ordinary text breaks the chain: the next line's leading word is kept.
  assert.match(boundedScreen(['ready to go.', 'Next: merge']).text, /^ready to go\.\nNext: merge$/);
});

test('a tail indented under the wrapped key, a boxed tail with borders on both sides, and a short Bearer that wraps are redacted', async () => {
  const { boundedScreen } = await import('../src/feedback-screen.ts');
  const indented = boundedScreen(['token=Zk3pQ9vL2m' + 'Xc7nB4hR8s', '    T1yU6wE0aJ and more']).text;
  assert.doesNotMatch(indented, /T1yU6w/);
  assert.match(indented, /^ {4}\[redacted\] and more$/m);
  const boxed = boundedScreen(['│ token=Zk3pQ9vL2m' + 'Xc7nB4hR8s │', '│ T1yU6wE0aJ │']).text;
  assert.doesNotMatch(boxed, /T1yU6w/);
  assert.match(boxed, /^│ \[redacted\] │$/m);
  const bearer = boundedScreen(['Authorization: Bearer abc123', 'def456ghi7 and more']).text;
  assert.doesNotMatch(bearer, /abc123|def456/);
  assert.match(bearer, /\[redacted\] and more/);
});

test('a glued credential name is redacted, a URL with an empty user too, and a wrapped base64 tail is redacted whole', async () => {
  const { redactScreen, boundedScreen } = await import('../src/feedback-screen.ts');
  assert.equal(redactScreen('PGPASSWORD=x'), 'PGPASSWORD=[redacted]');
  assert.equal(redactScreen('dbPassword: x'), 'dbPassword: [redacted]');
  assert.equal(redactScreen('"clientSecret": "abc"'), '"clientSecret": "[redacted]');
  assert.equal(redactScreen('accessToken=x'), 'accessToken=[redacted]');
  assert.equal(redactScreen('redis://:secret@host'), 'redis://:[redacted]@host');
  // A token whose value starts with a digit is a credential, not a count: a hex token and a base64 one.
  assert.equal(redactScreen('token: 8f3e2a1b9c'), 'token: [redacted]');
  assert.equal(redactScreen('"token": "3q2+7w=="'), '"token": "[redacted]');
  // The negatives: a count and a name that only looks like a credential word stay visible.
  assert.equal(redactScreen('tokens: 12k'), 'tokens: 12k');
  assert.equal(redactScreen('tokens: 1.2k'), 'tokens: 1.2k');
  assert.equal(redactScreen('max_tokens: 4096'), 'max_tokens: 4096');
  assert.equal(redactScreen('input_tokens: 1234'), 'input_tokens: 1234');
  assert.equal(redactScreen('input_tokens: 1234,'), 'input_tokens: 1234,');
  // Credential names that merely end in TOKEN, or carry a number with a separator, are redacted through the value.
  assert.equal(redactScreen('API_TOKEN=1234:abcdef'), 'API_TOKEN=[redacted]');
  assert.equal(redactScreen('access_token=12%2Fab'), 'access_token=[redacted]');
  assert.equal(redactScreen('GITHUB_TOKEN=12345678'), 'GITHUB_TOKEN=[redacted]');
  assert.equal(redactScreen('BOT_TOKEN=123456789:AAH'), 'BOT_TOKEN=[redacted]');
  assert.equal(redactScreen('monkey: 3'), 'monkey: 3');
  // A carried line's run takes base64's `/`, `+` and `=`, so the tail is redacted whole, and the chain goes on past a `=`.
  const tail = boundedScreen(['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/', 'bPxRfiCYEXAMPLEKEY+x/z=', 'next line']).text.split('\n');
  assert.deepEqual(tail, ['AWS_SECRET_ACCESS_KEY=[redacted]', '[redacted]', '[redacted] line']);
  // A chain led by a prompt marker `›`.
  assert.match(boundedScreen(['SECRET_KEY=Zk3pQ9vL2m' + 'Xc7nB4hR8s', '› T1yU6wE0aJ/x+y=']).text, /^SECRET_KEY=\[redacted\]\n› \[redacted\]$/);
});

test('a 32-character token without a digit is redacted, inside a line and on a line of its own', async () => {
  const { redactScreen, boundedScreen } = await import('../src/feedback-screen.ts');
  const letters = 'abcdefghijklmnopqrstuvwxyzABCDEF';
  assert.equal(redactScreen(`agent ${letters} up`), 'agent [redacted] up');
  assert.equal(boundedScreen([letters]).text, '[redacted]');
});

test('an env name whose credential word is not last is redacted, base64 with / and + included, and a URL password too', async () => {
  const { redactScreen, boundedScreen } = await import('../src/feedback-screen.ts');
  const b64 = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
  assert.equal(redactScreen(`AWS_SECRET_ACCESS_KEY=${b64}`), 'AWS_SECRET_ACCESS_KEY=[redacted]');
  assert.doesNotMatch(redactScreen(`export SECRET_KEY=${b64} extra`), /wJalr/);
  assert.equal(redactScreen('DB_PASS=hunter2'), 'DB_PASS=[redacted]');
  assert.equal(redactScreen('PRIVATE_KEY: abc/def+ghi'), 'PRIVATE_KEY: [redacted]');
  assert.equal(redactScreen('postgres://u:p@h/db'), 'postgres://u:[redacted]@h/db');
  // A continuation line led by a prompt marker is still read as the tail of the wrapped key.
  const lead = boundedScreen(['SECRET_KEY=Zk3pQ9vL2m' + 'Xc7nB4hR8s', '❯ T1yU6wE0aJ and more']).text;
  assert.doesNotMatch(lead, /T1yU6w/);
  assert.match(lead, /❯ \[redacted\] and more/);
  assert.match(boundedScreen(['› T1yU6wE0aJ']).text, /^› T1yU6wE0aJ$/, 'a lead alone starts no chain');
  // A word that merely contains a credential word is not a name: it stays visible, and a later credential is still redacted.
  assert.equal(redactScreen('tokens: 12k'), 'tokens: 12k');
  assert.equal(redactScreen('tokens: 12k SECRET=x'), 'tokens: 12k SECRET=[redacted]');
});

// S-2697: the credential shapes a screen line can carry, each with the text it must come out as. A row is
// [shape, input, output]. Every row is a credential, so its value must be gone: a singular `token` and a glued
// `pass` name (`dbpass`, `PGPASS`) are redacted even when the value is all digits, and a count exemption ends at
// its comma (`max_tokens=4096,secret=x`), so the secret after the comma is redacted.
const CREDENTIAL_SHAPES = [
  ['singular token, all digits (an OTP or PIN)', 'token: 4815162342', 'token: [redacted]'],
  ['singular token, digits and a unit', 'token: 12k', 'token: [redacted]'],
  ['glued pass, lowercase', 'dbpass=hunter2', 'dbpass=[redacted]'],
  ['glued pass, uppercase', 'PGPASS=hunter2', 'PGPASS=[redacted]'],
  ['glued pass, camel case', 'dbPass: hunter2', 'dbPass: [redacted]'],
  ['glued pass, a prefix segment', 'db_pass: hunter2', 'db_pass: [redacted]'],
  ['glued pass, a prefix that is not prose', 'hovpass=x', 'hovpass=[redacted]'],
  ['passphrase, bare', 'passphrase: hunter2', 'passphrase: [redacted]'],
  ['passphrase, suffix segment', 'SSH_PASSPHRASE=hunter2', 'SSH_PASSPHRASE=[redacted]'],
  ['passphrase, glued in a name', 'keypassphrase=x', 'keypassphrase=[redacted]'],
  ['count exempt until a comma, then a secret', 'max_tokens=4096,secret=x', 'max_tokens=4096,secret=[redacted]'],
  ['count exempt until a comma, then a glued pass', 'input_tokens: 1200,PGPASS=x', 'input_tokens: 1200,PGPASS=[redacted]'],
];

// S-2697: the look-alikes that stay visible: token counts, test counts, and prose that holds a credential word
// without a credential name. Each row is [look-alike, input, output].
const LOOK_ALIKES = [
  ['a plural count of tokens', 'tokens: 12k', 'tokens: 12k'],
  ['a tokens count with a unit', 'tokens: 1.2k', 'tokens: 1.2k'],
  ['a max_tokens count', 'max_tokens: 4096', 'max_tokens: 4096'],
  ['an input_tokens count with a comma after', 'input_tokens: 1200,', 'input_tokens: 1200,'],
  ['a test count in prose', '12 passed', '12 passed'],
  ['a test count with a colon', 'passed: 12', 'passed: 12'],
  ['a plural passes count', 'passes: 3', 'passes: 3'],
  ['bypass in prose', 'the bypass is fine', 'the bypass is fine'],
  ['compass in prose', 'compass heading north', 'compass heading north'],
  ['compass as a name', 'compass: north', 'compass: north'],
  ['bypass as a name', 'bypass: true', 'bypass: true'],
  ['a count with no credential name', 'monkey: 3', 'monkey: 3'],
];

test('the credential shapes table: singular token, glued pass names and a comma-ended count are redacted, and the look-alikes stay visible', async () => {
  const { redactScreen } = await import('../src/feedback-screen.ts');
  for (const [shape, input, output] of CREDENTIAL_SHAPES) assert.equal(redactScreen(input), output, `shape: ${shape}`);
  for (const [lookAlike, input, output] of LOOK_ALIKES) assert.equal(redactScreen(input), output, `look-alike: ${lookAlike}`);
});

test('a report reads at most three named agents, and says how many it left out', async () => {
  const many = ['a1', 'a2', 'a3', 'a4'].map((id) => ({ id, name: `agent-${id}` }));
  const events = Object.fromEntries(many.map((a) => [`${a.id} input:screen`, [{ id: 1, ts: 't', type: 'input:screen', data: JSON.stringify({ now: ['x'] }) }]]));
  const g = fakeApi({ agents: many, events });
  await report(g.api, 'rev', { kind: 'bug', summary: 'many', details: 'agent-a1 agent-a2 agent-a3 agent-a4 input:screen' });
  const body = g.itsas.find((x) => x.kind === 'feedback-report').body;
  assert.equal(g.seen.filter((s) => s.includes('/events?type=input:screen')).length, 3);
  assert.match(body, /Screen not attached for 1 more agent: a report reads at most 3\./);
});

test('a reply that is not an agent list files the report with a note, not an error', async () => {
  const g = fakeApi({ agents: {} });
  const text = await report(g.api, 'rev', { kind: 'bug', summary: 'bad list', details: 'go-mgr input:screen' });
  assert.match(text, /^Filed S-101 /);
  assert.match(g.itsas.find((x) => x.kind === 'feedback-report').body, /Screen not attached: the report names no agent this daemon knows\./);
});

test('a report without a screen type makes no event read', async () => {
  const g = fakeApi({ agents: [go] });
  await report(g.api, 'rev', { kind: 'bug', summary: 'plain', details: 'go-mgr is slow' });
  assert.equal(g.seen.filter((s) => s.includes('/events')).length, 0);
  assert.doesNotMatch(g.itsas.find((x) => x.kind === 'feedback-report').body, /Screen/);
});
