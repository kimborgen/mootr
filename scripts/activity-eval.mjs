#!/usr/bin/env node
// Live eval of the activity model classifier (S-214): labels N random NULL tool and text items
// from a database (read-only) with the real decision model, and prints how often its category
// agrees with a gold file. Opt-in: it calls the endpoint and spends money, so no test runs it.
//
//   node scripts/activity-eval.mjs --db PATH/stam.db --n 20 --gold gold.json
//
// gold.json is [{"agent_id": "...", "seq": 12, "category": "produce.edit"}, ...]. Items not in
// the gold file are labelled too, but not counted. The estimated cost is printed before the calls.
// The calls' usage is written to a scratch STAM_HOME (a copy of the settings and the key), never
// to the real database.
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: { db: { type: 'string' }, n: { type: 'string', default: '20' }, gold: { type: 'string' } },
});
const dbPath = values.db ?? join(process.env.STAM_HOME ?? join(homedir(), '.local/share/stam'), 'stam.db');
const n = Math.max(1, Number(values.n) || 20);
// What one call costs on average (the real measured figure, S-204: about $0.00005 per item).
const COST_PER_ITEM = 0.00005;

console.log(`classifying ${n} items with the decision model: about $${(n * COST_PER_ITEM).toFixed(4)}`);

// A scratch STAM_HOME: the calls' usage goes there, and the real home's key and settings are copied.
const home = mkdtempSync(join(tmpdir(), 'stam-activity-eval-'));
const real = process.env.STAM_HOME ?? join(homedir(), '.local/share/stam');
for (const f of ['opencode.env', 'settings.json']) if (existsSync(join(real, f))) copyFileSync(join(real, f), join(home, f));
process.env.STAM_HOME = home;

const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db
  .prepare("SELECT agent_id, seq, turn, kind, name, summary FROM activity_items WHERE category_source IS NULL AND kind IN ('tool', 'text') ORDER BY RANDOM() LIMIT ?")
  .all(n);
const previous = db.prepare("SELECT summary FROM activity_items WHERE agent_id = ? AND seq < ? AND kind = 'text' ORDER BY seq DESC LIMIT 1");

const { decide } = await import('../src/decide.ts');
const { itemState, categoryOf, CATEGORY_QUESTION, CLASSIFY_PURPOSE } = await import('../src/activity-classify.ts');

const gold = new Map(
  values.gold
    ? JSON.parse(readFileSync(values.gold, 'utf8')).map((g) => [`${g.agent_id}:${g.seq}`, g.category])
    : [],
);

let labelled = 0;
let agree = 0;
let counted = 0;
for (const row of rows) {
  const prev = previous.get(row.agent_id, row.seq)?.summary ?? null;
  const r = await decide(itemState(row, prev), CATEGORY_QUESTION, { purpose: CLASSIFY_PURPOSE });
  const c = categoryOf(r);
  const key = `${row.agent_id}:${row.seq}`;
  if (!c) {
    console.log(`${key}  no answer`);
    continue;
  }
  labelled++;
  const want = gold.get(key);
  if (want) {
    counted++;
    if (want === c.category) agree++;
    console.log(`${key}  ${want === c.category ? 'ok  ' : 'MISS'} model ${c.category} gold ${want}`);
  } else {
    console.log(`${key}  model ${c.category} (no gold)`);
  }
}
db.close();

console.log(`labelled ${labelled} of ${rows.length}`);
if (counted) console.log(`agreement ${agree}/${counted} = ${((100 * agree) / counted).toFixed(1)}%`);
