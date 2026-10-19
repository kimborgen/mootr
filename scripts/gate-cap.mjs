// The merge gate's CPU cap (S-2107): the whole gate process tree (the node gate, its gates, vitest workers, headless Chrome)
// runs in one systemd scope with CPUQuota=STAM_GATE_CPU_QUOTA (default 100%, one CPU), niced, with one vitest worker.
// Where systemd-run --user can't start a scope (not installed, no user bus, a container) it runs niced only and says so.
// STAM_GATE_CPU_QUOTA=0 or off disables the scope; the nice stays. Only the merge gate is capped, never the deploy path.
import { spawnSync } from 'node:child_process';

const NICE = ['nice', '-n', '10'];
const DEFAULT_QUOTA = '100%';

// The quota as a systemd percentage ("100%"), or null when the cap is off. Only whole percents from 1 to 10000 count; anything
// else logs and uses the default.
export function quotaOf(env = process.env, log = (m) => console.error(m)) {
  const raw = String(env.STAM_GATE_CPU_QUOTA ?? DEFAULT_QUOTA).trim().toLowerCase();
  if (raw === '0' || raw === '0%' || raw === 'off') return null;
  const m = /^(\d{1,5})%?$/.exec(raw);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 10_000) return `${Number(m[1])}%`;
  log(`gate cpu cap: STAM_GATE_CPU_QUOTA=${env.STAM_GATE_CPU_QUOTA} isn't a whole percent from 1 to 10000; using ${DEFAULT_QUOTA}`);
  return DEFAULT_QUOTA;
}

// Whether `systemd-run --user --scope` can start a scope here, probed with the real property: one probe per process, quota and PATH.
const probed = new Map();
export function scopeAvailable(quota = DEFAULT_QUOTA, env = process.env) {
  const key = `${quota} ${env.PATH}`;
  if (!probed.has(key)) {
    const r = spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', '-p', `CPUQuota=${quota}`, 'true'], { stdio: 'ignore', timeout: 10_000, env });
    probed.set(key, r.status === 0);
  }
  return probed.get(key);
}

// Runs the scope; if systemd-run exits before it ran the command (the marker file never appeared: no user bus, a refused scope),
// runs the command niced alone. A failure of the command itself keeps its status. A signal forwards to the scope's systemd-run and ends a launch that never started the gate with 128+N, before any fallback; once the gate started, its own status is returned.
const LAUNCH = `quota=$1; shift
marker="\${TMPDIR:-/tmp}/stam-gate-cap.$$"
rm -f "$marker"
systemd-run --user --scope --quiet --collect -p "CPUQuota=$quota" nice -n 10 sh -c ': > "$0"; exec "$@"' "$marker" "$@" &
pid=$!
cancelled=
trap 'cancelled=143; kill -TERM "$pid" 2>/dev/null' TERM
trap 'cancelled=130; kill -TERM "$pid" 2>/dev/null' INT
trap 'cancelled=129; kill -TERM "$pid" 2>/dev/null' HUP
wait "$pid"; rc=$?
while kill -0 "$pid" 2>/dev/null; do wait "$pid"; rc=$?; done
if [ -n "$cancelled" ] && [ ! -e "$marker" ]; then exit "$cancelled"; fi
if [ ! -e "$marker" ]; then
  echo 'gate cpu cap is off: systemd-run could not start a scope; running with nice only' >&2
  trap - TERM INT HUP
  exec nice -n 10 "$@"
fi
rm -f "$marker"
exit "$rc"
`;

// The command to start ARGV (a command and its arguments) capped. `available` is injectable for tests.
export function capArgv(argv, { env = process.env, available = scopeAvailable, log = (m) => console.error(m) } = {}) {
  const quota = quotaOf(env, log);
  if (quota === null) return [...NICE, ...argv];
  if (!available(quota, env)) {
    log(`gate cpu cap is off: systemd-run --user can't start a scope here; running with nice only`);
    return [...NICE, ...argv];
  }
  return ['sh', '-c', LAUNCH, 'gate-cap', quota, ...argv];
}

// Env that makes the gate's parallel runners use one worker: vitest reads VITEST_MAX_WORKERS.
export const SINGLE_WORKER_ENV = { VITEST_MAX_WORKERS: '1' };
