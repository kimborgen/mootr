// The test-only routes (POST /api/test/cost and /api/test/stall, src/daemon.ts) answer only a daemon that test/lib.sh
// started: STAM_TEST_COST_HOOKS is exactly 1, STAM_HOME is set and isn't the live home, the tmux
// socket is a stam-test- one, and STAM_HOME is a test home (src/test-env.ts: the `.stam-test-home`
// marker with test/lib.sh's `owner` file beside it). Anything else, a default home included, gets a 404.
import { join } from 'node:path';
import { homedir } from 'node:os';

export function testHooksAllowed(env: NodeJS.ProcessEnv, home: string, socket: string): boolean {
  return env.STAM_TEST_COST_HOOKS === '1' && Boolean(env.STAM_HOME) && home !== join(homedir(), '.local', 'share', 'stam') && socket.startsWith('stam-test-');
}

// Counts every statement execution (get, all, run, iterate) on the database handle until the returned
// stop function is called, which returns the count. Test-only: POST /api/test/statements (test/e2e-agents-route.sh).
export function countStatements(d: { prepare: (sql: string) => unknown }): () => number {
  const prepare = (d.prepare as (sql: string) => any).bind(d);
  let n = 0;
  (d as any).prepare = (sql: string) => {
    const st = prepare(sql);
    for (const m of ['get', 'all', 'run', 'iterate']) {
      const f = st[m].bind(st);
      st[m] = (...args: unknown[]) => {
        n++;
        return f(...args);
      };
    }
    return st;
  };
  return () => {
    delete (d as any).prepare;
    return n;
  };
}

// Agent names whose launch fails once their row exists (POST /api/test/launch-fail, test/e2e-reviewer-ring.sh).
// Always empty outside a test daemon.
export const failLaunch = new Set<string>();

// Holds a spawn's ITSA lookup while a test makes something else happen first (POST /api/test/itsa-gate,
// test/e2e-reviewer-ring.sh). Open unless held; `waiting` counts the spawns parked at it.
export const itsaGate = {
  waiting: 0,
  _held: null as Promise<void> | null,
  _open: () => {},
  hold() {
    if (!this._held) this._held = new Promise<void>((r) => (this._open = r));
  },
  release() {
    this._open();
    this._held = null;
  },
  async pass() {
    if (!this._held) return;
    this.waiting++;
    try {
      await this._held;
    } finally {
      this.waiting--;
    }
  },
};
