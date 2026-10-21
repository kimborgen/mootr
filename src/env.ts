// The env var names (S-2889): a reader takes the MOOTR_ name first and falls back to the STAM_ name. Writers set only
// STAM_ names until the cutover (S-2890), so no child carries a MOOTR_ name a test or an old reader could be shadowed by;
// a MOOTR_ name exists only when a person sets it by hand.
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

// Sets `X` as STAM_X, or removes both names when `value` is undefined.
export function setEnvVar(name: string, value: string | undefined, env: NodeJS.ProcessEnv = process.env): void {
  delete env[`MOOTR_${name}`];
  if (value === undefined) delete env[`STAM_${name}`];
  else env[`STAM_${name}`] = value;
}

// The names in `names` (given as STAM_ names) with their MOOTR_ twins, for a list of names to remove or forward.
export function withMootrTwins(names: string[]): string[] {
  return names.flatMap((n) => (n.startsWith('STAM_') ? [n, `MOOTR_${n.slice('STAM_'.length)}`] : [n]));
}

// The value of `X` in `K=V` entries, such as a /proc/PID/environ split at NUL: MOOTR_X first, then STAM_X.
export function entryValue(entries: string[], name: string): string | undefined {
  const find = (key: string) => {
    const e = entries.find((x) => x.startsWith(`${key}=`));
    return e === undefined ? undefined : e.slice(key.length + 1);
  };
  return find(`MOOTR_${name}`) ?? find(`STAM_${name}`);
}
