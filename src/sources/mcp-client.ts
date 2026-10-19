// A small MCP client the daemon's pollers use to call a remote server's tools (S-56): the
// streamable-HTTP transport, `initialize`, `notifications/initialized`, and `tools/call`. The
// bearer comes from the daemon's own login store (mcp-auth.tokenFor), so no harness and no
// command line ever holds it. Redirects are never followed, and one 401 asks for a refreshed
// token and retries. The stdio side for agents is mcp-proxy.ts; this is the same protocol run
// in the daemon, with the same JSON or SSE answers.
import { tokenFor } from '../mcp-auth.ts';

// The Mcp-Session-Id each server gave, by server name. Absent until initialized.
const sessions = new Map<string, string | null>();
let nextId = 1;

const headers = (token: string, sid: string | null | undefined): Record<string, string> => ({
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  authorization: `Bearer ${token}`,
  ...(sid ? { 'mcp-session-id': sid } : {}),
});

async function post(url: string, token: string, body: unknown, sid?: string | null): Promise<Response> {
  return fetch(url, { method: 'POST', redirect: 'manual', headers: headers(token, sid), body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
}

// The JSON-RPC answer to `id`: a JSON body, or the SSE data line that carries it.
async function answer(res: Response, id: number): Promise<any> {
  const text = await res.text();
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('\n');
      if (!data) continue;
      try {
        const msg = JSON.parse(data);
        if (msg.id === id) return msg;
      } catch {
        // Not a JSON message; keep reading the stream.
      }
    }
    throw new Error('no answer in the event stream');
  }
  return JSON.parse(text);
}

// Initializes a session with a server, once. A server without a session id runs sessionless.
async function initialize(name: string, url: string, token: string): Promise<string | null> {
  const id = nextId++;
  const res = await post(url, token, { jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stam', version: '1' } } });
  if (!res.ok) throw new Error(`${name}: initialize HTTP ${res.status}`);
  const sid = res.headers.get('mcp-session-id');
  const msg = await answer(res, id);
  if (msg.error) throw new Error(`${name}: initialize: ${msg.error.message ?? 'error'}`);
  // The initialized notification has no answer; a 202 is the normal reply.
  await post(url, token, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid).then((r) => r.arrayBuffer().catch(() => {}));
  sessions.set(name, sid);
  return sid;
}

// Calls one tool on the named MCP server and returns its `result` (its content holds the
// text the tool answered with). Throws when the server, its login, or the tool fails.
export async function callTool(name: string, tool: string, args: Record<string, unknown>): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const cred = await tokenFor(name, { refresh: attempt > 0 });
    const sid = sessions.has(name) ? sessions.get(name) : await initialize(name, cred.url, cred.token);
    const id = nextId++;
    const res = await post(cred.url, cred.token, { jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: args } }, sid);
    // A 401 refreshes the token once; a 404 means the session expired, so it starts over once.
    if ((res.status === 401 || res.status === 404) && attempt === 0) {
      await res.arrayBuffer().catch(() => {});
      if (res.status === 404) sessions.delete(name);
      continue;
    }
    if (!res.ok) throw new Error(`${name} ${tool}: HTTP ${res.status}`);
    const msg = await answer(res, id);
    if (msg.error) throw new Error(`${name} ${tool}: ${msg.error.message ?? 'error'}`);
    if (msg.result?.isError) throw new Error(`${name} ${tool}: ${textOf(msg.result) || 'the tool failed'}`);
    return msg.result;
  }
}

// The text of a tool result's text content, joined.
export function textOf(result: any): string {
  return (Array.isArray(result?.content) ? result.content : [])
    .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
    .map((c: any) => c.text)
    .join('\n');
}

// The JSON a tool answered with, or null when its text isn't JSON.
export function jsonOf(result: any): any {
  const text = textOf(result).trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// For tests: forget every session, so the next call initializes again.
export function resetSessions(): void {
  sessions.clear();
}
