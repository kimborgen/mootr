#!/usr/bin/env node
// stam's own agent view (src/agent-view.ts) with its OpenCode normalizer
// (src/adapters/opencode-view.ts), from a captured OpenCode v2.0.26 session
// (test/fixtures/opencode-view.json: a shell call that asked permission, then a reply).
// A fake OpenCode server answers the reads. Throwaway STAM_HOME, no daemon, no models.
// Run with `node --test test/agent-view.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-agent-view-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `agent-view-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE']) delete process.env[k];

const fx = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/opencode-view.json'), 'utf8'));
const SID = fx.session;
const stored = fx.messages.data; // newest first, as the server sends with order=desc

// The fake OpenCode server: messages (paged by limit and cursor), active sessions, permissions.
const oc = { messages: stored, active: {}, permissions: [], prompts: [], replies: [], cursors: [], delay: 0, answered: 0 };
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => setTimeout(answer, oc.delay));
  const answer = () => {
    oc.answered++;
    let data = {};
    if (u.pathname === `/api/session/${SID}/message`) {
      const limit = Number(u.searchParams.get('limit') ?? 50);
      let list = oc.messages;
      const cursor = u.searchParams.get('cursor');
      if (cursor) {
        const c = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        oc.cursors.push(c);
        list = list.slice(list.findIndex((m) => m.id === c.id) + 1);
      }
      data = list.slice(0, limit);
    } else if (u.pathname === '/api/session/active') data = oc.active;
    else if (u.pathname === `/api/session/${SID}/permission`) data = oc.permissions;
    else if (u.pathname === `/api/session/${SID}/prompt`) oc.prompts.push(JSON.parse(body));
    else if (u.pathname.startsWith(`/api/session/${SID}/permission/`)) oc.replies.push([u.pathname.split('/')[5], JSON.parse(body)]);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data }));
  };
});

let db, view, ocView, opencode, hub, hubUrl;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const feed = (ev) => {
  for (const l of opencode.eventListeners) l(ev);
};

before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.STAM_OPENCODE_PORT = String(server.address().port);
  db = await import('../src/db.ts');
  await import('../src/adapters/index.ts');
  view = await import('../src/agent-view.ts');
  ocView = await import('../src/adapters/opencode-view.ts');
  opencode = await import('../src/adapters/opencode.ts');
  db.open();
  db.createAgent({ id: 'oc', name: 'oc', role: 'dev', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: '/tmp/oc', parent_id: null, session_id: SID });
  db.createAgent({ id: 'cc', name: 'cc', role: 'dev', machine: 'x', harness: 'claude', model: null, effort: null, cwd: '/tmp/cc', parent_id: null, session_id: null });
  // The view's stream, served as the daemon serves it.
  hub = createServer((req, res) => view.stream(db.getAgent(req.url.slice(1)), res).catch((e) => res.destroyed || (res.writeHead(e.status ?? 500), res.end(e.message))));
  await new Promise((r) => hub.listen(0, '127.0.0.1', r));
  hubUrl = `http://127.0.0.1:${hub.address().port}`;
});

after(() => {
  server.closeAllConnections();
  hub.closeAllConnections();
  server.close();
  hub.close();
  rmSync(home, { recursive: true, force: true });
});

// Opens the view's event stream; `events` fills as they arrive.
function open(agent) {
  const events = [];
  return new Promise((resolve, reject) => {
    const req = request(`${hubUrl}/${agent}`, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
          buf = buf.slice(i + 2);
          if (line) events.push(JSON.parse(line.slice(6)));
        }
      });
      resolve({ status: res.statusCode, events, close: () => req.destroy() });
    });
    req.on('error', reject);
    req.end();
  });
}
async function until(fn, ms = 3000) {
  for (let t = 0; t < ms; t += 20) {
    const v = fn();
    if (v) return v;
    await sleep(20);
  }
  assert.fail('timed out');
}

test('stored messages normalize: user prompt, reasoning, a finished tool call, the reply; a succeeded idle marker drops', () => {
  const msgs = stored.map(ocView.fromOpenCode).filter(Boolean).reverse();
  assert.deepEqual(
    msgs.map((m) => [m.role, m.parts.map((p) => p.type).join('+')]),
    [
      ['user', 'text'],
      ['assistant', 'reasoning+tool'],
      ['assistant', 'text'],
    ],
  );
  const tool = msgs[1].parts[1];
  assert.equal(tool.name, 'shell');
  assert.deepEqual(tool.input, { command: 'echo hello-view' });
  assert.equal(tool.output, 'hello-view\n');
  assert.equal(tool.status, 'done');
  assert.ok(!msgs[1].running && !msgs[2].running);
  // Each part carries its own time, for the web view to split a step at a mail (S-278); a
  // part OpenCode stores no time for takes the one before it, or the message's.
  assert.deepEqual(msgs[1].marks, [stored[2].content[0].time.created, stored[2].content[1].time.created]);
  assert.deepEqual(msgs[2].marks, [msgs[2].at]);
  assert.equal(ocView.fromOpenCode({ id: 'm', type: 'idle', outcome: 'interrupted', time: { created: 1 } }).kind, 'interrupted');
  assert.equal(ocView.fromOpenCode({ id: 'm', type: 'synthetic', text: 'mail', time: { created: 1 } }).role, 'system');
});

test('live events build what the server stores, plus the permission part and its answer', () => {
  const store = new view.ViewStore();
  const results = fx.events.map((ev) => ocView.applyEvent(store, ev));
  const want = stored.map(ocView.fromOpenCode).filter((m) => m?.role === 'assistant').reverse();
  assert.equal(store.messages.length, 2);
  for (const [i, m] of store.messages.entries()) {
    assert.equal(m.id, want[i].id);
    assert.equal(m.running, false);
    const parts = m.parts.filter((p) => p.type !== 'permission');
    assert.deepEqual(parts, want[i].parts);
    // Each part made live has a time, in order, for the web view to split at mail (S-278).
    assert.ok(m.marks.length >= parts.length && m.marks.every((t, k) => t > 0 && (!k || t >= m.marks[k - 1])), JSON.stringify(m.marks));
  }
  const perm = store.messages[0].parts.find((p) => p.type === 'permission');
  assert.deepEqual(perm, { type: 'permission', id: fx.events.find((e) => e.type === 'permission.asked').data.id, action: 'shell', resources: ['echo hello-view'], tool: want[0].parts[1].id, status: 'once' });
  assert.deepEqual(store.permissions, []);
  assert.equal(store.running, false);
  assert.ok(results.includes('resync'));
  assert.equal(results[fx.events.findIndex((e) => e.type === 'session.usage.updated')], false);
});

test('a merge keeps streaming messages and permission parts, and marks only what changed', () => {
  const store = new view.ViewStore();
  const fresh = () => stored.map(ocView.fromOpenCode).filter(Boolean).reverse();
  store.merge(fresh());
  store.ask({ id: 'per_1', action: 'shell', resources: ['ls'], message: fresh()[1].id });
  const streaming = store.message('msg_new');
  streaming.at = Date.now();
  streaming.parts.push({ type: 'text', text: 'partial' });
  store.flush();
  store.merge(fresh());
  assert.deepEqual(store.flush(), []);
  assert.equal(store.messages.at(-1).id, 'msg_new');
  assert.ok(store.messages[1].parts.some((p) => p.type === 'permission'));
  const changed = fresh();
  changed[2].parts[0].text = 'edited';
  store.merge(changed);
  assert.deepEqual(
    store.flush().map((e) => e.message.id),
    [changed[2].id],
  );
});

test('the stream sends state with capabilities, then message and status events from live deltas', async () => {
  oc.messages = stored.slice(1); // as stored before the reply message
  oc.messages = oc.messages.filter((m) => m.type !== 'assistant' || m.content.some((c) => c.type === 'tool'));
  oc.active = { [SID]: {} };
  oc.permissions = [{ id: 'per_x', sessionID: SID, action: 'shell', resources: ['rm -rf /tmp/x'], source: { type: 'tool', messageID: oc.messages[0].id, id: 'call_x' } }];
  const c = await open('oc');
  assert.equal(c.status, 200);
  const first = await until(() => c.events[0]);
  assert.equal(first.type, 'state');
  const s = first.state;
  assert.deepEqual(s.capabilities, { can_stream: true, can_send: true, can_interrupt: true, can_approve: true });
  assert.equal(s.harness, 'opencode');
  assert.equal(s.running, true);
  assert.equal(s.older, null);
  assert.deepEqual(
    s.messages.map((m) => m.role),
    ['user', 'assistant'],
  );
  assert.equal(s.permissions[0].id, 'per_x');
  assert.ok(s.messages[1].parts.some((p) => p.type === 'permission' && p.id === 'per_x' && p.status === 'asked'));

  const mid = 'msg_live1';
  const base = { sessionID: SID, assistantMessageID: mid, ordinal: 0 };
  feed({ type: 'session.text.started', data: base });
  for (const w of ['Hello', ' from', ' the', ' view']) feed({ type: 'session.text.delta', data: { ...base, delta: w } });
  feed({ type: 'permission.replied', data: { sessionID: SID, requestID: 'per_x', reply: 'reject' } });
  feed({ type: 'session.text.delta', data: { ...base, sessionID: 'ses_other', delta: 'not ours' } });
  const msg = await until(() => c.events.findLast((e) => e.type === 'message' && e.message.id === mid));
  assert.deepEqual(msg.message.parts, [{ type: 'text', text: 'Hello from the view' }]);
  assert.equal(msg.message.running, true);
  // Deltas inside one 50 ms window go out as one event.
  assert.equal(c.events.filter((e) => e.type === 'message' && e.message.id === mid).length, 1);
  const st = await until(() => c.events.find((e) => e.type === 'status'));
  assert.deepEqual(st.permissions, []);
  const answered = await until(() => c.events.find((e) => e.type === 'message' && e.message.parts.some((p) => p.type === 'permission' && p.status === 'reject')));
  assert.ok(answered);

  // The turn ends: status goes idle, and a re-read brings the stored reply under its own id.
  oc.active = {};
  oc.permissions = [];
  oc.messages = stored;
  feed({ type: 'session.execution.succeeded', data: { sessionID: SID } });
  await until(() => c.events.find((e) => e.type === 'status' && e.running === false));
  const reply = stored[1];
  const r = await until(() => c.events.find((e) => e.type === 'message' && e.message.id === reply.id));
  assert.equal(r.message.parts[0].text, reply.content[0].text);

  // A second viewer joins the same live window. The streamed message the server never
  // stored is gone after the re-read: the server's messages are the truth.
  const c2 = await open('oc');
  const s2 = (await until(() => c2.events[0])).state;
  assert.deepEqual(
    s2.messages.map((m) => m.id),
    stored.map(ocView.fromOpenCode).filter(Boolean).reverse().map((m) => m.id),
  );
  c.close();
  c2.close();
});

// `limit` counts the server's messages, so one the view leaves out (the idle marker,
// stored[0]) makes a page shorter.
test('paging: older is the oldest id when more exist, and history before it reads through the cursor', async () => {
  oc.messages = stored;
  const a = db.getAgent('oc');
  const p1 = await view.history(a, undefined, 2);
  assert.deepEqual(
    p1.messages.map((m) => m.id),
    [stored[1].id],
  );
  assert.equal(p1.older, stored[1].id);
  const p2 = await view.history(a, p1.older, 2);
  assert.deepEqual(oc.cursors.at(-1), { id: stored[1].id, order: 'desc', direction: 'next' });
  assert.deepEqual(
    p2.messages.map((m) => m.id),
    [stored[3].id, stored[2].id],
  );
  assert.equal(p2.older, null);
});

test('send, interrupt, and permission replies reach the harness; a harness without a view says so', async () => {
  const a = db.getAgent('oc');
  await view.prompt(a, 'next step', 'steer');
  assert.deepEqual(oc.prompts.at(-1), { text: 'next step', delivery: 'steer' });
  await assert.rejects(view.prompt(a, '  '), /empty/);
  await assert.rejects(view.prompt(a, 'x', 'later'), /delivery/);
  await view.answerPermission(a, 'per_y', 'always');
  assert.deepEqual(oc.replies.at(-1), ['per_y', { decision: 'always' }]);
  await assert.rejects(view.answerPermission(a, 'per_y', 'maybe'), /decision/);
  oc.active = {};
  assert.equal(await view.interrupt(a), true);
  assert.deepEqual(
    db.listEvents('oc').map((e) => e.type).filter((t) => t.startsWith('view-')).sort(),
    ['view-interrupt', 'view-permission', 'view-prompt'],
  );
  assert.equal(view.capabilities(db.getAgent('cc')), null);
  const c = await open('cc');
  assert.equal(c.status, 409);
  c.close();
});

test("a peer's view stream is piped through as it arrives, with the peer's token and the local mark", async () => {
  const { peerStream } = await import('../src/peers.ts');
  let seen;
  // The second event is written only once the test has the first one, so the order is proven by
  // state: a relay that buffered the first event would never hand it over before the second exists.
  let release;
  const released = new Promise((r) => (release = r));
  const peer = createServer((req, res) => {
    seen = req.headers;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"state"}\n\n');
    released.then(() => res.write('data: {"type":"status"}\n\n'));
  });
  await new Promise((r) => peer.listen(0, '127.0.0.1', r));
  const relay = createServer((req, res) => peerStream({ name: 'p', url: `http://127.0.0.1:${peer.address().port}/`, token: 'T' }, req.url, res));
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  const chunks = [];
  const req = request(`http://127.0.0.1:${relay.address().port}/api/agents/x/view`, (res) => {
    assert.equal(res.headers['content-type'], 'text/event-stream');
    res.on('data', (c) => chunks.push([Date.now(), String(c)]));
  });
  req.end();
  await until(() => chunks.length >= 1);
  assert.equal(seen.authorization, 'Bearer T');
  assert.equal(seen['x-stam-local'], '1');
  assert.match(chunks[0][1], /state/);
  release();
  await until(() => chunks.length >= 2);
  assert.match(chunks[1][1], /status/);
  req.destroy();
  for (const s of [peer, relay]) s.closeAllConnections(), s.close();
});

test('a resync mid-stream rebuilds part slots: later deltas and tool events land in the parts they belong to', () => {
  const store = new view.ViewStore();
  const mid = 'msg_mid';
  const at = Date.now();
  // What the server stores halfway through: reasoning, text, and a tool still running.
  store.merge([
    {
      id: mid,
      role: 'assistant',
      at,
      running: true,
      parts: [
        { type: 'reasoning', text: 'Think' },
        { type: 'text', text: 'Hel' },
        { type: 'tool', id: 'call_1', name: 'shell', input: { command: 'ls' }, status: 'running' },
      ],
    },
  ]);
  const d = { sessionID: SID, assistantMessageID: mid, ordinal: 0 };
  ocView.applyEvent(store, { type: 'session.reasoning.delta', data: { ...d, delta: 'ing' } });
  ocView.applyEvent(store, { type: 'session.text.delta', data: { ...d, delta: 'lo' } });
  ocView.applyEvent(store, { type: 'session.tool.success', data: { ...d, id: 'call_1', content: [{ type: 'text', text: 'a.txt' }] } });
  ocView.applyEvent(store, { type: 'session.text.started', data: { ...d, ordinal: 1 } });
  ocView.applyEvent(store, { type: 'session.text.delta', data: { ...d, ordinal: 1, delta: 'Done' } });
  assert.deepEqual(store.messages[0].parts, [
    { type: 'reasoning', text: 'Thinking' },
    { type: 'text', text: 'Hello' },
    { type: 'tool', id: 'call_1', name: 'shell', input: { command: 'ls' }, output: 'a.txt', status: 'done' },
    { type: 'text', text: 'Done' },
  ]);
});

test('a client that leaves while the first read is pending is never attached, and the view closes', async () => {
  oc.messages = stored;
  oc.delay = 300;
  const req = request(`${hubUrl}/oc`);
  req.on('error', () => {});
  req.end();
  await until(() => view.openViews() === 1);
  req.destroy();
  // Wait for the abandoned read to be answered, then for a later viewer's first state: only that
  // viewer's view is open, so the abandoned one was never attached.
  await until(() => oc.answered >= 1);
  oc.delay = 0;
  const c = await open('oc');
  assert.equal((await until(() => c.events[0])).type, 'state');
  assert.equal(view.openViews(), 1);
  c.close();
  await until(() => view.openViews() === 0);
});

test('a client that stops reading is dropped once its buffer passes the cap, closing the view', async () => {
  oc.messages = stored;
  oc.active = { [SID]: {} };
  let closed = false;
  const req = request(`${hubUrl}/oc`, (res) => {
    res.pause(); // never reads
    res.on('close', () => (closed = true));
  });
  req.on('error', () => (closed = true));
  req.end();
  await until(() => view.openViews() === 1);
  const d = { sessionID: SID, assistantMessageID: 'msg_big', ordinal: 0 };
  feed({ type: 'session.text.started', data: d });
  const chunk = 'x'.repeat(256 * 1024);
  for (let i = 0; i < 60 && view.openViews(); i++) {
    feed({ type: 'session.text.delta', data: { ...d, delta: chunk } });
    // Yield a turn of the event loop so the socket can take the write; the loop ends on the state.
    await new Promise((r) => setTimeout(r, 0));
  }
  await until(() => view.openViews() === 0, 5000);
  req.destroy();
  oc.active = {};
});

test("the relay reads a peer's stream only as fast as its client takes it", async () => {
  const { peerStream } = await import('../src/peers.ts');
  let written = 0;
  let blocked = false;
  const peer = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = `data: ${'y'.repeat(64 * 1024)}\n\n`;
    const pump = () => {
      while (written < 400) {
        written++;
        if (!res.write(chunk)) return void ((blocked = true), res.once('drain', pump));
      }
    };
    pump();
  });
  await new Promise((r) => peer.listen(0, '127.0.0.1', r));
  const relay = createServer((req, res) => peerStream({ name: 'p', url: `http://127.0.0.1:${peer.address().port}`, token: 'T' }, req.url, res));
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  const req = request(`http://127.0.0.1:${relay.address().port}/x`, (res) => res.pause());
  req.on('error', () => {});
  req.end();
  // Wait for the peer to hit backpressure; the paused client never drains, so it stays held there.
  await until(() => blocked, 5000);
  // 400 chunks are 26 MB; a relay that ignored its client would have taken them all.
  assert.ok(written < 400, `the peer was held back after ${written} chunks`);
  req.destroy();
  for (const s of [peer, relay]) s.closeAllConnections(), s.close();
});

// S-203: mail to the agent joins its conversation as user messages of kind 'mail', at the
// time it was sent, with its read state; S-255: so does mail it sent, with its recipients.
test('mail to the agent shows as mail messages between its turns, and reading it updates the view', async () => {
  oc.messages = stored;
  oc.active = {};
  oc.permissions = [];
  db.createAgent({ id: 'om', name: 'om', role: 'dev', machine: 'x', harness: 'opencode', model: null, effort: null, cwd: '/tmp/om', parent_id: null, session_id: SID });
  const mail = (id, from, to, at) => {
    db.createMail({ id, from_id: from, from_name: from, subject: `About ${id}`, body: `Body of ${id}`, thread_id: 'th1', reply_to: null }, [to]);
    db.open().prepare('UPDATE mail SET created_at = ? WHERE id = ?').run(new Date(at).toISOString(), id);
  };
  const [, reply, firstAnswer, user] = stored;
  mail('m_early', 'human', 'om', user.time.created - 5000);
  mail('m_mid', 'cos', 'om', firstAnswer.time.created + 1);
  mail('m_late', 'human', 'om', reply.time.completed + 1);
  mail('m_mine', 'om', 'cos', firstAnswer.time.created + 2);

  const a = db.getAgent('om');
  const all = await view.history(a, undefined, 50);
  assert.deepEqual(
    all.messages.map((m) => m.id),
    ['mail:m_early', user.id, firstAnswer.id, 'mail:m_mid', 'mail:m_mine', reply.id, 'mail:m_late'],
  );
  const mine = all.messages.find((m) => m.id === 'mail:m_mine').parts[0];
  assert.deepEqual(mine.to, [{ id: 'cos', name: 'cos', read_at: null }]);
  assert.equal(mine.from_id, 'om');
  const card = all.messages[0];
  assert.equal(card.role, 'user');
  assert.equal(card.kind, 'mail');
  assert.deepEqual(card.parts, [{ type: 'mail', id: 'm_early', from_id: 'human', from: 'human', subject: 'About m_early', body: 'Body of m_early', thread: 'th1', read_at: null }]);

  // A page with older messages carries only the mail from its first message on.
  const p1 = await view.history(a, undefined, 2);
  assert.deepEqual(p1.messages.map((m) => m.id), [reply.id, 'mail:m_late']);

  // Open: a mail read, and a new mail, reach the view live.
  const c = await open('om');
  const s = (await until(() => c.events[0])).state;
  assert.equal(s.messages.filter((m) => m.kind === 'mail').length, 4);
  assert.equal(s.older, null);
  db.readMail('om', ['m_mid']);
  const read = await until(() => c.events.find((e) => e.type === 'message' && e.message.id === 'mail:m_mid'));
  assert.ok(read.message.parts[0].read_at > 0);
  // The agent's mail, read by its recipient, and a new one it sends.
  db.readMail('cos', ['m_mine']);
  const seen = await until(() => c.events.find((e) => e.type === 'message' && e.message.id === 'mail:m_mine'));
  assert.ok(seen.message.parts[0].to[0].read_at > 0);
  db.createMail({ id: 'm_sent', from_id: 'om', from_name: 'om', subject: 'Done', body: 'Branch ready', thread_id: 'th2', reply_to: null }, ['human']);
  const sentNow = await until(() => c.events.find((e) => e.type === 'message' && e.message.id === 'mail:m_sent'));
  assert.deepEqual(sentNow.message.parts[0].to, [{ id: 'human', name: 'human', read_at: null }]);
  mail('m_new', 'human', 'om', Date.now());
  const fresh = await until(() => c.events.find((e) => e.type === 'message' && e.message.id === 'mail:m_new'));
  assert.equal(fresh.message.parts[0].read_at, null);
  c.close();
  await until(() => view.openViews() === 0);
});

// S-203 reopened: a Claude Code turn is one message at its start, and can run for hours while
// mail comes in. Mail goes by time, after the turn's start; the turn carries each part's time
// (`marks`), and the web view splits it at the mail (S-255). Mail never counts against the
// window, and a page carries only the mail in its own time span.
test('a long Claude conversation with many mails keeps its harness messages, the mail interleaved by time', async () => {
  const MIN = 60_000;
  const t0 = Date.parse('2026-10-12T10:00:00Z');
  const iso = (ms) => new Date(ms).toISOString();
  const rows = [];
  // 150 short turns, a minute apart: 300 messages over two and a half hours.
  for (let k = 0; k < 150; k++) {
    const at = t0 + k * MIN;
    rows.push({ type: 'user', uuid: `u${k}`, timestamp: iso(at), message: { role: 'user', content: `Prompt ${k}` } });
    rows.push({ type: 'assistant', uuid: `a${k}`, timestamp: iso(at + 5000), message: { role: 'assistant', content: [{ type: 'text', text: `Answer ${k}` }] } });
  }
  // Then one turn of two hours, a tool call a minute.
  const long = t0 + 150 * MIN;
  rows.push({ type: 'user', uuid: 'uL', timestamp: iso(long), message: { role: 'user', content: 'The long one' } });
  for (let k = 0; k < 120; k++) {
    const at = long + 1000 + k * MIN;
    rows.push({ type: 'assistant', uuid: `aL${k}`, timestamp: iso(at), message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${k}`, name: 'Bash', input: { command: `step ${k}` } }] } });
    rows.push({ type: 'user', uuid: `rL${k}`, timestamp: iso(at + 30_000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${k}`, content: 'ok' }] } });
  }
  const end = long + 1000 + 119 * MIN + 30_000;
  const file = join(home, 'long-claude.jsonl');
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  db.createAgent({ id: 'cl', name: 'cl', role: 'dev', machine: 'x', harness: 'claude', model: null, effort: null, cwd: '/tmp/cl', parent_id: null, session_id: null });
  db.updateAgent('cl', { transcript_path: file, activity: 'idle' });

  // A mail every two minutes over all of it, every third read, and three after its last row.
  const sent = [];
  const mail = (id, at) => {
    db.createMail({ id, from_id: 'cos', from_name: 'cos', subject: `About ${id}`, body: `Body of ${id}`, thread_id: id, reply_to: null }, ['cl']);
    db.open().prepare('UPDATE mail SET created_at = ? WHERE id = ?').run(iso(at), id);
    sent.push({ id: `mail:${id}`, at });
  };
  for (let k = 0; k * 2 * MIN + 30_000 < end - t0; k++) mail(`mc${k}`, t0 + k * 2 * MIN + 30_000);
  db.readMail('cl', sent.filter((_, i) => i % 3 === 0).map((m) => m.id.slice(5)));
  for (let k = 0; k < 3; k++) mail(`mn${k}`, end + (k + 1) * MIN);
  assert.ok(sent.length > 100);

  const a = db.getAgent('cl');
  const check = (messages) => {
    const harness = messages.filter((m) => m.kind !== 'mail');
    assert.equal(harness.length, 50, 'the newest page holds 50 harness messages');
    assert.equal(harness.at(-1).id, 'aL0');
    const mails = messages.filter((m) => m.kind === 'mail');
    const want = sent.filter((m) => m.at >= harness[0].at).map((m) => m.id);
    assert.deepEqual(mails.map((m) => m.id), want, 'only the mail in the page time span');
    // The mail sent during the two-hour turn follows its start, then the newer mail; the turn
    // carries each tool call's time for the web view to split it at the mail.
    const turn = messages.findIndex((m) => m.id === 'aL0');
    const during = sent.filter((m) => m.at > long && m.at < end).map((m) => m.id);
    assert.deepEqual(messages.slice(turn + 1).map((m) => m.id), [...during, 'mail:mn0', 'mail:mn1', 'mail:mn2']);
    assert.equal(messages[turn - 1].id, 'uL');
    assert.deepEqual(messages[turn].marks, Array.from({ length: 120 }, (_, k) => long + 1000 + k * MIN));
  };
  const page = await view.history(a, undefined, 50);
  check(page.messages);
  assert.equal(page.older, 'u126');

  // The open view: its first state, and the resync each mail starts.
  const c = await open('cl');
  check((await until(() => c.events[0])).state.messages);
  mail('mn3', end + 4 * MIN);
  await until(() => c.events.find((e) => e.type === 'message' && e.message.id === 'mail:mn3'));
  c.close();
  await until(() => view.openViews() === 0);

  // A re-read that comes back with no harness messages (the transcript gone for a moment)
  // keeps the window's, and a window past its cap drops harness messages, never for mail.
  const store = new view.ViewStore();
  store.merge(view.withMail(a, page.messages.filter((m) => m.kind !== 'mail'), true));
  store.merge(view.withMail(a, [], false));
  assert.equal(store.messages.filter((m) => m.kind !== 'mail').length, 50);
  const many = Array.from({ length: 420 }, (_, i) => ({ id: `h${i}`, role: 'user', at: t0 + i * 30_000, parts: [] }));
  const big = new view.ViewStore();
  big.merge(view.withMail(a, many, false));
  assert.equal(big.messages.filter((m) => m.kind !== 'mail').length, 400);
  assert.ok(big.messages.filter((m) => m.kind === 'mail').every((m) => m.at >= many[20].at));
});
