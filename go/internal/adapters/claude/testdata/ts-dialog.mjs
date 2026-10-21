// Runs dialog screens through the TS daemon's own src/adapters/claude-dialog.ts, for go/internal/adapters/claude's
// dialog test (S-2848 B3a). The cases come as JSON on stdin, [{body, tool, target, input, approve}], and it prints
// [{names, key, target}] in the same order: dialogNames(body, tool, target), dialogKey(body, approve) (null for none),
// and dialogTarget(input). It touches no stam home.
//
//   node go/internal/adapters/claude/testdata/ts-dialog.mjs < cases.json
import { readFileSync, writeSync } from 'node:fs';

const { dialogNames, dialogKey, dialogTarget } = await import('../../../../../src/adapters/claude-dialog.ts');
const cases = JSON.parse(readFileSync(0, 'utf8'));
const out = cases.map((c) => ({ names: dialogNames(c.body ?? [], c.tool, c.target), key: dialogKey(c.body ?? [], c.approve) ?? null, target: dialogTarget(c.input ?? undefined) }));
writeSync(1, JSON.stringify(out));
process.exit(0);
