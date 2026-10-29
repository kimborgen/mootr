// The Agents table's name column (S-3023) on a test daemon: node agents-name.mjs BASE_URL OUT_DIR [--table]
// Measures each desk viewport from 1440 px down to 761 px (761 px and below is the phone list, which has no table). Each
// width is a fresh load of the page at that width, so each reading is the page as it draws at that width.
// The scan is coarse (every 4 px) and then 1 px apart around each drop edge, so each edge is measured 1 px above and 1 px
// below. At each width it reads the table's box, the name column's width and which columns are shown. It fails when the name
// column is under 200 px (the rule in docs/design-system.md), when a shown column's header is clipped, when the table runs past
// its box (a sideways scroll), or when the page crashes. --table prints every measured row. --scope=archived (or stopped, and so
// on) measures that scope instead of the live one. Shots go to OUT_DIR: each drop edge's narrowest width, 1440 and the phone.
// Run it against a fresh daemon with SEED_PHONE_LIST=1 (web/check/run.sh agents-name). Prints one line per check; exits 1 on a fail.
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { mkdirSync } from 'node:fs';
import { findPlaywright } from './find-playwright.mjs';

const [base, out, ...flags] = process.argv.slice(2);
if (!base || !out) { console.error('usage: node agents-name.mjs BASE_URL OUT_DIR [--table] [--scope=live|archived|stopped]'); process.exit(2); }
const allRows = flags.includes('--table');
const scope = flags.find((f) => f.startsWith('--scope='))?.slice('--scope='.length) ?? 'live';
mkdirSync(out, { recursive: true });
const MIN_NAME = 200;
const TOP = 1440;
const DESK_MIN = 761;
const COARSE = 4;
const { chromium } = findPlaywright();
const browser = await chromium.launch(chromiumLaunchOptions());
const origin = new URL(base).origin;
const token = new URLSearchParams(new URL(base).hash.slice(1)).get('token') ?? '';
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ': ' + detail : ''}`); };

const ctx = await browser.newContext({ viewport: { width: TOP, height: 900 }, colorScheme: 'light' });
const p = await ctx.newPage();
p.setDefaultTimeout(20000);
p.on('pageerror', (e) => console.log(`pageerror: ${e.message}`));

// Loads the desk's Agents page at the current viewport. Returns false when the table doesn't draw (or the page crashed).
// The scope is set on each load: the chips when they fit, else the scope select (the desk's own two forms).
const pickScope = async () => {
  const chip = p.locator(`section.agents-desk [data-scope-chip="${scope}"]`).first();
  if (await chip.isVisible().catch(() => false)) await chip.click();
  else await p.locator('section.agents-desk [data-scope-select]').selectOption(scope).catch(() => {});
  await p.waitForTimeout(300);
};
const load = async () => {
  await p.goto(origin + '/#token=' + token);
  await p.waitForSelector('[data-nav="left"], .agents-desk, #tree', { timeout: 30000 }).catch(() => {});
  await p.evaluate(() => window.stamDebug.shell.showAgentWorld('w:agents'));
  await p.waitForTimeout(400);
  if (!(await p.locator('section.agents-desk').count())) return false;
  await pickScope();
  return p.waitForSelector('section.agents-desk table.agents-table .ac-name', { timeout: 8000 }).then(() => true, () => false);
};

// One sample at the current viewport: the container, the name column, the shown columns, and any clipping.
const sample = () => p.evaluate(() => {
  const wrap = document.querySelector('.agents-table-wrap');
  const table = document.querySelector('table.agents-table');
  const ths = [...table.querySelectorAll('thead th')];
  const shown = ths.filter((th) => getComputedStyle(th).display !== 'none').map((th) => [...th.classList].find((c) => c.startsWith('ac-')) ?? th.textContent.trim());
  const name = table.querySelector('th.ac-name').getBoundingClientRect().width;
  const clipped = ths.filter((th) => getComputedStyle(th).display !== 'none' && th.scrollWidth > th.clientWidth + 1).map((th) => th.textContent.trim() || th.className);
  const overrun = Math.max(0, table.getBoundingClientRect().width - wrap.clientWidth);
  return { wrapW: wrap.clientWidth, name, shown: shown.join(' '), clipped, overrun };
});

const rows = new Map();
const crashed = [];
const missing = [];
const measure = async (w) => {
  if (rows.has(w) || missing.includes(w)) return rows.get(w);
  await p.setViewportSize({ width: w, height: 900 });
  const there = await load();
  if (!there) {
    if (await p.getByText("Couldn't show this view").count()) crashed.push(w); else missing.push(w);
    await p.screenshot({ path: `${out}/crash-${w}.png` });
    return null;
  }
  const s = await sample();
  rows.set(w, { w, ...s });
  return rows.get(w);
};
const shownAt = async (w) => (await measure(w))?.shown ?? null;

// Coarse pass from the top down, then 1 px around every width where the shown columns change.
const coarse = [];
for (let w = TOP; w >= DESK_MIN; w -= COARSE) coarse.push(w);
if (coarse[coarse.length - 1] !== DESK_MIN) coarse.push(DESK_MIN);
for (const w of coarse) await measure(w);
for (let i = 0; i < coarse.length - 1; i++) {
  const hi = coarse[i];
  const lo = coarse[i + 1];
  if ((await shownAt(hi)) === (await shownAt(lo))) continue;
  for (let w = hi; w >= lo; w--) await measure(w);
}

const measured = [...rows.values()].sort((a, b) => b.w - a.w);
const edges = [];
for (let i = 0; i < measured.length - 1; i++) if (measured[i].shown !== measured[i + 1].shown && measured[i].w - measured[i + 1].w === 1) edges.push(measured[i].w);
const under = measured.filter((r) => r.name < MIN_NAME);
check(`the name column is at least ${MIN_NAME} px at every measured desk width (${DESK_MIN}-${TOP} px)`, under.length === 0,
  under.length ? `${under.length} widths under, first at ${under[0].w} px (${under[0].name.toFixed(1)} px)` : `min ${Math.min(...measured.map((r) => r.name)).toFixed(1)} px`);
check('the Agents desk renders at every measured width', crashed.length === 0 && missing.length === 0,
  [crashed.length ? `${crashed.length} crashed (React error #185), first at ${crashed[0]} px` : '', missing.length ? `${missing.length} with no table` : ''].filter(Boolean).join('; '));
const clip = measured.filter((r) => r.clipped.length);
check('no shown column header is clipped', clip.length === 0, clip.length ? `${clip.length} widths, first at ${clip[0].w} px: ${clip[0].clipped.join(', ')}` : '');
const over = measured.filter((r) => r.overrun > 0.5);
check('the table never runs past its box (no sideways scroll)', over.length === 0, over.length ? `${over.length} widths, first at ${over[0].w} px by ${over[0].overrun.toFixed(1)} px` : '');

const show = (r) => `${String(r.w).padStart(5)} | ${String(r.wrapW).padStart(5)} | ${r.name.toFixed(1).padStart(7)} | ${r.shown}`;
console.log('\n viewport | box px | name px | shown columns');
for (const r of measured) {
  const isEdge = edges.some((e) => Math.abs(e - r.w) <= 1);
  if (allRows || r.w === TOP || isEdge) console.log(show(r));
}
console.log(`drop edges (viewport px, the table at it and 1 px narrower): ${edges.join(', ') || 'none'}`);
console.log(`measured ${measured.length} widths; crashed ${crashed.length}; no table ${missing.length}`);

// Shots: a fresh load at each width, asserted to be that wide. The drop edges are the widths 1 px above each new drop
// (the container at 1021, 931, 901, 811 and 621 px), where the name column is narrowest; 1440 is the desk at its widest.
for (const w of [1440, 1320, 1230, 1200, 1110, 920]) {
  await p.setViewportSize({ width: w, height: 900 });
  const drew = await load();
  const inner = await p.evaluate(() => window.innerWidth);
  check(`the shot at ${w} px is ${w} px wide`, inner === w, `${inner} px`);
  if (!drew) { check(`the shot at ${w} px shows the table`, false); continue; }
  const name = await p.evaluate(() => document.querySelector('th.ac-name').getBoundingClientRect().width);
  const box = await p.evaluate(() => document.querySelector('.agents-table-wrap').clientWidth);
  await p.screenshot({ path: `${out}/desk-${w}.png` });
  console.log(`shot ${w} px (box ${box} px): name ${name.toFixed(1)} px -> ${out}/desk-${w}.png`);
}
await ctx.close();

// The phone (360 px): the list, not the table, so the name rule does not apply there.
const pctx = await browser.newContext({ viewport: { width: 360, height: 780 }, colorScheme: 'light', isMobile: true, hasTouch: true });
const pp = await pctx.newPage();
pp.setDefaultTimeout(20000);
await pp.goto(origin + '/#token=' + token);
await pp.waitForSelector('[data-nav="left"]', { timeout: 30000 });
await pp.evaluate(() => window.stamDebug.shell.showAgentWorld('w:agents'));
await pp.waitForSelector('section.agents-phone .arow', { timeout: 20000 });
await pp.waitForTimeout(300);
check('360 px shows the phone list, not the table', (await pp.locator('section.agents-phone').count()) === 1 && (await pp.locator('table.agents-table').count()) === 0);
await pp.screenshot({ path: `${out}/phone-360.png` });
await pctx.close();
await browser.close();
console.log(failed ? `${failed} failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
