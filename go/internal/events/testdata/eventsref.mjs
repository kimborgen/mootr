// The TS side of the events parity test (S-4317): reads cases as JSON on stdin and answers each with src/watch.ts's own
// globMatch, matchesFilter, fitsSubscription, sanitizeFilter, subjectsForUrl and isFailureEvent, so go/internal/events
// can compare its answers with TS's over the same inputs. Throwaway STAM_HOME, no daemon.
//
//   node go/internal/events/testdata/eventsref.mjs < cases.json
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'stam-eventsref-'));
process.env.STAM_HOME = home;
process.env.STAM_MACHINE = 'test-machine';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
const watch = await import('../../../../src/watch.ts');
let raw = '';
for await (const c of process.stdin) raw += c;
const cases = JSON.parse(raw);
const out = {
  glob: cases.glob.map(([p, v]) => watch.globMatch(p, v)),
  matches: cases.matches.map(([f, ev]) => watch.matchesFilter(f, ev)),
  fits: cases.fits.map(([kind, id, f, ev]) => watch.fitsSubscription({ subscriber_kind: kind, subscriber_id: id, filter: f }, ev)),
  sanitize: cases.sanitize.map((v) => JSON.stringify(watch.sanitizeFilter(v))),
  url: cases.url.map((u) => watch.subjectsForUrl(u)),
  failure: cases.failure.map((ev) => watch.isFailureEvent(ev)),
};
process.stdout.write(JSON.stringify(out));
rmSync(home, { recursive: true, force: true });
process.exit(0);
