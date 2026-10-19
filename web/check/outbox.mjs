// The prompt input's outbox strip (S-373), by touch at 360 px (light and dark) and by pointer on a
// desktop window: a send clears the box at once, a refused one shows as failed and a click puts it
// back, a send that hangs stays pending, a draft set aside shows in its own style, and Save as draft
// moves the box's text to a draft row that a click restores. Needs a
// test daemon (daemon.sh); nothing is spent, because the prompt requests are answered by the check.
//   node web/check/outbox.mjs BASE_URL OUT_DIR
// Screenshots: OUT_DIR/outbox-<size>-<theme>.png. Prints one line per check; exits 1 if any failed.
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { findPlaywright } from './find-playwright.mjs';
import { mkdirSync } from 'node:fs';

const [base, out] = process.argv.slice(2);
if (!base || !out) { console.error('usage: node outbox.mjs BASE_URL OUT_DIR'); process.exit(2); }
mkdirSync(out, { recursive: true });

const { chromium, devices } = findPlaywright();
const u = new URL(base);
const token = new URLSearchParams(u.hash.slice(1)).get('token') ?? '';
const browser = await chromium.launch(chromiumLaunchOptions());
let failed = 0;
const check = (tag, name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} [${tag}] ${name}${detail ? ': ' + String(detail).slice(0, 200) : ''}`); };

// Against the real test daemon: the network goes away and comes back, and an answer is lost after the
// daemon has handled the request. Either way the mail arrives once.
const inbox = (name) => fetch(`${u.origin}/api/agents/${name}/inbox?limit=100`, { headers: { authorization: 'Bearer ' + token, 'x-stam-human': '1' } }).then((r) => r.json());
const copies = async (subject) => (await inbox('helper')).filter((m) => m.subject === subject).length;
async function realDaemon(ctx, p, tag, ta, press, rows) {
  await p.locator('#w-bottom .cmp-mode button', { hasText: 'Mail' }).click();
  const stamp = Date.now() % 100000;
  const send = async (text) => { await ta.fill(text); await press(p.locator('#w-bottom .cmp-send')); };
  const gone = (text) => p.waitForFunction((t) => ![...document.querySelectorAll('#w-bottom .ob-row')].some((r) => r.textContent.includes(t)), text, { timeout: 30000 });

  await ctx.setOffline(true);
  const offline = `offline ${stamp}`;
  await send(offline);
  await p.waitForSelector('#w-bottom .ob-row.pending');
  await p.waitForTimeout(2500);
  check(tag, 'with the network down the message stays pending, not failed', (await rows().evaluateAll((els, t) => els.filter((e) => e.textContent.includes(t)).map((e) => e.dataset.kind), offline)).join() === 'pending');
  check(tag, 'and nothing has reached the daemon', (await copies(offline)) === 0);
  await ctx.setOffline(false);
  await gone(offline);
  check(tag, 'once the network is back the mail arrives exactly once', (await copies(offline)) === 1, await copies(offline));

  // The daemon handles the first try and its answer is lost: the retry carries the same client id.
  const lost = `lost answer ${stamp}`;
  let tries = 0;
  await p.route('**/api/mail', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    tries++;
    if (tries === 1) { await route.fetch(); return route.abort('connectionreset'); }
    return route.fallback();
  });
  await send(lost);
  await gone(lost);
  check(tag, 'a lost answer is retried', tries >= 2, tries);
  check(tag, 'and the retry does not send the mail twice', (await copies(lost)) === 1, await copies(lost));
  await p.unroute('**/api/mail');
}

const RUNS = [
  { tag: '360-light', touch: true, scheme: 'light', opts: { ...devices['Pixel 7'], viewport: { width: 360, height: 740 } } },
  { tag: '360-dark', touch: true, scheme: 'dark', opts: { ...devices['Pixel 7'], viewport: { width: 360, height: 740 } } },
  { tag: '1280-light', touch: false, scheme: 'light', opts: { viewport: { width: 1280, height: 800 } } },
];
for (const run of RUNS) {
  const { tag } = run;
  const ctx = await browser.newContext({ ...run.opts, colorScheme: run.scheme });
  await ctx.addInitScript((t) => { try { localStorage.setItem('stam/theme', t); } catch {} }, run.scheme);
  const p = await ctx.newPage();
  p.setDefaultTimeout(8000);
  p.on('pageerror', (e) => check(tag, 'no page errors', false, e.message));
  // The first send is refused, the second hangs (pending), the rest answer.
  let n = 0;
  await p.route('**/api/agents/*/prompt', async (route) => {
    n++;
    if (n === 1) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: "helper isn't running" }) });
    if (n === 2) return; // never answered
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"sent":true}' });
  });
  // The mic shows once the daemon has a voice key: stub that, so the bar is as full as it gets.
  await p.route('**/api/voice', (route) => (route.request().method() === 'GET' ? route.fulfill({ status: 200, contentType: 'application/json', body: '{"configured":true}' }) : route.fallback()));
  await p.route('**/api/agents/*/view/prompt', async (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: "helper isn't running" }) }));
  await p.goto(base);
  await p.waitForSelector('#tree .node', { timeout: 20000 });
  await p.locator('#tree .node:has(.name:text-is("helper"))').first().locator('.name').click();
  await p.waitForTimeout(2500);
  const toTerminal = p.locator('#w-main .pane.focused .view-switch[data-to="terminal"]');
  if (await toTerminal.isVisible()) { await toTerminal.click(); await p.waitForTimeout(800); }
  const ta = p.locator('#w-bottom .composer textarea');
  // The prompt input starts in the setting's mode, which is Mail; these sends go to /prompt, so pick Direct.
  const modeBar = p.locator('#w-bottom .composer');
  if (await modeBar.locator('.cmp-mode-one').isVisible()) {
    if ((await modeBar.locator('.cmp-mode-one').getAttribute('aria-pressed')) === 'true') await modeBar.locator('.cmp-mode-one').tap();
  } else await modeBar.locator('.cmp-mode button:text-is("Direct")').click();
  const press = (loc) => (run.touch ? loc.tap() : loc.click());
  const rows = () => p.locator('#w-bottom .ob-row');
  const send = async (text) => { await ta.fill(text); await press(p.locator('#w-bottom .cmp-send')); };

  await send('this one is refused');
  await p.waitForSelector('#w-bottom .ob-row.failed');
  check(tag, 'the box is empty right after a send', (await ta.inputValue()) === '');
  const failTitle = await rows().first().getAttribute('title');
  check(tag, 'a refused send shows as failed with its reason', /^Failed: helper isn't running\. Click to put it back in the box$/.test(failTitle ?? ''), failTitle);
  await send('this one hangs\nsecond line');
  await p.waitForSelector('#w-bottom .ob-row.pending');
  check(tag, 'a send that gets no answer stays pending, one line, first line of the text', (await p.locator('#w-bottom .ob-row.pending .ob-text').textContent()) === 'this one hangs');
  const key = await p.evaluate(() => window.stamDebug.shell.activeIn('main'));
  await p.evaluate((k) => window.stamDebug.addDraft(k, 'a draft set aside'), key);
  await p.waitForSelector('#w-bottom .ob-row.draft');
  const kinds = await rows().evaluateAll((els) => els.map((e) => e.dataset.kind));
  check(tag, 'failed, pending and draft rows show together', kinds.join() === 'failed,pending,draft', kinds.join());
  const boxTop = await p.locator('#w-bottom .cmp-box').boundingBox();
  const stripBox = await p.locator('#w-bottom .cmp-outbox').boundingBox();
  check(tag, 'the strip sits directly above the box', stripBox.y + stripBox.height <= boxTop.y + 1 && boxTop.y - (stripBox.y + stripBox.height) < 12, `${stripBox.y + stripBox.height} vs ${boxTop.y}`);
  const vp = run.opts.viewport;
  check(tag, 'the box stays on screen', boxTop.y + boxTop.height <= vp.height, `${boxTop.y + boxTop.height} of ${vp.height}`);
  const widths = await rows().evaluateAll((els) => els.map((e) => e.scrollWidth <= e.clientWidth + 1));
  check(tag, 'no row overflows its width', widths.every(Boolean));
  if (run.touch) {
    const hs = await rows().evaluateAll((els) => els.filter((e) => e.dataset.kind !== 'failed').map((e) => Math.round(e.getBoundingClientRect().height)));
    check(tag, 'pending and draft rows are one thin line of about 30 px', hs.every((h) => h >= 28 && h <= 32), hs.join());
    // S-518: the failed row shows its reason in the row (it may wrap) rather than only in a tooltip.
    check(tag, 'the failed row shows the title and the reason', /this one is refused:\s*helper isn't running/.test(await p.locator('#w-bottom .ob-row.failed .ob-text').textContent()));
    const w = await p.locator('#w-bottom .ob-row.failed').evaluate((e) => [e.getBoundingClientRect().width, e.parentElement.getBoundingClientRect().width]);
    check(tag, 'the failed row spans the strip, so the whole row is the tap target', Math.abs(w[0] - w[1]) < 18, w.join('/'));
  }
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${out}/outbox-${tag}.png` });

  await ta.fill('typed since');
  await press(p.locator('#w-bottom .ob-row.failed'));
  check(tag, 'a click on the failed row puts its text back before what was typed since', (await ta.inputValue()) === 'this one is refused\n\ntyped since', await ta.inputValue());
  check(tag, 'the failed row is gone', (await p.locator('#w-bottom .ob-row.failed').count()) === 0);
  // Save as draft: the text moves to a draft row and the box clears; a click on that row restores it.
  await ta.fill('kept for later');
  check(tag, 'the bar has Save as draft once the box has text', (await p.locator('#w-bottom .cmp-draft').count()) === 1);
  // The resting state: no hover or focus left from the taps before.
  await p.mouse.move(0, 0);
  await p.evaluate(() => document.activeElement?.blur());
  await p.waitForTimeout(300);
  // The bar at its fullest: text in the box, the mic, the assistant, the label, Direct/Mail, Save as draft, send.
  const bar = await p.evaluate(() => {
    const b = document.querySelector('#w-bottom .cmp-bar'); const r = b.getBoundingClientRect()
    const kids = [...b.children].filter((e) => e.getBoundingClientRect().width > 0).map((e) => ({ c: e.className.split(' ')[0], l: Math.round(e.getBoundingClientRect().left), r: Math.round(e.getBoundingClientRect().right), w: Math.round(e.getBoundingClientRect().width) }))
    const t = document.querySelector('#w-bottom .cmp-target')
    return { barL: Math.round(r.left), barR: Math.round(r.right), scroll: b.scrollWidth - b.clientWidth, kids, mic: !!document.querySelector('#w-bottom .cmp-mic'), label: t ? Math.round(t.getBoundingClientRect().width) : 0 }
  });
  check(tag, 'the mic shows in the bar', bar.mic);
  check(tag, 'the bar has no overflow with text, the mic and Save as draft', bar.scroll <= 0 && bar.kids.every((k) => k.l >= bar.barL - 1 && k.r <= bar.barR + 1), JSON.stringify(bar));
  check(tag, 'the target label keeps room for its glyph', bar.label >= 20, bar.label);
  if (run.touch) {
    const one = p.locator('#w-bottom .cmp-mode-one');
    check(tag, 'the phone bar has one mode button, 44 px, in place of the Direct/Mail pair', !(await p.locator('#w-bottom .cmp-mode').isVisible()) && Math.round((await one.boundingBox()).width) === 44);
    check(tag, 'the clear button stays on the phone', await p.locator('#w-bottom .cmp-clear').isVisible());
    await one.tap();
    check(tag, 'the mode button switches to Mail: state, label and send button', (await one.getAttribute('aria-pressed')) === 'true' && /Sending as mail/.test(await one.getAttribute('aria-label')) && (await p.locator('#w-bottom .cmp-send').getAttribute('aria-label')) === 'Mail');
    check(tag, 'in Mail mode the send button still shows the arrow, not a second mail icon', await p.locator('#w-bottom .cmp-send .ico-up').isVisible() && !(await p.locator('#w-bottom .cmp-send .ico-mail').isVisible()));
    await p.mouse.move(0, 0); await one.evaluate((e) => e.blur());
    await p.waitForTimeout(300);
    await p.locator('#w-bottom .composer').screenshot({ path: `${out}/draft-bar-mail-${tag}.png` });
    await one.tap();
    check(tag, 'and back to Direct', (await one.getAttribute('aria-pressed')) === 'false');
    await p.mouse.move(0, 0); await one.evaluate((e) => e.blur());
    await p.waitForTimeout(300);
  }
  await p.locator('#w-bottom .composer').screenshot({ path: `${out}/draft-bar-${tag}.png` });
  await press(p.locator('#w-bottom .cmp-draft'));
  check(tag, 'Save as draft clears the box and the button goes with the text', (await ta.inputValue()) === '' && (await p.locator('#w-bottom .cmp-draft').count()) === 0);
  const kept = p.locator('#w-bottom .ob-row.draft', { hasText: 'kept for later' });
  check(tag, 'the saved text shows as a draft row', (await kept.count()) === 1);
  await press(kept);
  check(tag, 'a click on the draft restores it into the box', (await ta.inputValue()) === 'kept for later', await ta.inputValue());
  check(tag, 'the restored draft leaves the strip', (await p.locator('#w-bottom .ob-row.draft', { hasText: 'kept for later' }).count()) === 0);
  if (!run.touch) await realDaemon(ctx, p, tag, ta, press, rows);
  await ctx.close();
}
await browser.close();
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
