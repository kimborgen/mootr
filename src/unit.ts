// The stamd systemd unit's text (S-2278). `stam daemon install` writes it, and a deploy rewrites an
// older unit in place (migrateUnit), so the unit is only ever changed by code, never by hand.
import { lstatSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMootrHome } from './default-home.ts';

// ExecStart is parsed twice: by systemd, then by the shell the unit starts. A path is single-quoted for the
// shell (so `$`, backticks, spaces and quotes in STAM_HOME or the node path stay literal), and the whole
// script goes in systemd double quotes, where `\` and `"` are escaped and `$` and `%` doubled (systemd
// expands both in ExecStart).
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const systemd = (s: string) => `"${s.replace(/[\\"]/g, '\\$&').replace(/\$/g, '$$$$').replace(/%/g, '%%')}"`;

// An Environment= line: the assignment in double quotes, `\` and `"` escaped, `%` doubled (a specifier).
export const envLine = (k: string, v: string) => `Environment="${`${k}=${v}`.replace(/[\\"]/g, '\\$&').replace(/%/g, '%%')}"`;

// Starts the release at `dir` through its bin/stamd wrapper (the Go switch and its rollback are then a
// link swap plus a restart). A release built before the wrapper existed has no bin/stamd, so a rollback to
// one must still start: the shell tests for the wrapper and otherwise execs the node command the unit ran
// before. Testing -x, not exec's failure, keeps "no wrapper" apart from "the daemon failed", which must
// show as the failure it is (exit status and daemon.log) rather than trigger a second start.
export function execStart(dir: string, node: string): string {
  const wrapper = sh(join(dir, 'bin', 'stamd'));
  const script = `if [ -x ${wrapper} ]; then exec ${wrapper}; fi; exec ${sh(node)} --no-warnings ${sh(join(dir, 'src', 'cli.ts'))} daemon run`;
  return `/bin/sh -c ${systemd(script)}`;
}

// The node lines: bin/stamd reads MOOTR_NODE before STAM_NODE (S-2890 P3), and a unit carries both.
const nodeLines = (node: string) => `${envLine('MOOTR_NODE', node)}\n${envLine('STAM_NODE', node)}`;

// The unit for a daemon that runs `dir` (releases/current, or a checkout before the first deploy). With `alias`, its
// [Install] names the old service name (mootrd.service has Alias=stamd.service, S-3349).
export function unitText(o: { dir: string; node: string; path: string; env: string; log: string; alias?: string }): string {
  return `[Unit]
Description=stam daemon: runs and coordinates coding agents
After=network-online.target

[Service]
ExecStart=${execStart(o.dir, o.node)}
Environment=PATH=${o.path}
${nodeLines(o.node)}
${o.env}Restart=always
RestartSec=2
KillMode=process
StandardOutput=append:${o.log}
StandardError=append:${o.log}

[Install]
WantedBy=default.target
${o.alias ? `Alias=${o.alias}\n` : ''}`;
}

// An existing unit rewritten to the wrapper form, keeping its node, PATH, and settings, and given both node variables;
// undefined when it already is, or isn't a stamd unit this knows how to read.
export function migrateUnit(text: string, dir: string): string | undefined {
  // The STAM_NODE value in the unit is already escaped (envLine), so MOOTR_NODE gets it verbatim, not escaped a second time.
  const has = text.match(/^Environment="?STAM_NODE=((?:[^"\\\n]|\\.)+)"?$/m);
  if (has) {
    if (/^Environment="?MOOTR_NODE=/m.test(text)) return undefined;
    return text.replace(has[0], () => `Environment="MOOTR_NODE=${has[1]}"\n${has[0]}`);
  }
  const m = text.match(/^ExecStart=(\S+) --no-warnings \S+ daemon run$/m);
  if (!m) return undefined;
  const node = m[1];
  return text.replace(m[0], () => `ExecStart=${execStart(dir, node)}\n${nodeLines(node)}`);
}

// A regular file's lstat, or undefined when it isn't there. Only "not found" is "no unit": any other error (EACCES on the
// unit dir) throws, so an unreadable dir never reads as a machine without the unit.
function lstatOrNone(file: string) {
  try {
    return lstatSync(file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw new Error(`can't inspect ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Whether `name`.service in `unitDir` is a regular file (not an alias link, not absent). Only "not found" is "no": any other
// error throws.
export const isRegularUnit = (unitDir: string, name: string): boolean => Boolean(lstatOrNone(join(unitDir, `${name}.service`))?.isFile());

// The service `stam daemon install` writes: a test's own name (STAM_SERVICE); else stamd, with no alias, while the home is a
// real stam folder (a mootrd.service there would carry stam paths and an alias, and mootr-move.sh would refuse the machine);
// else, on a mootr home, stamd while a live regular stamd.service is there and --replace-stamd wasn't given, else mootrd.
export function serviceToInstall(unitDir: string, replace: boolean, home: string, own?: string): string {
  if (own) return own;
  if (!isMootrHome(home)) return 'stamd';
  return !replace && isRegularUnit(unitDir, 'stamd') ? 'stamd' : 'mootrd';
}

// Writes `text` as `name`.service in `unitDir`, and says what it found: 'moved' when a regular stamd.service was in the way and
// is now at stamd.service.pre-mootr, 'kept' when one is there and nothing was written, else 'none'. A regular stamd.service
// is the live daemon's unit, so without `replace` nothing is staged: a mootrd.service written under the legacy home would
// keep its paths through the move (mootr-move.sh keeps an existing one), and the live switch is the operator's (mootr-move.sh
// Steps 2 and 4). Real systemd can't enable an alias over a regular file, so `replace` moves it aside. With `replace`, `stop('stamd')` runs first (KillMode=process, so agents keep running) and must return true: any
// other result throws before anything is written or moved.
export function installUnitFile(unitDir: string, name: string, text: string, o: { replace?: boolean; stop?: (service: string) => boolean; start?: (service: string) => void } = {}): 'moved' | 'kept' | 'none' {
  const file = join(unitDir, `${name}.service`);
  const tmp = `${file}.tmp-${process.pid}`;
  const old = name === 'mootrd' ? join(unitDir, 'stamd.service') : undefined;
  const regular = old ? Boolean(lstatOrNone(old)?.isFile()) : false;
  if (old && regular && !o.replace) return 'kept';
  if (old && regular && o.stop?.('stamd') !== true) throw new Error("couldn't stop stamd, so nothing was written or moved; stop it, then run this again");
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
    if (!old || !regular) return 'none';
    renameSync(old, `${old}.pre-mootr`);
    return 'moved';
  } catch (e) {
    // The stop succeeded, so a failed write or rename must not leave the daemon down.
    if (old && regular) o.start?.('stamd');
    throw e;
  }
}
