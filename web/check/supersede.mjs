// Superseded mail display (S-1315), in headless Chromium at 360 px light and dark and on desktop, against a
// seeded test daemon (daemon.sh). The agent kid mails the human, then sends a replacement that supersedes
// the first. The check opens the thread, taps the quiet line to open the superseded mail, and finds it
// dimmed with a "Superseded by" link that fits the width and jumps to the replacement:
//   web/check/run.sh supersede
//   node web/check/supersede.mjs BASE_URL OUT_DIR   (a daemon from daemon.sh)
// Screenshots: OUT_DIR/supersede-*.png.
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { mkdirSync } from 'node:fs';
import { findPlaywright } from './find-playwright.mjs';

const [base, out] = process.argv.slice(2);
if (!base || !out) { console.error('usage: node supersede.mjs BASE_URL OUT_DIR'); process.exit(2); }
mkdirSync(out, { recursive: true });
const { chromium, devices } = findPlaywright();
const u = new URL(base);
const token = new URLSearchParams(u.hash.slice(1)).get('token') ?? '';
const testHuman = new URLSearchParams(u.hash.slice(1)).get('testHuman') ?? '';
const origin = u.origin;
const humanHeaders = testHuman ? { 'x-stam-test-human': testHuman } : {};
const agentTokens = JSON.parse(new URLSearchParams(u.hash.slice(1)).get('agents') || '{}');
const call = (method, path, body) => fetch(origin + path, { method, headers: { authorization: 'Bearer ' + (agentTokens[body?.from] || token), 'x-stam-human': '1', 'content-type': 'application/json', ...humanHeaders }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());

let failures = 0;
const check = (tag, ok, what, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} [${tag}] ${what}${ok || detail === undefined ? '' : ` (got ${typeof detail === 'string' ? detail : JSON.stringify(detail)})`}`);
  if (!ok) failures++;
};

const agents = await call('GET', '/api/agents');
const kid = agents.find((a) => a.name === 'kid');
if (!kid) { console.error('no seeded kid agent: restart daemon.sh'); process.exit(2); }
const first = await call('POST', '/api/mail', { from: kid.id, to: ['human'], subject: 'Build plan', body: 'I will delete the build cache, then rebuild everything from scratch.', new_thread: true });
check('api', !!first.id, 'kid mails the human', first);
const second = await call('POST', '/api/mail', { from: kid.id, to: ['human'], subject: 'Re: Build plan', body: 'Correction: I keep the cache and rebuild only the changed packages.', reply_to: first.id, supersedes: first.id });
check('api', !!second.id, 'kid sends a replacement that supersedes the first', second);
const third = await call('POST', '/api/mail', { from: kid.id, to: ['human'], subject: 'Re: Build plan', body: 'Second correction: rebuild only what the tests touch.', reply_to: second.id, supersedes: second.id });
check('api', !!third.id, 'kid supersedes the replacement too, a chain of three', third);
const tid = first.thread_id;

const browser = await chromium.launch(chromiumLaunchOptions());
const sizes = [
  { name: '360', scheme: 'light', ctx: { ...devices['Pixel 7'], viewport: { width: 360, height: 740 } }, tap: true },
  { name: '360', scheme: 'dark', ctx: { ...devices['Pixel 7'], viewport: { width: 360, height: 740 } }, tap: true },
  { name: 'desktop', scheme: 'light', ctx: { viewport: { width: 1280, height: 800 } }, tap: false },
];
for (const size of sizes) {
  const tag = `${size.name}-${size.scheme}`;
  const ctx = await browser.newContext({ ...size.ctx, colorScheme: size.scheme });
  if (testHuman) await ctx.route(`${origin}/api/**`, (r) => r.request().method() === 'GET' ? r.continue() : r.continue({ headers: { ...r.request().headers(), 'x-stam-test-human': testHuman } }));
  await ctx.addInitScript((t) => { try { localStorage.setItem('stam/theme', t); } catch {} }, size.scheme);
  const p = await ctx.newPage();
  p.setDefaultTimeout(10000);
  p.on('pageerror', (e) => check(tag, false, 'no page error', e.message));
  const press = (loc) => (size.tap ? loc.tap() : loc.click());
  await p.goto(origin + '/#token=' + token);
  await p.waitForSelector('#tree .node', { timeout: 20000 });
  const nav = p.locator('[data-nav="mail"]');
  // The phone's Inbox page lists the thread as the same row; the desktop keeps the sidebar list.
  const onPhone = await nav.isVisible();
  if (onPhone) await press(nav);
  const side = onPhone ? '#inbox-view' : '#mail-side';
  await press(p.locator(`${side} .mrow[data-thread="${tid}"]`));
  const line = p.locator(`.thread-view:visible .msg-withdrawn[data-withdrawn="${first.id}"]`);
  await line.waitFor();
  const note = await line.locator('.note').innerText();
  check(tag, note.includes(second.id), 'the quiet line names the replacement', note);
  await press(line.first());
  const card = p.locator(`.thread-view:visible article.msg.superseded[data-id="${first.id}"]`);
  await card.waitFor();
  const link = card.locator(`[data-superseded-link="${second.id}"]`);
  check(tag, (await link.count()) === 1, 'the superseded mail links to its replacement', await link.count());
  const box = await link.boundingBox();
  check(tag, !!box && box.x >= 0 && box.x + box.width <= p.viewportSize().width, 'the link fits the width', box);
  if (size.tap) check(tag, !!box && box.height >= 44, 'the link is a touch target', box?.height);
  check(tag, (await p.locator('.thread-view:visible article.msg.superseded').count()) === 1, 'only the opened superseded mail is dimmed (the other is a quiet row)');
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${out}/supersede-${tag}.png` });
  await press(link);
  await p.waitForSelector(`.thread-view:visible article.msg.flash[data-id="${second.id}"]`);
  check(tag, true, 'the link opens the replacement, itself a withdrawn row, and jumps to it');
  check(tag, (await p.locator(`.thread-view:visible article.msg.superseded[data-id="${second.id}"] [data-superseded-link="${third.id}"]`).count()) === 1, 'the replacement links on to the third mail');
  await ctx.close();
}
await browser.close();
console.log(failures ? `${failures} failed` : 'all ok');
process.exit(failures ? 1 : 0);
