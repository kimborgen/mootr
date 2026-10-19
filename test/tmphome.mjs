// A throwaway STAM_HOME for the in-process unit tests (S-277). The folder is removed when the
// process exits, on every path: a normal end, a failed assertion, a thrown error, or a signal.
// Tests never load the local embedder (a 472 MB model copy), so the home uses the stub.
// tempDir (S-668) is the same without the home: any temporary folder a test makes comes from it,
// so none is left behind. Only a SIGKILL skips the cleanup; scripts/sweep-test-homes.mjs covers that.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs = new Set();
let hooked = false;

export function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.add(dir);
  if (!hooked) {
    hooked = true;
    process.on('exit', () => {
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
    });
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => process.exit(130));
  }
  return dir;
}

export function tempHome(prefix) {
  const home = tempDir(prefix);
  process.env.STAM_EMBEDDER = 'stub';
  return home;
}
