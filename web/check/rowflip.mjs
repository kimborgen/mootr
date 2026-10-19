// The sidebar's spawn and archive motion in a real browser (S-700), on the Sidebar spawn and archive
// story: a row grows from transparent and small, an issue nudge during the grow adds onto it (it
// doesn't replace it), an archive leaves a ghost that goes, and no row keeps an inline style.
//   node web/check/rowflip.mjs BASE_URL OUT_DIR   (web/check/run.sh rowflip, against a test daemon)
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { mkdirSync } from 'node:fs';
import { findPlaywright } from './find-playwright.mjs';

const [base, out] = process.argv.slice(2);
if (!base || !out) { console.error('usage: node rowflip.mjs BASE_URL OUT_DIR'); process.exit(2); }
mkdirSync(out, { recursive: true });
const { chromium, devices } = findPlaywright();
const origin = new URL(base).origin;
const browser = await chromium.launch(chromiumLaunchOptions());
let failed = 0;
const check = (tag, name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} [${tag}] ${name}${detail ? ': ' + String(detail).slice(0, 300) : ''}`); };

// Plays are paused as they are created, in the page, so no delay between a click and the next
// round trip can let a 220 ms play run on: `hold` wraps `Element.prototype.animate`, `release`
// restores it and lets the held plays go.
const hold = () => {
  const orig = Element.prototype.animate;
  window.__origAnimate = orig;
  Element.prototype.animate = function (...a) { const an = orig.apply(this, a); an.pause(); return an; };
};
const release = () => {
  Element.prototype.animate = window.__origAnimate;
  document.getAnimations().forEach((a) => { if (a.playState === 'paused') a.play(); });
};

// Runs `fn` with every play held, and always lets them go again, even if `fn` rejects.
const held = async (tree, fn) => {
  try { await tree.evaluate(hold); return await fn(); } finally { await tree.evaluate(release).catch(() => {}); }
};

try {
for (const [tag, opts] of [['360', { ...devices['Pixel 7'], viewport: { width: 360, height: 740 } }], ['1500', { viewport: { width: 1500, height: 900 } }]]) {
  const ctx = await browser.newContext(opts);
  try {
  const p = await ctx.newPage();
  await p.goto(origin + '/stories#story=sidebar-spawn-and-archive');
  await p.waitForSelector('.sb-frame iframe');
  const frame = await (await p.locator('.sb-frame iframe').first().elementHandle()).contentFrame();
  await frame.waitForSelector('#df-spawn');
  const f = p.frameLocator('.sb-frame iframe').first();
  const tree = f.locator('.tree').first();
  await tree.waitFor();
  await tree.screenshot({ path: `${out}/before-${tag}.png` });
  // Every play is paused as it is created (`hold`), so nothing depends on how soon the next round
  // trip or task comes: a 220 ms play can't run on while the page waits.
  const grow = await held(tree, async () => {
  const g = await tree.evaluate(async (t) => {
    // React flushes a click's update in a microtask, so each click is followed by one.
    const flush = () => new Promise((r) => setTimeout(r, 0));
    document.querySelector('#df-spawn')?.click();
    await flush();
    const row = t.querySelector('.node[data-id="dev-1"]');
    if (!row) return { row: false };
    const at = () => { const cs = getComputedStyle(row); const m = new DOMMatrixReadOnly(cs.transform); return { ty: m.m42, scale: m.a, opacity: Number(cs.opacity) }; };
    const start = at();
    // An issue event on the same turn: the nudge starts while the grow runs.
    document.querySelector('#df-nudge')?.click();
    await flush();
    const anims = row.getAnimations().map((a) => a.effect.getComputedTiming().duration + ':' + a.effect.composite);
    return { row: true, start, mid: { ...at(), anims } };
  });
  // The checks and the screenshot read the held state, so they run before the plays are released.
  await tree.screenshot({ path: `${out}/nudge-mid-${tag}.png` });
  return g;
  });
  check(tag, 'a spawn makes a row', grow.row);
  check(tag, 'the new row starts displaced, small and transparent', grow.start && Math.abs(grow.start.ty) > 1 && grow.start.scale < 1 && grow.start.opacity < 0.5, JSON.stringify(grow.start));
  check(tag, 'the nudge adds onto the grow (all plays alive, two on add)', grow.mid?.anims.filter((x) => x.endsWith(':add')).length >= 2, JSON.stringify(grow.mid));
  check(tag, 'the grow\'s offset still shows during the nudge', grow.mid && (Math.abs(grow.mid.ty) > 0.5 || grow.mid.opacity < 1), JSON.stringify(grow.mid));
  // The plays end by themselves: wait for the state, not a time.
  await frame.waitForFunction(() => ![...document.querySelectorAll('.tree .node')].some((r) => r.getAnimations().length || /transform|opacity/.test(r.getAttribute('style') ?? '')));
  check(tag, 'no row keeps an inline transform or opacity', true);
  const arch = await held(tree, async () => {
    const r = await tree.evaluate(async () => {
      document.querySelector('#df-archive')?.click();
      await new Promise((res) => setTimeout(res, 0));
      const ghosts = [...document.querySelectorAll('.row-ghosts > *')];
      return { ghosts: ghosts.length, plays: ghosts.flatMap((g) => g.getAnimations()).length };
    });
    await tree.screenshot({ path: `${out}/archive-mid-${tag}.png` });
    return r;
  });
  check(tag, 'an archive leaves a ghost, playing', arch.ghosts === 1 && arch.plays >= 1, JSON.stringify(arch));
  await frame.waitForFunction(() => !document.querySelector('.row-ghosts > *'));
  check(tag, 'the ghost goes', true);
  } finally { await ctx.close(); }
}
} finally { await browser.close(); }
console.log(failed ? `${failed} failed` : 'rowflip: all passed');
process.exit(failed ? 1 : 0);
