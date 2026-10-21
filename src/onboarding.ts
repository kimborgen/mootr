// Onboarding status (S-2145): what a fresh install still lacks, for the assistant's onboarding block
// (blocks/assistant/30-onboarding.md) and `stam onboarding`. Every check is a cheap file or settings read, never a
// model call and never a spend: a harness counts as logged in when its credentials file (or API key variable)
// exists, which says nothing about whether the credentials still work.
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface HarnessStatus {
  installed: boolean;
  version: string | null;
  // 'unknown' where the login can't be read from a file: Claude's login on macOS is in the Keychain.
  loggedIn: boolean | 'unknown';
  // What the login check looked at, so a gap can be named: "~/.codex/auth.json".
  via: string;
}

export interface OnboardingStatus {
  harnesses: Record<string, HarnessStatus>;
  // Provider keys: the metadata of GET /api/secrets (S-2114), or 'unknown' when the route doesn't exist.
  providers: unknown;
  network: { localHuman: boolean };
  // `derived`: the repo stam derives from its own checkout; it is listed but never a gap.
  repos: { name: string; path: string; exists: boolean; derived?: boolean }[];
  cos: { exists: boolean; name: string | null };
  // The gaps, in the order to walk them. Empty when the install is set up.
  gaps: string[];
}

// Where each harness keeps its login. `env` names a variable that also counts.
function loginFiles(home: string, env: NodeJS.ProcessEnv): Record<string, { files: string[]; env?: string }> {
  return {
    claude: { files: [join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), '.credentials.json')], env: 'ANTHROPIC_API_KEY' },
    codex: { files: [join(env.CODEX_HOME || join(home, '.codex'), 'auth.json')], env: 'OPENAI_API_KEY' },
    opencode: { files: [join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode', 'auth.json')] },
  };
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

export function harnessStatus(versions: Record<string, string | null>, home = homedir(), env = process.env, platform: string = process.platform): Record<string, HarnessStatus> {
  const out: Record<string, HarnessStatus> = {};
  const logins = loginFiles(home, env);
  for (const [name, version] of Object.entries(versions)) {
    const l = logins[name];
    const file = l?.files.find((f) => existsSync(f));
    const viaEnv = l?.env && env[l.env] ? l.env : '';
    out[name] = {
      installed: !!version,
      version,
      loggedIn: file || viaEnv ? true : name === 'claude' && platform === 'darwin' ? 'unknown' : false,
      via: file ?? (viaEnv || l?.files[0] || 'unknown harness'),
    };
  }
  return out;
}

export interface OnboardingInput {
  versions: Record<string, string | null>;
  providers: unknown;
  localHuman: boolean;
  repos: Record<string, string>;
  // The repo stam derives from its own checkout (default-repo.ts). ensureSettings writes it into itsa.repos on a
  // fresh install, so it is compared by path: it is no repo of the user's.
  derivedRepos?: Record<string, string>;
  cos: string | null;
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string;
}

export function onboardingStatus(i: OnboardingInput): OnboardingStatus {
  const harnesses = harnessStatus(i.versions, i.home, i.env, i.platform);
  const derived = new Set(Object.values(i.derivedRepos ?? {}).map(real));
  const repos = Object.entries(i.repos).map(([name, path]) => ({ name, path, exists: existsSync(path), derived: derived.has(real(path)) }));
  const mine = repos.filter((r) => !r.derived);
  // Order: harness login, repos, chief of staff. localHuman off is no gap (it is false on Tailscale and Mac, and on every install from before S-2121). A missing harness is not a gap while another works,
  // and providers stay out until the secrets route exists (S-2114).
  const gaps: string[] = [];
  if (!Object.values(harnesses).some((h) => h.installed && h.loggedIn !== false)) gaps.push('no harness is installed and logged in');
  for (const r of mine) if (!r.exists) gaps.push(`repo ${r.name} is missing at ${r.path}`);
  if (!mine.length) gaps.push('no repo is configured');
  if (!i.cos) gaps.push('no chief of staff is running');
  return { harnesses, providers: i.providers, network: { localHuman: i.localHuman }, repos: repos.map(({ derived, ...r }) => ({ ...r, ...(derived ? { derived } : {}) })), cos: { exists: !!i.cos, name: i.cos }, gaps };
}
