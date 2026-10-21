import { homedir, hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { envVar } from './env.ts';

export const ROOT = join(import.meta.dirname, '..');
// The live home, which a test daemon never uses: tests set STAM_HOME to a throwaway folder.
export const DEFAULT_STAM_HOME = join(homedir(), '.local', 'share', 'stam');
// The renamed home (S-2889) is used only when it exists and the stam home doesn't: nothing is created, moved or linked.
const MOOTR_DEFAULT_HOME = join(homedir(), '.local', 'share', 'mootr');
const defaultHome = !existsSync(DEFAULT_STAM_HOME) && existsSync(MOOTR_DEFAULT_HOME) ? MOOTR_DEFAULT_HOME : DEFAULT_STAM_HOME;
export const STAM_HOME = envVar('HOME') ?? defaultHome;
// Whether this is the live home (S-422): never a test home, so test-only switches, such as
// STAM_TEST_HUMAN_KEY, do nothing here (src/test-env.ts gates them on the test-home marker).
const isHome = (home: string) => {
  try {
    return realpathSync(STAM_HOME) === realpathSync(home);
  } catch {
    return resolve(STAM_HOME) === resolve(home);
  }
};
export const LIVE_HOME = isHome(DEFAULT_STAM_HOME) || isHome(MOOTR_DEFAULT_HOME);
// `stam deploy` builds releases into RELEASES/SHA and points RELEASES/current at the live one.
export const RELEASES = join(STAM_HOME, 'releases');
const realReleases = (() => {
  try {
    return realpathSync(RELEASES);
  } catch {
    return undefined;
  }
})();
// The release this code runs from, or null when it runs from a checkout.
// STAM_RELEASE_ID names the release in a test daemon, which runs from a checkout.
export const RELEASE = envVar('RELEASE_ID') ?? (realReleases && dirname(ROOT) === realReleases ? basename(ROOT) : null);
// A release hands agents (MCP shim, hooks, statusline) the stable `current` path, so they
// follow deploys and never pin a release that gets pruned. A checkout hands out its own.
export const STAM_BIN = RELEASE ? join(RELEASES, 'current', 'bin', 'stam') : join(ROOT, 'bin', 'stam');
export const PORT = Number(envVar('PORT') ?? 7878);
export const STAM_URL = envVar('URL') ?? `http://127.0.0.1:${PORT}`;
// The tmux server a home keeps its agents' terminals in: a tmux socket *name* (`tmux -L`), a short word,
// not a path. The default `stam` is one name for the whole machine, so a second home here needs its own
// (`STAM_TMUX_SOCKET=other`), or its agents land in the first home's tmux server (export/README.public.md).
export const TMUX_SOCKET = envVar('TMUX_SOCKET') ?? 'stam';
export const MACHINE = envVar('MACHINE') ?? hostname();

// Private to the user: it holds generated settings, and Codex refuses a socket in a
// folder other users could write to.
export function agentDir(id: string): string {
  const dir = join(STAM_HOME, 'agents', id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(join(STAM_HOME, 'agents'), 0o700);
  chmodSync(dir, 0o700);
  return dir;
}

// The daemon creates the token on first start; the CLI, hooks, and MCP shim read it. The daemon
// reads the file only: a daemon started from an agent's shell would otherwise take that agent's
// STAM_TOKEN as the shared token (S-240).
export function ensureToken(): string {
  mkdirSync(STAM_HOME, { recursive: true });
  // The home holds secrets (S-743): keep it, and the token files, to this user. A same-user agent
  // still reads them, which needs OS isolation (docs/human-auth-design.md tier 2).
  try {
    chmodSync(STAM_HOME, 0o700);
  } catch {}
  const file = join(STAM_HOME, 'token');
  if (!existsSync(file)) writeFileSync(file, randomBytes(24).toString('base64url'), { mode: 0o600 });
  else try {
    chmodSync(file, 0o600);
  } catch {}
  return readFileSync(file, 'utf8').trim();
}

// The peer token (S-545): what other daemons send, kept apart from the shared token so a daemon can
// tell a peer from a local holder of the shared token. Copy it to the other machine's
// settings.peers[].peerToken.
export function ensurePeerToken(): string {
  mkdirSync(STAM_HOME, { recursive: true });
  const file = join(STAM_HOME, 'peer-token');
  if (!existsSync(file)) writeFileSync(file, randomBytes(24).toString('base64url'), { mode: 0o600 });
  else try {
    chmodSync(file, 0o600);
  } catch {}
  return readFileSync(file, 'utf8').trim();
}

export function readToken(): string | undefined {
  if (envVar('TOKEN')) return envVar('TOKEN');
  try {
    return readFileSync(join(STAM_HOME, 'token'), 'utf8').trim();
  } catch {
    return undefined;
  }
}

// The test base folder (test/tmpdir.sh): STAM_TEST_TMPDIR, or ~/.cache/stam-test when /tmp is a
// tmpfs; '' when tests use /tmp itself.
export function testTmpBase(): string {
  const tmpfs = spawnSync('stat', ['-f', '-c', '%T', '/tmp'], { encoding: 'utf8' }).stdout?.trim() === 'tmpfs';
  return envVar('TEST_TMPDIR') || (tmpfs ? join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'stam-test') : '');
}
