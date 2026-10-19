// Browse the official MCP registry and turn each server into stam install options (S-53).
// The registry is public, no auth: GET <base>?search=&limit=30&cursor= returns
// { servers: [{ server, _meta }], metadata: { nextCursor } }. Only the latest version of each
// name is shown. STAM_MCP_REGISTRY_URL points the fetch at a fake registry in tests, and each
// response is cached for ten minutes.
import { SSE_NOTE } from './mcp-config.ts';
import type { McpServer } from './instructions.ts';

// One input a server needs before it can run: a remote header or a package env var.
export interface RegistryField {
  name: string;
  description?: string;
  required?: boolean;
  secret?: boolean;
  prefill?: string;
  in: 'headers' | 'env';
}

// One way to reach a server, ready to become a settings.mcpServers entry.
export interface RegistryOption {
  kind: 'remote' | 'local';
  label: string;
  server: McpServer;
  fields: RegistryField[];
  // A caveat about this option alone, such as an SSE url.
  note?: string;
}

export interface RegistryEntry {
  name: string;
  title?: string;
  description?: string;
  version: string;
  websiteUrl?: string;
  repository?: string;
  options: RegistryOption[];
}

export interface RegistryPage {
  servers: RegistryEntry[];
  nextCursor?: string;
}

const base = () => process.env.STAM_MCP_REGISTRY_URL || 'https://registry.modelcontextprotocol.io/v0.1/servers';
const CACHE_MS = 600_000;
const cache = new Map<string, { at: number; page: RegistryPage }>();

const official = (entry: any) => entry?._meta?.['io.modelcontextprotocol.registry/official'] ?? {};
const publisher = (s: any) => s?._meta?.['io.modelcontextprotocol.registry/publisher-provided'] ?? {};

// Compare two versions, numerically where the parts are numbers (1.2.10 > 1.2.9).
export function compareVersions(a: string, b: string): number {
  const pa = String(a).split('.');
  const pb = String(b).split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i]);
    const nb = Number(pb[i]);
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return na - nb;
    } else {
      const c = String(pa[i] ?? '').localeCompare(String(pb[i] ?? ''));
      if (c) return c;
    }
  }
  return 0;
}

// One entry per server name: the one flagged latest, or else its highest version.
export function latestOnly(entries: any[]): any[] {
  const byName = new Map<string, any[]>();
  for (const e of entries) {
    const n = e?.server?.name;
    if (!n) continue;
    const list = byName.get(n) ?? [];
    list.push(e);
    byName.set(n, list);
  }
  const out: any[] = [];
  for (const list of byName.values()) {
    const latest = list.find((e) => official(e).isLatest === true) ?? list.slice().sort((a, b) => compareVersions(String(b?.server?.version ?? ''), String(a?.server?.version ?? '')))[0];
    out.push(latest);
  }
  return out;
}

// The fixed arguments of a package, in order: positional values as-is, a named one as
// --name=value. An argument with no fixed value is a user input and is skipped.
function fixedArgs(list: unknown): string[] {
  const out: string[] = [];
  for (const a of Array.isArray(list) ? list : []) {
    if (!a || typeof a !== 'object') continue;
    if (a.type === 'positional' && a.value != null) out.push(String(a.value));
    else if (a.type === 'named' && a.value != null) out.push(`--${a.name}=${a.value}`);
  }
  return out;
}

// npm, PyPI, and OCI packages into a command line, following the registry's own hints.
const RUN: Record<string, (id: string, version: string) => string[]> = {
  npm: (id, v) => ['npx', '-y', `${id}@${v}`],
  pypi: (id, v) => ['uvx', `${id}==${v}`],
  oci: (id, v) => ['docker', 'run', '-i', '--rm', `${id}:${v}`],
};

function packageOption(p: any): RegistryOption | null {
  const build = RUN[p?.registryType];
  if (!build || !p.identifier) return null;
  const args = build(String(p.identifier), String(p.version ?? ''));
  // A fixed argument already in the command (npm's runtime -y, say) is not added twice.
  for (const a of [...fixedArgs(p.packageArguments), ...fixedArgs(p.runtimeArguments)]) if (!args.includes(a)) args.push(a);
  const fields: RegistryField[] = [];
  for (const e of Array.isArray(p.environmentVariables) ? p.environmentVariables : []) {
    if (!e?.name) continue;
    // A value with no {placeholder} is fixed; a default pre-fills a non-secret field.
    const fixed = typeof e.value === 'string' && !e.value.includes('{');
    const prefill = fixed ? String(e.value) : typeof e.default === 'string' ? e.default : undefined;
    fields.push({ in: 'env', name: String(e.name), description: e.description, required: !fixed && e.isRequired === true, secret: e.isSecret === true, prefill });
  }
  return { kind: 'local', label: `${p.registryType} · ${args.join(' ')}`, server: { command: args[0], args: args.slice(1) }, fields };
}

function remoteOption(r: any): RegistryOption | null {
  if (!r?.url) return null;
  const fields: RegistryField[] = [];
  for (const h of Array.isArray(r.headers) ? r.headers : []) {
    if (!h?.name) continue;
    const templated = typeof h.value === 'string' && h.value.includes('{');
    const fixed = typeof h.value === 'string' && !templated;
    fields.push({ in: 'headers', name: String(h.name), description: h.description, required: !fixed && h.isRequired !== false, secret: h.isSecret === true, prefill: fixed ? String(h.value) : undefined });
  }
  const option: RegistryOption = { kind: 'remote', label: `Remote · ${r.url}`, server: { url: String(r.url) }, fields };
  if (r.type === 'sse') option.note = SSE_NOTE;
  return option;
}

// A remote over a package by default; streamable-http over sse when both exist.
export function optionsFor(server: any): RegistryOption[] {
  const remotes: any[] = Array.isArray(server?.remotes) ? server.remotes : [];
  const streamable = remotes.filter((r) => r?.type === 'streamable-http');
  const chosen = streamable.length ? streamable : remotes.filter((r) => r?.type === 'sse');
  const options: RegistryOption[] = [];
  for (const r of chosen) {
    const o = remoteOption(r);
    if (o) options.push(o);
  }
  for (const p of Array.isArray(server?.packages) ? server.packages : []) {
    const o = packageOption(p);
    if (o) options.push(o);
  }
  return options;
}

function toEntry(s: any): RegistryEntry {
  return {
    name: String(s.name ?? ''),
    title: typeof s.title === 'string' ? s.title : typeof publisher(s).title === 'string' ? publisher(s).title : undefined,
    description: typeof s.description === 'string' ? s.description : undefined,
    version: String(s.version ?? ''),
    websiteUrl: typeof s.websiteUrl === 'string' ? s.websiteUrl : undefined,
    repository: typeof s.repository?.url === 'string' ? s.repository.url : undefined,
    options: optionsFor(s),
  };
}

// A page of registry servers, from the cache when it is under ten minutes old.
export async function browseRegistry({ search = '', cursor }: { search?: string; cursor?: string } = {}): Promise<RegistryPage> {
  const key = `${search}\u0000${cursor ?? ''}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.page;
  const u = new URL(base());
  u.searchParams.set('limit', '30');
  if (search) u.searchParams.set('search', search);
  if (cursor) u.searchParams.set('cursor', cursor);
  const res = await fetch(u, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000), redirect: 'manual' });
  if (!res.ok) throw new Error(`the MCP registry answered HTTP ${res.status}`);
  const json: any = await res.json().catch(() => ({}));
  const page: RegistryPage = {
    servers: latestOnly(Array.isArray(json?.servers) ? json.servers : []).map((e) => toEntry(e.server)),
    nextCursor: json?.metadata?.nextCursor ? String(json.metadata.nextCursor) : undefined,
  };
  cache.set(key, { at: Date.now(), page });
  return page;
}

// The login a remote server is likely to need, decided when it is added, not for the whole
// list: GitHub's server takes the GitHub CLI; any other 401 with a WWW-Authenticate header
// takes OAuth; anything else takes none. No credential is sent to find out.
export async function remoteAuth(url: string): Promise<'gh' | 'oauth' | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(u.protocol)) return null;
  if (/(^|\.)githubcopilot\.com$/i.test(u.hostname)) return 'gh';
  try {
    const res = await fetch(u, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(4000),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stam', version: '2' } } }),
    });
    if (res.status === 401 && res.headers.get('www-authenticate')) return 'oauth';
  } catch {}
  return null;
}
