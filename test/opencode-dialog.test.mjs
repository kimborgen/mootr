#!/usr/bin/env node
// Unit tests for an OpenCode permission.asked as an ask in the human's thread (S-3980): raised from the event,
// answered through the session's permission reply endpoint, closed when OpenCode says it was replied outside stam.
// A stub server stands in for OpenCode on its own port, with its permission list and reply endpoint; no daemon, no
// model: `node --test test/opencode-dialog.test.mjs`.
import { test, before, after, beforeEach } from 'node:test';
import { killTmuxServer } from '../src/tmux-socket.ts';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-opencode-dialog-');
const port = 46000 + (process.pid % 10000);
const socket = `opencode-dialog-test-${process.pid}`;
process.env.STAM_HOME = home;
process.env.STAM_OPENCODE_PORT = String(port);
process.env.STAM_TMUX_SOCKET = socket;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID']) delete process.env[k];

// The stub: each session lists its pending permissions; an unknown session is a 404. `failList` and `failReply` make
// the listing and the reply answer 500.
const server = { sessions: new Map(), replies: [], failList: false, failReply: false, lists: 0 };
const stub = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status === 200 ? { data } : { error: 'stub' }));
    };
    const body = raw ? JSON.parse(raw) : {};
    const list = req.url.match(/^\/api\/session\/([^/]+)\/permission$/);
    if (req.method === 'GET' && list) {
      server.lists++;
      if (server.failList) return send(500, null);
      if (!server.sessions.has(list[1])) return send(404, null);
      return send(200, server.sessions.get(list[1]));
    }
    const reply = req.url.match(/^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/);
    if (req.method === 'POST' && reply) {
      if (server.failReply) return send(500, null);
      server.beforeReply?.(reply[1], decodeURIComponent(reply[2]));
      server.replies.push({ session: reply[1], permission: decodeURIComponent(reply[2]), decision: body.decision });
      const pending = server.sessions.get(reply[1]) ?? [];
      server.sessions.set(reply[1], pending.filter((p) => p.id !== decodeURIComponent(reply[2])));
      return send(200, {});
    }
    if (req.method === 'GET' && req.url === '/openapi.json') return send(200, {});
    send(404, null);
  });
});

let db, opencode, onEvent, raiseAsk, permissions, HUMAN;
before(async () => {
  await new Promise((r) => stub.listen(port, '127.0.0.1', r));
  db = await import('../src/db.ts');
  await import('../src/lifecycle.ts');
  permissions = await import('../src/permissions.ts');
  ({ HUMAN } = await import('../src/mail.ts'));
  ({ opencode, onEvent, raiseAsk } = await import('../src/adapters/opencode.ts'));
});
after(() => {
  stub.close();
  killTmuxServer(socket);
  rmSync(home, { recursive: true, force: true });
});
beforeEach(() => {
  server.sessions = new Map();
  server.replies = [];
  server.failList = false;
  server.failReply = false;
  server.beforeReply = null;
  server.lists = 0;
});

let seq = 0;
// An OpenCode agent on its own session; the session's pending permissions are the stub's list.
function agent(pending = []) {
  const n = ++seq;
  const session = `ses_dialog${n}`;
  server.sessions.set(session, pending);
  const id = db.newAgentId();
  db.createAgent({ id, name: `dialog ${n}`, role: 'role', machine: 'test', harness: 'opencode', model: null, effort: null, cwd: home, parent_id: null, session_id: session });
  db.updateAgent(id, { activity: 'working' });
  return db.getAgent(id);
}
const perm = (id, action = 'shell', resources = ['echo hi']) => ({ id, action, resources });
// The permission.asked event the server sends, and the ask it raises.
function asked(a, p) {
  onEvent({ type: 'permission.asked', data: { ...p, sessionID: a.session_id } });
  return db.pendingDialog(a.id);
}
// Lets the ask's raising (an async call) settle.
const settle = () => new Promise((r) => setTimeout(r, 50));

test('permission.asked raises one ask in the thread, with its permission id and the action', async () => {
  const a = agent([perm('per_one')]);
  asked(a, perm('per_one'));
  await settle();
  const pending = db.pendingDialog(a.id);
  assert.ok(pending, 'an ask is pending');
  assert.equal(pending.action, 'OpenCode asks to allow shell');
  assert.equal(JSON.parse(pending.details).permission, 'per_one');
  assert.equal(db.getAgent(a.id).activity, 'blocked');
});

test('a yes is sent to the permission id the ask was raised for, once, and the request is decided', async () => {
  const a = agent([perm('per_yes')]);
  asked(a, perm('per_yes'));
  await settle();
  const req = db.pendingDialog(a.id);
  const out = await permissions.answerPermission(req.id, true, HUMAN, '');
  assert.equal(out.typed, true);
  assert.deepEqual(server.replies, [{ session: a.session_id, permission: 'per_yes', decision: 'once' }]);
  assert.equal(db.getPermissionRequest(req.id).status, 'approved');
});

test('must-fail: a stale permission id is gone and nothing is sent', async () => {
  // The session no longer lists per_stale: it was replied to already, so the ask closes and no reply goes out.
  const a = agent([perm('per_other')]);
  asked(a, perm('per_stale'));
  await settle();
  const req = db.pendingDialog(a.id);
  assert.equal(await opencode.answerDialog(db.getAgent(a.id), req, true), 'gone');
  assert.deepEqual(server.replies, []);
});

test('must-fail: a permission id of another session is gone and nothing is sent', async () => {
  const a = agent([perm('per_mine')]);
  const other = agent([perm('per_theirs')]);
  asked(a, perm('per_theirs'));
  await settle();
  const req = db.pendingDialog(a.id);
  // The ask names this agent's session, so answering it through the other agent's session is refused.
  const detail = JSON.parse(req.details);
  assert.equal(detail.session, a.session_id);
  assert.equal(await opencode.answerDialog(db.getAgent(other.id), req, true), 'gone');
  assert.deepEqual(server.replies, []);
});

test('must-fail: a permission.replied that arrives before the reply response reads as the answer, not as an outside reply', async () => {
  const a = agent([perm('per_race')]);
  asked(a, perm('per_race'));
  await settle();
  const req = db.pendingDialog(a.id);
  // OpenCode emits permission.replied for our reply before it answers the reply request.
  server.beforeReply = (sid, pid) => onEvent({ type: 'permission.replied', data: { sessionID: sid, requestID: pid, reply: 'once' } });
  const out = await permissions.answerPermission(req.id, true, HUMAN, '');
  await settle();
  assert.equal(out.typed, true);
  assert.equal(db.getPermissionRequest(req.id).status, 'approved');
  assert.deepEqual(server.replies, [{ session: a.session_id, permission: 'per_race', decision: 'once' }]);
});

test('an ask already replied to outside stam is gone', async () => {
  const a = agent([perm('per_done')]);
  asked(a, perm('per_done'));
  await settle();
  server.sessions.set(a.session_id, []);
  const req = db.pendingDialog(a.id);
  assert.equal(await opencode.answerDialog(db.getAgent(a.id), req, false), 'gone');
  assert.deepEqual(server.replies, []);
});

test('a session the server no longer has (404 on the listing) is gone', async () => {
  const a = agent([perm('per_x')]);
  asked(a, perm('per_x'));
  await settle();
  server.sessions.delete(a.session_id);
  const req = db.pendingDialog(a.id);
  assert.equal(await opencode.answerDialog(db.getAgent(a.id), req, true), 'gone');
});

test('must-fail: an inspection error other than not-found keeps the ask open', async () => {
  const a = agent([perm('per_keep')]);
  asked(a, perm('per_keep'));
  await settle();
  server.failList = true;
  const req = db.pendingDialog(a.id);
  await assert.rejects(opencode.answerDialog(db.getAgent(a.id), req, true), /500/);
  await assert.rejects(permissions.answerPermission(req.id, true, HUMAN, ''), /500/);
  assert.equal(db.getPermissionRequest(req.id).status, 'pending');
  assert.deepEqual(server.replies, []);
});

test('must-fail: a server error during the reply keeps the ask pending and records no decision', async () => {
  const a = agent([perm('per_err')]);
  asked(a, perm('per_err'));
  await settle();
  server.failReply = true;
  const req = db.pendingDialog(a.id);
  await assert.rejects(permissions.answerPermission(req.id, true, HUMAN, ''), /500/);
  assert.equal(db.getPermissionRequest(req.id).status, 'pending');
  assert.deepEqual(server.replies, []);
});

test('must-fail: a question approve is unsafe and nothing is sent', async () => {
  const a = agent([perm('per_q', 'question', [])]);
  asked(a, perm('per_q', 'question', []));
  await settle();
  const req = db.pendingDialog(a.id);
  assert.equal(await opencode.answerDialog(db.getAgent(a.id), req, true), 'unsafe');
  assert.deepEqual(server.replies, []);
  assert.equal(db.getPermissionRequest(req.id).status, 'pending');
});

test('a question no is sent as a reject to its permission id', async () => {
  const a = agent([perm('per_qno', 'question', [])]);
  asked(a, perm('per_qno', 'question', []));
  await settle();
  const req = db.pendingDialog(a.id);
  assert.equal(await permissions.answerPermission(req.id, false, HUMAN, '').then((o) => o.typed), true);
  assert.deepEqual(server.replies, [{ session: a.session_id, permission: 'per_qno', decision: 'reject' }]);
});

test('a permission replied to outside stam closes its ask', async () => {
  const a = agent([perm('per_tui')]);
  asked(a, perm('per_tui'));
  await settle();
  const req = db.pendingDialog(a.id);
  onEvent({ type: 'permission.replied', data: { sessionID: a.session_id, requestID: 'per_other', reply: 'once' } });
  assert.ok(db.pendingDialog(a.id), 'another permission leaves the ask open');
  onEvent({ type: 'permission.replied', data: { sessionID: a.session_id, requestID: 'per_tui', reply: 'once' } });
  await settle();
  assert.equal(db.getPermissionRequest(req.id).status, 'withdrawn');
});

test('the ask carries only its own fields: extra fields of the OpenCode event, with a fake secret, reach neither the details nor the mail', async () => {
  const secret = 'fake-secret-zz9';
  const a = agent([perm('per_fields')]);
  // The event's extra fields, such as metadata with an env value, are not the ask's to keep.
  asked(a, { ...perm('per_fields'), metadata: { env: { OPENROUTER_API_KEY: secret } }, token: secret, extra: secret });
  await settle();
  const req = db.pendingDialog(a.id);
  assert.ok(!req.details.includes(secret), 'the secret is not in the ask details');
  assert.deepEqual(Object.keys(JSON.parse(req.details)).sort(), ['action', 'input', 'permission', 'session', 'tool']);
  const mail = permissions.dialogMail(a.name, [], req.action, req.details, '');
  assert.ok(!mail.shown.includes(secret) && !mail.line.includes(secret) && !mail.subject.includes(secret), 'the secret is not in the mail');
});

test('the requested command reaches the ask and its mail verbatim, as the agent asked for it', async () => {
  const command = `PASSWORD="hello world" curl -H 'Authorization:Bearer abc-def' https://user:s3cret-pass@example.com/a`;
  const a = agent([perm('per_verbatim', 'shell', [command])]);
  asked(a, perm('per_verbatim', 'shell', [command]));
  await settle();
  const req = db.pendingDialog(a.id);
  assert.equal(JSON.parse(req.details).input.command, command);
  const mail = permissions.dialogMail(a.name, [], req.action, req.details, '');
  assert.ok(mail.shown.includes(command), 'the mail shows the command as it is');
  assert.ok(!mail.shown.includes('{}'), 'the mail shows no empty input');
  assert.ok(!/Claude Code/.test(mail.why), 'the reason fallback names no harness');
});

test('must-fail: a permission.replied in the same burst as its permission.asked raises no ask', async () => {
  const a = agent([]);
  // Both events arrive in one chunk, with no settle between them: the reply comes first.
  onEvent({ type: 'permission.asked', data: { ...perm('per_burst'), sessionID: a.session_id } });
  onEvent({ type: 'permission.replied', data: { sessionID: a.session_id, requestID: 'per_burst', reply: 'once' } });
  await settle();
  assert.ok(!db.pendingDialog(a.id), 'no ask is pending for an answered permission');
  assert.equal(db.agentRequests(a.id).length, 0, 'no request was made for the answered permission');
});

test('must-fail: a permission.replied that arrives while the ask is being raised closes its row', async () => {
  const a = agent([]);
  const details = JSON.stringify({ tool: 'shell', input: { command: 'echo hi' }, action: 'shell', permission: 'per_slow', session: a.session_id });
  // dialogShown awaits askHome before it creates the row. The reply lands in that gap: no row yet, so it is remembered.
  let made;
  const slow = {
    dialogShown: (ag, act, det, rep) => {
      const raised = permissions.dialogShown(ag, act, det, rep);
      assert.ok(!db.pendingDialog(a.id), 'the row is not created yet');
      onEvent({ type: 'permission.replied', data: { sessionID: a.session_id, requestID: 'per_slow', reply: 'once' } });
      return raised.then(() => {
        made = db.pendingDialog(a.id);
      });
    },
    dialogClosed: permissions.dialogClosed,
  };
  await raiseAsk(db.getAgent(a.id), 'per_slow', 'OpenCode asks to allow shell', details, slow);
  assert.ok(made, 'the row was created');
  assert.equal(db.getPermissionRequest(made.id).status, 'withdrawn');
  assert.ok(!db.pendingDialog(a.id), 'no ask stays pending');
});

test('a pending OpenCode ask answers the same permission id from a fresh process, a daemon restart', async () => {
  const a = agent([perm('per_restart')]);
  asked(a, perm('per_restart'));
  await settle();
  const req = db.pendingDialog(a.id);
  // A new process has none of this process's state: it reads the ask from the database and answers it.
  const out = await runFreshAnswer(req.id, true);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(server.replies, [{ session: a.session_id, permission: 'per_restart', decision: 'once' }]);
  assert.equal(db.getPermissionRequest(req.id).status, 'approved');
});

test('a pending OpenCode ask read as gone after a restart, once its permission is no longer listed', async () => {
  const a = agent([perm('per_moved')]);
  asked(a, perm('per_moved'));
  await settle();
  const req = db.pendingDialog(a.id);
  server.sessions.set(a.session_id, []);
  const out = await runFreshAnswer(req.id, true);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /no longer shows this dialog/);
  assert.deepEqual(server.replies, []);
});

// Answers a request from a fresh Node process with the same STAM_HOME, the way a restarted daemon would.
// It runs asynchronously: this process serves the stub OpenCode server, so a blocking call would stall the reply.
function runFreshAnswer(requestId, approve) {
  const script = `
    const lifecycle = await import(${JSON.stringify(new URL('../src/lifecycle.ts', import.meta.url).href)});
    const permissions = await import(${JSON.stringify(new URL('../src/permissions.ts', import.meta.url).href)});
    const { HUMAN } = await import(${JSON.stringify(new URL('../src/mail.ts', import.meta.url).href)});
    await import(${JSON.stringify(new URL('../src/adapters/opencode.ts', import.meta.url).href)});
    await permissions.answerPermission(${JSON.stringify(requestId)}, ${approve}, HUMAN, '');
  `;
  return new Promise((resolve) => {
    execFile(process.execPath, ['--input-type=module', '-e', script], { env: process.env, timeout: 60_000 }, (err, _stdout, stderr) => {
      resolve({ status: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stderr: String(stderr) });
    });
  });
}
