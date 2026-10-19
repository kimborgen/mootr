// OAuth logins for remote MCP servers (S-50). The daemon holds the token and refreshes it;
// every harness reaches the server through `stam mcp-proxy NAME` (mcp-proxy.ts), which asks
// the daemon for a fresh bearer. Tokens live only in STAM_HOME/mcp-auth.json (mode 0600),
// never in settings, a harness config, the environment, or a command line.
//
// The flow follows the MCP authorization spec: protected-resource metadata (RFC 9728, from
// a 401's `WWW-Authenticate` or a `/.well-known/oauth-protected-resource`), authorization-
// server metadata (RFC 8414 / OIDC), dynamic client registration (RFC 7591) when no
// client_id is configured, authorization code with PKCE S256 and a single-use `state`, then
// a refresh_token for renewal. A `gh` server reuses the user's `gh auth token` instead.
//
// Discovery is a trust boundary: an attacker who controls one metadata document could aim
// the credential-bearing token and registration calls anywhere. So every endpoint must be
// https and public (no loopback, private, or link-local address), the authorization-server
// metadata's issuer must equal the URL it was fetched for (RFC 8414 §3.3), the protected
// resource must match the server URL's origin and path, and no request may follow a
// redirect. Tests set STAM_MCP_AUTH_INSECURE=1 to allow the fake http loopback servers.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { promisify } from 'node:util';
import { STAM_HOME } from './config.ts';
import { settings } from './settings.ts';
import type { McpAuth } from './instructions.ts';

const execFileAsync = promisify(execFile);
const storeFile = () => join(STAM_HOME, 'mcp-auth.json');
const insecure = () => process.env.STAM_MCP_AUTH_INSECURE === '1';
const trimSlash = (u: string) => u.replace(/\/+$/, '');

// One server's stored login. The client registration is kept beside the tokens so a refresh
// needs no new discovery. `server_url` is the configured MCP url this grant was made for;
// a changed url needs a new login, so a grant's bearer never follows a moved server.
export interface AuthEntry {
  server_url?: string;
  client_id?: string;
  client_secret?: string;
  access_token?: string;
  refresh_token?: string;
  // Milliseconds since the epoch, or absent when the server gave no expires_in.
  expires_at?: number;
  token_endpoint?: string;
  resource?: string;
  scopes?: string[];
}
export type AuthStore = Record<string, AuthEntry>;

export function store(): AuthStore {
  try {
    const s = JSON.parse(readFileSync(storeFile(), 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}

// Writes the whole store mode 0600 (create, then chmod, so an existing file is fixed too).
export function writeStore(s: AuthStore): void {
  writeFileSync(storeFile(), JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  chmodSync(storeFile(), 0o600);
}

// True for a loopback, private, link-local, CGNAT, or otherwise non-global address. An
// unparsable address is refused too.
export function privateIp(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return privateIp(v.slice(7));
  if (v.includes(':')) {
    if (v === '::1' || v === '::') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(v)) return true; // fc00::/7 unique-local
    if (/^fe[89ab][0-9a-f]:/.test(v)) return true; // fe80::/10 link-local
    if (/^ff[0-9a-f]{2}:/.test(v)) return true; // multicast
    return false;
  }
  const p = v.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = p;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return true;
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  return false;
}

// A trust boundary check for every URL discovery or a login will send a bearer to: https
// (unless a test opted out) and a public host. Exported so the tests pin it down.
export async function assertEndpoint(raw: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`not a url: ${raw}`);
  }
  if (insecure()) return;
  if (u.protocol !== 'https:') throw new Error(`MCP auth requires https, not ${u.protocol}//${u.host}`);
  if (isIP(u.hostname)) {
    if (privateIp(u.hostname)) throw new Error(`MCP auth refuses the private address ${u.hostname}`);
    return;
  }
  const addrs = await lookup(u.hostname, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error(`MCP auth can't resolve ${u.hostname}`);
  for (const a of addrs) if (privateIp(a.address)) throw new Error(`MCP auth refuses ${u.hostname} (${a.address})`);
}

// A redirect is never followed: a 3xx is an error, so a moved endpoint can't carry the
// request (and its body, such as a code, verifier, or client secret) elsewhere.
async function fetchJson(url: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(url, { redirect: 'manual', ...init, signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json', ...(init.headers ?? {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return text ? JSON.parse(text) : {};
}

async function postForm(url: string, form: URLSearchParams): Promise<any> {
  await assertEndpoint(url);
  return fetchJson(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
}

// A token endpoint's answer as stam reads it. Slack answers HTTP 200 with `ok: false` and an
// `error` (never echoed beyond that field), and its user token sits under `authed_user`, so
// that is used when the top level has no access_token.
export function tokenResponse(tok: any): any {
  if (tok?.ok === false) throw new Error(`the token endpoint refused: ${String(tok.error ?? 'unknown error').slice(0, 200)}`);
  if (!tok?.access_token && tok?.authed_user?.access_token) {
    const u = tok.authed_user;
    return { access_token: u.access_token, refresh_token: u.refresh_token, expires_in: u.expires_in };
  }
  return tok;
}

async function postJson(url: string, body: unknown): Promise<any> {
  await assertEndpoint(url);
  return fetchJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

// The protected resource's `resource` must match the server URL's origin and path prefix,
// so a metadata document can't point the grant at a different host or a sibling path.
function resourceMatches(prmResource: string, serverUrl: string): boolean {
  try {
    const r = new URL(prmResource);
    const s = new URL(serverUrl);
    if (r.origin !== s.origin) return false;
    const rp = trimSlash(r.pathname);
    const sp = trimSlash(s.pathname);
    return rp === '' || sp === rp || sp.startsWith(rp + '/');
  } catch {
    return false;
  }
}

const pending = new Map<string, { name: string; verifier: string; redirect: string; client_id: string; client_secret?: string; token_endpoint: string; resource: string; scopes: string[]; at: number }>();

// The protected-resource metadata for a server URL: first the 401's `WWW-Authenticate`
// resource_metadata, then `/.well-known/oauth-protected-resource` + its path, then at the
// origin.
async function discover(resourceUrl: string): Promise<any> {
  try {
    const res = await fetch(resourceUrl, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stam', version: '2' } } }),
    });
    if (res.status === 401) {
      const m = /resource_metadata="([^"]+)"/.exec(res.headers.get('www-authenticate') ?? '');
      if (m) {
        await assertEndpoint(m[1]);
        const md = await fetchJson(m[1]).catch(() => undefined);
        if (md?.authorization_servers?.length) return md;
      }
    }
  } catch {}
  const u = new URL(resourceUrl);
  for (const c of [`${u.origin}/.well-known/oauth-protected-resource${u.pathname}`, `${u.origin}/.well-known/oauth-protected-resource`]) {
    const md = await fetchJson(c).catch(() => undefined);
    if (md?.authorization_servers?.length) return md;
  }
  throw new Error(`no OAuth protected-resource metadata for ${resourceUrl}`);
}

// The authorization-server metadata (RFC 8414, falling back to OIDC discovery). Its issuer
// must be the identifier it was fetched for (RFC 8414 §3.3), and every endpoint it names
// must pass the trust-boundary check.
async function authServerMetadata(issuer: string): Promise<any> {
  await assertEndpoint(issuer);
  const base = trimSlash(issuer);
  for (const c of [`${base}/.well-known/oauth-authorization-server`, `${base}/.well-known/openid-configuration`]) {
    const md = await fetchJson(c).catch(() => undefined);
    if (!md?.authorization_endpoint || !md?.token_endpoint) continue;
    if (trimSlash(String(md.issuer ?? '')) !== base) throw new Error(`authorization-server metadata for ${base} claims issuer ${md.issuer}`);
    await assertEndpoint(md.authorization_endpoint);
    await assertEndpoint(md.token_endpoint);
    if (md.registration_endpoint) await assertEndpoint(md.registration_endpoint);
    return md;
  }
  throw new Error(`no OAuth authorization-server metadata for ${issuer}`);
}

const b64url = (buf: Buffer) => buf.toString('base64url');

// Registers stam as a public client with PKCE when no client_id is configured (RFC 7591).
async function registerClient(md: any, redirect: string, scopes: string[]): Promise<{ client_id: string; client_secret?: string }> {
  if (!md.registration_endpoint) throw new Error('the server has no dynamic registration endpoint and no client_id is configured');
  const body: Record<string, unknown> = {
    client_name: 'stam',
    redirect_uris: [redirect],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
  if (scopes.length) body.scope = scopes.join(' ');
  const reg = await postJson(md.registration_endpoint, body);
  if (!reg.client_id) throw new Error('dynamic client registration returned no client_id');
  return { client_id: reg.client_id, client_secret: reg.client_secret };
}

async function authFor(name: string): Promise<{ url: string; auth: McpAuth }> {
  const s = settings().mcpServers?.[name];
  if (!s?.auth) throw new Error(`MCP server ${name} has no auth configured`);
  if (!s.url) throw new Error(`MCP server ${name} has no url`);
  await assertEndpoint(s.url);
  return { url: s.url, auth: s.auth };
}

// Begins a login and returns the authorize URL to open. `redirect` is the web UI's
// `/oauth/callback`. The state, verifier, and client registration stay in memory for ten
// minutes and are single use.
export async function startLogin(name: string, redirect: string): Promise<{ url: string }> {
  const { url, auth } = await authFor(name);
  if (auth.type !== 'oauth') throw new Error(`${name} logs in with gh, not OAuth`);
  const prm = await discover(url);
  if (prm.resource && !resourceMatches(String(prm.resource), url)) throw new Error(`protected-resource metadata for ${url} names ${prm.resource}`);
  const md = await authServerMetadata(String(prm.authorization_servers[0]));
  const scopes = auth.scopes ?? prm.scopes_supported ?? [];
  const client = auth.client_id ? { client_id: auth.client_id, client_secret: auth.client_secret } : await registerClient(md, redirect, scopes);
  const resource = String(prm.resource ?? url);
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  for (const [k, v] of pending) if (Date.now() - v.at > 600_000) pending.delete(k);
  pending.set(state, { name, verifier, redirect, client_id: client.client_id, client_secret: client.client_secret, token_endpoint: String(md.token_endpoint), resource, scopes, at: Date.now() });
  const params = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, state, code_challenge: challenge, code_challenge_method: 'S256', resource });
  if (scopes.length) params.set('scope', scopes.join(' '));
  const sep = String(md.authorization_endpoint).includes('?') ? '&' : '?';
  return { url: `${md.authorization_endpoint}${sep}${params}` };
}

// Stores the tokens of a grant. A refresh keeps the old refresh_token when the response
// omits one; a new login replaces the whole grant, so it never keeps another grant's token.
function saveTokens(name: string, tok: any, p: { server_url: string; client_id: string; client_secret?: string; token_endpoint: string; resource: string; scopes: string[] }, opts: { refresh?: boolean } = {}): void {
  const s = store();
  const prev = opts.refresh ? s[name] ?? {} : {};
  s[name] = {
    server_url: p.server_url,
    client_id: p.client_id,
    ...(p.client_secret ? { client_secret: p.client_secret } : {}),
    token_endpoint: p.token_endpoint,
    resource: p.resource,
    ...(p.scopes.length ? { scopes: p.scopes } : {}),
    ...(tok.access_token ? { access_token: String(tok.access_token) } : {}),
    ...(tok.refresh_token ? { refresh_token: String(tok.refresh_token) } : prev.refresh_token ? { refresh_token: prev.refresh_token } : {}),
    ...(typeof tok.expires_in === 'number' ? { expires_at: Date.now() + tok.expires_in * 1000 } : prev.expires_at ? { expires_at: prev.expires_at } : {}),
  };
  writeStore(s);
}

// Completes a login: checks the single-use state and exchanges the code, with the PKCE
// verifier and the resource it was issued for.
export async function finishLogin(code: string, state: string): Promise<{ name: string }> {
  const p = pending.get(state);
  if (!p) throw new Error('unknown or already used login state');
  pending.delete(state);
  if (Date.now() - p.at > 600_000) throw new Error('the login state has expired');
  const serverUrl = settings().mcpServers?.[p.name]?.url ?? '';
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: p.redirect, client_id: p.client_id, code_verifier: p.verifier, resource: p.resource });
  if (p.client_secret) form.set('client_secret', p.client_secret);
  const tok = tokenResponse(await postForm(p.token_endpoint, form));
  if (!tok.access_token) throw new Error('the token endpoint returned no access_token');
  saveTokens(p.name, tok, { server_url: serverUrl, client_id: p.client_id, client_secret: p.client_secret, token_endpoint: p.token_endpoint, resource: p.resource, scopes: p.scopes });
  return { name: p.name };
}

async function refresh(name: string, e: AuthEntry): Promise<void> {
  if (!e.refresh_token || !e.token_endpoint || !e.client_id) throw new Error(`${name} has no refresh_token`);
  const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: e.refresh_token, client_id: e.client_id });
  if (e.resource) form.set('resource', e.resource);
  if (e.client_secret) form.set('client_secret', e.client_secret);
  const tok = tokenResponse(await postForm(e.token_endpoint, form));
  saveTokens(name, tok, { server_url: e.server_url ?? '', client_id: e.client_id, client_secret: e.client_secret, token_endpoint: e.token_endpoint, resource: e.resource ?? '', scopes: e.scopes ?? [] }, { refresh: true });
}

// A `gh` login reuses the user's token. Cached for five minutes so the proxy's frequent
// asks don't spawn gh each time.
let ghCache: { at: number; token: string } | undefined;
export async function ghToken(): Promise<string> {
  if (ghCache && Date.now() - ghCache.at < 300_000) return ghCache.token;
  const { stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 15_000 });
  const token = stdout.trim();
  if (!token) throw new Error('gh is not logged in');
  ghCache = { at: Date.now(), token };
  return token;
}

// The current bearer for a server: `gh`'s token, or the stored access_token, refreshed with
// the refresh_token when it is within a minute of expiry (or when asked to). A grant made
// for a different server url is refused, so a token never follows a moved server.
export async function token(name: string, opts: { refresh?: boolean } = {}): Promise<string> {
  const { url, auth } = await authFor(name);
  if (auth.type === 'gh') return ghToken();
  let e = store()[name];
  if (!e?.access_token && !e?.refresh_token) throw new Error(`${name} is not logged in`);
  if (e.server_url !== url) throw new Error(`${name}: the server url changed; log in again`);
  const stale = !e.expires_at || Date.now() > e.expires_at - 60_000;
  if (e.refresh_token && (opts.refresh || stale)) {
    await refresh(name, e);
    e = store()[name];
  }
  if (!e?.access_token) throw new Error(`${name} is not logged in`);
  return e.access_token;
}

// The proxy's ask: the bearer, the url to reach, and when the token expires.
export async function tokenFor(name: string, opts: { refresh?: boolean } = {}): Promise<{ name: string; url: string; token: string; expires_at: number | null }> {
  const { url } = await authFor(name);
  const value = await token(name, opts);
  return { name, url, token: value, expires_at: store()[name]?.expires_at ?? null };
}

// One row per auth server, without any token.
export async function status(): Promise<{ name: string; type: string; logged_in: boolean; expires_at: number | null }[]> {
  const out: { name: string; type: string; logged_in: boolean; expires_at: number | null }[] = [];
  for (const [name, s] of Object.entries(settings().mcpServers ?? {})) {
    if (!s?.auth) continue;
    if (s.auth.type === 'gh') {
      const logged_in = await ghToken().then(() => true).catch(() => false);
      out.push({ name, type: 'gh', logged_in, expires_at: null });
      continue;
    }
    const e = store()[name] ?? {};
    out.push({ name, type: 'oauth', logged_in: Boolean(e.access_token || e.refresh_token), expires_at: e.expires_at ?? null });
  }
  return out;
}

// Forgets a server's stored login.
export function logout(name: string): void {
  const s = store();
  delete s[name];
  writeStore(s);
}
