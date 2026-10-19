// Import existing MCP servers from the harnesses' own configs (S-52). Read-only: it scans the
// files a harness already has and reports what each server is and where it came from, so the
// Settings section can add them to settings.mcpServers. Only the user-level and project
// configs are read; stam's own per-agent configs (under STAM_HOME) are never touched, and
// stam's own `stam` server is skipped.
//
//   Claude Code  ~/.claude.json (top-level mcpServers and each projects[path].mcpServers),
//                and .mcp.json in each distinct agent folder and its git root.
//   Codex        ~/.codex/config.toml.
//   OpenCode     ~/.config/opencode/opencode.json and .jsonc (its user config).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { serversFromJson, serversFromToml, type ParsedServer } from './mcp-config.ts';
import type { McpServer } from './instructions.ts';

export interface ImportedServer {
  name: string;
  server: McpServer;
  // The source, for grouping in the UI: a file, or a file and the project it names.
  group: string;
  file: string;
  // The project path, for a Claude projects[] entry.
  path?: string;
  note?: string;
  status: 'new' | 'same' | 'differs';
  // What differs, when stam already has a server of that name (values stay masked).
  differences?: string[];
}

export interface ScanOptions {
  home: string;
  cwds: string[];
  existing: Record<string, McpServer>;
}

const isObj = (v: unknown): v is Record<string, any> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// JSON with // and /* */ comments, and trailing commas, removed (OpenCode writes .jsonc).
export function stripJsonc(text: string): string {
  let out = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      out += c;
      if (c === '\\') { out += text[++i] ?? ''; continue; }
      if (c === '"') q = false;
      continue;
    }
    if (c === '"') { q = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += c;
  }
  return out;
}

const sorted = (o?: Record<string, string>) => (o ? Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))) : null);
const norm = (s: McpServer) => JSON.stringify({ command: s.command ?? null, args: s.args ?? [], env: sorted(s.env), url: s.url ?? null, headers: sorted(s.headers), auth: s.auth ?? null, enabled: s.enabled !== false });

// Whether two servers are the same, comparing maps by key so order never matters.
export const sameServer = (a: McpServer, b: McpServer) => norm(a) === norm(b);

const show = (v: unknown) => (v === undefined || v === null ? '—' : typeof v === 'string' ? v : JSON.stringify(v));

// The fields that differ, with values masked for env and headers (names only).
function describeDifferences(existing: McpServer, found: McpServer): string[] {
  const out: string[] = [];
  for (const k of ['command', 'args', 'url', 'auth', 'enabled'] as const) {
    const a = k === 'enabled' ? existing.enabled !== false : existing[k];
    const b = k === 'enabled' ? found.enabled !== false : found[k];
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) out.push(`${k}: ${show(a)} → ${show(b)}`);
  }
  for (const k of ['env', 'headers'] as const) {
    const a = existing[k] ?? {};
    const b = found[k] ?? {};
    const onlyA = Object.keys(a).filter((x) => !(x in b));
    const onlyB = Object.keys(b).filter((x) => !(x in a));
    const changed = Object.keys(a).filter((x) => x in b && a[x] !== b[x]);
    if (onlyA.length) out.push(`${k}: only in stam: ${onlyA.join(', ')}`);
    if (onlyB.length) out.push(`${k}: only found: ${onlyB.join(', ')}`);
    if (changed.length) out.push(`${k}: value differs: ${changed.join(', ')}`);
  }
  return out;
}

// Each agent folder and its git root, so a .mcp.json at the repo root is found too.
function dirsToCheck(cwds: string[]): string[] {
  const dirs = new Set<string>();
  for (const cwd of cwds) {
    if (!cwd) continue;
    dirs.add(cwd);
    try {
      const root = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (root) dirs.add(root);
    } catch {}
  }
  return [...dirs];
}

function readJson(file: string): any | undefined {
  try {
    const parsed = JSON.parse(stripJsonc(readFileSync(file, 'utf8')));
    return isObj(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// Scan every harness config and report the servers found, each marked against what stam
// already has.
export function scanHarnesses({ home, cwds, existing }: ScanOptions): ImportedServer[] {
  const out: ImportedServer[] = [];
  const tilde = (p: string) => (p === home ? '~' : p.startsWith(home + '/') ? '~' + p.slice(home.length) : p);
  const add = (f: ParsedServer, group: string, file: string, path?: string) => {
    if (f.name === 'stam') return;
    const e: ImportedServer = { name: f.name, server: f.server, group, file, path, note: f.note, status: 'new' };
    const cur = existing[f.name];
    if (cur) {
      if (sameServer(cur, f.server)) e.status = 'same';
      else { e.status = 'differs'; e.differences = describeDifferences(cur, f.server); }
    }
    out.push(e);
  };

  const claudeFile = join(home, '.claude.json');
  const claude = readJson(claudeFile);
  if (claude) {
    for (const f of serversFromJson({ mcpServers: claude.mcpServers })) add(f, '~/.claude.json', claudeFile);
    if (isObj(claude.projects))
      for (const [path, proj] of Object.entries<Record<string, any>>(claude.projects)) {
        if (!isObj(proj)) continue;
        for (const f of serversFromJson({ mcpServers: proj.mcpServers })) add(f, `~/.claude.json · ${tilde(path)}`, claudeFile, path);
      }
  }

  for (const dir of dirsToCheck(cwds)) {
    const file = join(dir, '.mcp.json');
    if (!existsSync(file)) continue;
    let json: any;
    try {
      json = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    for (const f of serversFromJson(json)) add(f, tilde(file), file);
  }

  const codexFile = join(home, '.codex', 'config.toml');
  if (existsSync(codexFile)) {
    try {
      for (const f of serversFromToml(readFileSync(codexFile, 'utf8'))) add(f, '~/.codex/config.toml', codexFile);
    } catch {}
  }

  for (const name of ['opencode.json', 'opencode.jsonc']) {
    const file = join(home, '.config', 'opencode', name);
    const json = readJson(file);
    if (!json) continue;
    for (const f of serversFromJson(json)) add(f, tilde(file), file);
  }

  return out;
}
