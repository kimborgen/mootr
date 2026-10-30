import { createHash } from 'node:crypto';
import { STAM_URL, readToken } from './config.ts';
import { envVar } from './env.ts';

// A mail or a post can wait on the daemon's mail check and title generation, so under load it takes
// longer than the 10 s default; past it the client gave up while the daemon still delivered (S-1663).
export const WRITE_CALL_MS = 60_000;

// A cost_switch of an idle agent returns after the successor started (up to its 3-minute startup), so its
// call waits longer than the 10 s default; past it the client gave up while the daemon went on (S-923).
export const SWITCH_CALL_MS = 240_000;

// The `client_id` of a write an agent might retry after a timeout (src/client-dedup.ts). It comes from
// what the write says, not from the call, because the retry is a new tool call: the same sender
// saying the same thing to the same place within 5 minutes is the same write, and its repeat gets
// the first one's answer (the mail id) instead of a duplicate.
export const writeId = (...parts: unknown[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);

// The calls a script makes as what it is, not as the human (S-601): a write naming a system sender
// (`--system deploy-watch`), the health check, an ITSA read, and the agents list. They send no x-stam-human, so under
// auth.humanStrict the daemon doesn't log them as the human from a shared caller.
export function asSystem(method: string, path: string, body?: unknown): boolean {
  // `as_system` on the ITSA routes and `system` on mail only: an ITSA link's `system` is its kind.
  if (body && typeof body === 'object') {
    if ((body as any).as_system && path.startsWith('/api/itsas')) return true;
    if ((body as any).system && method === 'POST' && path === '/api/mail') return true;
  }
  // GET /api/agents ignores who asks (S-991): `stam ls` and the deploy's capPins logged a refusal each.
  // So do an ITSA's incident mark and its about-mails, which every waiting merge-pr worker reads (S-4356).
  return method === 'GET' && /^\/api\/(health|agents|itsas\/[\w-]+(\/(incident|about-mails))?)(\?|$)/.test(path);
}

export async function api<T = any>(method: string, path: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
  const res = await fetch(STAM_URL + path, {
    method,
    headers: {
      authorization: `Bearer ${readToken() ?? ''}`,
      'content-type': 'application/json',
      // The CLI speaks for the human, except when an agent runs it or it is the MCP server
      // (`stam mcp` alone, whose calls act as the agent; `stam mcp login|logout|status` is
      // the human managing a shared login).
      ...(envVar('AGENT_ID') || (process.argv[2] === 'mcp' && process.argv[3] === undefined) || asSystem(method, path, body) ? {} : { 'x-stam-human': '1' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = (await res.json()) as any;
  // Under auth.humanStrict the daemon refuses the CLI as the human and says where to answer (S-543).
  if (res.status === 403 && data?.hint) data.error = `${data.error}; ${data.hint}`;
  if (!res.ok) throw Object.assign(new Error(data?.error ?? `HTTP ${res.status}`), { status: res.status });
  return data as T;
}
