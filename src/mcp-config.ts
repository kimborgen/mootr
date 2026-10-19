// Paste any harness's normal MCP config and get stam's stored form back (S-51). The parsers
// live here so the settings UI and the import feature (S-52) share them. Each harness writes
// its servers differently; the shapes below are the ones in the wild:
//
//   Claude Code / .mcp.json  { "mcpServers": { "name": { "type": "http"|"sse"|"stdio",
//                              "command", "args", "env", "url", "headers" } } }, or the
//                              bare { "name": {...} } map.
//   Codex                    [mcp_servers.name] tables with command, args, env, url,
//                              http_headers, bearer_token_env_var, env_http_headers.
//   OpenCode                 { "mcp": { "name": { "type": "local"|"remote", "command": [],
//                              "environment", "url", "headers" } } }, also under mcp.servers.
//
// Everything lands in McpServer (instructions.ts), which every harness translates from. A
// value only an environment variable holds at run time (Codex's bearer_token_env_var and
// env_http_headers) can't be carried, so it is reported as a note instead.
import { spawn } from 'node:child_process';
import * as mcpAuth from './mcp-auth.ts';
import type { McpServer } from './instructions.ts';

export interface ParsedMcp {
  servers: Record<string, McpServer>;
  // What couldn't be carried as-is, for the UI to show beside the preview.
  notes: string[];
}

// One server as it was found, with the name it was under. The note is a caveat about that
// server alone (an env var it needs, or an SSE url), for the preview to show beside it.
export interface ParsedServer {
  name: string;
  server: McpServer;
  note?: string;
}

const SSE_NOTE = "stam connects over streamable HTTP; use the server's /mcp URL if it has one";
export { SSE_NOTE };

const isObj = (v: unknown): v is Record<string, any> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const strMap = (o: Record<string, any>): Record<string, string> => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)]));

// Anything that looks like one server, from any harness: a local command (a string with
// args, or OpenCode's array) or a remote url, plus its env and headers.
function toServer(entry: unknown): McpServer | null {
  if (!isObj(entry)) return null;
  const s: McpServer = {};
  if (typeof entry.command === 'string') s.command = entry.command;
  else if (Array.isArray(entry.command) && entry.command.length) {
    s.command = String(entry.command[0]);
    if (entry.command.length > 1) s.args = entry.command.slice(1).map(String);
  }
  if (!s.args && Array.isArray(entry.args)) s.args = entry.args.map(String);
  const env = entry.env ?? entry.environment;
  if (isObj(env)) s.env = strMap(env);
  if (typeof entry.url === 'string') s.url = entry.url;
  const headers = { ...(isObj(entry.headers) ? strMap(entry.headers) : {}), ...(isObj(entry.http_headers) ? strMap(entry.http_headers) : {}) };
  if (Object.keys(headers).length) s.headers = headers;
  if (entry.enabled === false) s.enabled = false;
  if (!s.command && !s.url) return null;
  return s;
}

// An SSE server is announced by its `type` or its url; stam reaches it over streamable HTTP,
// so the preview says to use the /mcp url when there is one.
const isSse = (entry: any, s: McpServer) => entry?.type === 'sse' || /\/sse\/?$/.test(s.url ?? '');

// One JSON-style server map, in any harness's shape, into stam's form.
function serversFromMap(map: Record<string, any>): ParsedServer[] {
  const out: ParsedServer[] = [];
  for (const [name, entry] of Object.entries(map)) {
    const s = toServer(entry);
    if (s) out.push({ name, server: s, ...(isSse(entry, s) ? { note: `${name}: ${SSE_NOTE}` } : {}) });
  }
  return out;
}

const looksLikeServer = (v: any) => isObj(v) && ['command', 'url', 'type', 'args', 'env', 'environment', 'headers'].some((k) => k in v);

// The server map in a JSON config: Claude's mcpServers, OpenCode's mcp (or mcp.servers),
// Codex's mcp_servers written as JSON, or a bare { name: server } map.
export function serversFromJson(json: any): ParsedServer[] {
  if (isObj(json?.mcpServers)) return serversFromMap(json.mcpServers);
  if (isObj(json?.mcp?.servers)) return serversFromMap(json.mcp.servers);
  if (isObj(json?.mcp)) return serversFromMap(json.mcp);
  if (isObj(json?.mcp_servers)) return serversFromMap(json.mcp_servers);
  if (isObj(json) && Object.keys(json).length && Object.values(json).every(looksLikeServer)) return serversFromMap(json);
  return [];
}

// A Codex [mcp_servers.NAME] table, minus what only an env var could carry. Also exported
// for the import scan, which reads a whole config.toml.
export function serversFromToml(text: string): ParsedServer[] {
  const root = parseToml(text);
  const out: ParsedServer[] = [];
  if (!isObj(root.mcp_servers)) return out;
  for (const [name, v] of Object.entries<Record<string, any>>(root.mcp_servers)) {
    if (!isObj(v)) continue;
    const s = toServer(v) ?? {};
    if (!s.command && !s.url) continue;
    const notes: string[] = [];
    if (typeof v.bearer_token_env_var === 'string') notes.push(`authorizes with the ${v.bearer_token_env_var} environment variable; stam stores header values, so set it by hand or choose OAuth`);
    if (isObj(v.env_http_headers) && Object.keys(v.env_http_headers).length) notes.push(`${Object.keys(v.env_http_headers).join(', ')} read a value from the environment at run time; set them by hand or choose OAuth`);
    if (isSse(v, s)) notes.push(SSE_NOTE);
    out.push({ name, server: s, ...(notes.length ? { note: `${name}: ${notes.join('; ')}` } : {}) });
  }
  return out;
}

// --- A tiny TOML reader, enough for the [mcp_servers.*] tables Codex writes ----------------
// Values: strings (basic and literal), arrays, inline tables, booleans, and numbers. Tables
// are nested objects; other top-level tables in a pasted config.toml are parsed and ignored.

// The first `ch` outside quotes, or -1.
function findTop(s: string, ch: string): number {
  let q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '\\' && q === '"') i++; else if (c === q) q = ''; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === ch) return i;
  }
  return -1;
}

// The index of the quote closing the string opened at `start` (s[start] is the quote).
function endQuote(s: string, start: number): number {
  const q = s[start];
  for (let i = start + 1; i < s.length; i++) {
    if (q === '"' && s[i] === '\\') { i++; continue; }
    if (s[i] === q) return i;
  }
  return s.length;
}

// The index of the `close` matching the `open` at `start`, or the string's end.
function matching(s: string, start: number, open: string, close: string): number {
  let depth = 0;
  let q = '';
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '\\' && q === '"') i++; else if (c === q) q = ''; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return i;
  }
  return s.length;
}

// Split on `sep` outside quotes and brackets (for arrays and inline tables).
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let buf = '';
  let depth = 0;
  let q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '\\' && q === '"') { buf += c + s[++i]; continue; } if (c === q) q = ''; buf += c; continue; }
    if (c === '"' || c === "'") { q = c; buf += c; continue; }
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    if (c === sep && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

// A key path: mcp_servers.name, "my server", a."b.c". Quotes are stripped, escapes ignored.
function splitKey(s: string): string[] {
  const out: string[] = [];
  let buf = '';
  let q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = ''; else buf += c; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '.') { out.push(buf.trim()); buf = ''; continue; }
    buf += c;
  }
  out.push(buf.trim());
  return out.filter((x) => x !== '');
}

function stripComment(line: string): string {
  const i = findTop(line, '#');
  return i < 0 ? line : line.slice(0, i);
}

function parseValue(s: string): any {
  s = s.trim();
  if (!s) return undefined;
  if (s[0] === '[') return splitTop(s.slice(1, matching(s, 0, '[', ']')), ',').map((p) => parseValue(p)).filter((v) => v !== undefined);
  if (s[0] === '{') {
    const out: Record<string, any> = {};
    for (const part of splitTop(s.slice(1, matching(s, 0, '{', '}')), ',')) {
      const eq = findTop(part, '=');
      if (eq >= 0) out[splitKey(part.slice(0, eq))[0]] = parseValue(part.slice(eq + 1));
    }
    return out;
  }
  if (s[0] === '"') {
    const inner = s.slice(1, endQuote(s, 0));
    return inner.replace(/\\(["\\nrtbf/])/g, (_, c: string) => ({ '"': '"', '\\': '\\', n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '/': '/' }[c] ?? c)).replace(/\\u([\da-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  if (s[0] === "'") return s.slice(1, endQuote(s, 0));
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^[-+]?[\d_]+(\.[\d_]+)?([eE][-+]?\d+)?$/.test(s)) return Number(s.replace(/_/g, ''));
  return s;
}

export function parseToml(text: string): Record<string, any> {
  const root: Record<string, any> = {};
  let table = root;
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    if (line.startsWith('[')) {
      table = splitKey(line.replace(/^\[+/, '').replace(/\]+$/, '')).reduce((o, k) => (o[k] ??= {}), root);
      continue;
    }
    const eq = findTop(line, '=');
    if (eq < 0) continue;
    const key = splitKey(line.slice(0, eq));
    const value = parseValue(line.slice(eq + 1));
    let target = table;
    for (const k of key.slice(0, -1)) target = (target[k] ??= {});
    target[key[key.length - 1]] = value;
  }
  return root;
}

// TOML is a table header, a top-level key = value, or a nested [table] later in the text.
function isToml(t: string): boolean {
  if (t[0] === '{') return false;
  return t[0] === '[' || /^[A-Za-z0-9_.'"-]+\s*=/.test(t) || /\n\s*\[/.test(t);
}

// Parse pasted text from any harness into stam's stored form. Throws with a plain reason
// when there is no config to read.
export function parseMcpConfig(text: string): ParsedMcp {
  const t = text.trim();
  if (!t) throw new Error('Paste an MCP server config.');
  const found = isToml(t) ? serversFromToml(t) : (() => {
    let json: any;
    try {
      json = JSON.parse(t);
    } catch {
      throw new Error('That is neither JSON nor a Codex TOML config.');
    }
    return serversFromJson(json);
  })();
  if (!found.length) throw new Error(isToml(t) ? 'No mcp_servers tables found.' : 'No MCP servers found in that config.');
  const servers: Record<string, McpServer> = {};
  const notes: string[] = [];
  for (const f of found) {
    servers[f.name] = f.server;
    if (f.note) notes.push(f.note);
  }
  return { servers, notes };
}

const PROTOCOL = '2025-06-18';
const rpc = (id: number, method: string, params: unknown) => ({ jsonrpc: '2.0', id, method, params });

// One JSON-RPC message from a response body: plain JSON, or the message in an SSE stream.
function readMessage(text: string, contentType: string): any {
  if (contentType.includes('text/event-stream')) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      if (!data) continue;
      try {
        const m = JSON.parse(data);
        if (m.id !== undefined) return m;
      } catch {}
    }
    return undefined;
  }
  const t = text.trim();
  return t ? JSON.parse(t) : undefined;
}

// Spawn a stdio server, initialize, and list its tools. The child is killed by PID once the
// answer arrives or after five seconds.
function testStdio(command: string, args: string[], env: Record<string, string>): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    let stderr = '';
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch {}
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error('No answer within 5 seconds.'))), 5000);
    child.on('error', (e) => finish(() => reject(e)));
    child.on('exit', (code) => finish(() => reject(new Error(stderr.trim() || `the server exited (${code})`))));
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1 && msg.error) finish(() => reject(new Error(msg.error.message || 'initialize failed')));
        if (msg.id === 2) {
          if (msg.error) finish(() => reject(new Error(msg.error.message || 'tools/list failed')));
          else finish(() => resolve((msg.result?.tools ?? []).map((t: any) => String(t.name))));
        }
      }
    });
    const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + '\n');
    send(rpc(1, 'initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'stam', version: '2' } }));
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send(rpc(2, 'tools/list', {}));
  });
}

// Initialize and list tools on a remote server over streamable HTTP, with the stored bearer
// for an `auth` server.
async function testRemote(name: string, url: string, headers: Record<string, string>, authorized: boolean): Promise<string[]> {
  const h: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers };
  if (authorized) h.authorization = `Bearer ${await mcpAuth.token(name)}`;
  const post = async (body: unknown): Promise<Response> => {
    // A redirect is never followed: the bearer must reach the configured server itself.
    const res = await fetch(url, { method: 'POST', redirect: 'manual', headers: h, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    if (!res.ok && res.status !== 202) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 160)}`.trim());
    return res;
  };
  const init = await post(rpc(1, 'initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'stam', version: '2' } }));
  const session = init.headers.get('mcp-session-id');
  if (session) h['mcp-session-id'] = session;
  const first = readMessage(await init.text(), init.headers.get('content-type') ?? '');
  if (first?.error) throw new Error(first.error.message || 'initialize failed');
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const listRes = await post(rpc(2, 'tools/list', {}));
  const list = readMessage(await listRes.text(), listRes.headers.get('content-type') ?? '');
  if (list?.error) throw new Error(list.error.message || 'tools/list failed');
  return (list?.result?.tools ?? []).map((t: any) => String(t.name));
}

export interface McpTestResult {
  ok: boolean;
  tools: string[];
  error?: string;
}

// Connect to one configured server and list its tools. Never throws: the failure is the
// `error` in the result the UI shows.
export async function testServer(name: string, server: McpServer): Promise<McpTestResult> {
  try {
    const tools = server.url
      ? await testRemote(name, server.url, server.headers ?? {}, Boolean(server.auth))
      : server.command
        ? await testStdio(server.command, server.args ?? [], server.env ?? {})
        : (() => { throw new Error('The server has no command or url.'); })();
    return { ok: true, tools };
  } catch (e) {
    return { ok: false, tools: [], error: e instanceof Error ? e.message : String(e) };
  }
}
