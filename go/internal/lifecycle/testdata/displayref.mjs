#!/usr/bin/env node
// S-3807: src/cost-display.ts on the cases of costdisplay_test.go, over a throwaway home with the given settings.
// Argv: settings.json's text and the cases as JSON. Prints one JSON.stringify'd result per case, one per line.
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

const root = new URL('../../../../', import.meta.url);
const { tempHome } = await import(new URL('test/tmphome.mjs', root));
const home = tempHome('stam-display-ref-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `display-ref-${process.pid}`;
process.env.STAM_MACHINE = 'test-machine';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'OPENROUTER_API_KEY']) delete process.env[k];
const [settingsJSON, casesJSON] = process.argv.slice(2);
writeFileSync(join(home, 'settings.json'), settingsJSON);
const cd = await import(new URL('src/cost-display.ts', root));

const out = [];
for (const c of JSON.parse(casesJSON)) {
  if (c.kinds) {
    const kind = cd.kindResolver();
    out.push(c.kinds.map((a) => kind(a)));
    continue;
  }
  if (c.ctx) {
    const ctx = {
      kind: (a) => c.ctx.kinds[a] ?? 'none',
      worth: (a, w) => c.ctx.worths[a]?.[w] ?? null,
      price: (a) => c.ctx.prices[a] ?? null,
    };
    const m = cd.convert(new Map(c.convert ?? []), ctx, c.windowPercent ?? undefined);
    out.push(c.round ? cd.roundModes(m) : m);
    continue;
  }
  if (c.raw) {
    const t = {};
    for (const part of c.raw) cd.addRaw(t, part);
    out.push({ raw: t, modes: cd.rawToModes(t, c.prices ?? {}) });
    continue;
  }
  if (c.tree) {
    const sums = cd.treeSums(c.tree.ids, new Map(Object.entries(c.tree.children)), new Map(Object.entries(c.tree.own)), () => ({ n: 0 }), (into, from) => { into.n += from.n; });
    out.push(Object.fromEntries(c.tree.ids.map((id) => [id, sums.get(id).n])));
    continue;
  }
  if (c.add) {
    const t = cd.zeroModes();
    for (const m of c.add) cd.addModes(t, m);
    out.push(t);
  }
}
console.log(out.map((x) => JSON.stringify(x)).join('\n'));
process.exit(0);
