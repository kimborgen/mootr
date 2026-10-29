// `stam daemon install` (S-3349), with everything it touches passed in so a test drives the whole sequence against a scratch
// unit dir and a fake systemctl. cli.ts passes the real ones.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { isMootrHome } from './default-home.ts';
import { installUnitFile, serviceToInstall } from './unit.ts';

export type InstallDeps = {
  unitDir: string;
  home: string;
  // STAM_SERVICE: a test instance's own unit name, which has no alias and is never refused.
  own?: string;
  replace: boolean;
  // The unit text for the service chosen (the alias is the caller's to add for mootrd).
  text: (service: string) => string;
  systemctl: (...args: string[]) => boolean;
  // Throws when the service name couldn't be read (an unreadable unit dir): nothing runs and nothing is written.
  checkService: () => void;
  linger: () => void;
  // Stops a daemon that runs outside systemd, by its pid file.
  killPidFile: () => void;
  healthy: () => Promise<boolean>;
  log: (line: string) => void;
};

// Returns the service installed. Throws, with nothing written or stopped, when the install can't proceed.
export async function installService(d: InstallDeps): Promise<string> {
  d.checkService();
  // The live switch to mootrd is mootr-move.sh's while the home is a real stam folder: a mootrd.service written here would carry
  // the legacy home's paths, and the move keeps an existing one.
  if (d.replace && !d.own && !isMootrHome(d.home)) {
    throw new Error(`--replace-stamd needs the mootr home, and ${d.home} is a real stam folder: run mootr-move.sh to switch to mootrd`);
  }
  mkdirSync(d.unitDir, { recursive: true });
  const service = serviceToInstall(d.unitDir, d.replace, d.home, d.own);
  const found = installUnitFile(d.unitDir, service, d.text(service), { replace: d.replace, stop: (old) => d.systemctl('stop', old), start: (old) => void d.systemctl('start', old) });
  if (found === 'moved') d.log(`moved ${join(d.unitDir, 'stamd.service')} aside to stamd.service.pre-mootr`);
  d.linger();
  d.killPidFile();
  d.systemctl('daemon-reload');
  d.systemctl('enable', service);
  // Restart, not start: a running daemon must pick up the new unit.
  d.systemctl('restart', service);
  d.log((await d.healthy()) ? `${service} installed as a user service (${join(d.unitDir, `${service}.service`)}) and running` : `${service} installed, but not answering; see daemon.log`);
  return service;
}
