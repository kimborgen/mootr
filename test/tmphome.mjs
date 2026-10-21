// A throwaway STAM_HOME for the in-process unit tests (S-277). The folder is removed when the
// process exits, on every path: a normal end, a failed assertion, a thrown error, or a signal.
// Tests never load the local embedder (a 472 MB model copy), so the home uses the stub.
// tempDir (S-668) is the same without the home: any temporary folder a test makes comes from it,
// so none is left behind. Only a SIGKILL skips the cleanup; scripts/sweep-test-homes.mjs covers that.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A stam agent's environment carries MOOTR_ names (S-2889), and they would win over the STAM_ overrides a test sets. Drop them
// here, so the CLI and the daemons a test starts read its STAM_ names only.
for (const k of Object.keys(process.env)) if (k.startsWith('MOOTR_')) delete process.env[k];

const dirs = new Set();
let hooked = false;

function track(dir) {
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

export function tempDir(prefix) {
  return track(mkdtempSync(join(tmpdir(), prefix)));
}

// A temporary folder in /tmp, whatever TMPDIR is. Use it for a copy of a tree that sits under TMPDIR under test/run.sh
// (cpSync cannot copy a tree into itself). It is cleaned up the same way as tempDir, and the sweep reads its prefix too.
export function tempDirOutside(prefix) {
  return track(mkdtempSync(join('/tmp', prefix)));
}

// make picks the folder: tempDir (under TMPDIR) by default, tempDirOutside for a home whose unix sockets must stay
// under the 108-byte path limit (a deep TMPDIR under test/run.sh pushes them past it).
export function tempHome(prefix, make = tempDir) {
  const home = make(prefix);
  process.env.STAM_EMBEDDER = 'stub';
  return home;
}
