// `stam doctor` (S-2894): what is missing on this machine for a first run, and how to fix each gap. Every check is
// read-only: it reads the environment, PATH and the filesystem, makes no write, starts no process, and prints no secret.
// It works with no daemon running. When one answers, the gaps of GET /api/onboarding (src/onboarding.ts) join the list.
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { envVar } from './env.ts';

export type CheckStatus = 'ok' | 'warn' | 'fail';
export interface Check {
  id: string;
  status: CheckStatus;
  message: string;
  // One line on how to fix a warn or fail.
  fix?: string;
}
export interface DoctorReport {
  ok: boolean;
  checks: Check[];
}

export interface DoctorInput {
  env?: NodeJS.ProcessEnv;
  home?: string;
  // The stam home folder and the daemon's port, as config.ts resolves them.
  stamHome: string;
  port: number;
  // The package.json whose engines.node is the Node requirement.
  packageJson: string;
  nodeVersion?: string;
  // The daemon's /api/health answer, through the CLI client so it carries the token (an unauthenticated probe gets a 401).
  // Throws when nothing answers; an error with `status` 401 or 403 means a daemon answered and refused the token.
  health?: (url: string) => Promise<{ ok?: boolean; release?: unknown }>;
  // The daemon's /api/onboarding answer, or null when none was asked for (tests pass a stub).
  onboarding?: (url: string) => Promise<{ gaps: string[] } | null>;
}

const executable = (file: string) => {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

// The first executable called `name` on PATH, or null.
export function onPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) if (dir && executable(join(dir, name))) return join(dir, name);
  return null;
}

// engines.node as ">=N": the least major version, or null when it is some other range.
function minMajor(range: string | undefined): number | null {
  const m = /^>=\s*(\d+)/.exec(range ?? '');
  return m ? Number(m[1]) : null;
}

const TOOL_FIX: Record<string, string> = {
  tmux: 'install tmux with your package manager (apt install tmux, brew install tmux)',
  git: 'install git with your package manager (apt install git, brew install git)',
};

function nodeCheck(i: DoctorInput): Check {
  const have = i.nodeVersion ?? process.version;
  let range: string | undefined;
  try {
    range = JSON.parse(readFileSync(i.packageJson, 'utf8')).engines?.node;
  } catch {}
  const need = minMajor(range);
  if (need === null) return { id: 'node', status: 'ok', message: `node ${have}` };
  const major = Number(/^v?(\d+)/.exec(have)?.[1]);
  if (major >= need) return { id: 'node', status: 'ok', message: `node ${have} (needs ${range})` };
  return { id: 'node', status: 'fail', message: `node ${have} is older than ${range}`, fix: `install Node ${need} or newer (nvm install ${need})` };
}

function toolChecks(env: NodeJS.ProcessEnv): Check[] {
  const out: Check[] = [];
  for (const tool of ['tmux', 'git']) {
    const at = onPath(tool, env);
    out.push(at ? { id: tool, status: 'ok', message: `${tool} at ${at}` } : { id: tool, status: 'fail', message: `${tool} is not on PATH`, fix: TOOL_FIX[tool] });
  }
  // Used only by parts of stam: a missing one limits that part and nothing else.
  const optional: [string, string, string][] = [
    ['systemctl', 'stam daemon install needs systemd', 'on a machine without systemd, run `stam daemon start` instead'],
    ['gh', 'pull requests from `stam pr open` need the GitHub CLI', 'install gh (https://cli.github.com) and run `gh auth login`'],
    ['tailscale', 'stam web serve needs Tailscale', 'install Tailscale (https://tailscale.com/download), or reach the web UI on 127.0.0.1'],
  ];
  for (const [tool, why, fix] of optional) {
    const at = onPath(tool, env);
    out.push(at ? { id: tool, status: 'ok', message: `${tool} at ${at}` } : { id: tool, status: 'warn', message: `${tool} is not on PATH: ${why}`, fix });
  }
  return out;
}

function harnessCheck(env: NodeJS.ProcessEnv, home: string): Check {
  // The adapters' own lookups: the *_BIN variable, a known install folder, then PATH.
  const candidates: [string, string[]][] = [
    ['claude', [envVar('CLAUDE_BIN', env) ?? '']],
    ['codex', [envVar('CODEX_BIN', env) ?? '', join(home, '.local/bin/codex')]],
    ['opencode', [envVar('OPENCODE_BIN', env) ?? '', join(home, '.opencode/bin/opencode')]],
  ];
  const found: string[] = [];
  for (const [name, files] of candidates) if (files.some((f) => f && executable(f)) || onPath(name, env)) found.push(name);
  if (found.length) return { id: 'harness', status: 'ok', message: `harness installed: ${found.join(', ')}` };
  return {
    id: 'harness',
    status: 'fail',
    message: 'no harness is installed (claude, codex or opencode)',
    fix: 'install one: npm install -g @anthropic-ai/claude-code, npm install -g @openai/codex, or https://opencode.ai',
  };
}

function homeCheck(stamHome: string): Check {
  if (!existsSync(stamHome)) {
    // The daemon creates it on first start; the closest existing parent has to allow that.
    let parent = stamHome;
    while (!existsSync(parent) && parent !== join(parent, '..')) parent = join(parent, '..');
    try {
      accessSync(parent, constants.W_OK);
      return { id: 'home', status: 'warn', message: `${stamHome} does not exist yet`, fix: 'the daemon creates it on first start' };
    } catch {
      return { id: 'home', status: 'fail', message: `${stamHome} does not exist and ${parent} is not writable`, fix: 'set STAM_HOME to a folder you can write' };
    }
  }
  try {
    accessSync(stamHome, constants.W_OK);
    return { id: 'home', status: 'ok', message: `${stamHome} is writable` };
  } catch {
    return { id: 'home', status: 'fail', message: `${stamHome} is not writable`, fix: `chmod u+w ${stamHome}, or set STAM_HOME to a folder you can write` };
  }
}

// Whether the port is free, by binding it on loopback (and closing at once): 'used' on EADDRINUSE, an error code
// (EACCES, ...) when the bind fails for another reason, which says nothing about whether the port is free.
function portState(port: number): Promise<'free' | 'used' | string> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'EADDRINUSE' ? 'used' : (e.code ?? 'error')));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve('free')));
  });
}

type Served = 'stam' | 'refused' | 'none';

// 'refused': a daemon answered but not to this token. Its JSON error body is what the client turns into a status.
async function servesStam(i: DoctorInput, url: string): Promise<Served> {
  if (!i.health) return 'none';
  try {
    const body = await i.health(url);
    return body?.ok === true && 'release' in body ? 'stam' : 'none';
  } catch (e) {
    const status = (e as { status?: number }).status;
    return status === 401 || status === 403 ? 'refused' : 'none';
  }
}

// Whether `url` is this machine's own port (the default), as opposed to a daemon elsewhere.
function isLocalPort(url: string, port: number): boolean {
  try {
    const u = new URL(url);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && Number(u.port || 80) === port;
  } catch {
    return false;
  }
}

export async function doctor(i: DoctorInput): Promise<DoctorReport> {
  const env = i.env ?? process.env;
  const home = i.home ?? homedir();
  const checks: Check[] = [nodeCheck(i), ...toolChecks(env), harnessCheck(env, home), homeCheck(i.stamHome)];
  const url = envVar('URL', env) ?? `http://127.0.0.1:${i.port}`;
  const served = await servesStam(i, url);
  const local = isLocalPort(url, i.port);
  if (served === 'stam') checks.push({ id: 'port', status: 'ok', message: local ? `port ${i.port} is serving stam` : `the daemon at ${url} is serving stam` });
  else if (served === 'refused') checks.push({ id: 'port', status: 'warn', message: `a daemon answers at ${url} but refused this CLI's token`, fix: 'set STAM_TOKEN to the token in STAM_HOME/token of that daemon' });
  else if (!local) checks.push({ id: 'port', status: 'warn', message: `STAM_URL points at ${url}, which does not answer`, fix: 'start the daemon there, or unset STAM_URL to use this machine' });
  else {
    const state = await portState(i.port);
    if (state === 'free') checks.push({ id: 'port', status: 'ok', message: `port ${i.port} is free` });
    else if (state === 'used') checks.push({ id: 'port', status: 'fail', message: `port ${i.port} is in use by something that is not stam`, fix: 'stop that process, or set STAM_PORT to a free port' });
    else checks.push({ id: 'port', status: 'fail', message: `port ${i.port} cannot be checked (${state})`, fix: 'set STAM_PORT to a port above 1024 that you may bind' });
  }
  const serving = served === 'stam';
  if (serving && i.onboarding) {
    try {
      const o = await i.onboarding(url);
      if (o?.gaps.length) for (const g of o.gaps) checks.push({ id: 'onboarding', status: 'warn', message: g, fix: 'see `stam onboarding` for the full status' });
      else if (o) checks.push({ id: 'onboarding', status: 'ok', message: 'the daemon reports no setup gaps' });
    } catch (e) {
      checks.push({ id: 'onboarding', status: 'warn', message: `the daemon is up but its onboarding status failed: ${(e as Error).message}`, fix: 'run `stam onboarding`' });
    }
  }
  return { ok: !checks.some((c) => c.status === 'fail'), checks };
}

// One line per check, and a fix line under each warn or fail.
export function formatReport(r: DoctorReport): string {
  const lines: string[] = [];
  for (const c of r.checks) {
    lines.push(`${c.status.padEnd(4)}  ${c.message}`);
    if (c.fix && c.status !== 'ok') lines.push(`      fix: ${c.fix}`);
  }
  return lines.join('\n');
}
