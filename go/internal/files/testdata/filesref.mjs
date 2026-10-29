// The reference for files_test.go: what src/files.ts says over a tree the test built. Run by the test (node, no daemon)
// with HOME and STAM_HOME set inside that tree: argv[2] is the input file, argv[3] the output file.
import { readFileSync, writeFileSync } from 'node:fs';

const { denied, resolveIn, realRoots, listDir, typeByExt, FilesError } = await import('../../../../src/files.ts');

const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const attempt = (f) => {
  try {
    return { ok: f() };
  } catch (e) {
    if (e instanceof FilesError) return { status: e.status, message: e.message };
    throw e;
  }
};
const out = {
  denied: input.denied.map((p) => denied(p)),
  roots: input.roots.map((c) => realRoots(c)),
  resolve: input.resolve.map((p) => attempt(() => resolveIn(p, input.allowed))),
  list: input.list.map((p) => attempt(() => listDir(p))),
  types: input.types.map((n) => typeByExt(n)),
};
writeFileSync(process.argv[3], JSON.stringify(out));
