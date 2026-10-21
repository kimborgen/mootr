// Runs cron specs through the TS daemon's own src/waits.ts nextCron and src/adapters/claude.ts nextCronFire, for
// go/internal/cron's and go/internal/adapters/claude's golden tests (S-2848 B2a). DIR is a test home (never the live
// home). Requests come as JSON on stdin; each result (the ISO time, null, or {"error": message}) goes out as JSON:
//
//   {"fn": "next", "spec": "...", "from": "ISO"}
//   {"fn": "fire", "spec": "...", "from": "ISO"}
//
//   node go/internal/cron/testdata/ts-cron.mjs DIR < requests.json
import { readFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';

const [dir] = process.argv.slice(2);
if (!dir) {
  console.error('usage: ts-cron.mjs DIR');
  process.exit(2);
}
process.env.STAM_HOME = resolve(dir);
process.env.STAM_MACHINE = 'test-machine';
const config = await import('../../../../src/config.ts');
if (config.LIVE_HOME) {
  console.error('ts-cron: refusing the live home');
  process.exit(2);
}
const waits = await import('../../../../src/waits.ts');
const claude = await import('../../../../src/adapters/claude.ts');

const out = [];
for (const r of JSON.parse(readFileSync(0, 'utf8'))) {
  try {
    if (r.fn === 'next') out.push(waits.nextCron(r.spec, new Date(r.from)).toISOString());
    else out.push(claude.nextCronFire(r.spec, new Date(r.from)));
  } catch (e) {
    out.push({ error: e instanceof Error ? e.message : String(e) });
  }
}
writeSync(1, JSON.stringify(out));
process.exit(0);
