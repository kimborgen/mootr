// Runs input box screens through the TS daemon's own src/adapters/claude-input.ts, for go/internal/adapters/claude's
// input test (S-2848 B3b). The cases come as JSON on stdin, [{lines, before, width, text, input, appended}], and it
// prints, in the same order, {box, shows, menu, around, same, problem, cols, bash}: inputBox(lines, width) (null for
// none, text null when it can't be rebuilt), inputShows(lines, text, width), menuUnderBox(lines), aroundBox(lines),
// sameAround(aroundBox(before), aroundBox(lines)), inputProblem(input) (null for none), displayWidth(text) and
// bashInputRecorded(appended, text). It touches no stam home.
//
//   node go/internal/adapters/claude/testdata/ts-input.mjs < cases.json
import { readFileSync, writeSync } from 'node:fs';

const m = await import('../../../../../src/adapters/claude-input.ts');
const cases = JSON.parse(readFileSync(0, 'utf8'));
const out = cases.map((c) => {
  const lines = c.lines ?? [];
  const width = c.width || undefined;
  const box = m.inputBox(lines, width);
  return {
    box: box ? { mark: box.mark, text: box.text ?? null } : null,
    shows: m.inputShows(lines, c.text ?? '', width),
    menu: m.menuUnderBox(lines),
    around: m.aroundBox(lines),
    same: m.sameAround(m.aroundBox(c.before ?? lines), m.aroundBox(lines)),
    problem: m.inputProblem(c.input) ?? null,
    cols: m.displayWidth(c.text ?? ''),
    bash: m.bashInputRecorded(c.appended ?? '', c.text ?? ''),
  };
});
writeSync(1, JSON.stringify(out));
process.exit(0);
