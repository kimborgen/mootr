// The PR diff view on a wide desktop pane (S-1531): the split view with the file list beside it, at 1500 px, plus the
// Split/Unified toggle and j/k between files. Needs a test daemon (daemon.sh seeds the PR, seed-diff.sh).
//   node web/check/diffshot.mjs BASE_URL OUT_DIR       writes OUT_DIR/diff-1500-light.png (and dark)
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { mkdirSync } from 'node:fs';
import { findPlaywright } from './find-playwright.mjs';

const [base, out] = process.argv.slice(2);
if (!base || !out) { console.error('usage: node diffshot.mjs BASE_URL OUT_DIR'); process.exit(2); }
mkdirSync(out, { recursive: true });
const { chromium } = findPlaywright();
const u = new URL(base);
const token = new URLSearchParams(u.hash.slice(1)).get('token') ?? '';
const origin = u.origin;
const browser = await chromium.launch(chromiumLaunchOptions());
let failed = 0;
const check = (tag, name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} [${tag}] ${name}${detail ? ': ' + String(detail).slice(0, 300) : ''}`); };

for (const theme of ['light', 'dark']) {
  const tag = `1500-${theme}`;
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 }, colorScheme: theme });
  await ctx.addInitScript((t) => { try { localStorage.setItem('stam/theme', t); localStorage.removeItem('stam.diff.mode'); } catch {} }, theme);
  const p = await ctx.newPage();
  p.setDefaultTimeout(15000);
  p.on('pageerror', (e) => check(tag, 'no page errors', false, e.message));
  await p.goto(origin + '/#token=' + token);
  await p.waitForSelector('#tree .node', { timeout: 20000 });
  await p.evaluate(() => { location.hash = 'diff=fixture:7'; });
  await p.waitForSelector('.dv .dv-count');
  await p.waitForSelector('[data-dv-file="src/a.ts"] .cm-mergeView .cm-line', { timeout: 30000 });
  check(tag, 'the file list is a left column', await p.locator('.dv-side .dv-li').count() === 9 && await p.locator('.dv-files-btn').count() === 0);
  check(tag, 'the split view shows both sides', await p.locator('[data-dv-file="src/a.ts"] .cm-mergeView .cm-editor').count() === 2);
  check(tag, 'a Split/Unified toggle shows, on Split', (await p.locator('.dv-mode button.on').innerText()) === 'Split');
  check(tag, 'changed lines are tinted on the status tokens', await p.locator('[data-dv-file="src/a.ts"] .cm-merge-b .cm-changedLine').first().evaluate((e) => getComputedStyle(e).backgroundColor !== 'rgba(0, 0, 0, 0)'));
  await p.waitForTimeout(500);
  await p.screenshot({ path: `${out}/diff-${tag}.png` });
  await p.locator('.dv-mode button', { hasText: 'Unified' }).click();
  await p.waitForSelector('[data-dv-file="src/a.ts"] .cm-deletedChunk');
  check(tag, 'Unified draws one editor', await p.locator('[data-dv-file="src/a.ts"] .cm-mergeView').count() === 0);
  await p.locator('.dv-mode button', { hasText: 'Split' }).click();
  await p.waitForSelector('[data-dv-file="src/a.ts"] .cm-mergeView');
  await p.locator('.dv-main').hover();
  const top0 = await p.locator('.dv-main').evaluate((e) => e.scrollTop);
  await p.keyboard.press('j');
  await p.waitForFunction((t) => document.querySelector('.dv-main').scrollTop > t, top0);
  check(tag, 'j scrolls to the next file', true);
  // Go to declaration (S-1532) on the head side of the split view: Ctrl-hover underlines a name that has a declaration,
  // Ctrl-click on `dup` shows the picker beside it, and Ctrl-click on `added` jumps to src/new.ts.
  const seen = () => p.evaluate(() => {
    const pick = document.querySelector('.decl-pick');
    return `picker ${pick ? `${pick.dataset.state} "${pick.textContent.slice(0, 160)}"` : 'none'}; underlined ${document.querySelector('.cm-decl-link')?.textContent ?? 'nothing'}; flashed ${[...document.querySelectorAll('.cm-decl-flash')].map((e) => e.textContent).join(', ') || 'nothing'}`;
  });
  const waitFor = async (what, fn, timeout = 15000) => { try { await p.waitForFunction(fn, undefined, { timeout }); } catch { throw new Error(`${what} never showed; the page showed ${await seen()}`); } };
  const wordAt = async (lineText, word) => {
    const line = p.locator('[data-dv-file="src/a.ts"] .cm-merge-b .cm-content .cm-line', { hasText: lineText }).first();
    await line.scrollIntoViewIfNeeded();
    const pt = await line.evaluate((el, w) => {
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const i = n.textContent.indexOf(w);
        if (i < 0) continue;
        const r = document.createRange();
        r.setStart(n, i + 1);
        r.setEnd(n, i + 2);
        const b = r.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      }
      return null;
    }, word);
    if (!pt) throw new Error(`no "${word}" in "${lineText}" on the head side of src/a.ts`);
    return pt;
  };
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  const helper = await wordAt('const line = helper(dup)', 'helper');
  await p.keyboard.down(mod);
  await p.mouse.move(helper.x, helper.y);
  await waitFor('the Ctrl-hover underline on "helper"', () => document.querySelector('.cm-decl-link')?.textContent === 'helper', 45000);
  check(tag, 'Ctrl-hover underlines a name that has a declaration', true);
  const dup = await wordAt('const line = helper(dup)', 'dup');
  await p.mouse.click(dup.x, dup.y);
  await p.keyboard.up(mod);
  await waitFor('the picker listing both "dup"s', () => document.querySelectorAll('.decl-pop .decl-row').length === 2);
  const pop = await p.locator('.decl-pop').evaluate((e) => { const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, r: b.right, b: b.bottom }; });
  check(tag, 'Ctrl-click on a name declared twice shows a popover beside it (below, or above near the bottom), inside the window', (pop.y >= dup.y || pop.b <= dup.y) && pop.x >= 0 && pop.r <= 1500 && pop.b <= 900, JSON.stringify({ pop, dup }));
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${out}/decl-picker-${tag}.png` });
  await p.keyboard.press('Escape');
  await waitFor('the picker closing on Escape', () => !document.querySelector('.decl-pick'));
  const added = await wordAt('const line = added', 'added');
  await p.keyboard.down(mod);
  await p.mouse.click(added.x, added.y);
  await p.keyboard.up(mod);
  await waitFor('the jump to "added" in src/new.ts', () => document.querySelector('[data-dv-file="src/new.ts"] .cm-decl-flash')?.textContent === 'export const added = 1');
  check(tag, 'Ctrl-click on a name declared in a PR file jumps there and marks the line', await p.locator('.decl-pick').count() === 0);
  await ctx.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
