// Builds an empty stam.db in DIR the way the TS daemon leaves it (src/db.ts open()), for index_test.go. Never the live
// home: DIR must be a new, empty folder.
//
//   node go/internal/search/testdata/mkdb.mjs DIR
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const home = resolve(process.argv[2] ?? '');
if (!process.argv[2] || readdirSync(home).length) {
  console.error('usage: mkdb.mjs EMPTY-DIR');
  process.exit(2);
}
process.env.STAM_HOME = home;
process.env.STAM_MACHINE = 'test-machine';
const config = await import('../../../../src/config.ts');
if (config.LIVE_HOME) {
  console.error('mkdb: refusing the live home');
  process.exit(2);
}
const db = await import('../../../../src/db.ts');
db.open();
