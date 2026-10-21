// The stamd systemd unit's text (S-2278). `stam daemon install` writes it, and a deploy rewrites an
// older unit in place (migrateUnit), so the unit is only ever changed by code, never by hand.
import { join } from 'node:path';

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

// The unit for a daemon that runs `dir` (releases/current, or a checkout before the first deploy).
export function unitText(o: { dir: string; node: string; path: string; env: string; log: string }): string {
  return `[Unit]
Description=stam daemon: runs and coordinates coding agents
After=network-online.target

[Service]
ExecStart=${execStart(o.dir, o.node)}
Environment=PATH=${o.path}
${envLine('STAM_NODE', o.node)}
${o.env}Restart=always
RestartSec=2
KillMode=process
StandardOutput=append:${o.log}
StandardError=append:${o.log}

[Install]
WantedBy=default.target
`;
}

// An existing unit rewritten to the wrapper form, keeping its node, PATH, and settings; undefined when it
// already is, or isn't a stamd unit this knows how to read.
export function migrateUnit(text: string, dir: string): string | undefined {
  if (/^Environment="?STAM_NODE=/m.test(text)) return undefined;
  const m = text.match(/^ExecStart=(\S+) --no-warnings \S+ daemon run$/m);
  if (!m) return undefined;
  const node = m[1];
  return text.replace(m[0], () => `ExecStart=${execStart(dir, node)}\n${envLine('STAM_NODE', node)}`);
}
