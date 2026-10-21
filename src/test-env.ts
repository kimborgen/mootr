// The one gate for test-only env vars that relax auth, identity or permissions (S-634):
// STAM_TEST_HUMAN_KEY, STAM_TEST_INPUT_BARRIER, the human-code vars of S-613, and STAM_TEST_PASSWORDLESS_SUDO (S-2121).
// A var is honoured only in a test home: not the live home, STAM_HOME holds the `.stam-test-home` marker
// that test/lib.sh's daemon_home writes, and its parent folder holds the `owner` file test/lib.sh writes
// into its throwaway TEST_TMP. A custom STAM_HOME with a restarted unit and the var set in its env does
// nothing, because neither file is there.
// This is an accident guard, not a security boundary: both files sit in places the same uid can write, so
// an agent that can restart the user's unit with an edited environment could also create them. That is
// the same tier-1 "out of API" class as replacing stam's code or the unit file, which S-426 accepts.
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

// The value of a test-only env var, or undefined when this isn't a test home.
export function testOnlyEnv(name: string, env: NodeJS.ProcessEnv = process.env, home = STAM_HOME, live = LIVE_HOME): string | undefined {
  const v = envVar(name.replace(/^STAM_/, ''), env);
  return v && testHome(home, live) ? v : undefined;
}

// A test-only var is set but ignored here: the daemon warns once.
export function ignoredTestOnlyEnv(name: string, env: NodeJS.ProcessEnv = process.env, home = STAM_HOME, live = LIVE_HOME): boolean {
  return Boolean(envVar(name.replace(/^STAM_/, ''), env)) && !testHome(home, live);
}

// The `Environment=` lines of the service unit (S-2596): each name in `keys` that is set, written under its STAM_ name, with
// the value resolved once (a MOOTR_-only value, set by hand, is written under STAM_ too, so a rollback to an older release
// still reads it). STAM_TEST_COST_HOOKS is added in a test home only, so installing against the live home with the var set
// never writes it into the live unit.
export function serviceEnv(keys: string[], env: NodeJS.ProcessEnv = process.env, home = STAM_HOME, live = LIVE_HOME): string {
  const names = testHome(home, live) ? [...keys, 'STAM_TEST_COST_HOOKS'] : keys;
  const suffixes = [...new Set(names.map((k) => k.replace(/^(STAM|MOOTR)_/, '')))];
  return suffixes.flatMap((s) => {
    const v = envVar(s, env);
    return v ? [`Environment=STAM_${s}=${v}\n`] : [];
  }).join('');
}
