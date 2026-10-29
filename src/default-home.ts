import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const notFound = (e: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '');
const cant = (path: string, e: unknown) => new Error(`can't inspect ${path}: ${e instanceof Error ? e.message : String(e)}`);
let warned = false;

// The default data home (S-3347, S-4335): ~/.local/share/stam when it is a real directory (lstat, links not followed), else
// ~/.local/share/mootr, so a fresh install gets mootr. A stray mootr folder never takes over a real stam home; after the move
// (S-2890) stam is a symlink to mootr, so mootr wins. When both are real directories stam wins and a warning is logged once.
// Only "not found" falls through; another error from lstat (EACCES) throws, so a stam home we couldn't inspect never silently
// becomes mootr. Shell mirror: scripts/default-home.sh (also inlined in scripts/storage-checkout-guard.sh and
// scripts/ensure-deps.sh, and in DEFAULT_HOME_SH for remote probes); Go: config.DefaultHome. test/default-home.test.mjs runs
// one table against all three.
export function defaultHome(userHome: string = homedir()): string {
  const [stam, mootr] = defaultHomes(userHome);
  let stamIsDir = false;
  try {
    stamIsDir = lstatSync(stam).isDirectory();
  } catch (e) {
    if (!notFound(e)) throw cant(stam, e);
  }
  if (!stamIsDir) return mootr;
  if (!warned && existsSync(mootr)) {
    warned = true;
    console.error(`default home: ${stam} and ${mootr} are both real folders; using ${stam}`);
  }
  return stam;
}

// Both spellings of the default home, whether or not either exists: a path-based guard matches either one.
export function defaultHomes(userHome: string = homedir()): [string, string] {
  return [join(userHome, '.local', 'share', 'stam'), join(userHome, '.local', 'share', 'mootr')];
}

// The shell function that does the same; scripts/default-home.sh holds this text, and a test keeps them equal.
// The builtin tests answer the usual cases without a fork (an existing mootr or a stam link means the share folder can be
// searched); stat classifies the rest, so only "not found" falls through to mootr.
export const DEFAULT_HOME_SH = `default_home() {
  s="$HOME/.local/share/stam"; m="$HOME/.local/share/mootr"
  if [ -d "$s" ] && [ ! -L "$s" ]; then
    [ ! -e "$m" ] || echo "default home: $s and $m are both real folders; using $s" >&2
    echo "$s"; return 0
  fi
  if [ -e "$m" ] || [ -L "$s" ]; then echo "$m"; return 0; fi
  err=$(LC_ALL=C stat -c %F -- "$s" 2>&1 >/dev/null) || case $err in
    *"No such file"*|*"Not a directory"*) ;;
    *) echo "default home: $err" >&2; return 1 ;;
  esac
  echo "$m"
}`;

// The daemon's service name (S-3347), mirroring the home rule: `stamd` when stamd.service is a regular file in the unit dir
// (lstat, so the live unit wins over a staged mootrd.service), else `mootrd` when mootrd.service exists, else `stamd`. After
// the move stamd.service is the alias symlink, so mootrd wins. Only "not found" falls through; another error throws.
export function defaultService(unitDir: string): string {
  const stamd = join(unitDir, 'stamd.service');
  try {
    if (lstatSync(stamd).isFile()) return 'stamd';
  } catch (e) {
    if (!notFound(e)) throw cant(stamd, e);
  }
  const mootrd = join(unitDir, 'mootrd.service');
  try {
    statSync(mootrd);
    return 'mootrd';
  } catch (e) {
    if (notFound(e)) return 'stamd';
    throw cant(mootrd, e);
  }
}

// Where a lock shared with older code lives (S-3347): the legacy stam folder when any entry of that name exists (lstat; a
// real folder or the post-move symlink), so an old and a new worker lock one file. Otherwise the resolved default home:
// no old release can run without a stam folder, and taking the lock must never mkdir a real `stam` that would flip the
// home rule. Only "not found" falls through; another error throws.
export function lockHome(userHome: string = homedir()): string {
  const stam = defaultHomes(userHome)[0];
  try {
    lstatSync(stam);
    return stam;
  } catch (e) {
    if (!notFound(e)) throw cant(stam, e);
  }
  return defaultHome(userHome);
}

// The home as it is on disk: an explicit `~/.local/share/stam` that is the post-move symlink to mootr is the mootr home. Only
// "not found" keeps the path as given; another error throws. `releases/current` under it is left unresolved.
export function realHome(home: string): string {
  try {
    return realpathSync(home);
  } catch (e) {
    if (notFound(e)) return home;
    throw cant(home, e);
  }
}

// Whether `home` is the mootr home (by its real folder name, S-3349): what names and paths a unit gets follows it.
export const isMootrHome = (home: string): boolean => basename(realHome(home)) === 'mootr';
