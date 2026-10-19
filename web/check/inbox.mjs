// The Inbox page (S-2054), in headless Chromium against a seeded test daemon (daemon.sh): on a desktop, opening
// it from the Mail tab, clicking a row opens its thread in a pane to the list's right and a second row reuses that
// pane; on a phone, a tap pushes the thread and back returns to the list where it was, rows are touch targets, the
// chips scroll sideways, and a swipe archives or defers.
//   web/check/run.sh inbox
//   node web/check/inbox.mjs BASE_URL OUT_DIR   (a daemon from daemon.sh)
// Screenshots: OUT_DIR/inbox-*.png.
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { mkdirSync } from 'node:fs';
import { findPlaywright } from './find-playwright.mjs';

const [base, out] = process.argv.slice(2);
if (!base || !out) { console.error('usage: node inbox.mjs BASE_URL OUT_DIR'); process.exit(2); }
mkdirSync(out, { recursive: true });
const { chromium, devices } = findPlaywright();
const u = new URL(base);
const token = new URLSearchParams(u.hash.slice(1)).get('token') ?? '';
const testHuman = new URLSearchParams(u.hash.slice(1)).get('testHuman') ?? '';
const origin = u.origin;
const humanHeaders = testHuman ? { 'x-stam-test-human': testHuman } : {};
const agentTokens = JSON.parse(new URLSearchParams(u.hash.slice(1)).get('agents') || '{}');
const ownToken = (path, body) => agentTokens[body?.by ?? body?.from ?? body?.agent];
const call = (method, path, body) => fetch(origin + path, { method, headers: { authorization: 'Bearer ' + (ownToken(path, body) || token), 'x-stam-human': '1', 'content-type': 'application/json', ...humanHeaders }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());

let failures = 0;
const check = (tag, ok, what, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} [${tag}] ${what}${ok || detail === undefined ? '' : ` (got ${typeof detail === 'string' ? detail : JSON.stringify(detail)})`}`);
  if (!ok) failures++;
};

const kid = (await call('GET', '/api/agents')).find((a) => a.name === 'kid');
if (!kid) { console.error('no seeded kid agent: restart daemon.sh'); process.exit(2); }
// Enough threads that the list scrolls on a phone, with long subjects among them.
const N = 22;
for (let i = 0; i < N; i++) {
  const long = i % 4 === 0 ? ' with a long subject that goes past the width of a phone and has to end in an ellipsis' : '';
  await call('POST', '/api/mail', { from: kid.id, to: ['human'], new_thread: true, subject: `Inbox check number ${i}${long}`, body: `Body line one of mail ${i}.\nSecond line.` });
}

const browser = await chromium.launch(chromiumLaunchOptions());
const sizes = [
  { name: 'desktop', ctx: { viewport: { width: 1280, height: 800 } }, phone: false },
  { name: '390', ctx: { ...devices['Pixel 7'], viewport: { width: 390, height: 780 } }, phone: true },
];
for (const size of sizes) {
  const tag = `${size.name}-light`;
  const ctx = await browser.newContext({ ...size.ctx, colorScheme: 'light' });
  if (testHuman) await ctx.route(`${origin}/api/**`, (r) => r.request().method() === 'GET' ? r.continue() : r.continue({ headers: { ...r.request().headers(), 'x-stam-test-human': testHuman } }));
  await ctx.addInitScript(() => { try { localStorage.setItem('stam/theme', 'light'); } catch {} });
  const p = await ctx.newPage();
  p.setDefaultTimeout(10000);
  p.on('pageerror', (e) => check(tag, false, 'no page error', e.message));
  const world = () => p.evaluate(() => window.stamDebug.shell.currentWorld());
  const tabs = () => p.evaluate(() => window.stamDebug.shell.tabsIn());
  const panes = () => p.evaluate(() => window.stamDebug.shell.leaves(window.stamDebug.shell.mainWorld().root).length);
  const shot = (name) => p.screenshot({ path: `${out}/inbox-${size.name}-${name}.png` });
  const rows = () => p.locator('#inbox-view:visible [data-inbox-row]');
  await p.goto(origin + '/#token=' + token);
  await p.waitForSelector('#tree .node', { timeout: 20000 });

  if (!size.phone) {
    // The Mail tab opens the page when it is showing and clicked again.
    const tab = p.locator('#pane-tab-mail');
    if (await tab.count()) { if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click(); await tab.click(); }
    else await p.evaluate(() => { location.hash = 'view=inbox'; });
  } else {
    await p.evaluate(() => { location.hash = 'view=inbox'; });
  }
  await p.waitForFunction(() => window.stamDebug.shell.currentWorld() === 'w:inbox', null, { timeout: 15000 });
  await p.waitForSelector('#inbox-view:visible [data-inbox-row]', { timeout: 15000 }).catch(async (e) => { await shot('failed'); throw new Error(e.message + ' | ' + await p.evaluate(() => JSON.stringify({ w: window.stamDebug.shell.currentWorld(), n: document.querySelectorAll('#inbox-view').length, vis: [...document.querySelectorAll('#inbox-view')].map((x) => x.offsetWidth + 'x' + x.offsetHeight), t: document.body.innerText.slice(0, 300) }))); });
  check(tag, true, 'the Inbox page opens as w:inbox');
  const nRows = await rows().count();
  check(tag, nRows >= N, 'the list holds the seeded threads', nRows);
  check(tag, (await p.locator('#inbox-view:visible .inbox-chip').allTextContents()).map((s) => s.replace(/\s*\d+$/, '')).join('|') === 'To answer|Unread|All|Awaiting|Deferred|Archived', 'the chips are To answer, Unread, All, Awaiting, Deferred, Archived');
  const count = await p.locator('[data-inbox-count]:visible').textContent();
  check(tag, /unread/.test(count), 'the header counts unread threads', count);
  check(tag, await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no sideways page scroll');
  await shot('list');

  if (!size.phone) {
    const first = rows().nth(0), second = rows().nth(1);
    const a = await first.getAttribute('data-thread'), b = await second.getAttribute('data-thread');
    await first.click();
    await p.waitForFunction((t) => window.stamDebug.shell.tabsIn().includes('thread:' + t), a);
    check(tag, (await panes()) === 2 && (await world()) === 'w:inbox', 'a click opens the thread in a second pane, the world stays the inbox', { panes: await panes(), tabs: await tabs() });
    await p.waitForSelector('.thread-view:visible');
    const geo = await p.evaluate(() => ({ list: document.querySelector('#inbox-view').getBoundingClientRect().right, thread: document.querySelector('.thread-view').getBoundingClientRect().left }));
    check(tag, geo.thread >= geo.list - 1, 'the thread pane lies to the right of the list', geo);
    check(tag, (await p.locator(`#inbox-view [data-thread="${a}"].sel`).count()) === 1, 'the open thread\'s row is selected');
    await shot('thread');
    await second.click();
    await p.waitForFunction((t) => window.stamDebug.shell.tabsIn().includes('thread:' + t), b);
    const t2 = await tabs();
    check(tag, (await panes()) === 2 && !t2.includes('thread:' + a) && t2.includes('thread:' + b), 'a second row reuses that pane', t2);
    check(tag, (await p.locator('#inbox-view .mrow.sel').count()) === 1 && (await p.locator(`#inbox-view [data-thread="${b}"].sel`).count()) === 1, 'only the second row is selected');
    // Enter on a focused row opens it too.
    const third = rows().nth(2);
    const c = await third.getAttribute('data-thread');
    await third.focus();
    await p.keyboard.press('Enter');
    await p.waitForFunction((t) => window.stamDebug.shell.tabsIn().includes('thread:' + t), c);
    check(tag, true, 'Enter on a focused row opens it');
    // Search: a subject word finds the thread, a nonsense word finds nothing.
    await p.locator('[data-inbox-search]:visible').fill('number 7');
    await p.waitForFunction(() => document.querySelector('#inbox-view [data-group="results"]') || document.querySelector('#inbox-view [data-inbox-state="empty"]'), null, { timeout: 15000 });
    const hit = await p.locator('#inbox-view:visible [data-inbox-row] .ir-top > .s').allTextContents();
    check(tag, hit.some((s) => s.includes('Inbox check number 7')), 'search lists the thread it finds', hit.slice(0, 3));
    await shot('search');
    await p.locator('[data-inbox-search]:visible').fill('');
    // The key hint shows under the list (S-2189).
    check(tag, (await p.locator('[data-inbox-keys]:visible').count()) === 1, 'the key hint shows under the list');
    // Keys with the search box left (Escape clears it and leaves it): j twice opens the second row after the first, e archives it and the next row opens.
    await p.locator('[data-inbox-search]:visible').press('Escape');
    const all = await rows().evaluateAll((els) => els.map((e) => ({ t: e.dataset.thread, ask: e.classList.contains('ask') })));
    const i = all.findIndex((r, k) => [r, all[k + 1], all[k + 2], all[k + 3]].every((x) => x && !x.ask));
    if (i < 0) throw new Error('need four rows that can be archived in a row');
    await p.locator(`#inbox-view [data-thread="${all[i].t}"]`).click();
    await p.waitForFunction((t) => window.stamDebug.shell.tabsIn().includes('thread:' + t), all[i].t);
    await p.keyboard.press('j');
    await p.keyboard.press('j');
    const [target, next] = [all[i + 2].t, all[i + 3].t];
    await p.waitForFunction((t) => window.stamDebug.shell.tabsIn().includes('thread:' + t), target);
    check(tag, (await p.locator(`#inbox-view [data-thread="${target}"].sel`).count()) === 1, 'j twice opens the second row after the first');
    await shot('keys');
    await p.keyboard.press('e');
    await p.waitForFunction((t) => window.stamDebug.shell.tabsIn().includes('thread:' + t), next);
    await p.waitForFunction((t) => !document.querySelector(`#inbox-view [data-thread="${t}"]`), target);
    check(tag, (await panes()) === 2 && (await world()) === 'w:inbox', 'e archives the open thread, the next row opens in the pane', await tabs());
    check(tag, (await p.locator(`#inbox-view [data-thread="${next}"].sel`).count()) === 1, 'the next row is selected');
    await shot('archived');
    // z puts the archived thread back on the list and opens it.
    await p.keyboard.press('z');
    await p.waitForFunction((t) => window.stamDebug.shell.tabsIn().includes('thread:' + t) && document.querySelector(`#inbox-view [data-thread="${t}"]`), target, { timeout: 15000 });
    check(tag, true, 'z brings the archived thread back and opens it');
  } else {
    check(tag, (await p.locator('[data-inbox-keys]:visible').count()) === 0, 'the key hint is hidden on a phone');
    // Rows are touch targets on two lines; the chips scroll sideways under the header.
    const heights = await rows().evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    check(tag, heights.every((h) => h >= 44), 'every row is at least 44 px tall', Math.min(...heights));
    const chips = await p.locator('#inbox-view:visible .inbox-chips').evaluate((e) => ({ s: e.scrollWidth, c: e.clientWidth, ov: getComputedStyle(e).overflowX }));
    check(tag, chips.ov === 'auto' && chips.s >= chips.c, 'the chips row scrolls sideways', chips);
    // Scroll the list, tap a row: the thread is pushed; back returns with the scroll kept.
    const top = await p.locator('#inbox-view:visible .inbox-list').evaluate((e) => { e.scrollTop = 420; return e.scrollTop; });
    check(tag, top > 100, 'the list scrolls', top);
    await p.waitForTimeout(200);
    const row = p.locator('#inbox-view:visible [data-inbox-row]').filter({ hasText: 'Inbox check number' }).nth(8);
    const tid = await row.getAttribute('data-thread');
    await row.tap();
    await p.waitForFunction((t) => window.stamDebug.shell.currentWorld() === 't:' + t, tid);
    check(tag, true, 'a tap pushes the thread');
    await p.waitForSelector('.thread-view:visible');
    await shot('thread');
    await p.goBack();
    await p.waitForFunction(() => window.stamDebug.shell.currentWorld() === 'w:inbox', null, { timeout: 10000 });
    await p.waitForSelector('#inbox-view:visible [data-inbox-row]');
    await p.waitForTimeout(300);
    const back = await p.locator('#inbox-view:visible .inbox-list').evaluate((e) => e.scrollTop);
    check(tag, Math.abs(back - top) <= 2, 'back returns to the list with its scroll kept', { top, back });
    await shot('back');
    // Swipe left archives, right defers (pointer events with a touch pointer, as swipeRow reads them).
    const swipe = (selector, dx) => p.evaluate(({ selector, dx }) => {
      const row = document.querySelector(selector);
      const r = row.getBoundingClientRect();
      const x0 = r.left + r.width / 2, y = r.top + r.height / 2;
      const ev = (type, x) => new PointerEvent(type, { pointerId: 7, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true });
      row.dispatchEvent(ev('pointerdown', x0));
      for (let i = 1; i <= 8; i++) window.dispatchEvent(ev('pointermove', x0 + (dx * i) / 8));
      window.dispatchEvent(ev('pointerup', x0 + dx));
    }, { selector, dx });
    const rowsOf = async () => (await call('GET', '/api/agents/human/threads?limit=100')).map((t) => t.thread_id);
    // Rows that wait on you can't be archived, and sit first; the swipes take the first two that don't.
    const ids = await p.locator('#inbox-view:visible [data-inbox-row]:not(.ask)').evaluateAll((els) => els.slice(0, 2).map((e) => e.dataset.thread));
    await p.locator(`#inbox-view:visible [data-thread="${ids[0]}"]`).scrollIntoViewIfNeeded();
    await swipe(`#inbox-view [data-thread="${ids[0]}"]`, -96);
    await p.waitForFunction((t) => !document.querySelector(`#inbox-view [data-thread="${t}"]`), ids[0]);
    await p.waitForTimeout(500);
    check(tag, !(await rowsOf()).includes(ids[0]), 'a swipe left archives the thread', ids[0]);
    await swipe(`#inbox-view [data-thread="${ids[1]}"]`, 96);
    await p.waitForFunction((t) => !document.querySelector(`#inbox-view [data-thread="${t}"]`), ids[1]);
    await p.waitForTimeout(500);
    const deferred = await call('GET', '/api/agents/human/threads?limit=100&deferred=1').catch(() => []);
    check(tag, !(await rowsOf()).includes(ids[1]), 'a swipe right defers the thread', ids[1]);
    void deferred;
    await call('POST', `/api/agents/human/threads/${ids[0]}/unarchive`, {});
    await call('POST', `/api/agents/human/threads/${ids[1]}/undefer`, {});
  }
  await ctx.close();
}
await browser.close();
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('inbox: all checks passed');
