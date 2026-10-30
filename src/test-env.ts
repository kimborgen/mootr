// The one gate for test-only env vars that relax auth, identity or permissions (S-634):
// STAM_TEST_HUMAN_KEY, STAM_TEST_INPUT_BARRIER, STAM_TEST_INPUT_CRASH (S-4155), the human-code vars of S-613, and STAM_TEST_PASSWORDLESS_SUDO (S-2121).
// A var is honoured only in a test home: not the live home, STAM_HOME holds the `.stam-test-home` marker
// that test/lib.sh's daemon_home writes, and its parent folder holds the `owner` file test/lib.sh writes
// into its throwaway TEST_TMP. A custom STAM_HOME with a restarted unit and the var set in its env does
// nothing, because neither file is there.
// This is an accident guard, not a security boundary: both files sit in places the same uid can write, so
// an agent that can restart the user's unit with an edited environment could also create them. That is
// the same tier-1 "out of API" class as replacing stam's code or the unit file, which S-426 accepts.
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { LIVE_HOME, STAM_HOME } from './config.ts';
import { envVar } from './env.ts';

export const TEST_HOME_MARKER = '.stam-test-home';

export function testHome(home: string, live = false): boolean {
  if (live || !home) return false;
  try {
    const h = realpathSync(home);
    return existsSync(join(h, TEST_HOME_MARKER)) && existsSync(join(dirname(h), 'owner'));
  } catch {
    return false;
  }
}

// The OpenCode binary a daemon on this home runs, or why it may run none (S-4237, S-107): the one boundary every launcher
// meets, a test script that calls runDaemon() itself included. Outside a test home, and in a smoke test (STAM_TEST_SMOKE),
// it is bin as given. A home with the test-home marker never runs the real OpenCode: the marker alone decides, not
// testHome()'s owner file too, so a test home made without lib.sh's owner file counts as well. There bin is resolved once,
// to an absolute path with every link followed, and that path is both what is judged and what runs, so a PATH or a cwd
// that differs at launch (the server's session, a TUI's shell) can't run another binary. A bare name is looked up on PATH;
// a relative path, a bare name not on PATH, or a path that isn't there is refused. The path is refused when it is one of
// the real ones, resolved the same way: ~/.opencode/bin/opencode (STAM_TEST_REAL_OPENCODE in the guard's own test) and
// `opencode` on PATH. checked marks a path judged here, which a caller that hands it to a shell quotes.
export function opencodeBinFor(bin: string, env: NodeJS.ProcessEnv = process.env, home = STAM_HOME, live = LIVE_HOME): { bin: string; checked?: true } | { refused: string } {
  if (live || !home || envVar('TEST_SMOKE', env)) return { bin };
  try {
    if (!existsSync(join(realpathSync(home), TEST_HOME_MARKER))) return { bin };
  } catch {
    return { bin };
  }
  const onPath = (name: string): string | undefined => {
    for (const dir of (env.PATH ?? '').split(':')) {
      if (!dir || !isAbsolute(dir)) continue;
      try {
        accessSync(join(dir, name), constants.X_OK);
        if (statSync(join(dir, name)).isFile()) return join(dir, name);
      } catch {}
    }
    return undefined;
  };
  const canonical = (p: string): string | undefined => {
    try {
      return realpathSync(p);
    } catch {
      return undefined;
    }
  };
  if (bin.includes('/') && !isAbsolute(bin)) return { refused: `OpenCode binary ${JSON.stringify(bin)} is a relative path, which this test home refuses: it could run another binary from the cwd it launches in` };
  const path = bin.includes('/') ? bin : onPath(bin);
  if (!path) return { refused: `OpenCode binary ${JSON.stringify(bin)} isn't a path and isn't on PATH, so this test home can't tell it from the real opencode` };
  const real = canonical(path);
  if (!real) return { refused: `OpenCode binary ${JSON.stringify(bin)} isn't there or doesn't resolve, so this test home can't tell it from the real opencode` };
  for (const r of [envVar('TEST_REAL_OPENCODE', env) ?? join(env.HOME ?? homedir(), '.opencode/bin/opencode'), onPath('opencode')]) {
    if (r && (canonical(r) ?? r) === real) return { refused: `refusing the real opencode (${real}) in a test home; only a smoke test (STAM_TEST_SMOKE) may run it` };
  }
  return { bin: real, checked: true };
}

// The value of a test-only env var, or undefined when this isn't a test home.
export function testOnlyEnv(name: string, env: NodeJS.ProcessEnv = process.env, home = STAM_HOME, live = LIVE_HOME): string | undefined {
  const v = envVar(name.replace(/^STAM_/, ''), env);
  return v && testHome(home, live) ? v : undefined;
}

// A test-only var is set but ignored here: the daemon warns once.
export function ignoredTestOnlyEnv(name: string, env: NodeJS.ProcessEnv = process.env, home = STAM_HOME, live = LIVE_HOME): boolean {
  return Boolean(envVar(name.replace(/^STAM_/, ''), env)) && !testHome(home, live);
}

// The `Environment=` lines of the service unit (S-2596): each name in `keys` that is set, written under its STAM_ name and its
// MOOTR_ twin (S-3345), with the value resolved once (a MOOTR_-only value, set by hand, is written under STAM_ too, so a
// rollback to an older release still reads it). STAM_TEST_COST_HOOKS is added in a test home only, so installing against the live home with the var set
// never writes it into the live unit.
export function serviceEnv(keys: string[], env: NodeJS.ProcessEnv = process.env, home = STAM_HOME, live = LIVE_HOME): string {
  const names = testHome(home, live) ? [...keys, 'STAM_TEST_COST_HOOKS'] : keys;
  const suffixes = [...new Set(names.map((k) => k.replace(/^(STAM|MOOTR)_/, '')))];
  return suffixes.flatMap((s) => {
    const v = envVar(s, env);
    return v ? [`Environment=STAM_${s}=${v}\n`, `Environment=MOOTR_${s}=${v}\n`] : [];
  }).join('');
}
