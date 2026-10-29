// Runs text and screens through what src/adapters/claude.ts typeLiteralInput reads off the screen, for
// go/internal/adapters/claude's typing test (S-2848 B3b): its own columns function and running check, cut out of the
// source (neither is exported, and importing the adapter would load the daemon), and Intl.Segmenter. The cases come as
// JSON on stdin, [{text, lines}], and it prints, in the same order, {cols, graphemes, running}. It touches no stam
// home.
//
//   node go/internal/adapters/claude/testdata/ts-typing.mjs < cases.json
import { readFileSync, writeSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const src = stripTypeScriptTypes(readFileSync(new URL('../../../../../src/adapters/claude.ts', import.meta.url), 'utf8'));
const at = src.indexOf('function columns(');
const columns = new Function(src.slice(at, src.indexOf('\n}\n', at) + 2) + '\nreturn columns;')();
const SPINNER = new Function('return ' + src.match(/^const SPINNER = (\/.*\/);$/m)[1])();
const running = new Function('SPINNER', 'l', 'return ' + src.match(/const running = \(l\s*\) => (.*);\n/)[1]);
const cases = JSON.parse(readFileSync(0, 'utf8'));
const out = cases.map((c) => ({
  cols: columns(c.text ?? ''),
  graphemes: [...new Intl.Segmenter().segment(c.text ?? '')].map((g) => g.segment),
  running: running(SPINNER, c.lines ?? []),
}));
writeSync(1, JSON.stringify(out));
process.exit(0);
