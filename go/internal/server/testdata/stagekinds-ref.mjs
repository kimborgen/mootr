// Runs the stage-narrowed-by-kinds scenario of TestStageKindsMatchesTS through src/itsa.ts: a stage field is narrowed to the kind
// `work`, closing a `work` and an `other` ITSA, then the one-off backfill over both kinds. It writes the stage of each ITSA and the
// backfill's count to expect.json, for go/internal/server's test (S-3233). Never the live home.
//
//   node go/internal/server/testdata/stagekinds-ref.mjs DIR
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: stagekinds-ref.mjs DIR');
  process.exit(2);
}
const home = resolve(dir);
if (existsSync(`${home}/stam.db`)) {
  console.error(`stagekinds-ref: ${home} already has a stam.db`);
  process.exit(2);
}
process.env.STAM_HOME = home;
process.env.STAM_MACHINE = 'test-machine';
const config = await import('../../../../src/config.ts');
if (config.LIVE_HOME) {
  console.error('stagekinds-ref: refusing the live home');
  process.exit(2);
}
const db = await import('../../../../src/db.ts');
const itsa = await import('../../../../src/itsa.ts');

// The end node of both kinds is `done`, as the flow process of TestStageKindsMatchesTS says (its kinds are work and other).
itsa.setCloseStage(() => 'done');
await itsa.createField({ key: 'stage', label: 'Stage', type: 'text' }, 'human');

const a = await itsa.create({ title: 'a', kind: 'work' });
const b = await itsa.create({ title: 'b', kind: 'other' });
const c = await itsa.create({ title: 'c', kind: 'work' });
const e = await itsa.create({ title: 'e', kind: 'other' });
for (const x of [a, b, c, e]) await itsa.set(x.id, { fields: { stage: 'draft' } }, 'human');
await itsa.updateField('stage', { kinds: ['work'] }, 'human');
await itsa.set(a.id, { status: 'done' }, 'human');
await itsa.set(b.id, { status: 'done' }, 'human');
const d = db.open();
d.prepare("UPDATE itsas SET status = 'done' WHERE id IN (?, ?)").run(c.id, e.id);
const backfilled = itsa.backfillClosedStage(() => 'done', ['work', 'other']);

const stageOf = (id) => {
  const r = d.prepare("SELECT v.value FROM itsa_field_values v JOIN itsa_fields f ON f.id = v.field_id WHERE v.itsa_id = ? AND f.key = 'stage'").get(id);
  return r ? JSON.parse(r.value) : null;
};
const stages = { a: stageOf(a.id), b: stageOf(b.id), c: stageOf(c.id), e: stageOf(e.id) };
writeFileSync(`${home}/expect.json`, JSON.stringify({ stages, backfilled }));
process.exit(0);
