#!/usr/bin/env node
// The live half of test/e2e-agent-view.sh: drives an OpenCode agent's view through a
// throwaway daemon's endpoints. Usage: node test/agent-view-live.mjs AGENT, with STAM_URL
// and STAM_HOME pointing at that daemon, and STAM_TEST_HUMAN_KEY the daemon's (it stands
// in for the human's `tailscale serve` proof). Prints each step; exits 1 on the first failure.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const agent = process.argv[2];
const url = process.env.STAM_URL;
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

// The view's event stream, read with fetch as the web UI reads it (EventSource can't send
// the token header).
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
async function until(what, fn, s = 60) {
  for (let t = 0; t < s * 10; t++) {
    const v = fn();
    if (v) return v;
    await sleep(100);
  }
  fail(`timed out waiting for ${what}`);
}
const texts = (m) => m.parts.filter((p) => p.type === 'text').map((p) => p.text).join('');

// History: the spawn prompt and the reply, with the agent's capabilities.
const v = await open();
const state = (await until('the first state', () => v.events.find((e) => e.type === 'state'))).state;
check(JSON.stringify(state.capabilities) === JSON.stringify({ can_stream: true, can_send: true, can_interrupt: true, can_approve: true }), 'state carries OpenCode capabilities');
check(state.running === false, 'the agent is idle');
const user = state.messages.find((m) => m.role === 'user');
const reply = state.messages.find((m) => m.role === 'assistant' && /first-reply/i.test(texts(m)));
check(user && reply && user.at < reply.at, `history has the prompt and the reply (${state.messages.length} messages)`);
const show = await call('GET', `/api/agents/${agent}`);
check(show.data.view?.can_send === true, "the agent's JSON says it has a view");

// Paging through the real server's cursor.
const p1 = await call('GET', `/api/agents/${agent}/view/history?limit=1`);
check(p1.status === 200 && p1.data.messages.length <= 1 && p1.data.older, `a one-message page names an older cursor (${p1.data.older})`);
const p2 = await call('GET', `/api/agents/${agent}/view/history?limit=50&before=${p1.data.older}`);
check(p2.data.messages.some((m) => m.id === user.id) && !p2.data.messages.some((m) => m.id === p1.data.older) && p2.data.older === null, 'the page before it reaches the first prompt, and ends there');

// Only the human sends: an agent's token with a forged x-stam-human header is refused.
const forged = { ...agentHeaders, 'x-stam-human': '1' };
for (const [what, body] of [
  ['prompt', { text: 'hi' }],
  ['interrupt', {}],
  ['permission', { request: 'per_x', decision: 'once' }],
]) {
  const r = await call('POST', `/api/agents/${agent}/view/${what}`, body, forged);
  check(r.status === 403, `a forged ${what} is refused`);
}

// Send, then watch the reply stream in.
const n0 = v.events.length;
const sent = await call('POST', `/api/agents/${agent}/view/prompt`, { text: 'Write the numbers one to thirty in English words, one per line, then the line END. Nothing else, no tools.' });
check(sent.status === 200, 'prompt sent');
await until('running', () => v.events.slice(n0).find((e) => e.type === 'status' && e.running));
const end = await until(
  'the streamed reply',
  () => v.events.slice(n0).find((e) => e.type === 'message' && e.message.role === 'assistant' && /END/.test(texts(e.message))),
  120,
);
const growing = v.events.slice(n0).filter((e) => e.type === 'message' && e.message.id === end.message.id && texts(e.message).length > 0);
check(growing.length >= 2 && texts(growing[0].message).length < texts(end.message).length, `the reply arrived in ${growing.length} growing updates`);
await until('idle again', () => v.events.slice(n0).find((e) => e.type === 'status' && e.running === false), 60);
const userEcho = await until('the prompt in the stream', () => v.events.slice(n0).find((e) => e.type === 'message' && e.message.role === 'user' && /thirty/.test(texts(e.message))), 10);
check(userEcho, 'the sent prompt shows as a user message');

// Interrupt a turn that runs a long command.
const n1 = v.events.length;
await call('POST', `/api/agents/${agent}/view/prompt`, { text: 'Run the shell command `sleep 45` (not in the background), then reply done.' });
await until('the sleep to start', () => v.events.slice(n1).find((e) => e.type === 'message' && e.message.parts.some((p) => p.type === 'tool' && p.status === 'running')), 90);
const t0 = Date.now();
const stop = await call('POST', `/api/agents/${agent}/view/interrupt`);
check(stop.status === 200 && stop.data.stopped === true, 'interrupt answered stopped');
await until('the turn to stop', () => v.events.slice(n1).find((e) => e.type === 'status' && e.running === false), 20);
check(Date.now() - t0 < 20_000, `stopped in ${Date.now() - t0} ms, long before the sleep ends`);
const marker = await until('an interrupted marker', () => v.events.slice(n1).find((e) => e.type === 'message' && e.message.kind === 'interrupted'), 10);
check(marker, 'the view shows the turn as interrupted');
v.close();
console.log('done');
process.exit(0);
