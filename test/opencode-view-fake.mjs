#!/usr/bin/env node
// The steps of test/e2e-opencode-view.sh: an OpenCode agent's view (src/adapters/opencode-view.ts, go/internal/agentview)
// driven through a throwaway daemon's endpoints, with the OpenCode server the fake (test/fake-opencode). Usage:
// node test/opencode-view-fake.mjs AGENT SESSION, with STAM_URL, STAM_HOME, STAM_TEST_HUMAN_KEY (the daemon's: it stands in
// for the human's `tailscale serve` proof) and STAM_OPENCODE_PORT set. Prints each step; exits 1 on the first failure.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [agent, session] = process.argv.slice(2);
const url = process.env.STAM_URL;
const fakeUrl = `http://127.0.0.1:${process.env.STAM_OPENCODE_PORT}/__fake`;
const token = readFileSync(join(process.env.STAM_HOME, 'token'), 'utf8').trim();
const agentHeaders = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const headers = { ...agentHeaders, 'x-stam-human': '1', 'x-stam-test-human': process.env.STAM_TEST_HUMAN_KEY };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  console.log(`FAIL: ${msg}`);
  process.exit(1);
};
const check = (ok, msg) => (ok ? console.log(`ok: ${msg}`) : fail(msg));

async function call(method, path, body, h = headers) {
  const r = await fetch(url + path, { method, headers: h, body: body && JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
async function fake(what, body) {
  const r = await fetch(`${fakeUrl}/${what}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json().catch(() => ({}));
}

// The view's event stream, read with fetch as the web UI reads it (EventSource can't send the token header).
async function open() {
  const events = [];
  const abort = new AbortController();
  const r = await fetch(`${url}/api/agents/${agent}/view`, { headers, signal: abort.signal });
  if (r.status !== 200) fail(`view stream answered ${r.status}: ${await r.text()}`);
  (async () => {
    let buf = '';
    try {
      for await (const c of r.body) {
        buf += Buffer.from(c).toString();
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
          buf = buf.slice(i + 2);
          if (line) events.push({ at: Date.now(), ...JSON.parse(line.slice(6)) });
        }
      }
    } catch {}
  })();
  return { events, close: () => abort.abort() };
}
async function until(what, fn, s = 30) {
  for (let t = 0; t < s * 10; t++) {
    const v = fn();
    if (v) return v;
    await sleep(100);
  }
  fail(`timed out waiting for ${what}`);
}
const texts = (m) => m.parts.filter((p) => p.type === 'text').map((p) => p.text).join('');

// A long transcript: 140 messages, oldest first, a user message and a reply with a tool in each pair, so that a page of
// 50 reaches back twice before the first one.
const N = 140;
const messages = [];
for (let i = 0; i < N / 2; i++) {
  const t = 1000 + i * 10;
  messages.push({ id: `msg_${String(2 * i).padStart(4, '0')}`, type: 'user', text: `question ${i}`, time: { created: t } });
  messages.push({
    id: `msg_${String(2 * i + 1).padStart(4, '0')}`,
    type: 'assistant',
    time: { created: t + 1, completed: t + 2 },
    content: [
      { type: 'text', text: `answer ${i}` },
      { type: 'tool', id: `tool_${i}`, name: 'bash', state: { status: 'completed', input: { command: `echo ${i}` }, content: [{ type: 'text', text: String(i) }] }, time: { created: t + 1 } },
    ],
  });
}
await fake('seed', { session, messages, permissions: [{ id: 'per_1', action: 'edit', resources: ['a.txt'] }], active: false });

const v = await open();
const state = (await until('the first state', () => v.events.find((e) => e.type === 'state'))).state;
check(JSON.stringify(state.capabilities) === JSON.stringify({ can_stream: true, can_send: true, can_interrupt: true, can_approve: true }), 'state carries OpenCode capabilities');
check(state.running === false, 'the agent is idle');
check(state.permissions?.some((p) => p.id === 'per_1' && p.action === 'edit'), 'the waiting permission is listed');
const show = await call('GET', `/api/agents/${agent}`);
check(show.data.view?.can_send === true, "the agent's JSON says it has a view");

// Paging older through the cursor: three pages (50, 50, 40), each ending where the next begins.
const ids = new Set();
const pages = [];
let before = '';
for (let i = 0; i < 6; i++) {
  const p = await call('GET', `/api/agents/${agent}/view/history?limit=50${before ? `&before=${before}` : ''}`);
  check(p.status === 200, `page ${i + 1} answers 200`);
  pages.push(p.data);
  for (const m of p.data.messages) {
    check(!ids.has(m.id), `message ${m.id} is on one page only`);
    ids.add(m.id);
  }
  if (!p.data.older) break;
  before = p.data.older;
}
check(pages.length === 3, `the transcript takes three pages (${pages.map((p) => p.messages.length).join(', ')})`);
check(pages[0].messages.length === 50 && pages[1].messages.length === 50 && pages[2].messages.length === 40, 'pages of 50, 50 and 40');
check(ids.size === N, `every one of ${N} messages was read once`);
check(pages[2].older === null, 'the last page ends there');
const first = pages[2].messages[0];
check(first.role === 'user' && texts(first) === 'question 0', 'the oldest message is the first question');
const lastPage = pages[0].messages;
check(texts(lastPage[lastPage.length - 1]) === 'answer 69' && lastPage[lastPage.length - 1].parts.some((p) => p.type === 'tool' && p.status === 'done'), 'the newest page ends with the last reply and its finished tool');

// Only the human sends: an agent's token with a forged x-stam-human header is refused.
const forged = { ...agentHeaders, 'x-stam-human': '1' };
for (const [what, body] of [
  ['prompt', { text: 'hi' }],
  ['interrupt', {}],
  ['permission', { request: 'per_1', decision: 'once' }],
]) {
  const r = await call('POST', `/api/agents/${agent}/view/${what}`, body, forged);
  check(r.status === 403, `a forged ${what} is refused`);
}
check(!JSON.stringify(await fetch(`${fakeUrl}/replies`).then((r) => r.json())).includes('per_1'), 'the refused reply reached no server');

// A prompt from the view reaches the server, and its reply streams back into the open window.
const n0 = v.events.length;
const sent = await call('POST', `/api/agents/${agent}/view/prompt`, { text: 'hello from the view', delivery: 'queue' });
check(sent.status === 200, 'prompt sent');
await until('running', () => v.events.slice(n0).find((e) => e.type === 'status' && e.running));
await until('the prompt in the stream', () => v.events.slice(n0).find((e) => e.type === 'message' && e.message.role === 'user' && /hello from the view/.test(texts(e.message))));
await until('the reply in the stream', () => v.events.slice(n0).find((e) => e.type === 'message' && e.message.role === 'assistant' && texts(e.message).length > 0));
await until('idle again', () => v.events.slice(n0).find((e) => e.type === 'status' && e.running === false));

// A permission answered from the view reaches the server's permission endpoint with its decision, and the ask ends.
const bad = await call('POST', `/api/agents/${agent}/view/permission`, { request: 'per_1', decision: 'maybe' });
check(bad.status === 400, 'an unknown decision is refused');
const ans = await call('POST', `/api/agents/${agent}/view/permission`, { request: 'per_1', decision: 'once' });
check(ans.status === 200, 'the permission reply is accepted');
const replies = await fetch(`${fakeUrl}/replies`).then((r) => r.json());
check(JSON.stringify(replies).includes('"permission":"per_1"') && JSON.stringify(replies).includes('"decision":"once"') && JSON.stringify(replies).includes(session), 'the server got the reply for this session');
await until('the permission ended', () => v.events.slice(n0).find((e) => e.type === 'permission' || (e.type === 'state' && !e.state.permissions?.length) || JSON.stringify(e).includes('per_1')));

// An interrupt stops a running turn.
await fake('seed', { session, messages: [], permissions: [], active: false });
await fake('execution', { session, kind: 'started' });
await until('running', () => v.events.slice(n0).filter((e) => e.type === 'status').pop()?.running === true);
const stop = await call('POST', `/api/agents/${agent}/view/interrupt`);
check(stop.status === 200, 'interrupt answered 200');
await until('stopped', () => v.events.slice(n0).filter((e) => e.type === 'status').pop()?.running === false);
v.close();

// A window that closed leaves no follower: the stream of the same agent opens again with a full state.
const again = await open();
const second = (await until('a state on a second window', () => again.events.find((e) => e.type === 'state'))).state;
check(second.running === false, 'a second window starts from a full state');
again.close();
console.log('PASS opencode-view steps');
