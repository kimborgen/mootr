// Withdrawn mail (S-413), in headless Chromium at 360 px light and dark and on desktop, against a
// seeded test daemon (daemon.sh). The agent kid asks the human for a permission; its parent helper
// denies it, which withdraws the mail. The check opens the thread, finds the one quiet line with the
// note, that it fits the width and counts in no unread, and that tapping it opens the mail:
//   web/check/run.sh withdraw
//   node web/check/withdraw.mjs BASE_URL OUT_DIR   (a daemon from daemon.sh)
// Screenshots: OUT_DIR/withdraw-*.png.
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { mkdirSync } from 'node:fs';
import { findPlaywright } from './find-playwright.mjs';

const [base, out] = process.argv.slice(2);
if (!base || !out) { console.error('usage: node withdraw.mjs BASE_URL OUT_DIR'); process.exit(2); }
mkdirSync(out, { recursive: true });
const { chromium, devices } = findPlaywright();
const u = new URL(base);
const token = new URLSearchParams(u.hash.slice(1)).get('token') ?? '';
const testHuman = new URLSearchParams(u.hash.slice(1)).get('testHuman') ?? '';
const origin = u.origin;
const humanHeaders = testHuman ? { 'x-stam-test-human': testHuman } : {};
// A write that names helper or kid (by, from, agent, or an agent's waits path) goes with that agent's own token
// (daemon.sh's agents=, S-545): the shared token can't act as an agent that has one.
const agentTokens = JSON.parse(new URLSearchParams(u.hash.slice(1)).get('agents') || '{}');
const ownToken = (path, body) => agentTokens[body?.by ?? body?.from ?? body?.agent] || agentTokens[path.match(/^\/api\/agents\/([\w-]+)\/waits\//)?.[1]];
const call = (method, path, body) => fetch(origin + path, { method, headers: { authorization: 'Bearer ' + (ownToken(path, body) || token), 'x-stam-human': '1', 'content-type': 'application/json', ...humanHeaders }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());

let failures = 0;
// check(TAG, OK, WHAT, DETAIL): the detail is printed when the check fails.
const check = (tag, ok, what, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} [${tag}] ${what}${ok || detail === undefined ? '' : ` (got ${typeof detail === 'string' ? detail : JSON.stringify(detail)})`}`);
  if (!ok) failures++;
};

// kid is a seeded agent (seed.mjs) whose parent is helper.
const agents = await call('GET', '/api/agents');
const kid = agents.find((a) => a.name === 'kid'), helper = agents.find((a) => a.name === 'helper');
if (!kid || !helper) { console.error('no seeded kid and helper agents: restart daemon.sh'); process.exit(2); }
const perm = await call('POST', '/api/permissions', { agent: kid.id, action: 'Delete the build cache', reason: 'The cache is stale and blocks the next build.', audience: 'human' });
const unreadBefore = (await call('GET', '/api/agents/human/inbox?unread=1&limit=200')).length;
const den = await call('POST', `/api/permissions/${perm.id}/answer`, { approve: false, by: helper.id, note: 'Keep the cache; rebuild in ./tmp.' });
check('api', den.status === 'denied', 'helper denies the request', den);
const tid = (await call('GET', '/api/agents/human/threads?archived=1&limit=200')).find((t) => t.mails.some((m) => m.permission_id === perm.id))?.thread_id;
check('api', !!tid, 'the thread is archived', tid);
const mailId = (await call('GET', `/api/threads/${tid}?box=human`))[0].id;
const unreadAfter = (await call('GET', '/api/agents/human/inbox?unread=1&limit=200')).length;
check('api', unreadAfter === unreadBefore - 1, 'the withdrawn mail counts in no unread', [unreadBefore, unreadAfter]);
// kid carries on in the thread, which brings it back with a normal mail beside the quiet line.
await call('POST', '/api/mail', { from: kid.id, to: ['human'], subject: 'Re: Permission: Delete the build cache', body: 'Understood. I rebuild in `./tmp` and keep the cache.', reply_to: mailId });

const browser = await chromium.launch(chromiumLaunchOptions());
const sizes = [
  { name: '360', scheme: 'light', ctx: { ...devices['Pixel 7'], viewport: { width: 360, height: 740 } }, tap: true },
  { name: '360', scheme: 'dark', ctx: { ...devices['Pixel 7'], viewport: { width: 360, height: 740 } }, tap: true },
  { name: '430', scheme: 'light', ctx: { ...devices['Pixel 7'], viewport: { width: 430, height: 800 } }, tap: true },
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
  if (await nav.isVisible()) await press(nav);
  await press(p.locator(`#mail-side .mrow[data-thread="${tid}"]`));
  const line = p.locator('.thread-view:visible .msg-withdrawn');
  await line.waitFor();
  check(tag, (await line.count()) === 1, 'the thread shows one withdrawn line', await line.count());
  const text = await line.locator('.note').innerText();
  check(tag, text === `Answered by @helper: denied`, 'the line says who answered and how', text);
  const box = await line.boundingBox();
  check(tag, !!box && box.x >= 0 && box.x + box.width <= p.viewportSize().width, 'the line fits the width', box);
  if (size.tap) check(tag, !!box && box.height >= 44, 'the line is a touch target', box?.height);
  check(tag, (await p.locator(`.thread-view:visible [data-id="${mailId}"]`).count()) === 0, 'the withdrawn mail itself is not shown');
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${out}/withdraw-${tag}.png` });
  await press(line);
  await p.waitForSelector(`.thread-view:visible article[data-id="${mailId}"]`);
  check(tag, true, 'tapping the line opens the mail');
  await ctx.close();
}
await browser.close();
console.log(failures ? `${failures} failed` : 'all ok');
process.exit(failures ? 1 : 0);
