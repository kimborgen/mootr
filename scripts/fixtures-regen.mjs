#!/usr/bin/env node
// Rewrites api/fixtures/NAME/cases.json from today's TS code (S-2386). Run it when TS behaviour
// changes on purpose, review the diff, and commit it: the Go ports must match the new files.
// It names every case it adds, removes or changes, and refuses to change a stored output (or
// input) without --accept, so a TS change can't slip into the fixtures unseen.
// Usage: node scripts/fixtures-regen.mjs [--accept] [NAME...]   (no names: every fixture)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, render } from './fixtures-lib.mjs';

const root = join(import.meta.dirname, '..', 'api', 'fixtures');
const args = process.argv.slice(2);
const accept = args.includes('--accept');
const names = args.filter((a) => !a.startsWith('--'));
const known = (text) => new Map(JSON.parse(text).cases.map((c) => [c.name, JSON.stringify(c)]));

let refused = false;
const todo = [];
for (const name of names.length ? names : Object.keys(FIXTURES)) {
  if (!FIXTURES[name]) throw new Error(`unknown fixture ${name}; have ${Object.keys(FIXTURES).join(', ')}`);
  const file = join(root, name, 'cases.json');
  const text = render(name);
  const before = existsSync(file) ? known(readFileSync(file, 'utf8')) : new Map();
  const after = known(text);
  const added = [...after.keys()].filter((n) => !before.has(n));
  const removed = [...before.keys()].filter((n) => !after.has(n));
  const changed = [...after.keys()].filter((n) => before.has(n) && before.get(n) !== after.get(n));
  for (const [label, list] of [['added', added], ['removed', removed], ['CHANGED', changed]]) for (const n of list) console.log(`${name}: ${label}: ${n}`);
  if (changed.length && !accept) {
    console.error(`${name}: ${changed.length} stored case(s) would change; review them, then rerun with --accept`);
    refused = true;
  } else todo.push({ name, file, text, count: after.size });
}
if (refused) process.exit(1);
for (const { name, file, text, count } of todo) {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(file, text);
  console.log(`wrote api/fixtures/${name}/cases.json (${count} cases)`);
}
process.exit(0);
