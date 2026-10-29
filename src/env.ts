import { statSync } from 'node:fs';
import { join } from 'node:path';

// The env var names (S-2889): a reader takes the MOOTR_ name first and falls back to the STAM_ name. Writers set both
// (S-3345, P3 of S-2890): STAM_X as before, so a rollback to a release that reads only STAM_X still works, and MOOTR_X with the
// same value, so a reader that prefers MOOTR_X never meets a stale twin.
const conflicts = new Set<string>();

// The value of `X` read from `env`: MOOTR_X when it is set, else STAM_X. When both are set and differ, MOOTR_X
// wins and the conflict is logged once per name, without either value (some vars hold tokens).
export function envVar(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const mootr = env[`MOOTR_${name}`];
  const stam = env[`STAM_${name}`];
  if (mootr !== undefined && stam !== undefined && mootr !== stam && !conflicts.has(name)) {
    conflicts.add(name);
    console.error(`MOOTR_${name} and STAM_${name} are both set and differ: using MOOTR_${name}`);
  }
  return mootr ?? stam;
}

// Sets `X` as STAM_X and MOOTR_X with the same value, or removes both names when `value` is undefined.
export function setEnvVar(name: string, value: string | undefined, env: NodeJS.ProcessEnv = process.env): void {
  if (value === undefined) {
    delete env[`MOOTR_${name}`];
    delete env[`STAM_${name}`];
  } else {
    env[`MOOTR_${name}`] = value;
    env[`STAM_${name}`] = value;
  }
}

// The STAM_X and MOOTR_X pair for each STAM_X in `defaults`, each set to its final value (S-3345): the last of `layers` that sets it
// (MOOTR_X before STAM_X inside a layer, as envVar reads), else the default. Spread the result after the layers, so a default is
// never twinned ahead of an override that sets only one name and shadows it.
export function twinDefaults(defaults: Record<string, string>, ...layers: Record<string, string | undefined>[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, d] of Object.entries(defaults)) {
    const name = k.replace(/^STAM_/, '');
    let v = d;
    for (const layer of layers) v = layer[`MOOTR_${name}`] ?? layer[`STAM_${name}`] ?? v;
    out[`STAM_${name}`] = v;
    out[`MOOTR_${name}`] = v;
  }
  return out;
}

// `env` with a MOOTR_X twin, of the same value, added for each STAM_X it sets (S-3345). For the variables a writer sets
// for a child: an explicit twin in `env` is kept as given. Never pass a copy of process.env, whose MOOTR_ names a person set.
export function withTwins<T extends Record<string, string>>(env: T): Record<string, string> {
  const out: Record<string, string> = { ...env };
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('STAM_') && !(`MOOTR_${k.slice(5)}` in env)) out[`MOOTR_${k.slice(5)}`] = v;
  }
  return out;
}

// The names in `names` (given as STAM_ names) with their MOOTR_ twins, for a list of names to remove or forward.
export function withMootrTwins(names: string[]): string[] {
  return names.flatMap((n) => (n.startsWith('STAM_') ? [n, `MOOTR_${n.slice('STAM_'.length)}`] : [n]));
}

// An agent's identity and token, as STAM_ names (S-3329): a process that isn't that agent must not inherit any of them, under
// either name. The daemon's start, agentExec's children and the tmux panes all scrub this list (withMootrTwins).
export const AGENT_IDENTITY = ['STAM_AGENT_ID', 'STAM_AGENT_NAME', 'STAM_TOKEN'];

// `base` (a process environment) without the identity names `env` doesn't set, then `env` spread over it, so a name `env` sets
// (as a STAM_ name, or its MOOTR_ twin alone) is the child's own.
export function withoutIdentity(base: NodeJS.ProcessEnv, env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) out[k] = v;
  for (const k of withMootrTwins(AGENT_IDENTITY)) if (!(k in env)) delete out[k];
  return { ...out, ...env };
}

// The value of `X` in `K=V` entries, such as a /proc/PID/environ split at NUL: MOOTR_X first, then STAM_X.
export function entryValue(entries: string[], name: string): string | undefined {
  const find = (key: string) => {
    const e = entries.find((x) => x.startsWith(`${key}=`));
    return e === undefined ? undefined : e.slice(key.length + 1);
  };
  return find(`MOOTR_${name}`) ?? find(`STAM_${name}`);
}

// The Go toolchain's bin dir under `home` (~/.local/go/bin, S-3666) when that directory exists, else undefined. Only the
// directory's presence decides; nothing is read from it.
export function goBinDir(home: string | undefined): string | undefined {
  if (!home) return undefined;
  const bin = join(home, '.local/go/bin');
  try {
    return statSync(bin).isDirectory() ? bin : undefined;
  } catch {
    return undefined;
  }
}

// `argv` run through the shell with `bin` put first on the shell's own PATH (S-3666): the shell's startup files have run by then,
// so every dir they add stays, and a dir already on PATH is not added again. `bin` undefined leaves `argv` as it is.
export function withGoBinArgv(argv: string[], bin: string | undefined): string[] {
  if (bin === undefined) return argv;
  return ['/bin/sh', '-c', 'case ":$PATH:" in *":$1:"*) ;; *) PATH="$1:$PATH" ;; esac; export PATH; shift; exec "$@"', 'sh', bin, ...argv];
}
