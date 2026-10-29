// Renders templates with the TS daemon's own src/templates.ts and src/instructions.ts, for go/internal/templates'
// golden tests (S-2804). DIR is a test home (never the live home), FAKEHOME the user home the harnesses' global files
// are read from. Requests come as JSON on stdin, one result each (its text, or its error) goes out as JSON:
//
//   {"fn": "render", "name": "...", "vars": {...}, "type": "..."}
//   {"fn": "humanMail", "model": "..." | null, "type": "..."}
//   {"fn": "instructions", "harness": "claude", "cwd": "..."}
//   {"fn": "composer", "type": "...", "harness": "..."}: src/inventory.ts composerCatalog, as JSON text
//
//   node go/internal/templates/testdata/ts-render.mjs DIR FAKEHOME < requests.json
import { readFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';

const [dir, fakeHome] = process.argv.slice(2);
if (!dir || !fakeHome) {
  console.error('usage: ts-render.mjs DIR FAKEHOME');
  process.exit(2);
}
process.env.STAM_HOME = resolve(dir);
process.env.HOME = resolve(fakeHome);
process.env.STAM_MACHINE = 'test-machine';
const config = await import('../../../../src/config.ts');
if (config.LIVE_HOME) {
  console.error('ts-render: refusing the live home');
  process.exit(2);
}
const templates = await import('../../../../src/templates.ts');
const instructions = await import('../../../../src/instructions.ts');

const out = [];
for (const r of JSON.parse(readFileSync(0, 'utf8'))) {
  try {
    if (r.fn === 'render') out.push({ text: templates.render(r.name, r.vars ?? {}, r.type ?? undefined) });
    else if (r.fn === 'humanMail') out.push({ text: templates.humanMailPrompt(r.model, r.type ?? undefined) });
    else if (r.fn === 'instructions') out.push({ text: instructions.instructionsPrompt(r.harness, r.cwd) });
    else if (r.fn === 'composer') out.push({ text: JSON.stringify((await import('../../../../src/inventory.ts')).composerCatalog(r.type || undefined, r.harness || undefined)) });
    else throw new Error(`unknown fn ${r.fn}`);
  } catch (e) {
    out.push({ error: String(e instanceof Error ? e.message : e) });
  }
}
// Synchronous, so process.exit can't cut a large result short on a pipe.
writeSync(1, JSON.stringify(out));
process.exit(0);
