// Settings page, home and peer variants (S-405): the scope note, the "This machine" tag, read-only
// shared controls and the stale warning, on a phone (390 px) and a desktop (1280 px).
//   node web/check/settingsscope.mjs BASE_URL OUT_DIR
// The home variant is the daemon's own reply. The peer variant answers GET /api/config/settings
// with a fake peer reply (the real daemon is a home), so no second daemon runs. Prints one line
// per check and exits 1 if any failed. Screenshots: OUT_DIR/scope-<variant>-<size>.png.
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { mkdirSync } from 'node:fs';
import { findPlaywright } from './find-playwright.mjs';

const [base, out] = process.argv.slice(2);
if (!base || !out) { console.error('usage: node settingsscope.mjs BASE_URL OUT_DIR'); process.exit(2); }
mkdirSync(out, { recursive: true });
const { chromium } = findPlaywright();
const u = new URL(base);
const token = new URLSearchParams(u.hash.slice(1)).get('token') ?? '';
const origin = u.origin;
const browser = await chromium.launch(chromiumLaunchOptions());
let failures = 0;
const check = (name, ok) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); if (!ok) failures++; };

for (const size of [{ n: 'phone', w: 390, h: 844, phone: true }, { n: 'desktop', w: 1280, h: 800 }]) {
  for (const variant of ['home', 'peer', 'stale']) {
    const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h }, isMobile: !!size.phone, hasTouch: !!size.phone });
    await ctx.addInitScript(() => { try { localStorage.setItem('stam/theme', 'light'); localStorage.setItem('stam/settings-section', 'spend'); localStorage.removeItem('stam/settings-item'); } catch {} });
    const p = await ctx.newPage();
    p.setDefaultTimeout(8000);
    if (variant !== 'home') {
      // A peer's reply: the home's shared settings with its own local keys, and which machine is the home.
      await p.route(`${origin}/api/config/settings`, async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const r = await route.fetch();
        const j = await r.json();
        const s = JSON.parse(j.text);
        s.peers = [{ name: 'homebox', url: 'http://homebox:7878', token: 'x' }, ...(s.peers ?? [])];
        await route.fulfill({ response: r, json: { text: JSON.stringify(s), local: j.local, home: 'homebox', stale: variant === 'stale', fetchedAt: variant === 'stale' ? new Date(Date.now() - 7 * 60000).toISOString() : new Date().toISOString() } });
      });
    }
    await p.goto(origin + '/#token=' + token);
    await p.waitForSelector('#tree .node', { timeout: 20000 }).catch(() => {});
    if (size.phone && !(await p.locator('#open-config').first().isVisible())) { await p.locator('[data-nav="left"]').first().tap(); await p.waitForTimeout(500); }
    await p.locator('#open-config').first().click();
    await p.waitForSelector('.settings-view .scope-note');
    const tag = `${variant}-${size.n}`;
    const note = (await p.locator('.scope-note').first().innerText()).replace(/\s+/g, ' ');
    const ctlOff = await p.locator('.settings-inner input[type=number]:disabled, .settings-inner .choice:disabled').count();
    const ctlOn = await p.locator('.settings-inner input[type=number]:not(:disabled), .settings-inner .choice:not(:disabled)').count();
    if (variant === 'home') {
      check(`${tag}: note says shared, kept on the home`, /shared by all machines; kept on/i.test(note));
      check(`${tag}: no control is disabled`, ctlOff === 0 && ctlOn > 0);
    } else {
      check(`${tag}: note points to homebox`, /Shared settings live on homebox\. Change them there/.test(note));
      check(`${tag}: shared controls are disabled`, ctlOff > 0 && ctlOn === 0);
      check(`${tag}: stale note ${variant === 'stale' ? 'shown' : 'absent'}`, (await p.locator('.scope-stale').count()) === (variant === 'stale' ? 1 : 0));
    }
    if (variant === 'peer') {
      // The disabled look (design system: text-disabled ink, no wash or selection fill, default cursor)
      // on a textarea, a segmented control, and a choice card.
      const look = (sel) => p.locator(sel).first().evaluate((el) => { const c = getComputedStyle(el); return { color: c.color, bg: c.backgroundColor, cursor: c.cursor, on: el.classList.contains('on') }; });
      const disabled = await p.evaluate(() => { const d = document.createElement('i'); d.style.color = 'var(--text-disabled)'; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; });
      const clear = 'rgba(0, 0, 0, 0)';
      const ta = await look('.settings-inner textarea:disabled');
      check(`${tag}: textarea disabled look`, ta.color === disabled && ta.bg === clear && ta.cursor === 'default');
      await p.locator('.settings-nav .item', { hasText: 'Executive assistant' }).first().click().catch(() => {});
      const seg = await look('.settings-inner .seg button:disabled').catch(() => null);
      if (seg) check(`${tag}: seg button disabled look, no selection fill`, seg.color === disabled && seg.bg === clear && seg.cursor === 'default');
      await p.locator('.settings-nav .item', { hasText: 'Spending' }).first().click().catch(() => {});
      await p.locator('.settings-inner .choice.on:disabled').first().hover({ force: true }).catch(() => {});
      const ch = await look('.settings-inner .choice.on:disabled').catch(() => null);
      if (ch) check(`${tag}: choice card disabled look, no selection fill`, ch.bg === clear && ch.cursor === 'default');
      check(`${tag}: found a seg and a choice to test`, !!seg && !!ch);
      // Spending: a number input and a chip's remove button have no live look (the chip's x is gone).
      const num = await look('.settings-inner input[type=number]:disabled');
      const bd = await p.locator('.settings-inner input[type=number]:disabled').first().evaluate((el) => getComputedStyle(el).borderColor);
      const subtle = await p.evaluate(() => { const d = document.createElement('i'); d.style.color = 'var(--border-subtle)'; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; });
      check(`${tag}: number input disabled look`, num.color === disabled && num.bg === clear && num.cursor === 'default' && bd === subtle);
      const chipX = await p.locator('.chip-edit button').evaluateAll((els) => els.map((el) => ({ off: el.matches(':disabled'), shown: getComputedStyle(el).display !== 'none' })));
      check(`${tag}: chip remove buttons are disabled and hidden`, chipX.length > 0 && chipX.every((b) => b.off && !b.shown));
      // No shared section keeps a live field, segment, choice or chip button on a peer.
      const live = [];
      for (const label of ['Executive assistant', 'New agents', 'Agent view', 'Agent types', 'Decision steps', 'Mail to you', 'Activity', 'Notifications', 'Context and compaction', 'Spending', 'Resources', 'MCP servers']) {
        await p.locator('.settings-nav .item', { hasText: label }).first().click().catch(() => {});
        await p.waitForTimeout(400);
        const n = await p.locator('.settings-inner :is(input, textarea, select):not(:disabled), .settings-inner :is(.seg button, .choice:not(.type-cards .choice), .chip-edit button):not(:disabled)').evaluateAll((els) => els.map((el) => `${el.tagName.toLowerCase()}.${el.className || el.type || ''}`));
        if (n.length) live.push(`${label}: ${n.join(', ')}`);
      }
      // The type cards only navigate; a type opens to view, with every control of its form disabled.
      await p.locator('.settings-nav .item', { hasText: 'Agent types' }).first().click().catch(() => {});
      await p.locator('.type-cards .choice[data-type="review-ring"]').first().click();
      await p.waitForSelector('.type-form .ring-members');
      const formLive = await p.locator('.type-form :is(input, textarea, select, .seg button, .ring-btn, .ring-add):not(:disabled)').evaluateAll((els) => els.map((el) => `${el.tagName.toLowerCase()}.${el.className || el.type || ''}`));
      const formActs = await p.locator('.type-form :is(button[type=submit], .btn.danger), .type-add').count();
      check(`${tag}: review-ring form has no live control and no save${formLive.length ? ' (' + formLive.join(', ') + ')' : ''}`, formLive.length === 0 && formActs === 0);
      await p.screenshot({ path: `${out}/scope-${tag}-review-ring.png` });
      await p.locator('.type-back').click();
      check(`${tag}: no live control in shared sections${live.length ? ' (' + live.join('; ') + ')' : ''}`, live.length === 0);
      await p.locator('.settings-nav .item', { hasText: 'Spending' }).first().click().catch(() => {});
    }
    await p.screenshot({ path: `${out}/scope-${tag}.png` });
    // The Machines section keeps its controls editable on a peer, tagged "This machine".
    await p.locator('.settings-nav .item', { hasText: 'Machines' }).first().click().catch(async () => { await p.locator('[data-nav="settings"]').first().tap().catch(() => {}); });
    if (variant === 'peer' && !size.phone) {
      await p.waitForSelector('.peer-row');
      check(`${tag}: machines controls stay editable`, (await p.locator('.peer-row input:disabled').count()) === 0 && (await p.locator('.lede .scope-tag').count()) === 1);
      await p.screenshot({ path: `${out}/scope-${tag}-machines.png` });
    }
    await ctx.close();
  }
}
await browser.close();
process.exit(failures ? 1 : 0);
