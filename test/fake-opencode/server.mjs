// A scripted fake of OpenCode v2.0.26's server, enough for stam's OpenCode adapter and its
// view (src/adapters/opencode.ts, opencode-view.ts): sessions, stored messages paged newest
// first with the message cursor, the event stream, prompts, permission replies, and
// interrupts. Shapes as test/fixtures/opencode-view.json records them. No model: a prompt
// gets the reply "Got it: TEXT". Run through test/fake-opencode/opencode:
//   opencode serve --hostname 127.0.0.1 --port PORT
// Tests seed a conversation with POST /__fake/seed {session, messages (oldest first),
// permissions, active}.
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1] || 4790);
const sessions = new Map(); // id -> { info, messages (oldest first), permissions, active }
const clients = new Set();
let n = 0;
const id = (p) => `${p}_fake${String(++n).padStart(6, '0')}`;
const now = () => Date.now();

function session(sid) {
  if (!sessions.has(sid)) sessions.set(sid, { info: { id: sid, title: sid }, messages: [], permissions: [], active: false });
  return sessions.get(sid);
}
function emit(type, data) {
  const line = `data: ${JSON.stringify({ type, data })}\n\n`;
  for (const r of clients) r.write(line);
}
const tick = () => new Promise((r) => setTimeout(r, 20));

// A prompt's turn: the user's message, then a short reply streamed as OpenCode streams it.
async function turn(sid, text) {
  const s = session(sid);
  s.messages.push({ id: id('msg'), type: 'user', text, time: { created: now() } });
  s.active = true;
  emit('session.execution.started', { sessionID: sid });
  emit('session.inbox.delivered', { sessionID: sid });
  await tick();
  const m = { id: id('msg'), type: 'assistant', content: [], time: { created: now() } };
  s.messages.push(m);
  const reply = `Got it: ${text}`;
  emit('session.text.started', { sessionID: sid, assistantMessageID: m.id, ordinal: 0 });
  for (const w of reply.split(/(?<= )/)) {
    emit('session.text.delta', { sessionID: sid, assistantMessageID: m.id, ordinal: 0, delta: w });
    await tick();
  }
  m.content.push({ type: 'text', text: reply });
  m.time.completed = now();
  emit('session.text.ended', { sessionID: sid, assistantMessageID: m.id, ordinal: 0, text: reply });
  finish(sid, m, 'succeeded');
}
function finish(sid, m, how) {
  const s = session(sid);
  s.active = false;
  if (m) emit('session.step.ended', { sessionID: sid, assistantMessageID: m.id });
  emit(`session.execution.${how}`, { sessionID: sid });
}

function page(s, u) {
  let list = [...s.messages].reverse();
  const type = u.searchParams.get('type');
  if (type) list = list.filter((m) => m.type === type);
  const cursor = u.searchParams.get('cursor');
  if (cursor) {
    const c = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    list = list.slice(list.findIndex((m) => m.id === c.id) + 1);
  }
  return list.slice(0, Number(u.searchParams.get('limit') ?? 50));
}

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const json = body ? JSON.parse(body) : {};
    const p = u.pathname.split('/').filter(Boolean); // api, session, ID, ...
    const send = (data) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data })); };
    if (u.pathname === '/api/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(': hello\n\n');
      clients.add(res);
      return res.on('close', () => clients.delete(res));
    }
    if (u.pathname === '/__fake/seed') {
      const s = session(json.session);
      Object.assign(s, { messages: json.messages ?? [], permissions: json.permissions ?? [], active: !!json.active });
      return send({ ok: true });
    }
    if (u.pathname === '/api/session' && req.method === 'POST') {
      const sid = id('ses');
      session(sid).info = { id: sid, title: json.title, directory: json.location?.directory };
      return send(session(sid).info);
    }
    if (u.pathname === '/api/session') return send([]);
    if (u.pathname === '/api/session/active') return send(Object.fromEntries([...sessions].filter(([, s]) => s.active).map(([k]) => [k, { type: 'busy' }])));
    if (p[0] === 'api' && p[1] === 'session' && p[2]) {
      const sid = p[2], s = session(sid);
      if (!p[3]) return send(s.info);
      if (p[3] === 'message') return send(page(s, u));
      if (p[3] === 'permission' && !p[4]) return send(s.permissions);
      if (p[3] === 'prompt') { send({}); return turn(sid, String(json.text ?? '')); }
      if (p[3] === 'interrupt') {
        send({});
        const m = s.messages.findLast((x) => x.type === 'assistant' && !x.time.completed);
        if (m) m.time.completed = now();
        for (const x of s.permissions) emit('permission.replied', { sessionID: sid, requestID: x.id, reply: 'reject' });
        s.permissions = [];
        s.messages.push({ id: id('msg'), type: 'idle', outcome: 'interrupted', time: { created: now() } });
        return finish(sid, m, 'interrupted');
      }
      if (p[3] === 'permission' && p[5] === 'reply') {
        send({});
        const perm = s.permissions.find((x) => x.id === p[4]);
        s.permissions = s.permissions.filter((x) => x.id !== p[4]);
        emit('permission.replied', { sessionID: sid, requestID: p[4], reply: json.decision });
        const m = s.messages.find((x) => x.id === perm?.source?.messageID);
        const tool = m?.content.find((c) => c.type === 'tool' && c.id === perm?.source?.id);
        if (!m || !tool) return;
        await tick();
        const ok = json.decision !== 'reject';
        tool.state = { ...tool.state, status: ok ? 'completed' : 'error', ...(ok ? { content: [{ type: 'text', text: 'removed build/' }] } : { error: { message: 'The user rejected permission' } }) };
        emit(ok ? 'session.tool.success' : 'session.tool.failed', { sessionID: sid, assistantMessageID: m.id, id: tool.id, ...(ok ? { content: tool.state.content } : { error: tool.state.error }) });
        m.content.push({ type: 'text', text: ok ? 'Removed the build folder.' : 'Left the build folder alone.' });
        m.time.completed = now();
        return finish(sid, m, 'succeeded');
      }
      return send({});
    }
    if (u.pathname === '/api/shell') return send([]);
    send({});
  });
});
server.listen(port, '127.0.0.1');
