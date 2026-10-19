// The one gate for test-only env vars that relax auth, identity or permissions (S-634):
// STAM_TEST_HUMAN_KEY, STAM_TEST_INPUT_BARRIER, and the human-code vars of S-613.
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
  const v = env[name];
  return v && testHome(home, live) ? v : undefined;
}

// A test-only var is set but ignored here: the daemon warns once.
export function ignoredTestOnlyEnv(name: string, env: NodeJS.ProcessEnv = process.env, home = STAM_HOME, live = LIVE_HOME): boolean {
  return Boolean(env[name]) && !testHome(home, live);
}
