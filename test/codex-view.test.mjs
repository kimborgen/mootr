#!/usr/bin/env node
// Unit test for Codex's part of stam's own agent view (src/adapters/codex-view.ts): history
// from thread/read mapped to view messages and paged, live items and deltas from the
// daemon's connection into one part each, approvals as permission parts and their answers
// as the app-server's replies, interrupts and steers as turn/interrupt and turn/steer. A
// fake app-server on a unix socket where the daemon's connection looks for it
// (test/fake-codex/server.mjs); no model, no daemon: `node --test test/codex-view.test.mjs`.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeCodex } from './fake-codex/server.mjs';
import { tempHome, tempDirOutside } from './tmphome.mjs';

const fx = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/codex-view.json'), 'utf8'));
// The fake app-server listens on a socket under this home: a short folder, outside a deep TMPDIR (test/run.sh's).
const home = tempHome('stam-cv-', tempDirOutside);
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `codex-view-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

let db, view, codexView, codex, config, fake;
const SID = 'thr-1';
const A = 'cv-agent';
let agent;
// What thread/read answers, when a test sets it; the fixture otherwise.
let thread = null;

// A LiveSink like agent-view's: the store plus counters for what the stream would flush.
function sink() {
  const s = { store: new view.ViewStore(), changes: 0, resyncs: 0 };
  s.changed = () => s.changes++;
  s.resync = () => s.resyncs++;
  return s;
}
// Waits until a condition holds (the notifications cross a socket), then returns.
async function until(cond, what) {
  for (let i = 0; i < 300; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}
const partsOf = (s, id) => s.store.messages.find((m) => m.id === id)?.parts ?? [];

before(async () => {
  db = await import('../src/db.ts');
  await import('../src/adapters/index.ts');
  view = await import('../src/agent-view.ts');
  codexView = (await import('../src/adapters/codex-view.ts')).codexView;
  codex = await import('../src/adapters/codex.ts');
  config = await import('../src/config.ts');
  db.createAgent({ id: A, name: 'cv', role: 'dev', machine: 'x', harness: 'codex', model: 'gpt-6.1-sol', effort: null, cwd: '/tmp/cv', parent_id: null, session_id: SID });
  // The socket the daemon's connection looks for: the agent's app-server, in its folder.
  mkdirSync(config.agentDir(A), { recursive: true });
  fake = await startFakeCodex(join(config.agentDir(A), 'codex.sock'), {
    responses: {
      'thread/read': () => thread ?? fx,
      'turn/interrupt': (p) => {
        // The real app-server confirms the interrupt with turn/completed.
        fake.notify('turn/completed', { threadId: SID, turn: { id: p.turnId, status: 'interrupted', items: [] } });
        return {};
      },
    },
  });
  agent = db.getAgent(A);
});

after(async () => {
  await fake?.close();
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  fake.log.length = 0;
});

test('no thread yet > the view says why, and the stream is not opened', () => {
  const a = { ...agent, session_id: null };
  assert.match(codexView.unavailable(a), /no Codex thread yet/);
  assert.equal(codexView.unavailable(agent), null);
});

test('history > thread/read turns become messages: user, reasoning, tool output, agent text', async () => {
  const p = await codexView.page(agent, { limit: 50 });
  assert.equal(p.older, null);
  const byId = Object.fromEntries(p.messages.map((m) => [m.id, m]));
  assert.deepEqual(p.messages.map((m) => m.id), ['u-1', 'r-1', 'c-1', 'm-1', 'u-2', 'f-1', 'm-2']);
  assert.deepEqual(byId['u-1'].parts, [{ type: 'text', text: 'list the files' }]);
  assert.equal(byId['u-1'].role, 'user');
  assert.deepEqual(byId['r-1'].parts, [{ type: 'reasoning', text: 'Looking at the directory.' }]);
  assert.deepEqual(byId['c-1'].parts, [{ type: 'tool', id: 'c-1', name: 'shell', input: { command: 'ls', cwd: '/work' }, output: 'a.txt\nb.txt\n', status: 'done' }]);
  assert.deepEqual(byId['m-1'].parts, [{ type: 'text', text: 'There are two files.' }]);
  assert.equal(byId['f-1'].parts[0].name, 'apply_patch');
  assert.equal(byId['f-1'].parts[0].output, '-old\n+new');
  assert.equal(byId['m-2'].running, undefined);
});

test('history > paged by before and limit, the oldest message of a page is the next cursor', async () => {
  // Seven messages, oldest first: u-1 r-1 c-1 m-1 u-2 f-1 m-2.
  const newest = await codexView.page(agent, { limit: 3 });
  assert.deepEqual(newest.messages.map((m) => m.id), ['u-2', 'f-1', 'm-2']);
  assert.equal(newest.older, 'u-2');
  const middle = await codexView.page(agent, { limit: 3, before: newest.older });
  assert.deepEqual(middle.messages.map((m) => m.id), ['r-1', 'c-1', 'm-1']);
  assert.equal(middle.older, 'r-1');
  const oldest = await codexView.page(agent, { limit: 3, before: middle.older });
  assert.deepEqual(oldest.messages.map((m) => m.id), ['u-1']);
  assert.equal(oldest.older, null);
  assert.deepEqual((await codexView.page(agent, { limit: 3, before: 'nope' })).messages, []);
});

// S-278: thread/read's items carry no time, so a turn's items all sat at its start and a mail
// sent or received during the turn showed after all of it. Each item now takes its start from
// the thread's rollout file, as Codex 0.162.1 writes it (item_completed with started_at_ms),
// and the mail goes right after the item before it.
test('history > items take their start from the rollout, so mail during a turn sits between its items', async () => {
  const t0 = Date.parse('2026-10-12T23:51:45Z');
  const iso = (ms) => new Date(ms).toISOString();
  const rollout = join(home, 'rollout.jsonl');
  const done = (id, type, start) => JSON.stringify({ timestamp: iso(start + 5), type: 'event_msg', payload: { type: 'item_completed', thread_id: SID, turn_id: 't-1', item: { type, id }, started_at_ms: start, completed_at_ms: start + 5 } });
  writeFileSync(rollout, [
    JSON.stringify({ timestamp: iso(t0), type: 'session_meta', payload: { id: SID } }),
    JSON.stringify({ timestamp: iso(t0 + 1), type: 'event_msg', payload: { type: 'task_started' } }),
    done('u-1', 'UserMessage', t0 + 1000),
    done('exec-1', 'McpToolCall', t0 + 60_000),
    JSON.stringify({ timestamp: iso(t0 + 60_100), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_1' } }),
    done('exec-2', 'CommandExecution', t0 + 180_000),
  ].join('\n') + '\n' + done('m-1', 'AgentMessage', t0 + 240_000).slice(0, 40));
  const mcp = (id, tool) => ({ id, type: 'mcpToolCall', server: 'stam', tool, arguments: {}, status: 'completed' });
  thread = { thread: { id: SID, path: rollout, turns: [{ id: 't-1', status: 'inProgress', startedAt: t0 / 1000, items: [
    { id: 'u-1', type: 'userMessage', content: [{ type: 'text', text: 'go' }] },
    mcp('exec-1', 'send_mail'),
    { id: 'exec-2', type: 'commandExecution', command: 'ls', cwd: '/w', status: 'completed', commandActions: [] },
    { id: 'm-1', type: 'agentMessage', text: 'done' },
  ] }] } };
  try {
    const mail = (id, at) => ({ id: `mail:${id}`, role: 'user', kind: 'mail', at, parts: [] });
    const order = (p) => view.interleave([...p.messages, mail('sent', t0 + 60_050), mail('got', t0 + 120_000)]).map((m) => m.id);
    let p = await codexView.page(agent, { limit: 50 });
    assert.deepEqual(p.messages.map((m) => m.at), [t0 + 1000, t0 + 60_000, t0 + 180_000, t0 + 180_001]);
    assert.deepEqual(order(p), ['u-1', 'exec-1', 'mail:sent', 'mail:got', 'exec-2', 'm-1']);
    // The rollout's partial last line, finished, gives the reply its own time.
    appendFileSync(rollout, done('m-1', 'AgentMessage', t0 + 240_000).slice(40) + '\n');
    p = await codexView.page(agent, { limit: 50 });
    assert.equal(p.messages.at(-1).at, t0 + 240_000);
    // No rollout: the items keep their order just after the turn's start, as before.
    thread.thread.path = join(home, 'missing.jsonl');
    p = await codexView.page(agent, { limit: 50 });
    assert.deepEqual(p.messages.map((m) => m.at), [t0, t0 + 1, t0 + 2, t0 + 3]);
  } finally {
    thread = null;
  }
});

test('streaming > item deltas grow one text part, and item/completed settles it', async () => {
  const s = sink();
  const stop = codexView.follow(agent, s);
  try {
    // Opens the connection (page does that too, but the follow is what must hear it).
    await codexView.page(agent, { limit: 1 });
    fake.notify('turn/started', { threadId: SID, turn: { id: 'turn-live', items: [], status: 'inProgress' } });
    fake.notify('item/started', { threadId: SID, turnId: 'turn-live', startedAtMs: 1, item: { id: 'm-live', type: 'agentMessage', text: '' } });
    for (const d of ['Hel', 'lo', ' there']) fake.notify('item/agentMessage/delta', { threadId: SID, turnId: 'turn-live', itemId: 'm-live', delta: d });
    await until(() => partsOf(s, 'm-live')[0]?.text === 'Hello there', 'the deltas');
    assert.equal(partsOf(s, 'm-live').length, 1);
    assert.equal(s.store.messages.find((m) => m.id === 'm-live').running, true);
    assert.equal(s.store.running, true);
    fake.notify('item/completed', { threadId: SID, turnId: 'turn-live', completedAtMs: 2, item: { id: 'm-live', type: 'agentMessage', text: 'Hello there.' } });
    await until(() => partsOf(s, 'm-live')[0]?.text === 'Hello there.', 'the completed item');
    assert.equal(s.store.messages.find((m) => m.id === 'm-live').running, undefined);
    fake.notify('turn/completed', { threadId: SID, turn: { id: 'turn-live', status: 'completed', items: [] } });
    await until(() => s.store.running === false && s.resyncs === 1, 'the turn to end');
  } finally {
    stop();
  }
});

test('tool output > command output deltas build the tool part, and the completed item replaces them', async () => {
  const s = sink();
  const stop = codexView.follow(agent, s);
  try {
    await codexView.page(agent, { limit: 1 });
    fake.notify('item/started', { threadId: SID, turnId: 'turn-t', startedAtMs: 1, item: { id: 'cmd-1', type: 'commandExecution', command: 'seq 2', cwd: '/w', status: 'inProgress', aggregatedOutput: null, commandActions: [], source: 'agent' } });
    fake.notify('item/commandExecution/outputDelta', { threadId: SID, turnId: 'turn-t', itemId: 'cmd-1', delta: '1\n' });
    fake.notify('item/commandExecution/outputDelta', { threadId: SID, turnId: 'turn-t', itemId: 'cmd-1', delta: '2\n' });
    await until(() => partsOf(s, 'cmd-1')[0]?.output === '1\n2\n', 'the output deltas');
    assert.equal(partsOf(s, 'cmd-1')[0].status, 'running');
    fake.notify('item/completed', { threadId: SID, turnId: 'turn-t', completedAtMs: 2, item: { id: 'cmd-1', type: 'commandExecution', command: 'seq 2', cwd: '/w', status: 'completed', aggregatedOutput: '1\n2\n', exitCode: 0, commandActions: [], source: 'agent' } });
    await until(() => partsOf(s, 'cmd-1')[0]?.status === 'done', 'the completed command');
    assert.deepEqual(partsOf(s, 'cmd-1'), [{ type: 'tool', id: 'cmd-1', name: 'shell', input: { command: 'seq 2', cwd: '/w' }, output: '1\n2\n', status: 'done' }]);
  } finally {
    stop();
  }
});

test('approval > a server request becomes a permission part, and the view\'s answer is the app-server\'s reply', async () => {
  const s = sink();
  const stop = codexView.follow(agent, s);
  try {
    await codexView.page(agent, { limit: 1 });
    fake.notify('item/started', { threadId: SID, turnId: 'turn-a', startedAtMs: 1, item: { id: 'cmd-2', type: 'commandExecution', command: 'rm x', cwd: '/w', status: 'inProgress', aggregatedOutput: null, commandActions: [], source: 'agent' } });
    const reply = fake.request('item/commandExecution/requestApproval', { threadId: SID, turnId: 'turn-a', itemId: 'cmd-2', startedAtMs: 1, command: 'rm x' });
    await until(() => s.store.permissions.length === 1, 'the approval');
    const [perm] = s.store.permissions;
    assert.deepEqual({ action: perm.action, resources: perm.resources, message: perm.message }, { action: 'shell', resources: ['rm x'], message: 'cmd-2' });
    assert.deepEqual(partsOf(s, 'cmd-2').find((p) => p.type === 'permission'), { type: 'permission', id: perm.id, action: 'shell', resources: ['rm x'], tool: 'cmd-2', status: 'asked' });
    // The view's status comes from the open request too, for a view opened later.
    const st = await codexView.status(agent);
    assert.deepEqual(st.permissions.map((p) => p.id), [perm.id]);

    await codexView.answerPermission(agent, perm.id, 'always');
    const answer = await reply;
    assert.deepEqual(answer, { jsonrpc: '2.0', id: Number(perm.id), result: { decision: 'acceptForSession' } });
    // The app-server says it resolved; the view records the decision it sent.
    fake.notify('serverRequest/resolved', { threadId: SID, requestId: Number(perm.id) });
    await until(() => s.store.permissions.length === 0, 'the resolution');
    assert.equal(partsOf(s, 'cmd-2').find((p) => p.type === 'permission').status, 'always');
  } finally {
    stop();
  }
});

test('approval > a file change approval, rejected, is declined', async () => {
  const s = sink();
  const stop = codexView.follow(agent, s);
  try {
    await codexView.page(agent, { limit: 1 });
    const reply = fake.request('item/fileChange/requestApproval', { threadId: SID, turnId: 'turn-b', itemId: 'f-2', startedAtMs: 1, grantRoot: '/w' });
    await until(() => s.store.permissions.length === 1, 'the file approval');
    const [perm] = s.store.permissions;
    assert.equal(perm.action, 'edit');
    assert.deepEqual(perm.resources, ['/w']);
    await codexView.answerPermission(agent, perm.id, 'reject');
    assert.deepEqual((await reply).result, { decision: 'decline' });
    fake.notify('serverRequest/resolved', { threadId: SID, requestId: Number(perm.id) });
    await until(() => s.store.permissions.length === 0, 'the file resolution');
  } finally {
    stop();
  }
});

test('approval > an answer to a request no longer open is refused', async () => {
  await assert.rejects(codexView.answerPermission(agent, '424242', 'once'), (e) => e.status === 409);
});

test('approval > a subagent thread\'s approval is not the agent\'s: not shown, listed, or answerable here', async () => {
  const s = sink();
  const stop = codexView.follow(agent, s);
  try {
    await codexView.page(agent, { limit: 1 });
    const reply = fake.request('item/commandExecution/requestApproval', { threadId: 'thr-child', turnId: 'turn-c', itemId: 'cmd-c', startedAtMs: 1, command: 'rm child' });
    // Sent after it, an approval of the agent's own thread shows: the child's has been seen by then.
    const own = fake.request('item/commandExecution/requestApproval', { threadId: SID, turnId: 'turn-c', itemId: 'cmd-o', startedAtMs: 2, command: 'ls own' });
    await until(() => s.store.permissions.length === 1, 'the own approval');
    assert.equal(s.store.permissions[0].resources[0], 'ls own');
    const st = await codexView.status(agent);
    assert.deepEqual(st.permissions.map((p) => p.resources[0]), ['ls own']);
    await assert.rejects(codexView.answerPermission(agent, String(reply.id), 'once'), (e) => e.status === 409);
    // Clean up: the own approval is answered, and the child's request resolves elsewhere.
    await codexView.answerPermission(agent, s.store.permissions[0].id, 'once');
    await own;
    fake.notify('serverRequest/resolved', { threadId: 'thr-child', requestId: reply.id });
    fake.notify('serverRequest/resolved', { threadId: SID, requestId: Number(s.store.permissions[0].id) });
    await until(() => s.store.permissions.length === 0, 'the own resolution');
    // The child's request is still open at the app-server: it answers it itself.
    fake.notify('serverRequest/resolved', { threadId: 'thr-child', requestId: reply.id });
  } finally {
    stop();
  }
});

test('approval > a second answer to the same request is refused, and only one reply is sent', async () => {
  const s = sink();
  const stop = codexView.follow(agent, s);
  try {
    await codexView.page(agent, { limit: 1 });
    const reply = fake.request('item/commandExecution/requestApproval', { threadId: SID, turnId: 'turn-d', itemId: 'cmd-d', startedAtMs: 1, command: 'once' });
    await until(() => s.store.permissions.length === 1, 'the approval');
    const id = s.store.permissions[0].id;
    await codexView.answerPermission(agent, id, 'once');
    assert.deepEqual((await reply).result, { decision: 'accept' });
    await assert.rejects(codexView.answerPermission(agent, id, 'reject'), (e) => e.status === 409);
    fake.notify('serverRequest/resolved', { threadId: SID, requestId: Number(id) });
    await until(() => s.store.permissions.length === 0, 'the resolution');
  } finally {
    stop();
  }
});

test('reasoning > summary and content deltas keep their own buffers, rendered in history\'s order', async () => {
  const s = sink();
  const stop = codexView.follow(agent, s);
  try {
    await codexView.page(agent, { limit: 1 });
    const d = { threadId: SID, turnId: 'turn-r', itemId: 'r-live' };
    fake.notify('item/reasoning/summaryTextDelta', { ...d, summaryIndex: 1, delta: 'two' });
    fake.notify('item/reasoning/summaryTextDelta', { ...d, summaryIndex: 0, delta: 'one ' });
    fake.notify('item/reasoning/textDelta', { ...d, contentIndex: 0, delta: 'raw' });
    fake.notify('item/reasoning/summaryTextDelta', { ...d, summaryIndex: 0, delta: 'more' });
    await until(() => partsOf(s, 'r-live')[0]?.text === 'one more\ntwo\nraw', 'the reasoning deltas');
    assert.deepEqual(partsOf(s, 'r-live'), [{ type: 'reasoning', text: 'one more\ntwo\nraw' }]);
  } finally {
    stop();
  }
});

test('interrupt > turn/interrupt names the running turn, and the confirmation ends it', async () => {
  const s = sink();
  const stop = codexView.follow(agent, s);
  try {
    await codexView.page(agent, { limit: 1 });
    fake.notify('turn/started', { threadId: SID, turn: { id: 'turn-int', items: [], status: 'inProgress' } });
    await until(() => s.store.running === true, 'the turn to start');
    assert.equal(await codexView.interrupt(agent), true);
    const sent = fake.log.find((m) => m.method === 'turn/interrupt');
    assert.deepEqual(sent.params, { threadId: SID, turnId: 'turn-int' });
    await until(() => s.store.running === false, 'the interrupt to end the turn');
  } finally {
    stop();
  }
});

test('prompts > steer goes to turn/steer with the running turn as precondition; idle, turn/start', async () => {
  const s = sink();
  const stop = codexView.follow(agent, s);
  try {
    await codexView.page(agent, { limit: 1 });
    fake.notify('turn/started', { threadId: SID, turn: { id: 'turn-s', items: [], status: 'inProgress' } });
    await until(() => s.store.running === true, 'the turn to start');
    await codexView.prompt(agent, 'also check b', 'steer');
    const steer = fake.log.find((m) => m.method === 'turn/steer');
    assert.deepEqual(steer.params, { threadId: SID, expectedTurnId: 'turn-s', input: [{ type: 'text', text: 'also check b', text_elements: [] }] });
    fake.notify('turn/completed', { threadId: SID, turn: { id: 'turn-s', status: 'completed', items: [] } });
    await until(() => s.store.running === false, 'the turn to end');

    fake.log.length = 0;
    await codexView.prompt(agent, 'hello', 'queue');
    assert.equal(fake.log.filter((m) => m.method === 'turn/steer').length, 0);
    const start = fake.log.find((m) => m.method === 'turn/start');
    assert.equal(start.params.threadId, SID);
    assert.deepEqual(start.params.input, [{ type: 'text', text: 'hello', text_elements: [] }]);
    // Steer with nothing running starts a turn, as a queued prompt does.
    fake.log.length = 0;
    await codexView.prompt(agent, 'idle steer', 'steer');
    assert.equal(fake.log.some((m) => m.method === 'turn/start'), true);
    assert.equal(fake.log.some((m) => m.method === 'turn/steer'), false);
  } finally {
    stop();
  }
});
