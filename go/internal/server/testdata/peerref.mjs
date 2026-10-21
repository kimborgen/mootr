// Builds a home with a small ITSA tree (an incident mark on a root, a mark below a child, a missing parent, a loop), copies
// its stam.db to stam.pre.db, and writes to expect.json what src/itsa-owners.ts incidentMarkedHere answers for each ref, for
// go/internal/server's peer hooks test (S-2849, PR 3e). Never the live home.
//
//   node go/internal/server/testdata/peerref.mjs DIR
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: peerref.mjs DIR');
  process.exit(2);
}
const home = resolve(dir);
if (existsSync(`${home}/stam.db`)) {
  console.error(`peerref: ${home} already has a stam.db`);
  process.exit(2);
}
process.env.STAM_HOME = home;
process.env.STAM_MACHINE = 'test-machine';
delete process.env.OPENROUTER_API_KEY;
const config = await import('../../../../src/config.ts');
if (config.LIVE_HOME) {
  console.error('peerref: refusing the live home');
  process.exit(2);
}
const db = await import('../../../../src/db.ts');
const itsa = await import('../../../../src/itsa.ts');
const owners = await import('../../../../src/itsa-owners.ts');

const d = db.open();
const make = async (title, parent) => itsa.create({ title, ...(parent ? { parent: parent.id } : {}) });
const a = await make('A marked root');
const b = await make('B under A', a);
const c = await make('C under B', b);
const e = await make('D unmarked root');
const f = await make('E under D', e);
const g = await make('F marked leaf under D', e);
const h = await make('G orphan');
const i = await make('H loop one');
const j = await make('I loop two', i);
d.prepare('UPDATE itsas SET incident = 1 WHERE id IN (?, ?)').run(a.id, g.id);
d.prepare("UPDATE itsas SET parent_id = 'gone' WHERE id = ?").run(h.id);
d.prepare('UPDATE itsas SET parent_id = ?, incident = 1 WHERE id = ?').run(j.id, i.id);
d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
copyFileSync(`${home}/stam.db`, `${home}/stam.pre.db`);

const refs = [a.id, a.key, b.key, c.id, c.key, e.key, f.key, g.key, h.key, i.key, j.key, 'nope', 'S-99999', '', 'incident'];
const cases = refs.map((ref) => ({ ref, marked: owners.incidentMarkedHere(ref) }));
writeFileSync(`${home}/expect.json`, JSON.stringify({ cases }));
process.exit(0);
