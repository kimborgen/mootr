// `stam mcp-proxy NAME`: a stdio MCP server that bridges to a remote streamable-HTTP MCP
// server, adding the `Authorization: Bearer` the daemon holds for NAME (mcp-auth.ts). Every
// adapter writes an `auth` server as this command, so one login serves every harness and the
// token never reaches a harness config, the environment, or a command line.
//
// Newline-delimited JSON-RPC arrives on stdin; each message is POSTed to the server and its
// JSON or SSE answer is written back as one line per message. The server's `Mcp-Session-Id`
// is kept once it gives one. A 401 asks the daemon for a refreshed token once and retries.
import { api } from './client.ts';
import { envVar } from './env.ts';

interface Credential {
  url: string;
  token: string;
  expires_at: number | null;
}

const writeLine = (line: string) => process.stdout.write(line + '\n');

export function runMcpProxy(name: string): void {
  let cred: Credential | undefined;
  let sessionId: string | undefined;
  const agent = envVar('AGENT_ID') ?? '';

  async function credential(refresh = false): Promise<Credential> {
    if (!refresh && cred && (cred.expires_at == null || Date.now() < cred.expires_at - 60_000)) return cred;
    const q = new URLSearchParams({ agent });
    if (refresh) q.set('refresh', '1');
    cred = await api<Credential>('GET', `/api/mcp/${encodeURIComponent(name)}/token?${q}`);
    return cred;
  }

  async function post(msg: unknown, c: Credential): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${c.token}`,
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    // A redirect is never followed: the bearer must reach the configured server itself.
    return fetch(c.url, { method: 'POST', redirect: 'manual', headers, body: JSON.stringify(msg) });
  }

  // Writes a response body: a JSON message as one line, an SSE stream as one line per
  // `data:` message. A 202 (a notification) has nothing to write.
  async function emit(res: Response): Promise<void> {
    if (res.status === 202) return;
    const text = await res.text();
    if (!text.trim()) return;
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
        if (data) writeLine(data);
      }
      return;
    }
    const t = text.trim();
    try {
      writeLine(JSON.stringify(JSON.parse(t)));
    } catch {
      writeLine(t);
    }
  }

  async function forward(msg: any): Promise<void> {
    let res = await post(msg, await credential());
    if (res.status === 401) res = await post(msg, await credential(true));
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      if (msg && msg.id !== undefined) writeLine(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `MCP server ${name}: HTTP ${res.status}${detail ? ` ${detail.slice(0, 200)}` : ''}` } }));
      return;
    }
    await emit(res);
  }

  let buf = '';
  let chain: Promise<void> = Promise.resolve();
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      // One message at a time, so the initialize handshake and its session id land first.
      chain = chain.then(() => forward(msg)).catch((e) => {
        if (msg?.id !== undefined) writeLine(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: String(e instanceof Error ? e.message : e) } }));
      });
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
