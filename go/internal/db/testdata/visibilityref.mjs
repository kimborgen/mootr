// Reads a JSON list of visibility column values (a string, or null for a NULL column) from stdin and writes, for each,
// what src/org.ts visibilityOf decodes, for go/internal/db's visibility test (S-4003). Its home is the throwaway one in
// argv[2]: importing org.ts loads the db and settings modules, which open nothing until called.
import { readFileSync } from 'node:fs';

process.env.STAM_HOME = process.argv[2];
const { visibilityOf } = await import('../../../../src/org.ts');
const inputs = JSON.parse(readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(inputs.map((visibility) => visibilityOf({ visibility }))));
