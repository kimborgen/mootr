// The secret store (S-2114): provider keys the human enters in the UI, in STAM_HOME/secrets.json
// (mode 600), apart from settings.json. Settings hold only a reference by name, {"secret": "NAME"}.
//
// Write-only from outside: PUT and DELETE /api/secrets/NAME are human-only, and GET /api/secrets
// lists names, provider, the last 4 characters and the last test result. No route returns a value;
// only this process reads one, through getSecret and the helpers below. The daemon keeps the values
// in memory and never puts them in its process.env, so the tmux agents it starts can't inherit them.
//
// A secret that stands for an environment variable (`env`, such as OPENROUTER_API_KEY) is
// overridden by that variable in the daemon's environment, and falls back to the same line in
// opencode.env when the store has none. The keys in opencode.env are imported into the store once.
// Each secret has a slot: `stam` for stam's own model calls, `agent` for the keys stam's OpenCode
// server hands its agents, so the two can differ.
import { createHash } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { STAM_HOME } from './config.ts';
import { checkCredential } from './llm/http.ts';

export type Slot = 'stam' | 'agent';
export interface TestResult {
  ok: boolean;
  at: string;
  detail?: string;
}
interface Entry {
  value: string;
  provider: string;
  slot: Slot;
  env?: string;
  setAt: string;
  test?: TestResult;
}
interface Store {
  secrets: Record<string, Entry>;
  // Files already imported once, such as "opencode.env".
  imported: string[];
}
// What a route may show about a secret: never its value.
export interface SecretInfo {
  name: string;
  provider: string;
  slot: Slot;
  env: string | null;
  last4: string;
  setAt: string;
  test: TestResult | null;
  // Set when the daemon's environment overrides the stored value.
  overriddenBy: 'env' | null;
}
export type SecretRef = { secret: string };

export class SecretError extends Error {}
// The file itself is broken: unreadable, not JSON, or not a regular file.
export class SecretFileError extends SecretError {}

export const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ENV_RE = /^[A-Z_][A-Z0-9_]*$/;
const MAX_VALUE = 8192;
// Lines of opencode.env that hold a key; other lines stay config in that file.
const KEY_VAR = /(_API_KEY|_KEY|_TOKEN|_SECRET)$/;

const file = () => join(STAM_HOME, 'secrets.json');
const legacyFile = () => join(STAM_HOME, 'opencode.env');

let memo: { key: string; store: Store } | null = null;

// A stat key, so a file changed by another stam process (the CLI on this home) is read again.
function statKey(fd: number): string {
  const st = fstatSync(fd);
  return `${st.ino}:${st.size}:${st.mtimeMs}`;
}

// The store as on disk, read into memory. A missing file is an empty store. The file is opened
// without following a symlink and checked on the open descriptor: a file with group or other
// bits is narrowed to 600 and the daemon says so once.
function read(): Store {
  let fd: number;
  try {
    fd = openSync(file(), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return (memo = { key: 'none', store: { secrets: {}, imported: [] } }).store;
    throw new SecretFileError(`secrets.json can't be read: ${(e as NodeJS.ErrnoException).code ?? e}`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new SecretFileError('secrets.json is not a regular file');
    if ((st.mode & 0o077) !== 0) {
      fchmodSync(fd, 0o600);
      console.warn('secrets.json had group or other permissions; narrowed to 600');
    }
    const key = statKey(fd);
    if (memo && memo.key === key) return memo.store;
    let parsed: any;
    try {
      parsed = JSON.parse(readFileSync(fd, 'utf8'));
    } catch {
      throw new SecretFileError('secrets.json is not valid JSON');
    }
    const store: Store = { secrets: {}, imported: Array.isArray(parsed?.imported) ? parsed.imported.filter((x: unknown) => typeof x === 'string') : [] };
    for (const [name, e] of Object.entries<any>(parsed?.secrets ?? {})) {
      if (!NAME_RE.test(name) || typeof e?.value !== 'string' || !e.value) continue;
      store.secrets[name] = {
        value: e.value,
        provider: typeof e.provider === 'string' ? e.provider : '',
        slot: e.slot === 'agent' ? 'agent' : 'stam',
        ...(typeof e.env === 'string' && ENV_RE.test(e.env) ? { env: e.env } : {}),
        setAt: typeof e.setAt === 'string' ? e.setAt : '',
        ...(e.test && typeof e.test.ok === 'boolean' ? { test: { ok: e.test.ok, at: String(e.test.at ?? ''), ...(e.test.detail ? { detail: String(e.test.detail) } : {}) } } : {}),
      };
    }
    memo = { key, store };
    return store;
  } finally {
    closeSync(fd);
  }
}

// Writes the store atomically: a new file created with mode 600 beside it, synced, then renamed over.
function write(store: Store): void {
  const tmp = `${file()}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, JSON.stringify(store, null, 2) + '\n');
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  closeSync(fd);
  renameSync(tmp, file());
  memo = null;
}

// KEY=VALUE lines of opencode.env, quotes stripped. Empty when there is no file. Once the file
// is imported, its key lines are the store's: a key the human deletes or changes in the UI isn't
// brought back from the file, so only its other lines (OpenCode config) are read.
function legacyLines(imported = false): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(legacyFile(), 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const l of text.split('\n')) {
    const i = l.indexOf('=');
    if (i <= 0 || !ENV_RE.test(l.slice(0, i))) continue;
    const v = l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
    if (v && !(imported && KEY_VAR.test(l.slice(0, i)))) out[l.slice(0, i)] = v;
  }
  return out;
}

// A store name and provider for a variable: OPENROUTER_API_KEY is "openrouter".
export function nameForEnv(v: string): string {
  return v.replace(KEY_VAR, '').toLowerCase().replace(/_/g, '-').replace(/^[^a-z0-9]+/, '') || 'key';
}

// The one-time import of opencode.env (S-2114): each key line becomes a `stam` secret and a
// separate `agent` secret with the same value, so OpenCode's key can later be changed alone. It
// runs once per home: the store remembers the file, so a secret the human deletes isn't brought
// back. A store secret already under a name is kept. Returns the names it added.
export function importLegacyOnce(): string[] {
  const store = structuredClone(read());
  if (store.imported.includes('opencode.env')) return [];
  const lines = legacyLines();
  const keys = Object.keys(lines).filter((k) => KEY_VAR.test(k));
  // No key in the file yet: nothing to import and nothing remembered, so a key added later imports then.
  if (!keys.length) return [];
  const added: string[] = [];
  const at = new Date().toISOString();
  for (const v of keys) {
    const provider = nameForEnv(v);
    for (const [name, slot] of [[provider, 'stam'], [`${provider}-agent`, 'agent']] as const) {
      if (!NAME_RE.test(name) || store.secrets[name]) continue;
      store.secrets[name] = { value: lines[v], provider, slot, env: v, setAt: at };
      added.push(name);
    }
  }
  store.imported.push('opencode.env');
  write(store);
  if (added.length) console.log(`secrets: imported ${added.join(', ')} from opencode.env`);
  return added;
}

// The store, after the one-time import. Writes go through this, so a broken file refuses them.
function load(): Store {
  importLegacyOnce();
  return read();
}

// The store for a reader that must not fail (stam's own key, OpenCode's env, the daemon's start):
// a broken, unreadable or symlinked file reads as empty, so the environment and opencode.env still
// work, and the daemon says why once per reason.
const warned = new Set<string>();
function readable(): Store {
  try {
    return load();
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (!warned.has(why)) {
      warned.add(why);
      console.warn(`secrets: ${why}; using the environment and opencode.env only`);
    }
    return { secrets: {}, imported: [] };
  }
}

// Reads the store into memory at startup and runs the import. A broken file is logged, not fatal.
export function init(): void {
  readable();
}

// A secret's value by name, for in-process use only (the LLM layer, OpenCode's env). An
// environment variable the secret stands for overrides it. Undefined when there is none.
export function getSecret(name: string): string | undefined {
  const e = readable().secrets[name];
  if (!e) return undefined;
  return (e.env && process.env[e.env]) || e.value;
}

// The stored value and the variable it stands for, without the environment's override: what the
// human entered, for the Settings page's Test (S-2115). In-process only. A broken file refuses.
export function stored(name: string): { value: string; env?: string } | undefined {
  const e = load().secrets[name];
  return e && { value: e.value, ...(e.env ? { env: e.env } : {}) };
}

// The provider a stored secret is tagged with, or undefined when the store holds no entry by that name.
// In-process only, and never the value: a reader checks what kind of secret a reference names (S-2767).
export function providerOf(name: string): string | undefined {
  return readable().secrets[name]?.provider;
}

// Whether a settings value is a reference to a secret.
export function isRef(v: unknown): v is SecretRef {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && typeof (v as SecretRef).secret === 'string';
}

// The value a settings reference names, or undefined when it names none.
export function resolveRef(v: unknown): string | undefined {
  return isRef(v) ? getSecret(v.secret) : undefined;
}

// The key for a variable in a slot: the environment first, then the store's secret for that
// variable and slot (the first by name when several are), then opencode.env's line until it is
// imported. Undefined when none has it.
export function keyFor(env: string, slot: Slot = 'stam'): string | undefined {
  if (process.env[env]) return process.env[env];
  const store = readable();
  const hit = Object.entries(store.secrets)
    .sort(([a], [b]) => a.localeCompare(b))
    .find(([, e]) => e.env === env && e.slot === slot);
  return hit?.[1].value ?? legacyLines(store.imported.includes('opencode.env'))[env];
}

// The variables stam's OpenCode server starts with: opencode.env's lines, then the `agent` slot's
// secrets over them, then the daemon's environment over those for the same variables.
// The first secret by name wins a variable two of them name.
export function agentEnv(): Record<string, string> {
  const store = readable();
  const out = legacyLines(store.imported.includes('opencode.env'));
  for (const [, e] of Object.entries(store.secrets).sort(([a], [b]) => b.localeCompare(a))) if (e.slot === 'agent' && e.env) out[e.env] = e.value;
  for (const k of Object.keys(out)) if (process.env[k]) out[k] = process.env[k]!;
  return out;
}

// What a route may show: names, provider, slot, the last 4 characters and the last test result.
export function list(): SecretInfo[] {
  return Object.entries(load().secrets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, e]) => info(name, e));
}

function info(name: string, e: Entry): SecretInfo {
  return {
    name,
    provider: e.provider,
    slot: e.slot,
    env: e.env ?? null,
    last4: e.value.length > 8 ? e.value.slice(-4) : '',
    setAt: e.setAt,
    test: e.test ?? null,
    overriddenBy: e.env && process.env[e.env] ? 'env' : null,
  };
}

// Sets a secret. A new value clears the last test result. Returns its info, never the value.
export function set(name: string, input: { value?: unknown; provider?: unknown; slot?: unknown; env?: unknown }): SecretInfo {
  if (!NAME_RE.test(name)) throw new SecretError('a secret name is 1-64 characters: lower-case letters, digits, dot, dash and underscore');
  const value = input.value;
  if (typeof value !== 'string' || !value.trim()) throw new SecretError('value must be a non-empty string');
  if (value.length > MAX_VALUE) throw new SecretError(`value is over ${MAX_VALUE} characters`);
  if (/[\r\n\0]/.test(value)) throw new SecretError('value must be one line');
  // A key goes in a header, so it must be one a header can carry (checkCredential, S-2115); the
  // message names what is wrong, never the value.
  try {
    checkCredential(value.trim(), 'API key');
  } catch {
    throw new SecretError('value must be printable ASCII with no spaces');
  }
  if (input.slot !== undefined && input.slot !== 'stam' && input.slot !== 'agent') throw new SecretError('slot must be stam or agent');
  if (input.env !== undefined && input.env !== null && (typeof input.env !== 'string' || !ENV_RE.test(input.env))) throw new SecretError('env must be an environment variable name');
  if (input.provider !== undefined && (typeof input.provider !== 'string' || input.provider.length > 64)) throw new SecretError('provider must be a short string');
  const store = structuredClone(load());
  const prev = store.secrets[name];
  const env = input.env === null ? undefined : ((input.env as string | undefined) ?? prev?.env);
  const entry: Entry = {
    value: value.trim(),
    provider: (input.provider as string | undefined) ?? prev?.provider ?? '',
    slot: (input.slot as Slot | undefined) ?? prev?.slot ?? 'stam',
    ...(env ? { env } : {}),
    setAt: new Date().toISOString(),
  };
  store.secrets[name] = entry;
  write(store);
  return info(name, entry);
}

// Deletes a secret. False when there was none.
export function remove(name: string): boolean {
  const store = structuredClone(load());
  if (!store.secrets[name]) return false;
  delete store.secrets[name];
  write(store);
  return true;
}

// Records the result of testing a secret against its provider (the LLM layer's check).
// The detail is the provider's error text, which may echo the key in part (masked or not): the value
// and any long token-like run are cut out, and it is capped at 200 characters.
export function recordTest(name: string, result: { ok: boolean; detail?: string }): void {
  const store = structuredClone(load());
  const e = store.secrets[name];
  if (!e) return;
  const detail = result.detail ? scrub(result.detail, e.value) : '';
  e.test = { ok: result.ok, at: new Date().toISOString(), ...(detail ? { detail } : {}) };
  write(store);
}

// The store name of an MCP server's OAuth client secret (S-2736): `mcp-SLUG-HASH-client`. The slug is
// the server's name made to fit NAME_RE; the hash is of the raw name, so two names that sanitize alike
// (`a b` and `a-b`) never share a secret. Undefined when no such name can be made.
export function mcpClientSecretName(server: string): string | undefined {
  const slug = server.toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 40);
  const tag = createHash('sha256').update(server).digest('hex').slice(0, 8);
  const name = `mcp-${slug}-${tag}-client`;
  return NAME_RE.test(name) ? name : undefined;
}

// Stores an MCP server's client secret under its name, and returns the reference that takes its place.
// A value already under that name is replaced: it is the human's new value, or a new registration.
// Throws when the store refuses (unreadable, or a value it can't hold), so the caller writes nothing.
export function setMcpClientSecret(server: string, value: string): SecretRef {
  const name = mcpClientSecretName(server);
  if (!name) throw new SecretError(`${server} has no name the secret store can hold`);
  set(name, { value, provider: 'mcp' });
  return { secret: name };
}

export function scrub(text: string, value: string): string {
  return text
    .split(value)
    .join('[key]')
    .replace(/[A-Za-z0-9_\-*.]{16,}/g, '[…]')
    .slice(0, 200);
}
