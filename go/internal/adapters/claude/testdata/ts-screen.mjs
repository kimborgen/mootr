// Reads Claude Code input boxes with the TS daemon's own src/adapters/claude-ghost.ts, for go/internal/adapters/claude's
// golden screen test (S-2820). The cases come as JSON on stdin, [{ansi: [rows], text}], and it prints
// [{box, ghost}] in the same order: promptInBox (null for no box) and inputGhost.
//
//   node go/internal/adapters/claude/testdata/ts-screen.mjs < cases.json
import { readFileSync, writeSync } from 'node:fs';

const { promptInBox, inputGhost } = await import('../../../../../src/adapters/claude-ghost.ts');
const cases = JSON.parse(readFileSync(0, 'utf8'));
const out = cases.map((c) => ({ box: promptInBox(c.ansi, c.text) ?? null, ghost: inputGhost(c.ansi) }));
writeSync(1, JSON.stringify(out));
process.exit(0);
