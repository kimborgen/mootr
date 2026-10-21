// Reads a JSON list of strings from stdin and writes, for each, the keys src/itsa-keys.ts namedKeys finds, for
// go/internal/db's key test (S-2849).
import { readFileSync } from 'node:fs';
import { namedKeys } from '../../../../src/itsa-keys.ts';

const inputs = JSON.parse(readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(inputs.map((t) => namedKeys(t))));
