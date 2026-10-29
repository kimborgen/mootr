#!/usr/bin/env node
// Codex's approvals and questions as asks (S-3979): an approval or question the agent's own thread waits on is a
// permission request with its details, and the human's answer goes back as the app-server's reply to that same request
// (src/adapters/codex.ts answerDialog, src/adapters/codex-dialog.ts). A fake app-server on a unix socket where the
// daemon's connection looks for it (test/fake-codex/server.mjs); no model, no daemon, no real Codex:
// `node --test test/codex-dialog.test.mjs`. The replies are checked against the protocol schema the app-server
// generates (test/fixtures/codex-protocol, from `codex app-server generate-json-schema`).
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { tempHome, tempDirOutside } from './tmphome.mjs';
import { startFakeCodex } from './fake-codex/server.mjs';

// The fake app-server listens on a socket under this home: a short folder, outside a deep TMPDIR (test/run.sh's).
const home = tempHome('stam-codex-dialog-', tempDirOutside);
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `codex-dialog-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let db, codex, adapter, codexView, config, permissions, dialogMail, codexReply, HUMAN, fake, realShow;
const SID = 'thr-dialog';
const A = 'dialog-agent';
const APPROVAL = 'item/commandExecution/requestApproval';
const FILE = 'item/fileChange/requestApproval';
const QUESTION = 'item/tool/requestUserInput';
const ONE_QUESTION = [{ id: 'folder', header: 'Folder', question: 'Which folder?', options: [{ label: 'Alpha', description: 'the first' }, { label: 'Beta', description: 'the second' }], isOther: false, isSecret: false }];

// Waits until a condition holds (the notifications cross a socket), then returns.
async function until(cond, what) {
  for (let i = 0; i < 300; i++) {
    try {
      if (await cond()) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}
const agentRow = () => db.getAgent(A);
// The one pending dialog the agent has, once the daemon has raised it.
const pendingRow = () => db.pendingDialog(A);
const idOf = (row) => JSON.parse(row.details).request.id;
// Raises a server request on the fake app-server and waits until the agent's dialog shows it; returns both.
async function ask(method, params, srv = fake) {
  // A dialog that was pending before this request doesn't count, even with the same JSON-RPC id.
  const before = pendingRow()?.id;
  const reply = srv.request(method, { threadId: SID, turnId: 'turn-d', itemId: 'item-d', ...params });
  await until(() => pendingRow() && pendingRow().id !== before && idOf(pendingRow()) === reply.id, 'the dialog');
  return { reply, row: pendingRow() };
}
// Whether the app-server has been sent an answer to the request (the client's reply resolves it).
function answered(reply) {
  let done = false;
  reply.then(() => (done = true));
  return () => done;
}
// The open requests the view sees for the agent, once the daemon has them.
const openIds = async () => (await codexView.status(agentRow())).permissions.map((p) => p.id);

// The protocol the app-server publishes (test/fixtures/codex-protocol), compiled per schema.
const ajv = new Ajv({ strict: false, validateFormats: false });
const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/codex-protocol');
const schema = (name) => {
  const validate = ajv.compile(JSON.parse(readFileSync(join(fixtures, `${name}.json`), 'utf8')));
  return (value) => {
    assert.equal(validate(value), true, `${name}: ${ajv.errorsText(validate.errors)}`);
  };
};

// Holds each ask the adapter makes while `hold` is set, so a test can put a request mid-creation.
let hold = null;
let throwNext = false;
let asksMade = 0;
let asksDone = 0;

before(async () => {
  db = await import('../src/db.ts');
  await import('../src/adapters/index.ts');
  codex = await import('../src/adapters/codex.ts');
  adapter = codex.codex;
  codexView = (await import('../src/adapters/codex-view.ts')).codexView;
  config = await import('../src/config.ts');
  permissions = await import('../src/permissions.ts');
  dialogMail = permissions.dialogMail;
  codexReply = (await import('../src/adapters/codex-dialog.ts')).codexReply;
  HUMAN = (await import('../src/mail.ts')).HUMAN;
  realShow = codex.dialogAsk.show;
  codex.dialogAsk.show = async (...args) => {
    asksMade++;
    if (throwNext) {
      throwNext = false;
      throw new Error('the ask failed');
    }
    if (hold) await hold;
    const r = await realShow(...args);
    asksDone++;
    return r;
  };
  db.createAgent({ id: A, name: 'dialog', role: 'dev', machine: 'x', harness: 'codex', model: 'gpt-6.1-sol', effort: null, cwd: '/tmp/dialog', parent_id: null, session_id: SID });
  mkdirSync(config.agentDir(A), { recursive: true });
});

after(() => {
  rmSync(home, { recursive: true, force: true });
});

// Each test starts its own app-server on the agent's socket, and the daemon's connection to it is what the dialogs come in on.
beforeEach(async () => {
  hold = null;
  throwNext = false;
  permissions.askMailHold.before = undefined;
  fake = await startFakeCodex(join(config.agentDir(A), 'codex.sock'));
  await until(async () => {
    await codex.appServer(A, 'thread/loaded/list', {});
    return true;
  }, 'the connection to the app-server');
});

afterEach(async () => {
  // A test may have closed it already.
  await fake?.close().catch(() => {});
  fake = undefined;
});

test('an approval is an ask, and approving it answers that request with accept', async () => {
  const { reply, row } = await ask(APPROVAL, { command: 'rm old.log', cwd: '/w', reason: 'cleanup', env: { API_TOKEN: 'sekrit-value' } });
  assert.equal(row.action, 'Codex asks to run a command');
  const d = JSON.parse(row.details);
  assert.equal(d.tool, 'Bash');
  assert.deepEqual(d.input, { command: 'rm old.log\n# in /w', description: 'cleanup' });
  assert.equal(row.details.includes('sekrit-value'), false, 'the ask carries no env values');
  await permissions.answerPermission(row.id, true, HUMAN, '');
  assert.deepEqual(await reply, { jsonrpc: '2.0', id: reply.id, result: { decision: 'accept' } });
});

test('the mail says the command\'s reason and its folder, and a missing reason is harness-neutral', async () => {
  const { reply, row } = await ask(APPROVAL, { command: 'make', cwd: '/w/build', reason: 'rebuild the cache' });
  const mail = dialogMail(A, [], row.action, row.details, row.reason);
  assert.equal(mail.why, 'rebuild the cache');
  assert.match(mail.shown, /make\n# in \/w\/build/);
  await permissions.answerPermission(row.id, false, HUMAN, 'no');
  await reply;
  const bare = await ask(APPROVAL, { command: 'make' });
  const why = dialogMail(A, [], bare.row.action, bare.row.details, bare.row.reason).why;
  assert.equal(why, 'The harness gave no reason with this dialog; ask the agent, or read its last message in its terminal.');
  await permissions.answerPermission(bare.row.id, false, HUMAN, 'no');
  await bare.reply;
});

test('a rejected file change approval is declined, and the agent carries on', async () => {
  const { reply, row } = await ask(FILE, { grantRoot: '/w', reason: 'write docs' });
  assert.equal(row.action, 'Codex asks to change files');
  await permissions.answerPermission(row.id, false, HUMAN, 'no');
  assert.deepEqual((await reply).result, { decision: 'decline' });
});

test('a question is answered with the chosen option\'s label, as the one answer to it', async () => {
  const { reply, row } = await ask(QUESTION, { questions: ONE_QUESTION, isBlocking: true });
  assert.equal(row.action, 'Codex asks a question');
  const d = JSON.parse(row.details);
  assert.equal(d.tool, 'AskUserQuestion');
  assert.deepEqual(d.input.questions[0].options.map((o) => o.label), ['Alpha', 'Beta']);
  await permissions.answerPermission(row.id, true, HUMAN, 'Beta');
  assert.deepEqual(await reply, { jsonrpc: '2.0', id: reply.id, result: { answers: { folder: { answers: ['Beta'] } } } });
});

test('a yes to a question with no single choice is unsafe: nothing is sent, and a no still can be', async () => {
  // Two questions: a yes names one choice, and Codex wants them all.
  const two = await ask(QUESTION, { questions: [...ONE_QUESTION, { ...ONE_QUESTION[0], id: 'region' }], isBlocking: true });
  await assert.rejects(permissions.answerPermission(two.row.id, true, HUMAN, 'Alpha'), /nothing was typed/);
  await assert.rejects(permissions.answerPermission(two.row.id, true, HUMAN, ''), /nothing was typed/);
  assert.equal(db.getPermissionRequest(two.row.id).status, 'pending');
  await permissions.answerPermission(two.row.id, false, HUMAN, 'Denied');
  assert.deepEqual((await two.reply).result, { answers: { folder: { answers: [] }, region: { answers: [] } } });

  // One question with no options (free text): no choice can be given at all.
  const free = await ask(QUESTION, { questions: [{ id: 'name', header: 'Name', question: 'Your name?', options: null }], isBlocking: true });
  await assert.rejects(permissions.answerPermission(free.row.id, true, HUMAN, 'Alpha'), /nothing was typed/);
  await permissions.answerPermission(free.row.id, false, HUMAN, 'Denied');
  assert.deepEqual((await free.reply).result, { answers: { name: { answers: [] } } });
});

test('a choice that is not one of the question\'s options is unsafe and sends nothing', async () => {
  const { reply, row } = await ask(QUESTION, { questions: ONE_QUESTION, isBlocking: true });
  await assert.rejects(permissions.answerPermission(row.id, true, HUMAN, 'Gamma'), /nothing was typed/);
  assert.equal(db.getPermissionRequest(row.id).status, 'pending');
  await permissions.answerPermission(row.id, true, HUMAN, 'Alpha');
  assert.deepEqual((await reply).result, { answers: { folder: { answers: ['Alpha'] } } });
});

test('the replies match the protocol the app-server generates, for every answer the adapter sends', () => {
  // The question params the tests ask are the protocol's own shape, so the reply is checked against a real request.
  schema('ToolRequestUserInputParams')({ threadId: SID, turnId: 't', itemId: 'i', isBlocking: true, questions: ONE_QUESTION });
  schema('CommandExecutionRequestApprovalResponse')(codexReply(APPROVAL, {}, true));
  schema('CommandExecutionRequestApprovalResponse')(codexReply(APPROVAL, {}, false));
  schema('FileChangeRequestApprovalResponse')(codexReply(FILE, {}, false));
  schema('ToolRequestUserInputResponse')(codexReply(QUESTION, { questions: ONE_QUESTION }, true, 'Beta'));
  schema('ToolRequestUserInputResponse')(codexReply(QUESTION, { questions: [...ONE_QUESTION, { ...ONE_QUESTION[0], id: 'region' }] }, false));
});

test('a stale or mismatched request is gone: a wrong id, a wrong method, or another connection never gets the answer', async () => {
  const { reply, row } = await ask(APPROVAL, { command: 'ls' });
  const d = JSON.parse(row.details);
  const as = (request) => ({ ...row, details: JSON.stringify({ ...d, request: { ...d.request, ...request } }) });
  const sent = answered(reply);
  // Another request's id on the same connection: the open request is not that one.
  assert.equal(adapter.answerDialog(agentRow(), as({ id: d.request.id + 1 }), true), 'gone');
  // The same id, another method.
  assert.equal(adapter.answerDialog(agentRow(), as({ method: FILE }), true), 'gone');
  // The same id, from a connection that is not the daemon's.
  assert.equal(adapter.answerDialog(agentRow(), as({ conn: 'another-process.9' }), true), 'gone');
  assert.deepEqual(await openIds(), [String(d.request.id)]);
  await new Promise((r) => setImmediate(r));
  assert.equal(sent(), false, 'no mismatched answer reached the app-server');
  // The real request is still answered by its own id.
  await permissions.answerPermission(row.id, true, HUMAN, '');
  assert.equal((await reply).id, d.request.id);
  assert.deepEqual((await reply).result, { decision: 'accept' });
});

test('an answered request is gone when its dialog is answered again', async () => {
  const { reply, row } = await ask(APPROVAL, { command: 'ls -la' });
  await permissions.answerPermission(row.id, true, HUMAN, '');
  await reply;
  assert.equal(adapter.answerDialog(agentRow(), db.getPermissionRequest(row.id), true), 'gone');
  assert.equal(adapter.answerDialog(agentRow(), db.getPermissionRequest(row.id), false), 'gone');
});

test('the TUI answering a request closes its ask, and the app-server\'s resolution is not answered again', async () => {
  const { row, reply } = await ask(QUESTION, { questions: ONE_QUESTION, isBlocking: true });
  fake.notify('serverRequest/resolved', { threadId: SID, requestId: reply.id });
  await until(() => db.getPermissionRequest(row.id).status !== 'pending', 'the ask to close');
  assert.equal(pendingRow(), undefined);
});

test('a request resolved while its ask is being made leaves no pending ask', async () => {
  let release;
  hold = new Promise((r) => (release = r));
  const made = asksMade;
  const done = asksDone;
  const reply = fake.request(APPROVAL, { threadId: SID, turnId: 't', itemId: 'i', command: 'ls' });
  await until(() => asksMade === made + 1, 'the ask to start');
  // The app-server resolves it (the TUI answered) before its ask is created.
  fake.notify('serverRequest/resolved', { threadId: SID, requestId: reply.id });
  await until(async () => (await openIds()).length === 0, 'the resolution to arrive');
  release();
  await until(() => asksDone === done + 1, 'the ask to finish');
  assert.equal(pendingRow(), undefined, 'the ask it made is closed, not left pending');
  assert.deepEqual(db.pendingDialogs().filter((r) => r.agent_id === A), []);
});

test('a request replaced while its ask is being made leaves one pending ask, the newer one', async () => {
  let release;
  hold = new Promise((r) => (release = r));
  const made = asksMade;
  const done = asksDone;
  const older = fake.request(APPROVAL, { threadId: SID, turnId: 't', itemId: 'i1', command: 'ls' });
  await until(() => asksMade === made + 1, 'the older ask to start');
  // A newer request arrives while the older one's ask is still being made.
  hold = null;
  const newer = fake.request(APPROVAL, { threadId: SID, turnId: 't', itemId: 'i2', command: 'pwd' });
  await until(async () => (await openIds()).length === 2, 'both requests to be open');
  release();
  await until(() => asksDone === done + 2, 'both asks to finish');
  const pending = db.pendingDialogs().filter((r) => r.agent_id === A);
  assert.equal(pending.length, 1, 'one pending ask');
  assert.equal(idOf(pending[0]), newer.id, 'the newer request is the one asked');
  await permissions.answerPermission(pending[0].id, true, HUMAN, '');
  assert.deepEqual((await newer).result, { decision: 'accept' });
  assert.notEqual(older.id, newer.id);
});

test('a dropped connection, or a restarted app-server, never gets an old request\'s answer', async () => {
  const { row: old, reply: oldReply } = await ask(APPROVAL, { command: 'make' });
  // The app-server goes away: its requests go with the connection, so the old dialog reads as gone.
  await fake.close();
  await until(async () => (await openIds()).length === 0, 'the dropped connection');
  assert.equal(adapter.answerDialog(agentRow(), old, true), 'gone');
  // A new app-server (a restart) hands out the same first request id, which the old dialog must not answer.
  fake = await startFakeCodex(join(config.agentDir(A), 'codex.sock'));
  await until(async () => {
    await codex.appServer(A, 'thread/loaded/list', {});
    return true;
  }, 'the reconnection');
  const { row: fresh, reply: freshReply } = await ask(APPROVAL, { command: 'make install' });
  assert.equal(idOf(fresh), idOf(old), 'the ids collide');
  const sent = answered(oldReply);
  assert.equal(adapter.answerDialog(agentRow(), old, false), 'gone');
  await new Promise((r) => setImmediate(r));
  assert.equal(sent(), false);
  await permissions.answerPermission(fresh.id, true, HUMAN, '');
  assert.deepEqual((await freshReply).result, { decision: 'accept' });
});

test('a daemon restart keeps the old dialog\'s row, and the new process never answers it, even for the same request id and params', async () => {
  // The test's own connection goes: the processes below take turns on the app-server, each a fresh adapter module over
  // the same database. Each one's first connection is connection 1, as a restart's is.
  await fake.close();
  fake = await startFakeCodex(join(config.agentDir(A), 'codex.sock'));
  const first = await import('../src/adapters/codex.ts?process=first');
  await until(async () => {
    await first.appServer(A, 'thread/loaded/list', {});
    return true;
  }, 'the first process connection');
  const { row: old, reply: oldReply } = await ask(APPROVAL, { command: 'make' });
  // The daemon restarts: the first process's connection drops, and the restarted one connects. The old row stays pending.
  await fake.close();
  fake = await startFakeCodex(join(config.agentDir(A), 'codex.sock'));
  const restarted = await import('../src/adapters/codex.ts?process=restarted');
  await until(async () => {
    await restarted.appServer(A, 'thread/loaded/list', {});
    return true;
  }, 'the restarted connection');
  // The same request, with the same params: the same id and the same details, from the restarted process.
  const reply = fake.request(APPROVAL, { threadId: SID, turnId: 'turn-d', itemId: 'item-d', command: 'make' });
  await until(() => pendingRow() && pendingRow().id !== old.id && idOf(pendingRow()) === reply.id, 'the new ask');
  const fresh = pendingRow();
  assert.notEqual(fresh.details, old.details, 'the restarted process\'s ask is its own row');
  const sent = answered(oldReply);
  assert.equal(first.codex.answerDialog(agentRow(), old, true), 'gone');
  assert.equal(restarted.codex.answerDialog(agentRow(), old, true), 'gone');
  await new Promise((r) => setImmediate(r));
  assert.equal(sent(), false, 'the old dialog reached nothing');
  assert.equal(restarted.codex.answerDialog(agentRow(), fresh, true), 'typed');
  assert.deepEqual((await reply).result, { decision: 'accept' });
});

// The human's mail row for a permission request: whether it was withdrawn, and by what note.
const humanMailOf = (mailId) => db.open().prepare("SELECT withdrawn_at, withdrawn_note FROM mail_recipients WHERE mail_id = ? AND agent_id = 'human'").get(mailId);

test('a request closed after its row is made, but before its mail is stored, leaves no open mail', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  permissions.askMailHold.before = () => gate;
  const made = asksDone;
  const before = pendingRow()?.id;
  try {
    const reply = fake.request(APPROVAL, { threadId: SID, turnId: 't', itemId: 'i', command: 'ls' });
    await until(() => pendingRow() && pendingRow().id !== before && idOf(pendingRow()) === reply.id, 'the row');
    const row = pendingRow();
    // The TUI answers while the mail is still being stored: the row closes before its mail exists.
    fake.notify('serverRequest/resolved', { threadId: SID, requestId: reply.id });
    await until(() => db.getPermissionRequest(row.id).status !== 'pending', 'the row to close');
    release();
    await until(() => asksDone === made + 1, 'the ask to finish');
    const [mailId] = db.permissionMailIds(row.id);
    assert.ok(mailId, 'the ask stored its mail');
    assert.ok(humanMailOf(mailId).withdrawn_at, 'the late mail is withdrawn at once');
    assert.equal(humanMailOf(mailId).withdrawn_note, 'Withdrawn: closed while it was being sent');
  } finally {
    release();
  }
});

test('a request closed after its row is made, but before its mail is stored, leaves no open mail (requestPermission, any harness)', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  permissions.askMailHold.before = () => gate;
  const a = agentRow();
  const later = new Date(Date.now() + 60_000).toISOString();
  try {
    const made = permissions.requestPermission(a, 'Codex asks to run a command', 'a reason', '{}');
    // The row exists, and its mail is held.
    await until(() => db.stalePendingPermissions(A, later).length === 1, 'the row');
    const [row] = db.stalePendingPermissions(A, later);
    await permissions.withdrawStaleRequests(a, later, 'closed');
    assert.equal(db.getPermissionRequest(row.id).status, 'withdrawn');
    release();
    await made;
    const [mailId] = db.permissionMailIds(row.id);
    assert.ok(humanMailOf(mailId).withdrawn_at, 'the late mail is withdrawn at once');
  } finally {
    release();
  }
});

test('an ask that fails does not stop the next one', async () => {
  const made = asksMade;
  throwNext = true;
  const failed = fake.request(APPROVAL, { threadId: SID, turnId: 't', itemId: 'i1', command: 'fails' });
  // The failing ask has run (and thrown) before the next request comes, so the next request is not what it fails on.
  await until(() => asksMade === made + 1 && !throwNext, 'the failing ask to run');
  const next = await ask(APPROVAL, { command: 'runs' });
  assert.equal(idOf(next.row), next.reply.id);
  assert.notEqual(failed.id, next.reply.id);
  await permissions.answerPermission(next.row.id, true, HUMAN, '');
  assert.deepEqual((await next.reply).result, { decision: 'accept' });
});
