// The names of the timer units the scripts install (S-3349, P5 of S-2890). What --install writes follows the home
// (`unitToInstall`: `stam-NAME` under a real legacy home, `mootr-NAME` under a mootr one), and a caller that starts or
// queries one picks whichever is installed in the unit dir (`installedUnit`: `mootr-NAME` before `stam-NAME`). Before the
// move a machine has only stam-* units, and they keep working.
import { existsSync, lstatSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { defaultHome, isMootrHome, realHome } from '../src/default-home.ts';

// Whether UNIT.service (or UNIT.EXT) is in DIR. Only "not found" is "no": any other error (EACCES on the unit dir, say) throws, so a
// unit dir we couldn't read never silently becomes "no mootr unit".
export function hasUnit(dir, unit, ext = 'service') {
  const file = join(dir, `${unit}.${ext}`);
  try {
    lstatSync(file);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;
    throw new Error(`can't inspect ${file}: ${e.message}`);
  }
}

// The unit to start or query for NAME (`full-suite`): mootr-NAME when installed, else stam-NAME.
export function installedUnit(dir, name) {
  return hasUnit(dir, `mootr-${name}`) ? `mootr-${name}` : `stam-${name}`;
}

// One rule for what --install writes, so a mootr name never carries a stam path: while the home is a real legacy
// `~/.local/share/stam` the legacy `stam-NAME` name and stam paths, as before; with a mootr home (the post-move symlink
// included, even when it is given as `~/.local/share/stam`) `mootr-NAME` and mootr paths. A machine with a `stam-NAME`
// unit installed and no `mootr-NAME` keeps the stam name even then, so the old and new timers never both exist and a
// live timer is never touched; mootr-move.sh moves the old files away first. A `mootr-NAME` unit beside a legacy home is a
// move that isn't finished: that throws.
export function unitToInstall(dir, name, home = defaultHome()) {
  const mootr = hasUnit(dir, `mootr-${name}`) || hasUnit(dir, `mootr-${name}`, 'timer');
  if (!isMootrHome(home)) {
    if (mootr) throw new Error(`mootr-${name} is installed but the home is still ${home}: finish the move to mootr first`);
    return `stam-${name}`;
  }
  if (mootr) return `mootr-${name}`;
  return hasUnit(dir, `stam-${name}`) || hasUnit(dir, `stam-${name}`, 'timer') ? `stam-${name}` : `mootr-${name}`;
}

// A path of a script as a unit under HOME runs it: with a mootr home, the stam folder's path is the mootr folder's.
export function homePath(path, home = defaultHome()) {
  home = realHome(home);
  if (!isMootrHome(home)) return path;
  const legacy = join(dirname(home), 'stam') + sep;
  return path.startsWith(legacy) ? join(home, path.slice(legacy.length)) : path;
}

// The script a unit runs: REL under the home's releases/current (a deploy swaps the code under the unit). Without a deployed
// current, FALLBACK is this file's own path, and node resolves the main module's symlink, so that is `releases/<sha>`,
// pinned to one release: a path under any releases/<name>/ becomes releases/current/ under the home, and the home is the
// real one (a stam symlink to mootr is mootr). A path outside releases (a checkout) stays as given.
export function unitScript(home, rel, fallback) {
  home = realHome(home);
  const current = join(home, 'releases', 'current', rel);
  if (existsSync(current)) return current;
  const m = homePath(fallback, home).match(/^(.*)\/releases\/[^/]+\/(.+)$/);
  return m ? join(m[1], 'releases', 'current', m[2]) : homePath(fallback, home);
}
