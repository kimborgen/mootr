// Judges each case in CASES with src/thread-resolved.ts threadResolved and src/auto-archive.ts humanWaited, and prints the
// verdicts as JSON, for go/internal/server's auto-archive test (S-3734). A case is {thread, closed, open, waits}: closed
// maps an ITSA id to when it closed (null while open; an id missing is unknown here), open is the decision mails still
// waiting, waits the open waits on the human. Never the live home.
//
//   node go/internal/server/testdata/resolvedref.mjs CASES.json HOME
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [file, dir] = process.argv.slice(2);
if (!file || !dir) {
  console.error('usage: resolvedref.mjs CASES.json HOME');
  process.exit(2);
}
process.env.STAM_HOME = resolve(dir);
process.env.STAM_MACHINE = 'test-machine';
const config = await import('../../../../src/config.ts');
if (config.LIVE_HOME) {
  console.error('resolvedref: refusing the live home');
  process.exit(2);
}
const { threadResolved } = await import('../../../../src/thread-resolved.ts');
const { humanWaited } = await import('../../../../src/auto-archive.ts');

const out = JSON.parse(readFileSync(file, 'utf8')).map((c) => {
  const waited = humanWaited(c.thread, c.waits);
  const v = threadResolved(c.thread, {
    itsaClosedAt: (id) => c.closed[id],
    decisionOpen: (id) => c.open.includes(id),
    humanWaited: (t) => humanWaited(t, c.waits),
  });
  return { waited, verdict: v.resolved ? `resolved: ${v.kind}` : `not: ${v.why}` };
});
process.stdout.write(JSON.stringify(out));
