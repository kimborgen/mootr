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
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { promisify } from 'node:util';
import { STAM_HOME } from './config.ts';
import { isSettingsHome, setSetting, settings, settingsOnDisk } from './settings.ts';
import * as secrets from './secrets.ts';
import { checkCredential } from './llm/http.ts';
import type { McpAuth, McpServer } from './instructions.ts';
import { envVar } from './env.ts';
import { PeerBadReply, peerByName, peerCall } from './peers.ts';

const execFileAsync = promisify(execFile);
const storeFile = () => join(STAM_HOME, 'mcp-auth.json');
const insecure = () => envVar('MCP_AUTH_INSECURE') === '1';
const trimSlash = (u: string) => u.replace(/\/+$/, '');

// One server's stored login. The client registration is kept beside the tokens so a refresh
// needs no new discovery. `server_url` is the configured MCP url this grant was made for;
// a changed url needs a new login, so a grant's bearer never follows a moved server. The
// client secret is a reference into the secret store (S-2736); a plain string is the old form,
// moved by migrateClientSecrets at start.
export interface AuthEntry {
  server_url?: string;
  client_id?: string;
  client_secret?: secrets.SecretRef | string;
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
  if (!text) return {};
  // A SyntaxError quotes the start of the body, which can hold a credential, so the message is fixed (S-3503).
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`an OAuth endpoint answered non-JSON from ${url}`);
  }
}

async function postForm(url: string, form: URLSearchParams): Promise<any> {
  await assertEndpoint(url);
  return fetchJson(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
}

// The provider errors that may be echoed, and nothing else (Go's providerCodes in go/internal/mcpauth/mcpauth.go, keep
// the two lists in step): the RFC 6749 §5.2 codes and Slack's oauth.v2.access errors.
export const providerCodes = new Set([
  // RFC 6749.
  'invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client', 'unsupported_grant_type', 'invalid_scope',
  'access_denied', 'server_error', 'temporarily_unavailable',
  // Slack oauth.v2.access.
  'accesslimited', 'account_inactive', 'bad_client_secret', 'bad_redirect_uri', 'cannot_install_an_org_installed_app',
  'deprecated_endpoint', 'ekm_access_denied', 'enterprise_is_restricted', 'fatal_error', 'internal_error', 'invalid_arg_name',
  'invalid_arguments', 'invalid_array_arg', 'invalid_auth', 'invalid_charset', 'invalid_client_id', 'invalid_code',
  'invalid_code_verifier', 'invalid_form_data', 'invalid_grant_type', 'invalid_post_type', 'invalid_refresh_token',
  'method_deprecated', 'missing_post_type', 'missing_scope', 'no_permission', 'no_scopes', 'not_allowed_token_type',
  'not_authed', 'oauth_authorization_url_mismatch', 'org_login_required', 'pkce_not_allowed', 'preview_feature_not_available',
  'ratelimited', 'request_timeout', 'service_unavailable', 'team_access_not_granted', 'team_added_to_org', 'token_expired',
  'token_revoked', 'two_factor_setup_required', 'user_email_unverified',
]);

// A token endpoint's answer as stam reads it. Slack answers HTTP 200 with `ok: false` and an
// `error`, which is echoed only when it is one of providerCodes (anything else is 'unknown error', since a provider
// can put a token in it). Its user token sits under `authed_user`, so that is used when the top level has no access_token.
export function tokenResponse(tok: any): any {
  if (tok?.ok === false) {
    const code = typeof tok.error === 'string' && providerCodes.has(tok.error) ? tok.error : 'unknown error';
    throw new Error(`the token endpoint refused: ${code}`);
  }
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

const pending = new Map<string, { name: string; verifier: string; redirect: string; client_id: string; client_secret?: secrets.SecretRef | string; token_endpoint: string; resource: string; scopes: string[]; at: number }>();

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

// A client secret's value for a request: a reference is read from the store, and one the store
// doesn't hold is an error, never a silent drop. A plain string is checked and used as it is, until
// the write path moves it into the store. Only a store entry tagged `mcp` is a client secret (S-2767),
// so a provider's key never goes to an MCP server's token endpoint. The error names the entry, never its value.
function clientSecretValue(server: string, secret: secrets.SecretRef | string | undefined): string | undefined {
  if (!secret) return undefined;
  if (typeof secret === 'string') return checkCredential(secret, `${server}'s client secret`);
  const provider = secrets.providerOf(secret.secret);
  if (provider !== undefined && provider !== 'mcp') throw new Error(`${server}: ${secret.secret} is not an MCP client secret`);
  const value = secrets.getSecret(secret.secret);
  if (value !== undefined) return value;
  // Client secrets live in each machine's own store, and only the home machine's holds them.
  if (!isSettingsHome()) throw new Error(`${server}: log in on the home machine, which keeps its client secret`);
  throw new Error(`${server}: its client secret ${secret.secret} isn't in the secret store`);
}

// The reference a grant keeps for a client secret: a settings reference as it is, and a plain
// string (a registration's, or an old settings value) moved into the store under the server's
// name first. The store write is committed before the reference is returned.
function keepClientSecret(server: string, secret: secrets.SecretRef | string | undefined): secrets.SecretRef | undefined {
  if (!secret) return undefined;
  if (secrets.isRef(secret)) return secret;
  return secrets.setMcpClientSecret(server, secret);
}

// Begins a login and returns the authorize URL to open. `redirect` is the web UI's
// `/oauth/callback`. The state, verifier, and client registration stay in memory for ten
// minutes and are single use.
export async function startLogin(name: string, redirect: string): Promise<{ url: string }> {
  refuseOnPeer(name, 'log in');
  const { url, auth } = await authFor(name);
  if (auth.type !== 'oauth') throw new Error(`${name} logs in with gh, not OAuth`);
  const prm = await discover(url);
  if (prm.resource && !resourceMatches(String(prm.resource), url)) throw new Error(`protected-resource metadata for ${url} names ${prm.resource}`);
  const md = await authServerMetadata(String(prm.authorization_servers[0]));
  const scopes = auth.scopes ?? prm.scopes_supported ?? [];
  const client = auth.client_id ? { client_id: auth.client_id, client_secret: auth.client_secret } : await registerClient(md, redirect, scopes);
  // A configured secret the store can't give fails here, before the human goes to the browser.
  clientSecretValue(name, client.client_secret);
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
function saveTokens(name: string, tok: any, p: { server_url: string; client_id: string; client_secret?: secrets.SecretRef | string; token_endpoint: string; resource: string; scopes: string[] }, opts: { refresh?: boolean } = {}): void {
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
    // A response with no expires_in gets no expiry: the old one belongs to the old access token, so keeping it
    // would let a token that never expires pass as one that does (a lease, S-3176). token() then reads the grant as stale.
    ...(typeof tok.expires_in === 'number' ? { expires_at: Date.now() + tok.expires_in * 1000 } : {}),
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
  const secret = clientSecretValue(p.name, p.client_secret);
  if (secret) form.set('client_secret', secret);
  const tok = tokenResponse(await postForm(p.token_endpoint, form));
  if (!tok.access_token) throw new Error('the token endpoint returned no access_token');
  // The secret is kept once the login has worked, and the grant then names it (S-2736).
  saveTokens(p.name, tok, { server_url: serverUrl, client_id: p.client_id, client_secret: keepClientSecret(p.name, p.client_secret), token_endpoint: p.token_endpoint, resource: p.resource, scopes: p.scopes });
  return { name: p.name };
}

async function refresh(name: string, e: AuthEntry): Promise<void> {
  if (!e.refresh_token || !e.token_endpoint || !e.client_id) throw new Error(`${name} has no refresh_token`);
  const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: e.refresh_token, client_id: e.client_id });
  if (e.resource) form.set('resource', e.resource);
  const secret = clientSecretValue(name, e.client_secret);
  if (secret) form.set('client_secret', secret);
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

// The refreshes in flight, by server (S-3176): concurrent callers share one refresh, since a provider that
// rotates refresh tokens revokes the whole family when two refreshes race.
const refreshing = new Map<string, Promise<void>>();

// Refreshes a grant once for every caller that asks while the refresh runs. A caller that arrives after a
// refresh left the grant fresh doesn't refresh again, unless it forces one.
function refreshOnce(name: string, force: boolean): Promise<void> {
  const running = refreshing.get(name);
  if (running) return running;
  const e = store()[name];
  if (!e?.refresh_token) return Promise.resolve();
  if (!force && e.expires_at && Date.now() <= e.expires_at - 60_000) return Promise.resolve();
  const p = refresh(name, e).finally(() => refreshing.delete(name));
  refreshing.set(name, p);
  return p;
}

// The current bearer for a server: `gh`'s token, or the stored access_token, refreshed with
// the refresh_token when it is within a minute of expiry (or when asked to). A grant made
// for a different server url is refused, so a token never follows a moved server.
export async function token(name: string, opts: { refresh?: boolean } = {}): Promise<string> {
  const { url, auth } = await authFor(name);
  if (auth.type === 'gh') return ghToken();
  if (!isSettingsHome()) return (await peerLease(name, opts, url)).token;
  let e = store()[name];
  if (!e?.access_token && !e?.refresh_token) throw new Error(`${name} is not logged in`);
  if (e.server_url !== url) throw new Error(`${name}: the server url changed; log in again`);
  const stale = !e.expires_at || Date.now() > e.expires_at - 60_000;
  if (e.refresh_token && (opts.refresh || stale)) {
    await refreshOnce(name, Boolean(opts.refresh));
    e = store()[name];
  }
  if (!e?.access_token) throw new Error(`${name} is not logged in`);
  return e.access_token;
}

// The proxy's ask: the bearer, the url to reach, and when the token expires. On a peer the bearer is the home's
// lease (S-3177), and its url and expiry come with it.
export async function tokenFor(name: string, opts: { refresh?: boolean } = {}): Promise<{ name: string; url: string; token: string; expires_at: number | null }> {
  const { url, auth } = await authFor(name);
  if (auth.type !== 'gh' && !isSettingsHome()) {
    const lease = await peerLease(name, opts, url);
    return { name, url, token: lease.token, expires_at: lease.expires_at };
  }
  const value = await token(name, opts);
  return { name, url, token: value, expires_at: store()[name]?.expires_at ?? null };
}

// A peer's copy of a lease (S-3177), kept in this daemon's memory only, per server: never written to disk, settings,
// logs or mail, and gone at a restart. It serves until 60 s before it expires, and one fetch from the home serves every
// caller that asks while it runs.
interface HeldLease {
  url: string;
  token: string;
  expires_at: number;
}
// Keyed by server name and the url this machine's settings name for it, so a lease for another url is never served.
const held = new Map<string, HeldLease>();
// The fetch from the home now running for a key, and the forced fetch queued behind it (S-3472). A non-forced caller
// joins the running fetch. A forced caller never does, since that fetch may bring back the token it is replacing: it
// joins the queued forced fetch, which starts once the running one ends, so its token is newer than the request.
interface Flight {
  p: Promise<HeldLease>;
  queued?: Promise<HeldLease>;
}
const leasing = new Map<string, Flight>();

async function peerLease(name: string, opts: { refresh?: boolean }, want: string): Promise<HeldLease> {
  const key = `${name}\n${want}`;
  const force = Boolean(opts.refresh);
  const cached = held.get(key);
  if (!force && cached && cached.url === want && Date.now() <= cached.expires_at - 60_000) return cached;
  const flight = leasing.get(key);
  if (!flight) return launchLease(key, name, want, force);
  console.log(`mcp lease: ${name} waits for the running fetch from the home${force ? ', then fetches again' : ''}`);
  if (!force) return flight.p;
  flight.queued ??= flight.p.then(
    () => launchLease(key, name, want, true),
    () => launchLease(key, name, want, true),
  );
  return flight.queued;
}

// Starts a fetch from the home for a key and makes it the running one. A lease replaces the held one. A refusal
// (any error but an unreachable home) drops the held one, so a lease the home no longer gives is never served from the
// cache; an unreachable home keeps it, so the peer serves it until its margin (S-3472).
function launchLease(key: string, name: string, want: string, force: boolean): Promise<HeldLease> {
  const flight: Flight = {
    p: leaseMatching(name, want, force).then(
      (lease) => {
        held.set(key, lease);
        return lease;
      },
      (e) => {
        if (!(e instanceof HomeUnreachable)) held.delete(key);
        throw e;
      },
    ),
  };
  leasing.set(key, flight);
  const done = () => {
    if (leasing.get(key) === flight && !flight.queued) leasing.delete(key);
  };
  flight.p.then(done, done);
  return flight.p;
}

// A lease whose url isn't the one this machine's settings name is dropped, and the home is asked once more (S-3177
// review). The second ask isn't forced: the url is the home's settings, which a refresh doesn't change, so it would only
// call the provider again (S-3472). If the second lease still names another url, the bearer is refused and never
// returned: it belongs to a different resource. Both urls are named, and no token is.
async function leaseMatching(name: string, want: string, refresh: boolean): Promise<HeldLease> {
  let lease = await leaseFromHome(name, refresh);
  if (lease.url !== want) lease = await leaseFromHome(name, false);
  if (lease.url !== want)
    throw new Error(`${name}: the home leases a token for ${lease.url}, but this machine's settings name ${want}; the token is not used. Make the url of ${name} the same on both machines, then retry`);
  return lease;
}

// A peer holds no logins: a login, and a logout, happen on the home, which keeps every grant (S-3177).
function refuseOnPeer(name: string, what: string): void {
  if (isSettingsHome()) return;
  throw new Error(`${name}: ${what} on ${settings().home}, which keeps the MCP logins; this machine leases them from ${settings().home}`);
}

// The error for a home that got nothing, or whose answer never came back (S-3472): a network failure, not a refusal.
export class HomeUnreachable extends Error {}

// A GET to the home's peer routes (S-3176), with the lease token from settings.peers, the only bearer the
// home's lease routes accept. `what` names the request in each error. Nothing here logs or returns the token.
// A network failure is HomeUnreachable; an answer that isn't JSON is its own error, since the home is up (S-3472);
// an answer with any status is returned, for homeError.
async function homeGet(what: string, path: string): Promise<{ status: number; data: any }> {
  const home = settings().home;
  const peer = peerByName(home);
  if (!peer) throw new Error(`${what}: ${home} isn't in settings.peers, so its MCP logins can't be leased`);
  if (!peer.leaseToken) throw new Error(`${what}: settings.peers[${home}].leaseToken is missing; copy the value of STAM_HOME/mcp-lease-token from ${home} into it`);
  try {
    return await peerCall({ ...peer, token: peer.leaseToken, peerToken: peer.leaseToken }, 'GET', path);
  } catch (e) {
    if (e instanceof PeerBadReply) throw new Error(`${what}: ${home} answered something that is not JSON, so its MCP logins can't be leased; check that settings.peers[${home}].url is ${home}'s daemon`);
    throw new HomeUnreachable(`${what}: the home ${home} is unreachable, so its MCP logins can't be leased; start ${home} and retry`);
  }
}

// The error for a home answer that is not the one asked for (S-3177). Each status says what to do; the home's
// message names the cause, and no answer carries a token.
function homeError(what: string, home: string, res: { status: number; data: any }): Error {
  const why = typeof res.data?.error === 'string' ? `: ${res.data.error}` : '';
  if (res.status === 401 || res.status === 403)
    return new Error(`${what}: ${home} refused the lease token (${res.status}${why}). Check that settings.peers[${home}].leaseToken is the value of STAM_HOME/mcp-lease-token on ${home}, and that the server has shareWithPeers on ${home}`);
  if (res.status === 409) return new Error(`${what}: ${home} has no lease for it${why}. Re-login or refresh on ${home}, then retry`);
  if (res.status === 200) return new Error(`${what}: ${home} answered 200 without a lease`);
  return new Error(`${what}: ${home} answered ${res.status}${why}`);
}

async function leaseFromHome(name: string, refresh: boolean): Promise<HeldLease> {
  const home = settings().home;
  const res = await homeGet(name, `/api/peer/mcp/${encodeURIComponent(name)}/lease${refresh ? '?refresh=1' : ''}`);
  const d = res.data;
  if (res.status !== 200 || !d?.access_token || typeof d.expires_at !== 'number') throw homeError(name, home, res);
  console.log(`mcp lease: ${name} from ${home}, expires ${new Date(d.expires_at).toISOString()}`);
  return { url: String(d.url), token: String(d.access_token), expires_at: d.expires_at };
}

// One row per auth server, without any token. `only` keeps the servers it names. On a peer the rows are the
// home's shared servers, each marked as leased from the home (S-3177).
// `local_grant` marks a peer's own grant from before the lease (S-3177); its `logged_in` is false, since the peer
// holds no lease for it. `home` is set on a peer only: whether the home answered (S-3178), with `error` when it didn't.
export type McpStatusRow = { name: string; type: string; logged_in: boolean; expires_at: number | null; leased_from?: string; local_grant?: boolean };
export type McpHomeState = { name: string; reachable: boolean; error?: string };
export type McpStatusPage = { servers: McpStatusRow[]; home: McpHomeState | null };

// The page of status rows for this daemon. On a peer the rows are its own gh logins and grants, then the home's
// shared rows. A home that doesn't answer leaves its rows out and says so, so no stale "logged in" is shown.
export async function status(): Promise<McpStatusPage> {
  if (!isSettingsHome()) return peerStatus();
  return { servers: await localStatus(), home: null };
}

async function peerStatus(): Promise<McpStatusPage> {
  const home = settings().home;
  const own: McpStatusRow[] = [];
  for (const [name, s] of Object.entries(settings().mcpServers ?? {})) {
    if (!s?.auth) continue;
    if (s.auth.type === 'gh') {
      const logged_in = await ghToken().then(() => true).catch(() => false);
      own.push({ name, type: 'gh', logged_in, expires_at: null });
    } else if (store()[name]) {
      own.push({ name, type: 'oauth', logged_in: false, expires_at: null, local_grant: true });
    }
  }
  try {
    const res = await homeGet('MCP status', '/api/peer/mcp/status');
    if (res.status !== 200) throw homeError('MCP status', home, res);
    const leased = (res.data.servers as McpStatusRow[]).map((row) => ({ ...row, leased_from: home }));
    return { servers: [...own, ...leased], home: { name: home, reachable: true } };
  } catch (e) {
    return { servers: own, home: { name: home, reachable: false, error: e instanceof Error ? e.message : String(e) } };
  }
}

async function localStatus(only: (name: string) => boolean = () => true): Promise<McpStatusRow[]> {
  const out: McpStatusRow[] = [];
  for (const [name, s] of Object.entries(settings().mcpServers ?? {})) {
    if (!s?.auth || !only(name)) continue;
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

// The lease (S-3176): a short-lived access token a peer may hold, minted on the home from the grant
// the home keeps. Only a server the settings share (`shareWithPeers`) is leased, and never a `gh` server
// (a peer uses its own gh) or a grant that never expires. Every refusal is a LeaseError with its status;
// a settings or grant read that fails refuses too, since nothing is known to be shared.
export class LeaseError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// The longest lifetime a lease may carry for a server (S-3176): its leaseMaxSeconds, a positive integer, or
// 3600 when absent. Any other value refuses the lease, so a bad value never means "no cap".
const LEASE_CAP_DEFAULT = 3600;
function leaseCapSeconds(name: string, server: McpServer): number {
  const cap = server.leaseMaxSeconds;
  if (cap === undefined) return LEASE_CAP_DEFAULT;
  if (Number.isSafeInteger(cap) && cap > 0) return cap;
  throw new LeaseError(409, `${name}'s leaseMaxSeconds must be a positive integer (settings mcpServers.${name}.leaseMaxSeconds)`);
}

export async function leaseFor(name: string, opts: { refresh?: boolean } = {}): Promise<{ url: string; access_token: string; expires_at: number }> {
  let server: McpServer | undefined;
  try {
    server = settings().mcpServers?.[name];
  } catch (e) {
    throw new LeaseError(403, `${name}: the settings could not be read, so sharing can't be checked (${e instanceof Error ? e.message : e})`);
  }
  if (!server) throw new LeaseError(404, `no MCP server named ${name}`);
  if (server.shareWithPeers !== true) throw new LeaseError(403, `${name} is not shared with peers (shareWithPeers is off)`);
  if (server.auth?.type === 'gh') throw new LeaseError(400, `${name} uses gh; a peer uses its own gh login`);
  const cap = leaseCapSeconds(name, server);
  const grant = store()[name];
  if (!grant?.access_token && !grant?.refresh_token) throw new LeaseError(409, `${name} is not logged in on this home`);
  if (!grant.expires_at) throw new LeaseError(409, `${name}'s grant never expires, so it is not leased`);
  // A grant already over the cap is refused before any forced refresh (S-3212): a refresh would only bring
  // the same 409 and call the provider again on every ask.
  if (opts.refresh && grant.expires_at - Date.now() > cap * 1000) throw overCap(name, grant.expires_at - Date.now(), cap);
  const got = await tokenFor(name, opts);
  if (!got.expires_at) throw new LeaseError(409, `${name}'s grant never expires, so it is not leased`);
  // A lease must outlive the peer's cache of it, so one that ends within a minute is refused too.
  if (got.expires_at <= Date.now() + 60_000) throw new LeaseError(409, `${name}'s grant ends within a minute, so it is not leased`);
  // The cap is on the lifetime the peer would hold: rotating the lease token can't revoke a bearer already sent,
  // so a token that lives longer is refused, not shortened.
  const remaining = got.expires_at - Date.now();
  if (remaining > cap * 1000) throw overCap(name, remaining, cap);
  return { url: got.url, access_token: got.token, expires_at: got.expires_at };
}

// The refusal for a token that lives longer than the server's cap (S-3176). It names no token.
function overCap(name: string, remainingMs: number, cap: number): LeaseError {
  return new LeaseError(409, `${name}'s token lives ${Math.round(remainingMs / 1000)} s, over the ${cap} s cap: the provider issues longer-lived tokens than peers accept (settings mcpServers.${name}.leaseMaxSeconds)`);
}

// The status rows of the servers the settings share, for a peer (S-3176). No token is in them.
export async function sharedStatus(): Promise<McpStatusRow[]> {
  return localStatus((name) => settings().mcpServers?.[name]?.shareWithPeers === true);
}

// Whether two secrets are equal, compared in constant time: both are hashed first, so the length of
// the presented one isn't checked against the other's.
export function sameSecret(presented: string, secret: string): boolean {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(presented), digest(secret));
}

// The secret name the settings reference for a server, if any.
function settingsSecretName(name: string): string | undefined {
  const v = settingsOnDisk()?.mcpServers?.[name]?.auth?.client_secret;
  return secrets.isRef(v) ? v.secret : undefined;
}

// Forgets a server's stored login. A client secret the registration made goes with it; one the
// settings name stays, since the next login needs it (S-2736).
// A peer issues no logins, but a grant it still holds from before the lease (S-3177) is deleted here, refresh token and
// all. A peer with no grant of its own is refused, naming the home.
export function logout(name: string): void {
  if (!store()[name]) refuseOnPeer(name, 'log out');
  const s = store();
  const ref = s[name]?.client_secret;
  delete s[name];
  writeStore(s);
  if (secrets.isRef(ref) && ref.secret === secrets.mcpClientSecretName(name) && ref.secret !== settingsSecretName(name)) secrets.remove(ref.secret);
}

// Moves the plain-text client secrets into the secret store (S-2736): the McpAuth values in
// settings (on the home daemon, which holds the shared settings) and the token file's. Each moves
// under its server's name, and its entry becomes the reference; the store write is committed
// before the plain text is replaced. A store name already holding another value is left alone,
// and a store that can't be read moves nothing. A second run finds only references, so it changes
// nothing. Logs names, never values.
export function migrateClientSecrets(): void {
  const moved = (server: string, value: string): secrets.SecretRef | undefined => {
    try {
      const name = secrets.mcpClientSecretName(server);
      if (!name) {
        console.warn(`mcp-auth: ${server}'s client secret stays in settings: no store name fits it`);
        return undefined;
      }
      const held = secrets.stored(name)?.value;
      if (held !== undefined && held !== value) {
        console.warn(`mcp-auth: ${server}'s client secret stays in place: ${name} holds another value`);
        return undefined;
      }
      if (held === undefined) {
        secrets.set(name, { value, provider: 'mcp' });
        console.log(`mcp-auth: moved ${server}'s client secret into the secret store as ${name}`);
      }
      return { secret: name };
    } catch (e) {
      console.warn(`mcp-auth: ${server}'s client secret stays in place: ${e instanceof Error ? e.message : e}`);
      return undefined;
    }
  };
  if (isSettingsHome()) {
    const servers = settingsOnDisk()?.mcpServers;
    if (servers && typeof servers === 'object') {
      const next = structuredClone(servers);
      let changed = false;
      for (const [server, s] of Object.entries<any>(next)) {
        const value = s?.auth?.client_secret;
        if (typeof value !== 'string' || !value) continue;
        const ref = moved(server, value);
        if (!ref) continue;
        s.auth.client_secret = ref;
        changed = true;
      }
      if (changed) setSetting('mcpServers', next);
    }
  }
  const s = store();
  let changed = false;
  for (const [server, e] of Object.entries(s)) {
    if (typeof e.client_secret !== 'string' || !e.client_secret) continue;
    const ref = moved(server, e.client_secret);
    if (!ref) continue;
    e.client_secret = ref;
    changed = true;
  }
  if (changed) writeStore(s);
}
