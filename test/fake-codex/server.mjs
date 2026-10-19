// A scripted fake of Codex's app-server (codex-cli 0.162.1's protocol, JSON-RPC over a
// WebSocket on a unix socket), enough for stam's Codex adapter and its view
// (src/adapters/codex.ts, codex-view.ts): requests get scripted answers, and the test
// pushes notifications and server requests (approvals) to every client, as the real
// app-server does. No model. Every request a client sends is logged, for assertions.
//
//   const fake = await startFakeCodex(sockPath, { responses: { 'thread/read': (p) => ({...}) } });
//   fake.notify('turn/started', {...});            // to every client
//   const reply = fake.request('item/commandExecution/requestApproval', {...}); // resolves with the client's reply
//   fake.log                                        // [{ method, params }] of client requests
//   await fake.close();
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const defaults = {
  initialize: () => ({ userAgent: 'fake-codex', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' }),
  'thread/resume': (p) => ({ thread: { id: p.threadId }, model: 'gpt-6.1-sol', approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' } }),
  'thread/read': (p) => ({ thread: { id: p.threadId, turns: [] } }),
  'thread/turns/list': () => ({ data: [], nextCursor: null, backwardsCursor: null }),
  'thread/loaded/list': () => ({ data: [] }),
  'turn/start': () => ({ turn: { id: 'turn-started', items: [], status: 'inProgress' } }),
  'turn/steer': (p) => ({ turnId: p.expectedTurnId }),
  'turn/interrupt': () => ({}),
  'account/rateLimits/read': () => ({ rateLimits: {} }),
};

export async function startFakeCodex(sock, script = {}) {
  const responses = { ...defaults, ...(script.responses ?? {}) };
  const log = [];
  const clients = new Set();
  const awaiting = new Map(); // server request id -> resolve(reply)
  let nextId = 1000;
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  const send = (ws, msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ jsonrpc: '2.0', ...msg }));

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('message', async (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.method && m.id !== undefined) {
        log.push({ method: m.method, params: m.params });
        const handler = responses[m.method];
        try {
          const result = handler ? await handler(m.params ?? {}) : {};
          send(ws, { id: m.id, result });
        } catch (e) {
          send(ws, { id: m.id, error: { code: -32000, message: String(e.message ?? e) } });
        }
      } else if (m.method) {
        log.push({ method: m.method, params: m.params });
      } else if (m.id !== undefined) {
        awaiting.get(m.id)?.(m);
        awaiting.delete(m.id);
      }
    });
  });
  await new Promise((resolve) => http.listen(sock, resolve));

  return {
    log,
    // A notification to every client.
    notify(method, params) {
      for (const ws of clients) send(ws, { method, params });
    },
    // A server request (an approval) to every client; resolves with the first reply, and
    // carries its JSON-RPC id.
    request(method, params) {
      const id = nextId++;
      for (const ws of clients) send(ws, { id, method, params });
      const reply = new Promise((resolve) => awaiting.set(id, resolve));
      return Object.assign(reply, { id });
    },
    async close() {
      for (const ws of clients) ws.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => http.close(resolve));
    },
  };
}
