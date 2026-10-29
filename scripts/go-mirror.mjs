// The TS modules the Go daemon mirrors (S-3286), derived from the Go tests that compare Go with TS. A Go test reads TS through
// the src/ files it names (`src/tmux.ts` in go/internal/tmux/tmux_test.go, say) and through the node scripts it runs from its
// testdata/ folder (ts-launch.mjs, say). A src/ file is mirrored when one of those names it, or it is imported, directly or
// through other relative imports, by a src/ file or a script that is. A script's `new URL('src/x.ts', root)` counts as an import (S-3853). A PR that changes a mirrored file runs every Go test
// (the `go-mirror` gate, go/mirror-check.sh); pathGateRows in gate-rules.mjs takes this set.
//
// Pure: the caller reads the files. GO_TESTS is a Map of go/**/*_test.go path -> text; READ(path) returns a repo file's text,
// or undefined when there is no such file, and throws when one can't be read. The live checkout and main's copy (gate.mjs)
// read them differently.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';

const SRC_REF = /\bsrc\/[\w./-]+\.ts\b/g;
const TESTDATA_REF = /"(testdata\/[\w./-]+\.mjs)"/g;
const RELATIVE_IMPORT = /(?:from\s+|import\s*\(\s*)'(\.\.?\/[^']+)'/g;
// A testdata script loads a src/ module through a root URL (`new URL('src/x.ts', root)`) or a path from its own file (S-3853).
const URL_SRC_REF = /new URL\(\s*'([^']+\.ts)'\s*,\s*(import\.meta\.url)?/g;
// A Go test that compares with TS by name: a *MatchesTS, *MatchTS or *Parity test. Each must name a module (unmirroredParityTests).
export const PARITY_TEST_RUN = 'Match(es)?TS|Parity';
const PARITY_TEST = new RegExp(`^func (Test\\w*(?:${PARITY_TEST_RUN})\\w*)\\(`, 'm');

// The src/ modules a file's `new URL('…src/x.ts', base)` references reach, as repo paths. A base of import.meta.url is relative to the
// file's folder; any other base is the repo root. A target outside src/ (or outside the repo) reaches nothing.
function urlTargets(file, text) {
  const targets = [];
  for (const m of text.matchAll(URL_SRC_REF)) {
    const target = posix.normalize(m[2] ? join(dirname(file), m[1]) : m[1]);
    if (target.startsWith('src/')) targets.push(target);
  }
  return targets;
}

// The src/ files Go tests read, directly or through a testdata script, and the src/ files those import, transitively. Returns null
// when a file it needs can't be read: the caller then selects every src/ path (fail closed).
export function mirrorSet(goTests, read) {
  const mirrored = new Set();
  const visited = new Set();
  const queue = [];
  for (const [path, text] of goTests) {
    for (const m of text.matchAll(SRC_REF)) queue.push(m[0]);
    for (const m of text.matchAll(TESTDATA_REF)) queue.push(posix.normalize(join(dirname(path), m[1])));
    queue.push(...urlTargets(path, text));
  }
  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    let text;
    try { text = read(file); } catch { return null; }
    if (text === undefined) continue;
    if (file.startsWith('src/')) mirrored.add(file);
    for (const m of text.matchAll(RELATIVE_IMPORT)) queue.push(posix.normalize(join(dirname(file), m[1])));
    queue.push(...urlTargets(file, text));
  }
  return mirrored;
}

// The Go parity tests that reach no src/ module, so mirrorSet can't select them for a change to one: gate-unit fails on any.
export function unmirroredParityTests(goTests, read) {
  const out = [];
  for (const [path, text] of goTests) {
    const name = PARITY_TEST.exec(text)?.[1];
    if (!name) continue;
    const reached = mirrorSet(new Map([[path, text]]), read);
    if (!reached || reached.size === 0) out.push(`${path}: ${name}`);
  }
  return out;
}

// The trees the mirror is read from: a Go test's node script imports src/, and src/ modules import from scripts/, export/ and test/
// (fixtures-lib.mjs imports test/tmphome.mjs). gate.mjs's mainMirror reads the same trees from main, so the two sets agree.
export const MIRROR_DIRS = ['go', 'src', 'scripts', 'export', 'test'];
const inMirrorDirs = (p) => MIRROR_DIRS.some((d) => p.startsWith(`${d}/`));

// The text of a repo file under ROOT, or undefined when there is none or it is outside MIRROR_DIRS.
export function readRepo(root) {
  return (p) => (inMirrorDirs(p) && existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : undefined);
}

// The Go test files of the checkout at ROOT, by path from ROOT.
export function goTestsOf(root) {
  const goTests = new Map();
  for (const f of readdirSync(join(root, 'go'), { recursive: true })) {
    if (f.endsWith('_test.go')) goTests.set(posix.join('go', f), readFileSync(join(root, 'go', f), 'utf8'));
  }
  return goTests;
}

// The mirror set of the checkout at ROOT, read from its go/ and src/ trees, or null when they can't be read.
export function liveMirror(root) {
  try {
    return mirrorSet(goTestsOf(root), readRepo(root));
  } catch {
    return null;
  }
}
