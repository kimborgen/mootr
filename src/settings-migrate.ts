// `stam settings migrate` (S-404, S-380 change 4): compares a peer's settings.json with the shared
// cache from the home, and with apply rewrites the file with only its local keys. Local only: no
// network, no daemon. The settings memo picks the rewritten file up by stat.
import { constants, copyFileSync, existsSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { MACHINE, STAM_HOME } from './config.ts';
import { REDACTED, homeOf, localPart, readSharedCache, redactValue, sharedPart } from './settings.ts';

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

// Leaf paths of an object: arrays and scalars are leaves; empty objects (left by sharedPart) are skipped.
function leaves(o: unknown, prefix: string[] = [], out = new Map<string, unknown>()): Map<string, unknown> {
  if (isObj(o)) for (const [k, v] of Object.entries(o)) leaves(v, [...prefix, k], out);
  else if (prefix.length) out.set(prefix.join('.'), o);
  return out;
}

// An MCP server's args can carry a credential as `--token=VALUE` or as the value after `--token`.
const SECRET_FLAG = /^--?([\w-]*(token|secret|password|apikey|api-key|api_key|authorization))$/i;
// The value after these flags is a header line, and a string like `Authorization: Bearer X` or
// `API_KEY=X` is a credential wherever it sits.
const HEADER_FLAG = /^(--header|-H)$/;
const SECRET_PAIR = /^((authorization|[\w-]*(token|key|secret))\s*[:=]\s*)/i;
function scrubArgs(args: unknown[]): unknown[] {
  let after = false;
  return args.map((a) => {
    if (typeof a !== 'string') return a;
    const pair = a.match(SECRET_PAIR);
    if (pair && !after) return `${pair[1]}${REDACTED}`;
    const eq = a.match(/^(--?[\w-]+)=/);
    if (eq && SECRET_FLAG.test(eq[1])) return `${eq[1]}=${REDACTED}`;
    if (after) {
      after = false;
      return REDACTED;
    }
    after = SECRET_FLAG.test(a) || HEADER_FLAG.test(a);
    return a;
  });
}
// redactValue plus the MCP args scrub. Display only: the daemon's settings reads and the S-362
// round-trip (restoreRedacted) keep redactValue's exact output.
function redactForDisplay(obj: any): any {
  const out = redactValue(obj);
  if (out?.mcpServers && typeof out.mcpServers === 'object')
    for (const srv of Object.values<any>(out.mcpServers)) if (Array.isArray(srv?.args)) srv.args = scrubArgs(srv.args);
  return out;
}

export type MigrateResult = {
  home: string;
  same: string[];
  differs: { path: string; here: unknown; home: unknown }[];
  onlyHere: { path: string; here: unknown }[];
  onlyHome: string[];
  applied?: { backup: string; removed: string[] };
};

export function runMigrate(apply: boolean): { code: number; text: string; result: Partial<MigrateResult> & { error?: string } } {
  const file = join(STAM_HOME, 'settings.json');
  const fail = (text: string, home?: string) => ({ code: 1, text, result: { home, error: text } });
  // The raw file decides everything: the home from its own keys, never from the memoized settings().
  const raw = existsSync(file) ? readFileSync(file, 'utf8') : null;
  let disk: any = {};
  if (raw !== null) {
    try {
      disk = JSON.parse(raw);
    } catch (e) {
      return fail(`settings.json is not valid JSON: ${e instanceof Error ? e.message : e}`);
    }
  }
  const homeName = homeOf(disk);
  if (homeName === MACHINE) return { code: 0, text: `this is the settings home (${MACHINE}); nothing to migrate`, result: { home: MACHINE } };
  const cache = readSharedCache();
  if (!cache) return fail(`no shared settings cached yet from ${homeName}; is the daemon running and the home reachable?`, homeName);

  const mineRaw = leaves(sharedPart(disk));
  const theirsRaw = leaves(sharedPart(cache.settings));
  // Values shown are scrubbed the way agents' reads of the file are; comparing uses the raw values.
  const mineShown = leaves(redactForDisplay(sharedPart(disk)));
  const theirsShown = leaves(redactForDisplay(sharedPart(cache.settings)));
  const r: MigrateResult = { home: homeName, same: [], differs: [], onlyHere: [], onlyHome: [] };
  for (const [path, v] of mineRaw) {
    if (!theirsRaw.has(path)) r.onlyHere.push({ path, here: mineShown.get(path) });
    else if (isDeepStrictEqual(v, theirsRaw.get(path))) r.same.push(path);
    else r.differs.push({ path, here: mineShown.get(path), home: theirsShown.get(path) });
  }
  for (const path of theirsRaw.keys()) if (!mineRaw.has(path)) r.onlyHome.push(path);

  const lines = [
    `${homeName} is the settings home. Compared with ${file}:`,
    `  same as the home: ${r.same.length}`,
    `  differs: ${r.differs.length}`,
    ...r.differs.map((d) => `    ${d.path}: here ${JSON.stringify(d.here)}, home ${JSON.stringify(d.home)}`),
    `  only here: ${r.onlyHere.length}`,
    ...r.onlyHere.map((d) => `    ${d.path}: ${JSON.stringify(d.here)}`),
    `  only on the home (you now get these): ${r.onlyHome.length}`,
    ...r.onlyHome.map((p) => `    ${p}`),
  ];
  const removed = [...mineRaw.keys()];
  if (!apply) {
    lines.push(removed.length ? `dry run: --apply would remove ${removed.length} shared key(s) from settings.json` : 'nothing to remove', 'nothing written');
    return { code: 0, text: lines.join('\n'), result: r };
  }
  if (!removed.length) {
    lines.push('nothing to remove');
    return { code: 0, text: lines.join('\n'), result: r };
  }
  // The backup comes first and is never overwritten: a differing earlier backup stays and this one
  // gets a timestamp, so a strip never runs without a copy of what it removes.
  let backup = `${file}.pre-S380`;
  let reused = false;
  try {
    copyFileSync(file, backup, constants.COPYFILE_EXCL);
    chmodSync(backup, 0o600);
  } catch (e: any) {
    if (e?.code !== 'EEXIST') return fail(`backup failed: ${e?.message ?? e}`, homeName);
    if (readFileSync(backup, 'utf8') === raw) reused = true;
    else {
      backup = `${backup}.${new Date().toISOString().replace(/[:.]/g, '-')}`;
      copyFileSync(file, backup, constants.COPYFILE_EXCL);
      chmodSync(backup, 0o600);
    }
  }
  // A daemon may have written the file since the report: abort rather than drop that write.
  if (readFileSync(file, 'utf8') !== raw) return fail('settings.json changed while migrating; nothing was rewritten (the backup is kept). Stop the daemon and run again.', homeName);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(localPart(disk), null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
  r.applied = { backup, removed };
  lines.push(`backup ${reused ? 'already at' : 'written to'} ${backup}`, `removed ${removed.length} shared key(s) from settings.json:`, ...removed.map((p) => `    ${p}`));
  return { code: 0, text: lines.join('\n'), result: r };
}
