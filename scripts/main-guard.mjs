// The main guard every script in scripts/ and web/check/ uses (S-3011). A script runs main only when node was
// started with it. Both paths go through realpath: import.meta.url is the real path, while argv[1] is as typed,
// so a script started through a symlink (releases/current/...) would otherwise run nothing. Never throws.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMain(url) {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}
