// Opens DIR/stam.db with the TS daemon's src/db.ts, as a rollback to the TS daemon would, and prints the agent REF and
// its events as JSON, for go/internal/db's tests (S-2613). DIR is a test folder, never the live home.
//
//   node go/internal/db/testdata/ts-read.mjs DIR REF
import { resolve } from 'node:path';

const [dir, ref] = process.argv.slice(2);
if (!dir || !ref) {
  console.error('usage: ts-read.mjs DIR REF');
  process.exit(2);
}
process.env.STAM_HOME = resolve(dir);
process.env.STAM_MACHINE = 'test-machine';
const config = await import('../../../../src/config.ts');
if (config.LIVE_HOME) {
  console.error('ts-read: refusing the live home');
  process.exit(2);
}
const db = await import('../../../../src/db.ts');
const agent = db.getAgent(ref);
const out = { agent: agent && { id: agent.id, name: agent.name, parent_id: agent.parent_id }, events: agent ? db.listEvents(agent.id) : [] };
db.open().close();
console.log(JSON.stringify(out));
