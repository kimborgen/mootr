// Instructions, skills, and MCP servers across harnesses. Each harness loads only its
// own instruction files (Claude Code: CLAUDE.md and CLAUDE.local.md; OpenCode and Codex:
// AGENTS.md) and only from the folder it starts in and its parents. stam tells every
// agent about the instruction files its harness skips, including ones in subfolders of
// a multi-repo workspace, adds the user's instructions for all agents, and deploys
// skills and MCP servers to every harness.
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, symlinkSync, rmSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { join, dirname, relative, basename, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { STAM_HOME } from './config.ts';
import { render } from './templates.ts';
import type { SecretRef } from './secrets.ts';
import { peerShared, settings } from './settings.ts';
import { envVar } from './env.ts';

const NATIVE: Record<string, string[]> = {
  claude: ['CLAUDE.md', 'CLAUDE.local.md'],
  opencode: ['AGENTS.md'],
  codex: ['AGENTS.md'],
};
const ALL_FILES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md'];
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.venv', 'venv', '__pycache__', '.cache']);

export const GLOBAL_INSTRUCTIONS = join(STAM_HOME, 'instructions.md');
// The instructions for all agents: the settings home's instructions.md, which a peer reads from its
// shared cache when it has one (S-387), else its own file. '' when there is none.
export function globalInstructions(): string {
  const cached = peerShared()?.instructions;
  if (cached !== undefined) return cached;
  try {
    return readFileSync(GLOBAL_INSTRUCTIONS, 'utf8');
  } catch {
    return '';
  }
}
export const SKILLS_DIR = join(STAM_HOME, 'skills');

// The folder stam stops at when walking up: the git root, or the home folder.
function top(cwd: string): string {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return homedir();
  }
}

function upwards(cwd: string): string[] {
  return upwardDirs(cwd).flatMap((d) => ALL_FILES.filter((f) => existsSync(join(d, f))).map((f) => join(d, f)));
}

// The working folder and its parents up to the git root (or home), nearest first.
function upwardDirs(cwd: string): string[] {
  const stop = top(cwd);
  const out: string[] = [];
  for (let d = cwd; ; d = dirname(d)) {
    out.push(d);
    if (d === stop || d === dirname(d) || !d.startsWith(stop)) break;
  }
  return out;
}

// Instruction files below the working folder, two levels deep, which no harness loads
// when it starts in the parent folder.
function downwards(cwd: string, depth = 2): string[] {
  const out: string[] = [];
  const walk = (d: string, level: number) => {
    if (level > depth) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.has(e) || e.startsWith('.')) continue;
      const p = join(d, e);
      try {
        if (!statSync(p).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const f of ALL_FILES) if (existsSync(join(p, f))) out.push(join(p, f));
      walk(p, level + 1);
    }
  };
  walk(cwd, 1);
  return out;
}

function globalFiles(harness: string): string[] {
  const claudeGlobal = join(homedir(), '.claude', 'CLAUDE.md');
  const codexGlobal = join(homedir(), '.codex', 'AGENTS.md');
  return [
    ...(harness !== 'claude' && existsSync(claudeGlobal) ? [claudeGlobal] : []),
    ...(harness !== 'codex' && existsSync(codexGlobal) ? [codexGlobal] : []),
  ];
}

// The user-global instruction file a harness loads itself, if any.
function nativeGlobal(harness: string): string | undefined {
  const f = { claude: join(homedir(), '.claude', 'CLAUDE.md'), codex: join(homedir(), '.codex', 'AGENTS.md') }[harness];
  return f && existsSync(f) ? f : undefined;
}

export interface NativeInstructionFile {
  path: string;
  source: 'repo' | 'user-global';
}

// The instruction files the harness loads on its own, in the order it reads them: its
// global file, then from the git root down to the working folder, nearest last.
export function nativeFiles(harness: string, cwd: string): NativeInstructionFile[] {
  const names = NATIVE[harness] ?? [];
  const out: NativeInstructionFile[] = [];
  const global = nativeGlobal(harness);
  if (global) out.push({ path: global, source: 'user-global' });
  for (const d of upwardDirs(cwd).reverse()) {
    for (const f of names) {
      const p = join(d, f);
      if (existsSync(p)) out.push({ path: p, source: 'repo' });
    }
  }
  return out;
}

export interface InstructionsDetail {
  // The user's text added to every agent (`instructions.md`), empty when unset.
  global: string;
  // The note naming the files this harness skips, empty when there are none.
  note: string;
  native: NativeInstructionFile[];
}

// The Instructions section, split into its pieces so the Instructions view can show the
// all-agents text and the skipped-files note as separate parts.
export function instructionsDetail(harness: string, cwd: string): InstructionsDetail {
  const native = NATIVE[harness] ?? [];
  const here = upwards(cwd).filter((f) => !native.includes(basename(f)));
  const below = downwards(cwd);
  const globals = globalFiles(harness);
  const lines: string[] = [];
  if (here.length || globals.length)
    lines.push(
      'Read these instruction files before you start; your harness does not load them on its own. Where they speak to another harness, follow their intent:',
      ...[...globals, ...here].map((f) => `- ${f}`),
    );
  if (below.length)
    lines.push(
      '',
      'Subfolders of your workspace have their own instruction files. Before working in one of these folders, read its file:',
      ...below.map((f) => `- ${relative(cwd, f)}`),
    );
  const global = globalInstructions().trim();
  return { global, note: lines.join('\n'), native: nativeFiles(harness, cwd) };
}

// The Instructions section of an agent's system prompt.
export function instructionsPrompt(harness: string, cwd: string): string {
  const { global, note } = instructionsDetail(harness, cwd);
  if (!global && !note) return '';
  return render('instruction-files', { global, files: note });
}

// Every skill folder stam deploys: the user's Claude Code skills, then stam's own.
export function skillFolders(): { name: string; path: string; source: string }[] {
  const out = new Map<string, { name: string; path: string; source: string }>();
  for (const [source, dir] of [
    ['claude', join(homedir(), '.claude', 'skills')],
    ['stam', SKILLS_DIR],
  ] as const) {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {}
    for (const n of names) if (existsSync(join(dir, n, 'SKILL.md'))) out.set(n, { name: n, path: join(dir, n), source });
  }
  return [...out.values()];
}

// The "Skills available" block for an agent type that names skills (S-891): one line per skill with
// its description and the absolute path to its SKILL.md, which works on every harness because a skill
// is a file. A name with no skill folder any more is returned in `missing` and left out, never thrown on.
const SKILL_LINE_MAX = 240;
export function typeSkillsBlock(names: unknown): { text: string; missing: string[] } {
  const list = Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : [];
  const folders = new Map(skillFolders().map((s) => [s.name, s]));
  const lines: string[] = [];
  const missing: string[] = [];
  for (const n of [...new Set(list)]) {
    const s = folders.get(n);
    if (!s) {
      missing.push(n);
      continue;
    }
    let text = '';
    try {
      text = readFileSync(join(s.path, 'SKILL.md'), 'utf8');
    } catch {}
    const d = parseSkill(text).description.replace(/\s+/g, ' ').trim();
    lines.push(`- ${n}: ${d.length > SKILL_LINE_MAX ? `${d.slice(0, SKILL_LINE_MAX - 1)}…` : d || 'no description'} (${join(s.path, 'SKILL.md')})`);
  }
  if (!lines.length) return { text: '', missing };
  return { text: `## Skills available\n\nBefore you do work that matches a skill below, read its SKILL.md and follow it.\n\n${lines.join('\n')}`, missing };
}

// A Claude Code plugin holding stam's own skills (Claude Code already has the user's).
export function claudePluginDir(): string | undefined {
  const own = skillFolders().filter((s) => s.source === 'stam');
  if (!own.length) return undefined;
  const dir = join(STAM_HOME, 'claude-plugin');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  mkdirSync(join(dir, 'skills'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'stam-skills', description: 'Skills managed by stam', version: '1.0.0' }, null, 2));
  for (const s of own) symlinkSync(s.path, join(dir, 'skills', s.name));
  return dir;
}

// The folder Codex, OpenCode, Gemini CLI and others read user skills from.
// STAM_AGENTS_SKILLS moves it, so test daemons never write into the real one.
export const agentsSkillsDir = () => envVar('AGENTS_SKILLS') || join(homedir(), '.agents', 'skills');

const sourceDirs = () => [join(homedir(), '.claude', 'skills'), SKILLS_DIR];

// True for a symlink stam made: it points straight at SOURCE/NAME, the name it has itself.
function isOurLink(p: string): boolean {
  try {
    if (!lstatSync(p).isSymbolicLink()) return false;
    const to = readlinkSync(p);
    return sourceDirs().some((d) => to === join(d, basename(p)));
  } catch {
    return false;
  }
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

// Links every skill into a harness's skills folder, replacing links stam made before. Only links
// into stam's skill folders are removed or replaced; a real file or someone else's link stays, and
// a skill of the same name is then left unlinked.
export function linkSkills(target: string): void {
  mkdirSync(target, { recursive: true });
  // A target that is, or sits inside, a source folder would get stam's skills written into it.
  const t = real(target);
  if (sourceDirs().some((d) => t === real(d) || t.startsWith(real(d) + sep))) return;
  for (const e of readdirSync(target)) if (isOurLink(join(target, e))) rmSync(join(target, e));
  for (const s of skillFolders()) if (!existsSync(join(target, s.name)) && !isLink(join(target, s.name))) symlinkSync(s.path, join(target, s.name));
}
// Links every harness's skills folder again after a skill was added or replaced (S-890).
export function relinkSkills(): void {
  for (const dir of [join(STAM_HOME, 'opencode', 'skills'), agentsSkillsDir()]) {
    try {
      linkSkills(dir);
    } catch {}
  }
  try {
    claudePluginDir();
  } catch {}
}
function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// What a SKILL.md says in its frontmatter: `name` and `description`, plain, quoted or folded (`>`, `|`).
export function parseSkill(text: string): { description: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { description: '', body: text };
  const lines = m[1].split(/\r?\n/);
  let description = '';
  const i = lines.findIndex((l) => /^description\s*:/.test(l));
  if (i >= 0) {
    const first = lines[i].replace(/^description\s*:\s*/, '');
    const rest: string[] = [];
    for (const l of lines.slice(i + 1)) {
      if (/^\S/.test(l)) break;
      rest.push(l.trim());
    }
    const folded = /^[>|][+-]?$/.test(first);
    description = (folded ? rest : [first, ...rest]).filter(Boolean).join(' ');
    description = description.replace(/^(["'])([\s\S]*)\1$/, '$2');
  }
  return { description, body: text.slice(m[0].length) };
}

export type SkillHarness = 'claude' | 'opencode' | 'codex';
export type SkillReach = 'native' | 'prompt' | 'unreachable';
export interface SkillInfo {
  name: string;
  path: string;
  // user: ~/.claude/skills; stam: STAM_HOME/skills; imported: a stam skill with an origin.json.
  source: 'user' | 'stam' | 'imported';
  description: string;
  body: string;
  // Tokens of SKILL.md (bytes / 4) and of its other files, estimates.
  tokens: number;
  extraTokens: number;
  reaches: Record<SkillHarness, SkillReach>;
  // Where an imported skill came from (origin.json, S-890).
  origin?: { url: string; path: string; commit: string; date: string };
}

function folderBytes(dir: string, skip: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (p === skip) continue;
    try {
      n += e.isDirectory() ? folderBytes(p, skip) : statSync(p).size;
    } catch {}
  }
  return n;
}

// Every skill with what Settings › Skills shows. A harness reaches a skill natively when its
// skills folder holds it: Claude Code reads the user folder and stam's plugin, OpenCode and Codex
// the folders linkSkills fills (STAM_HOME/opencode/skills, and ~/.agents/skills), which are checked on disk.
export function skillInfos(): SkillInfo[] {
  const opencodeDir = join(STAM_HOME, 'opencode', 'skills');
  return skillFolders().map((s) => {
    // The harness's folder holds this skill, not a different one of the same name.
    const has = (dir: string, name: string) => existsSync(join(dir, name, 'SKILL.md')) && real(join(dir, name)) === real(s.path);
    const file = join(s.path, 'SKILL.md');
    let text = '';
    let bytes = 0;
    try {
      text = readFileSync(file, 'utf8');
      bytes = Buffer.byteLength(text);
    } catch {}
    let extra = 0;
    try {
      extra = folderBytes(s.path, file);
    } catch {}
    const { description, body } = parseSkill(text);
    const source = s.source === 'claude' ? 'user' : existsSync(join(s.path, 'origin.json')) ? 'imported' : 'stam';
    let origin: SkillInfo['origin'];
    if (source === 'imported') {
      try {
        const o = JSON.parse(readFileSync(join(s.path, 'origin.json'), 'utf8'));
        origin = { url: String(o.url), path: String(o.path ?? ''), commit: String(o.commit ?? ''), date: String(o.date ?? '') };
      } catch {}
    }
    return {
      name: s.name,
      path: s.path,
      source,
      ...(origin ? { origin } : {}),
      description,
      body,
      tokens: Math.ceil(bytes / 4),
      extraTokens: Math.ceil(extra / 4),
      reaches: {
        claude: 'native',
        opencode: has(opencodeDir, s.name) ? 'native' : 'unreachable',
        codex: has(agentsSkillsDir(), s.name) ? 'native' : 'unreachable',
      },
    };
  });
}

// How a remote MCP server authenticates (S-50). The token itself never lives here: it is
// held by the daemon in STAM_HOME/mcp-auth.json, and every harness reaches the server
// through `stam mcp-proxy NAME` (see mcp-auth.ts and mcp-proxy.ts). `gh` reuses the user's
// `gh` login; `oauth` follows the MCP authorization spec, with a dynamic client
// registration when no client_id is given.
// The client secret is a reference into the secret store (S-2736); a plain string is the old form,
// moved into the store at start.
export type McpAuth = { type: 'gh' } | { type: 'oauth'; client_id?: string; client_secret?: SecretRef | string; scopes?: string[] };

// One MCP server from settings.mcpServers, in Claude Code's format: a stdio server has
// `command`, `args`, and `env`; a remote one has `url` and `headers`. A remote server with
// `auth` is reached through the stam proxy instead of its url. `enabled: false` keeps a
// server out of every harness. This is the stored form all three harnesses translate from,
// so the type lives here, once.
export interface McpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  auth?: McpAuth;
  enabled?: boolean;
  // Lets a peer lease this server's access token from the home (S-3176). Off by default: sharing is per server.
  shareWithPeers?: boolean;
  // The longest lifetime, in seconds, a peer may lease for this server (S-3176). Absent means 3600; any
  // other value refuses the lease.
  leaseMaxSeconds?: number;
}

// The MCP servers every harness gets, from settings.mcpServers: the enabled ones only.
export function extraMcpServers(): Record<string, McpServer> {
  const out: Record<string, McpServer> = {};
  for (const [name, s] of Object.entries(settings().mcpServers ?? {})) if (s && s.enabled !== false) out[name] = s;
  return out;
}
