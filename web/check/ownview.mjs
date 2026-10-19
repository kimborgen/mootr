// stam's own view of an agent (S-79) in headless Chromium, on desktop and at 360 px light,
// against a test daemon with the fake OpenCode and a seeded conversation:
//   OWN_VIEW=1 web/check/run.sh ownview
//   node web/check/ownview.mjs BASE_URL OUT_DIR       (a daemon from OWN_VIEW=1 daemon.sh)
// Opens oc's conversation from its menu, checks the mail components, folded thinking and tool
// calls, the capped centred column, paging older messages, answering the permission, and a
// prompt from the bottom input, mail to the agent as sheets on the user's side with their read
// state (S-203), and the working indicator (S-205); at 360 px, no bar, the state on the tab
// icon and Stop in the header (S-205), a stam mail notice folded to one line and opened by a tap
// (S-296) in light and dark, and the same view by touch with no sideways scroll and
// 44 px targets, and Open thread on a mail in the assistant's overlay (S-378) opens the thread
// over the page, the overlay closing. No model runs. Screenshots: OUT_DIR/ownview-*.png.
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { mkdirSync } from 'node:fs';
import { findPlaywright } from './find-playwright.mjs';

const [base, out] = process.argv.slice(2);
if (!base || !out) { console.error('usage: node ownview.mjs BASE_URL OUT_DIR'); process.exit(2); }
mkdirSync(out, { recursive: true });
const { chromium, devices } = findPlaywright();
const u = new URL(base);
const token = new URLSearchParams(u.hash.slice(1)).get('token') ?? '';
const testHuman = new URLSearchParams(u.hash.slice(1)).get('testHuman') ?? '';
const origin = u.origin;
const api = (path) => fetch(origin + path, { headers: { authorization: 'Bearer ' + token, 'x-stam-human': '1' } }).then((r) => r.json());
const call = (method, path, body) => fetch(origin + path, { method, headers: { authorization: 'Bearer ' + token, 'x-stam-human': '1', 'x-stam-test-human': testHuman, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

let failures = 0;
const check = (tag, ok, what, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} [${tag}] ${what}${ok || detail === undefined ? '' : ` (got ${typeof detail === 'string' ? detail : JSON.stringify(detail)})`}`);
  if (!ok) failures++;
};
const oc = (await api('/api/agents')).find((a) => a.name === 'oc');
if (!oc) { console.error('no agent named oc: use a daemon from OWN_VIEW=1 web/check/daemon.sh'); process.exit(2); }
check('api', !!oc.view?.can_send, 'the agent list carries the view capabilities', oc.view);

const browser = await chromium.launch(chromiumLaunchOptions());
async function open(tag, opts, theme = 'light') {
  const ctx = await browser.newContext({ colorScheme: theme, ...opts });
  // The view's sends are the human's own; this header stands in for tailscale serve.
  if (testHuman) await ctx.route(`${origin}/api/agents/*/view/*`, (r) => r.continue({ headers: { ...r.request().headers(), 'x-stam-test-human': testHuman } }));
  // The composer asks for the voice status (GET /api/voice), which only the human reads.
  if (testHuman) await ctx.route(`${origin}/api/voice`, (r) => r.continue({ headers: { ...r.request().headers(), 'x-stam-test-human': testHuman } }));
  await ctx.addInitScript((t) => { try { localStorage.setItem('stam/theme', t); } catch {} }, theme);
  const p = await ctx.newPage();
  p.setDefaultTimeout(10000);
  p.on('pageerror', (e) => check(tag, false, 'no page error', e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/compute-pressure/.test(m.text())) check(tag, false, 'no console error', m.text()); });
  await p.goto(origin + '/#token=' + token);
  await p.waitForSelector('#tree .node', { state: 'attached', timeout: 20000 });
  await p.waitForTimeout(1000);
  return p;
}
const shot = (p, name) => p.screenshot({ path: `${out}/ownview-${name}.png` });
// The seeded mail notice (S-296): one line, collapsed; a tap or click opens the full text.
// Screenshots: OUT_DIR/ownview-TAG-notice.png and -notice-open.png.
async function mailNotice(p, tag, name) {
  const row = p.locator('.ov-msg[data-id="msg_seednotice"]');
  const toggle = row.locator('.ov-mail-notice button');
  await row.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await toggle.waitFor({ state: 'visible' });
  check(tag, await toggle.innerText() === '[stam] You have mail', 'the mail notice shows as one line', await toggle.innerText().catch(() => 'missing'));
  check(tag, await toggle.getAttribute('aria-expanded') === 'false' && await row.locator('.ov-mail-notice .ov-text').count() === 0, 'the mail notice starts collapsed');
  check(tag, /Child kid finished/.test(await row.innerText()), 'the other notice in the row shows as it is');
  await shot(p, `${tag}-${name}`);
  await toggle.click();
  await row.locator('.ov-mail-notice .ov-text', { hasText: 'Unless stopping now' }).waitFor({ state: 'visible' });
  check(tag, await toggle.getAttribute('aria-expanded') === 'true' && /Unless stopping now/.test(await row.locator('.ov-mail-notice .ov-text').innerText().catch(() => '')), 'a click opens the full mail notice text');
  await shot(p, `${tag}-${name}-open`);
}
const ids = (p) => p.locator('.ov .ov-msg').evaluateAll((els) => els.map((e) => e.dataset.id));

// --- Phone, 360 px light -------------------------------------------------------------------
{
  const tag = '360-light';
  const p = await open(tag, { ...devices['Pixel 7'], viewport: { width: 360, height: 740 } });
  await p.locator('[data-nav="left"]').tap();
  await p.waitForTimeout(300);
  await p.locator('#tree .node:has(.name:text-is("oc")) [data-more]').first().tap();
  await p.locator('.menu [role=menuitem]', { hasText: 'Conversation' }).tap();
  await p.waitForSelector('.ov .ov-msg');
  await p.waitForTimeout(800);
  const r = await p.evaluate(() => {
    const W = innerWidth;
    const vis = (el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 && !el.closest('[hidden]'); };
    const scrolls = (el) => { for (let a = el.parentElement; a; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') return true; } return false; };
    const wide = [...document.querySelectorAll('.ov *')].filter((el) => vis(el) && el.getBoundingClientRect().right > W + 1 && !scrolls(el)).map((el) => el.className).slice(0, 5);
    const inView = (b) => b.bottom > 0 && b.top < innerHeight;
    const small = [...document.querySelectorAll('.ov button, .ov summary')].filter((el) => vis(el) && inView(el.getBoundingClientRect()) && !el.closest('.md .mb-table, .mb-code'))
      .map((el) => ({ el, b: el.getBoundingClientRect() })).filter(({ b }) => Math.min(b.width, b.height) < 43.5).map(({ el, b }) => `${el.tagName}.${el.className} ${Math.round(b.width)}x${Math.round(b.height)}`);
    const col = document.querySelector('.ov-scroll > .ov-col').getBoundingClientRect();
    return { scrollW: document.scrollingElement.scrollWidth, W, wide, small, col: col.width };
  });
  check(tag, r.scrollW <= r.W && !r.wide.length, 'no sideways scroll', r.wide.join(', '));
  check(tag, !r.small.length, 'touch targets at least 44 px', r.small.join('; '));
  check(tag, r.col >= r.W - 40, 'the column takes the full width', r.col);
  check(tag, await p.locator('#w-bottom .composer textarea').isVisible(), 'the prompt input shows under the conversation');
  // No bar under the conversation: the seeded turn waits on a permission, so the tab icon says
  // blocked, Stop is the prompt input's send button, and the indicator says what it waits for.
  check(tag, await p.locator('.tabbar .tab.active .glyph').getAttribute('data-state') === 'blocked', 'the tab icon shows the waiting turn', await p.locator('.tabbar .tab.active .glyph').getAttribute('data-state').catch(() => 'none'));
  check(tag, await p.locator('#mobile-nav [data-nav="main"] .glyph').getAttribute('data-state') === 'blocked', 'the bottom navigation shows it too');
  check(tag, await p.locator('#w-bottom .composer button[aria-label="Stop"]').isVisible(), 'Stop is the send button while the turn runs');
  check(tag, await p.locator('.ov-work.asking').innerText() === 'Waiting for your answer', 'the indicator says the turn waits on you');
  await p.locator('.ov-scroll').evaluate((s) => { s.scrollTop = s.scrollHeight; });
  await p.waitForTimeout(400);
  // The mixed exchange, from its top; the permission waits below it.
  await p.locator('.ov-msg[data-id="msg_seed0053"]').evaluate((e) => e.scrollIntoView({ block: 'start' }));
  await p.waitForTimeout(300);
  await p.locator('.ov-msg[data-id="msg_seed0053"] details.ov-tools > summary').tap();
  await p.waitForTimeout(300);
  await shot(p, '360-light-drawer-open');
  await p.locator('.ov-msg[data-id="msg_seed0053"] details.ov-tools > summary').tap();
  await p.waitForTimeout(300);
  await shot(p, '360-light');
  await p.locator('.ov-scroll').evaluate((s) => { s.scrollTop = s.scrollHeight; });
  await p.waitForTimeout(300);
  const perm = p.locator('.ov-msg[data-id="msg_seedrun"] .ov-perm');
  check(tag, await perm.locator('button', { hasText: 'Allow once' }).isVisible(), 'the permission card shows its buttons');
  await shot(p, '360-light-permission');
  await p.locator('.ov-msg[data-id="mail:m_seedread"]').evaluate((e) => e.scrollIntoView({ block: 'start' }));
  await p.waitForTimeout(300);
  await shot(p, '360-light-mail');
  await p.locator('.ov-msg[data-id="mail:m_seedunread"]').evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await p.waitForTimeout(300);
  await shot(p, '360-light-mail-unread');
  const sentGap = await p.locator('.ov-msg[data-id="mail:m_seedsent"]').evaluate((e) => e.getBoundingClientRect().left - e.closest('.ov-col').getBoundingClientRect().left);
  check(tag, sentGap < 2, 'a mail the agent sent sits on its side', sentGap);
  await mailNotice(p, tag, 'notice');
  await p.context().close();
}

// --- Phone, 360 px dark: the mail notice in the other theme -----------------------------------
{
  const tag = '360-dark';
  const p = await open(tag, { ...devices['Pixel 7'], viewport: { width: 360, height: 740 } }, 'dark');
  await p.locator('[data-nav="left"]').tap();
  await p.locator('#tree .node:has(.name:text-is("oc")) [data-more]').first().waitFor({ state: 'visible' });
  await p.locator('#tree .node:has(.name:text-is("oc")) [data-more]').first().tap();
  await p.locator('.menu [role=menuitem]', { hasText: 'Conversation' }).tap();
  await p.waitForSelector('.ov .ov-msg');
  await p.locator('.ov-msg[data-id="msg_seedrun"] .ov-perm').waitFor({ state: 'visible' });
  await mailNotice(p, tag, 'notice');
  await p.context().close();
}

// --- Desktop -------------------------------------------------------------------------------
{
  const tag = 'desktop';
  const p = await open(tag, { viewport: { width: 1500, height: 900 } });
  const node = p.locator('#tree .node:has(.name:text-is("oc"))').first();
  await node.click({ button: 'right' });
  await p.getByRole('menuitem', { name: 'Conversation' }).click();
  await p.waitForSelector('.ov .ov-msg');
  await p.waitForTimeout(800);
  check(tag, /^oc\b/.test(await p.locator('.tab.active, .tab[aria-selected=true]').first().locator('.label').innerText().catch(() => '')), 'the tab is the agent\'s conversation');
  const msg = p.locator('.ov-msg[data-id="msg_seed0053"]');
  check(tag, await msg.locator('.mb-callout').count() === 1 && await msg.locator('.mb-metrics').count() === 1 && await msg.locator('table').count() === 1 && await msg.locator('.mb-checklist').count() === 1,
    'mail components render inside the assistant\'s message');
  check(tag, !(await msg.locator('details.ov-reasoning').evaluate((d) => d.open)), 'thinking starts folded');
  // Four calls in a row fold into one drawer, closed; its header counts them and shows the latest.
  const drawer = msg.locator('details.ov-tools');
  check(tag, await drawer.count() === 1 && !(await drawer.evaluate((d) => d.open)), 'the run of tool calls is one drawer, closed');
  check(tag, await drawer.locator('summary .ov-tools-n').innerText() === '4 tool calls', 'the drawer counts its calls', await drawer.locator('summary .ov-tools-n').innerText());
  check(tag, await drawer.locator(':scope > summary > .ov-what code').innerText() === 'npx tsc --noEmit', 'the drawer shows the latest call', await drawer.locator(':scope > summary > .ov-what code').innerText());
  await msg.locator('details.ov-tools > summary').click();
  check(tag, await msg.locator('details.ov-tool summary code').first().innerText() === 'npm test', 'opening the drawer shows each call, the first on one line');
  await msg.locator('details.ov-tool summary').first().click();
  check(tag, /212 passed/.test(await msg.locator('.ov-tool-out').first().innerText()), 'opening a call shows its output');
  const col = await p.locator('.ov-scroll > .ov-col').evaluate((c) => { const b = c.getBoundingClientRect(), s = c.parentElement.getBoundingClientRect(); return { w: b.width, left: b.left - s.left, right: s.right - b.right, rem: parseFloat(getComputedStyle(document.documentElement).fontSize) }; });
  check(tag, col.w <= 48 * col.rem + 1 && Math.abs(col.left - col.right) < 24, 'the column is capped and centred', col);
  // Agent prose spans the column like tool rows (S-1479), not the 75ch mail measure.
  const prose = await msg.locator('.ov-text > p').first().evaluate((e) => e.getBoundingClientRect().width).catch(() => 0);
  check(tag, prose >= col.w - 2, 'agent prose spans the full column', { prose, col: col.w });
  // Mail to the agent (S-203): sheets on the user's side, where they were sent, with their read state.
  const read = p.locator('.ov-msg[data-id="mail:m_seedread"]');
  const unread = p.locator('.ov-msg[data-id="mail:m_seedunread"]');
  check(tag, /^Read \d\d:\d\d$/.test(await read.locator('.ov-mail-read').innerText()), 'a read mail says when the agent read it', await read.locator('.ov-mail-read').innerText());
  check(tag, await unread.locator('.ov-mail-read').innerText() === 'Unread' && await unread.locator('.who').innerText() === 'cos', 'an unread mail says so, with its sender', await unread.locator('.ov-mail-head').innerText());
  // Mail the agent sent (S-255): the same sheet on its side, saying who read it.
  const sent = p.locator('.ov-msg.out[data-id="mail:m_seedsent"]');
  check(tag, await sent.locator('.who').innerText() === 'To you' && /^Read \d\d:\d\d$/.test(await sent.locator('.ov-mail-read').innerText()), 'a sent mail says who it went to and that they read it', await sent.locator('.ov-mail-head').innerText().catch(() => 'missing'));
  const order = await ids(p);
  check(tag, order.indexOf('mail:m_seedread') === order.indexOf('msg_seed0052') - 1 && order.indexOf('mail:m_seedsent') === order.indexOf('msg_seed0053') + 1 && order.indexOf('mail:m_seedunread') === order.indexOf('msg_seedrun') - 1, 'each mail sits where it was sent', order.slice(-8));
  const gap = await read.evaluate((e) => e.closest('.ov-col').getBoundingClientRect().right - e.getBoundingClientRect().right);
  check(tag, gap < 2, 'a mail sits on the user\'s side', gap);
  check(tag, await read.locator('.ov-mail-snip').count() === 1, 'a long mail starts as a preview');
  await read.evaluate((e) => e.scrollIntoView({ block: 'start' }));
  await p.waitForTimeout(300);
  await shot(p, 'desktop-light-mail');
  await read.locator('.ov-mail-foot button', { hasText: 'Show all' }).click();
  check(tag, await read.locator('.ov-mail-snip').count() === 0 && await read.locator('.ov-mail-body').count() === 1, 'Show all shows the whole body');
  const mailCap = await read.locator('.ov-mail-body .md > *').first().evaluate((e) => getComputedStyle(e).maxWidth).catch(() => 'missing');
  check(tag, parseFloat(mailCap) > 0 && parseFloat(mailCap) < col.w, 'a mail body paragraph stays capped at the mail measure, narrower than the column', { mailCap, col: col.w });
  const perm = p.locator('.ov-msg[data-id="msg_seedrun"] .ov-perm');
  check(tag, await perm.locator('button', { hasText: 'Allow once' }).count() === 1, 'the waiting permission has its card in the message that asked');
  check(tag, await p.locator('#w-bottom .composer button[aria-label="Stop"]').count() === 1, 'Stop shows while the agent works');
  check(tag, await p.locator('.ov-col > .ov-work.asking').count() === 1, 'the working indicator says the turn waits on a permission');
  // The wave lifts the dots above their box; the box must keep the lift, or it is clipped (S-377).
  const lift = await p.evaluate(() => {
    const w = document.createElement('div');
    w.className = 'ov-work writing';
    w.innerHTML = '<span class="ov-work-dots" aria-hidden="true"><i></i><i></i><i></i></span>';
    document.querySelector('.ov-col').append(w);
    const dots = w.querySelector('.ov-work-dots');
    const P = parseFloat(getComputedStyle(dots.firstElementChild).animationDuration) * 1000;
    for (const a of document.getAnimations()) {
      if (a.animationName !== 'ov-work-wave' || !dots.contains(a.effect.target)) continue;
      a.pause();
      a.currentTime = 0.3 * P + a.effect.getTiming().delay;
    }
    const box = dots.getBoundingClientRect();
    const painted = [...dots.querySelectorAll('i')].map((e) => e.getBoundingClientRect());
    const res = { top: Math.min(...painted.map((r) => r.top)) - box.top, bottom: box.bottom - Math.max(...painted.map((r) => r.bottom)) };
    w.remove();
    return res;
  });
  check(tag, lift.top > -0.01 && lift.bottom > -0.01, 'the working dots are not clipped at the top of the wave', lift);
  await p.locator('.ov-scroll').evaluate((s) => { s.scrollTop = s.scrollHeight; });
  await p.waitForTimeout(400);
  await shot(p, 'desktop-light-drawer-open');
  await msg.locator('details.ov-tools > summary').click();
  await p.waitForTimeout(200);
  await shot(p, 'desktop-light');
  await mailNotice(p, tag, 'notice');

  // Older messages load on scrolling to the top, and what was on screen stays put.
  const before = (await ids(p)).length;
  const anchor = await p.locator('.ov-msg').first().evaluate((e) => e.dataset.id);
  await p.locator('.ov-scroll').evaluate((s) => { s.scrollTop = 0; });
  await p.waitForFunction((n) => document.querySelectorAll('.ov .ov-msg').length > n, before);
  await p.waitForTimeout(300);
  const after = (await ids(p)).filter((id) => !id.startsWith('mail:'));
  check(tag, after.length === 57 && after[0] === 'msg_seed0000', 'scrolling up reads the older messages', `${before} then ${after.length}, first ${after[0]}`);
  const top = await p.locator(`.ov-msg[data-id="${anchor}"]`).evaluate((e) => e.getBoundingClientRect().top - e.closest('.ov-scroll').getBoundingClientRect().top);
  check(tag, top > 0, 'the message that was first stays in view below the new ones', top);
  check(tag, await p.locator('.ov-start').innerText() === 'Start of the conversation', 'the start of the conversation is marked');

  // The permission, answered from the view: the fake runs the tool and ends the turn.
  await p.locator('.ov-scroll').evaluate((s) => { s.scrollTop = s.scrollHeight; });
  await perm.locator('button', { hasText: 'Allow once' }).click();
  await p.waitForFunction(() => /Allowed once/.test(document.querySelector('.ov-msg[data-id="msg_seedrun"] .ov-perm-status')?.textContent ?? ''));
  await p.waitForFunction(() => /removed build/.test(document.querySelector('.ov-msg[data-id="msg_seedrun"] .ov-tool-out')?.textContent ?? '') || document.querySelector('.ov-msg[data-id="msg_seedrun"] .ov-tool-st.done'));
  await p.waitForFunction(() => !document.querySelector('#w-bottom .composer button[aria-label="Stop"]'));
  check(tag, true, 'Allow once runs the tool, and Stop goes when the turn ends');
  check(tag, await p.locator('.ov-work').count() === 0, 'the working indicator goes with the turn');

  // A prompt from the bottom input goes through the view and the reply streams in.
  const bottom = p.locator('#w-bottom .composer');
  check(tag, /oc/.test(await bottom.locator('.cmp-target').innerText().catch(() => '')), 'the bottom prompt input targets the agent');
  // The input starts in the setting's mode (mail); this flow is the direct prompt.
  await bottom.locator('.cmp-mode button', { hasText: 'Direct' }).click();
  await bottom.locator('textarea').fill('Ship it.');
  await bottom.locator('textarea').press('Enter');
  await p.waitForFunction(() => [...document.querySelectorAll('.ov .ov-assistant')].some((m) => m.textContent.includes('Got it: Ship it.')), null, { timeout: 15000 });
  const shown = await p.waitForFunction(() => { const m = [...document.querySelectorAll('.ov .ov-msg')].slice(-2); return m[0]?.classList.contains('ov-user') && m[0].textContent.includes('Ship it.') && m[1]?.textContent.includes('Got it: Ship it.'); }).then(() => true, () => false);
  check(tag, shown, 'the prompt shows as the human\'s message, then the reply');
  await shot(p, 'desktop-light-after');
  await p.context().close();
}

// --- Open thread from the assistant's overlay (S-378) --------------------------------------
// oc is chief of staff, so the assistant overlay shows its conversation over the page. Kim's
// mail to oc is a card there; Open thread takes Kim to the thread, and the overlay closes.
for (const [tag, vp] of [['desktop', { viewport: { width: 1500, height: 900 } }], ['360-light', { ...devices['Pixel 7'], viewport: { width: 360, height: 740 } }]]) {
  await call('POST', '/api/chief-of-staff', { agent: oc.id });
  const sent = await call('POST', '/api/mail', { from: 'human', to: [oc.id], new_thread: true, subject: `Check: open thread ${tag}`, body: 'A follow-up from the overlay.' });
  const p = await open(tag, vp);
  // The desktop opens the overlay with its shortcut; a phone taps the Assistant button in its bottom bar.
  if (tag === 'desktop') await p.keyboard.press('Alt+c');
  else await p.locator('[data-nav="assistant"]').tap();
  await p.waitForSelector('#top-world .top-targets');
  await p.locator(`#top-world .top-targets button[data-target="${oc.id}"]`).click();
  const card = p.locator(`#top-world .ov-msg[data-id="mail:${sent.id}"]`);
  await card.waitFor();
  await card.locator('.ov-mail-foot button', { hasText: 'Open thread' }).click();
  // The thread's mail loads after the view opens, so wait for its text, not the empty view.
  await p.locator('.thread-view:visible', { hasText: 'A follow-up from the overlay.' }).waitFor({ timeout: 30000 });
  const world = await p.evaluate(() => window.stamDebug.shell.currentWorld());
  check(tag, world === 't:' + sent.thread_id, 'Open thread in the assistant opens that thread', world);
  check(tag, await p.locator('#top-world').count() === 0, 'the assistant overlay closes when the thread opens');
  check(tag, (await p.locator('.thread-view:visible').innerText()).includes('A follow-up from the overlay.'), 'the thread shows the mail Kim sent');
  await p.context().close();
}
await call('POST', '/api/chief-of-staff', { agent: null });

await browser.close();
console.log(failures ? `FAIL: ${failures} own view check(s)` : 'PASS: own view checks');
process.exit(failures ? 1 : 0);
