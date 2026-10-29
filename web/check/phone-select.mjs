// The phone Agents list's select mode (S-3282) on a test daemon seeded with SEED_PHONE_LIST=1: node phone-select.mjs BASE_URL OUT_DIR
// At 360 and 430 px, in light and dark, it enters select mode and measures the header's targets and each row's x offset
// before and after (no row moves), checks three rows, pauses them and waits a poll for the set to hold, archives them
// through the confirm, then checks the last row of a scrolled list clears the bar, and leaves by Esc and by Back. The
// desk at 1440 px shows the same bar under its table. Prints one line per check; exits 1 on a fail.
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { mkdirSync } from 'node:fs';
import { findPlaywright } from './find-playwright.mjs';

const [base, out] = process.argv.slice(2);
if (!base || !out) { console.error('usage: node phone-select.mjs BASE_URL OUT_DIR'); process.exit(2); }
mkdirSync(out, { recursive: true });
const { chromium, devices } = findPlaywright();
const browser = await chromium.launch(chromiumLaunchOptions());
const origin = new URL(base).origin;
const token = new URLSearchParams(new URL(base).hash.slice(1)).get('token') ?? '';
let failed = 0;
const check = (tag, name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} [${tag}] ${name}${detail ? ': ' + detail : ''}`); };
const shot = async (p, name) => { await p.waitForTimeout(300); await p.screenshot({ path: `${out}/${name}.png` }); };

// The phone's Agents page, opened as the bottom bar's Agents tab opens it.
async function openPhone(ctx) {
  const p = await ctx.newPage();
  await p.goto(origin + '/#token=' + token);
  await p.waitForSelector('[data-nav="left"]', { timeout: 30000 });
  await p.evaluate(() => window.stamDebug.shell.showAgentWorld('w:agents'));
  await p.waitForSelector('section.agents-phone .arow', { timeout: 20000 });
  await p.waitForTimeout(400);
  return p;
}

// The x of each of the first three rows' names, the size of the select button, and the page's world.
const measure = (p) => p.evaluate(() => {
  const rect = (el) => (el ? el.getBoundingClientRect() : null);
  const xs = [...document.querySelectorAll('section.agents-phone .arow')].slice(0, 5).map((r) => Math.round(rect(r.querySelector('.arow-name')).left * 10) / 10);
  const btn = (sel) => { const r = rect(document.querySelector(sel)); return r ? Math.round(r.height) : null; }
  const slot = rect(document.querySelector('section.agents-phone .arow-check')) ?? rect(document.querySelector('section.agents-phone .arow-chev'));
  const row = rect(document.querySelector('section.agents-phone .arow'));
  return { xs, select: btn('[data-select-on]'), all: btn('[data-select-all]'), done: btn('[data-select-done]'), slot: slot ? Math.round(slot.width) : null, row: row ? Math.round(row.height) : null, world: window.stamDebug.shell.currentWorld() };
});

// The bulk bar's top and height, the list's bottom padding, and the bottom of the list's last row.
const foot = (p) => p.evaluate(() => {
  const bar = document.querySelector('.agents-bulk-dock');
  const list = document.querySelector('[data-agents-list]');
  const rows = [...list.querySelectorAll('.arow')];
  const last = rows[rows.length - 1];
  return {
    bar: bar ? { top: bar.getBoundingClientRect().top, h: bar.getBoundingClientRect().height } : null,
    pad: parseFloat(getComputedStyle(list).paddingBottom),
    lastBottom: last ? last.getBoundingClientRect().bottom : null,
    scroll: { top: Math.round(list.scrollTop), client: list.clientHeight, height: list.scrollHeight },
    buttons: [...document.querySelectorAll('[data-agents-bulk] .btn')].map((b) => Math.round(b.getBoundingClientRect().height)),
  };
});

const countText = (p) => p.evaluate(() => document.querySelector('[data-select-count]')?.textContent ?? null);
const checkedIds = (p) => p.evaluate(() => [...document.querySelectorAll('section.agents-phone .arow.on')].map((r) => r.dataset.id));

for (const [size, device] of [['360', devices['Pixel 7']], ['430', devices['iPhone 15']]]) {
  const viewport = size === '360' ? { width: 360, height: 740 } : { width: 430, height: 860 };
  for (const scheme of ['light', 'dark']) {
    const tag = `${size}-${scheme}`
    const ctx = await browser.newContext({ ...device, viewport, colorScheme: scheme });
    const p = await openPhone(ctx);
    const before = await measure(p);
    await p.click('[data-select-on]');
    await p.waitForSelector('[data-select-count]', { timeout: 5000 });
    const after = await measure(p);
    check(tag, 'Select shows the select header, and the first five names keep their x offset', JSON.stringify(before.xs) === JSON.stringify(after.xs), `before ${before.xs} after ${after.xs}`);
    console.log(`     numbers ${tag}: Select ${before.select}px, Select all ${after.all}px, Done ${after.done}px, checkbox slot ${after.slot}px wide, row ${after.row}px high`);
    check(tag, 'Select, Select all and Done are at least 44 px high', [before.select, after.all, after.done].every((h) => h >= 44), `${before.select}/${after.all}/${after.done}`);
    check(tag, 'select mode starts with nothing checked',(await p.evaluate(() => document.querySelector('[data-select-count]')?.textContent)) === '0 selected');
    // The first three rows as the list shows them now: an earlier viewport's archive has taken the seeded roots.
    const first = await p.evaluate(() => [...document.querySelectorAll('section.agents-phone .arow')].slice(0, 3).map((r) => r.dataset.id));
    for (const id of first) await p.click(`.arow[data-id="${id}"] .arow-main`);
    check(tag, 'three taps check three rows', (await countText(p)) === '3 selected', await countText(p));
    check(tag, 'the taps open no agent', (await measure(p)).world === 'w:agents', (await measure(p)).world);
    await p.waitForSelector('.agents-bulk-dock', { timeout: 5000 });
    const f = await foot(p);
    check(tag, 'the list pads its foot by the bar height', f.bar && Math.abs(f.pad - f.bar.h) < 1, `pad ${f.pad} bar ${f.bar?.h}`);
    check(tag, 'the bar buttons are at least 44 px high', f.buttons.length > 0 && f.buttons.every((h) => h >= 44), f.buttons.join('/'));
    console.log(`     bar ${tag}: ${f.bar?.h}px high, list foot padding ${f.pad}px, buttons ${f.buttons.join('/')}px`);
    const row = await p.evaluate(() => {
      const bar = document.querySelector('[data-agents-bulk]');
      const btns = [...bar.querySelectorAll('.btn')];
      return { widths: btns.map((b) => Math.round(b.getBoundingClientRect().width)), labels: btns.map((b) => b.textContent.trim()), fits: bar.scrollWidth <= bar.clientWidth + 0.5, barW: Math.round(bar.clientWidth), tops: [...new Set(btns.map((b) => Math.round(b.getBoundingClientRect().top)))].length };
    });
    check(tag, 'the four actions fit one row, with their labels', row.fits && row.tops === 1 && row.labels.length === 4, `labels ${row.labels.join(' | ')}, widths ${row.widths.join('/')} in ${row.barW}`);
    console.log(`     labels ${tag}: ${row.labels.join(' | ')}; widths ${row.widths.join('/')}px in a ${row.barW}px bar`);
    const zero = await p.evaluate(() => document.querySelector('[data-bulk="resume"]')?.dataset.count === '0');
    if (zero) {
      // aria-disabled reads as not enabled to Playwright, so the tap is forced: it is the tap a disabled action takes.
      await p.click('[data-bulk="resume"]', { force: true });
      await p.waitForTimeout(400);
      const said = await p.evaluate(() => document.body.innerText.includes('None of the 3 can resume'));
      check(tag, 'a tap on Resume with none to resume says why', said);
    }
    await shot(p, `${tag}-select-3`);
    const label = await p.evaluate(() => [...document.querySelectorAll('[data-agents-bulk] [data-bulk]')].map((b) => b.textContent).join(' | '));
    console.log(`     bar ${tag}: ${label}`);

    await p.click('[data-bulk="pause"]');
    await p.waitForFunction(() => document.body.innerText.includes('Paused'), null, { timeout: 15000 }).catch(() => {});
    const toast = await p.evaluate(() => (document.body.innerText.match(/Paused[^\n]*/) ?? [''])[0]);
    check(tag, 'pause ends with one summary line', toast.startsWith('Paused'), toast);
    await p.waitForTimeout(6000);
    check(tag, 'the selection holds through a poll', (await countText(p)) === '3 selected', await countText(p));
    await p.click('[data-bulk="archive"]');
    await p.waitForSelector('[data-bulk-confirm]', { timeout: 5000 });
    await shot(p, `${tag}-archive-confirm`);
    await p.click('[data-bulk-confirm] .btn.danger');
    await p.waitForTimeout(3000);
    check(tag, 'archive with the confirm drops the archived rows from the set', (await p.evaluate(() => document.querySelector('[data-select-count]')?.textContent)) !== '3 selected', await countText(p));

    await p.evaluate(() => { const l = document.querySelector('[data-agents-list]'); l.scrollTop = l.scrollHeight; });
    const ids = await p.evaluate(() => [...document.querySelectorAll('section.agents-phone .arow')].slice(-3).map((r) => r.dataset.id));
    for (const id of ids) await p.evaluate((id) => document.querySelector(`.arow[data-id="${id}"] .arow-main`).click(), id);
    await p.waitForSelector('.agents-bulk-dock', { timeout: 5000 });
    await p.evaluate(() => { const l = document.querySelector('[data-agents-list]'); l.scrollTop = l.scrollHeight; });
    await p.waitForTimeout(300);
    const g = await foot(p);
    check(tag, 'the last row clears the bar at the list foot', g.bar && g.lastBottom <= g.bar.top + 1, `last ${g.lastBottom} bar ${g.bar?.top}`);
    console.log(`     foot ${tag}: list ${JSON.stringify(g.scroll)}, last row bottom ${Math.round(g.lastBottom)}, bar top ${Math.round(g.bar.top)}`);
    await shot(p, `${tag}-foot`);

    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);
    check(tag, 'Esc leaves select mode, and the page stays', (await p.evaluate(() => !document.querySelector('[data-select-count]') && !!document.querySelector('[data-agents-count]'))));
    await p.click('[data-select-on]');
    await p.waitForSelector('[data-select-done]', { timeout: 5000 });
    await p.goBack();
    await p.waitForTimeout(500);
    check(tag, 'the browser Back leaves select mode, and the page stays', (await p.evaluate(() => !document.querySelector('[data-select-count]') && !!document.querySelector('section.agents-phone'))));
    if (size === '360' && scheme === 'light') {
      // The Main tab shows this same Agents world, so a tab that leaves the list is Mail's: select mode ends with it.
      await p.click('[data-select-on]');
      await p.waitForSelector('[data-select-done]', { timeout: 5000 });
      await p.click('[data-nav="mail"]');
      await p.waitForTimeout(500);
      const after = await p.evaluate(() => ({ select: !!document.querySelector('[data-select-count]'), bottomHidden: !!document.querySelector('#w-bottom')?.hidden, composer: !!document.querySelector('#w-bottom .composer') }));
      check(tag, 'Select, then the Mail tab: select mode ends with the list', !after.select, JSON.stringify(after));
      // The Issues panel and the tree (the bottom Agents tab) cover the list without leaving its world: each ends select mode,
      // and no bar is left over the panel.
      for (const [name, nav, from] of [['Issues', 'issues', 'main'], ['tree', 'left', 'main']]) {
        await p.click('[data-nav="' + from + '"]');
        await p.waitForSelector('[data-select-on]', { timeout: 5000 });
        await p.click('[data-select-on]');
        await p.click(`.arow[data-id] .arow-main`);
        await p.waitForSelector('.agents-bulk-dock', { timeout: 5000 });
        await p.click('[data-nav="' + nav + '"]');
        await p.waitForTimeout(500);
        const t = await p.evaluate(() => ({ select: !!document.querySelector('[data-select-count]'), dock: !!document.querySelector('.agents-bulk-dock') }));
        check(tag, `Select, then the ${name} tab: select mode ends and no bar floats over the panel`, !t.select && !t.dock, JSON.stringify(t));
      }
    }
    await ctx.close();
  }
}

// The desk at 1440 px: the bar under its table, the same bulk actions and counts.
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const p = await ctx.newPage();
  await p.goto(origin + '/#token=' + token);
  // The desk has no phone bottom bar, so the desk's own nav button (hidden at 1440) is the page's ready mark.
  await p.waitForSelector('#shell', { state: 'attached', timeout: 30000 });
  await p.waitForFunction(() => !!window.stamDebug, null, { timeout: 30000 });
  await p.evaluate(() => window.stamDebug.shell.showAgentWorld('w:agents'));
  await p.waitForSelector('section.agents-desk tr[data-agent-row]', { timeout: 20000 });
  // The first three rows the table shows, as the phone run has archived the seeded roots.
  const deskIds = await p.evaluate(() => [...document.querySelectorAll('section.agents-desk tr[data-agent-row]')].slice(0, 3).map((r) => r.dataset.agentRow));
  for (const id of deskIds) await p.evaluate((id) => document.querySelector(`tr[data-agent-row="${id}"] td.ac-check`).click(), id);
  await p.waitForSelector('section.agents-desk [data-agents-bulk]', { timeout: 5000 });
  const label = await p.evaluate(() => [...document.querySelectorAll('[data-agents-bulk] [data-bulk]')].map((b) => b.textContent).join(' | '));
  check('1440', 'the desk bar shows its count and actions', label.includes('Pause') && label.includes('Archive'), label);
  check('1440', 'the desk shows no phone select header', !(await p.evaluate(() => document.querySelector('[data-select-count]'))));
  await shot(p, '1440-desk-bar');
  await ctx.close();
}

await browser.close();
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
