#!/usr/bin/env node
// read_mail that times out on the client loses no mail (S-357), run by test/e2e-read-mail.sh against a
// throwaway daemon. The daemon holds an agent's read route past the MCP client's timeout, so the read
// times out client-side while the daemon still handles it; the mail it handed out stays owed until a
// later read acknowledges the batch. Waits on state (unread mail, the daemon's inbox), never the clock.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const home = process.env.STAM_HOME;
const base = process.env.STAM_URL;
const token = readFileSync(join(home, 'token'), 'utf8').trim();
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};
const check = (cond, msg) => (cond ? console.log(`PASS: ${msg}`) : fail(msg));

// Calls as the human (the test's setup and the raw daemon calls of the second client).
async function http(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-stam-human': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${data?.error ?? res.status}`);
  return data;
}
// Waits until `cond` holds, polling the daemon's state.
async function until(cond, what) {
  for (let i = 0; i < 100; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  fail(`timed out waiting for ${what}`);
}

const sender = await http('POST', '/api/register', { name: 'sender' });
const reader = await http('POST', '/api/register', { name: 'reader' });
const stamp = Date.now();
const send = async (agent, subject) => (await http('POST', '/api/mail', { from: 'sender', to: [agent], new_thread: true, subject, body: `Body of ${subject}` })).id;
const unreadIds = async (agent) => (await http('GET', `/api/agents/${agent}/inbox?unread=1&limit=50`)).map((m) => m.id);
// The mail ids a read_mail text names, in order.
const idsIn = (text) => [...text.matchAll(/^## (\S+):/gm)].map((m) => m[1]);

// The agent's own MCP calls, as a stam agent makes them: its id in its environment.
process.env.STAM_AGENT_ID = reader.id;
const mcp = await import('../src/mcp.ts');
const readMail = (args = {}) => mcp.callTool('read_mail', args).then((r) => r.content[0].text);
// A read the daemon holds past the client's timeout: the client gets the timeout error.
async function timedOutRead(args) {
  await http('POST', '/api/test/read-hold', { agent: reader.id, action: 'hold' });
  const err = await readMail(args).then(
    () => null,
    (e) => e,
  );
  check(err && /abort|timeout/i.test(err.message), 'the held read times out on the client');
  await http('POST', '/api/test/read-hold', { agent: reader.id, action: 'release' });
}

// 1. More than 10 mail, read with a timed-out read: the daemon hands out 10, which stay owed. The next
// read returns those 10 (oldest first), then the rest once they are acknowledged.
const old = [];
for (let i = 1; i <= 12; i++) old.push(await send(reader.name, `Old ${i} ${stamp}`));
await timedOutRead();
await until(async () => (await unreadIds(reader.id)).length === 2, 'the daemon to mark the 10 read mail');
const second = idsIn(await readMail());
check(JSON.stringify(second) === JSON.stringify(old.slice(0, 10)), 'the next read returns the 10 owed mail, oldest first, and no unread mail beyond 10');
const third = idsIn(await readMail());
check(JSON.stringify(third) === JSON.stringify(old.slice(10)), 'the read after acknowledges the batch and returns the 2 unread mail, oldest first');
check((await readMail()) === 'No unread mail.', 'once acknowledged, nothing is handed out again');

// 2. Explicit ids return exactly those, not the owed mail; owed mail comes back on the next read, ahead of
// older unread mail.
const older = await send(reader.name, `Older unread ${stamp}`);
const n1 = await send(reader.name, `Explicit one ${stamp}`);
const n2 = await send(reader.name, `Owed explicit ${stamp}`);
await timedOutRead({ ids: [n2] });
await until(async () => !(await unreadIds(reader.id)).includes(n2), 'the daemon to mark n2 read');
const explicit = idsIn(await readMail({ ids: [n1] }));
check(JSON.stringify(explicit) === JSON.stringify([n1]), 'explicit ids return exactly those mail, not the owed mail');
const withOwed = idsIn(await readMail());
check(JSON.stringify(withOwed) === JSON.stringify([n2, older]), 'owed mail comes first, ahead of an older unread mail');
check((await readMail()) === 'No unread mail.', 'nothing left after those are acknowledged');

// 3. Two clients for one agent (raw daemon calls, each with its own batches). A batch's acknowledgement
// retires its mail whichever client was handed it again, so nothing stays owed.
const q1 = await send(reader.name, `Two clients ${stamp}`);
const a1 = await http('POST', `/api/agents/${reader.id}/read`, { batch: 'client-a-1' });
check(a1.map((m) => m.id).join() === q1, 'client A gets the mail in its batch');
const b1 = await http('POST', `/api/agents/${reader.id}/read`, { batch: 'client-b-1' });
check(b1.map((m) => m.id).join() === q1, 'client B is handed the same mail while A still owes it');
const a2 = await http('POST', `/api/agents/${reader.id}/read`, { batch: 'client-a-2', ack: 'client-a-1' });
check(a2.length === 0, "A's acknowledgement retires the mail, even though B was handed it too");
const b2 = await http('POST', `/api/agents/${reader.id}/read`, { batch: 'client-b-2', ack: 'client-b-1' });
check(b2.length === 0, 'nothing is handed out again to B after A acknowledged');

// 4. A failure part-way through a read leaves no half state: a test route makes the delivery insert fail after
// the read state was written, so the read is refused and the mail stays unread, owed to nobody.
const injected = await send(reader.name, `Injected ${stamp}`);
await http('POST', '/api/test/delivery-fail', { fail: true });
const refused = await http('POST', `/api/agents/${reader.id}/read`, { ids: [injected], batch: 'injected-1' }).then(
  () => null,
  (e) => e,
);
check(refused && /injected/.test(refused.message), 'a read whose delivery fails is refused');
check((await unreadIds(reader.id)).includes(injected), 'the mail stays unread after the refused read');
await http('POST', '/api/test/delivery-fail', { fail: false });
check(idsIn(await readMail({ ids: [injected] })).join() === injected, 'once the failure is gone, the mail is read and handed out');
