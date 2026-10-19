// Defer on an ask thread (S-1068), in headless Chromium at 360 px and on desktop: kid mails the human a
// decision, the human defers the thread (the Defer action, not "Decide later"); the check sees the thread
// leave the inbox, listed under Deferred, and still listed in To answer, with its decision unanswered.
//   web/check/run.sh defer-asks
//   node web/check/defer-asks.mjs BASE_URL OUT_DIR   (a daemon from daemon.sh)
// Screenshots: OUT_DIR/defer-asks-{deferred,toanswer}-*.png.
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { mkdirSync } from 'node:fs';
import { findPlaywright } from './find-playwright.mjs';

const [base, out] = process.argv.slice(2);
if (!base || !out) { console.error('usage: node defer-asks.mjs BASE_URL OUT_DIR'); process.exit(2); }
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

const agents = await call('GET', '/api/agents');
const kid = agents.find((a) => a.name === 'kid');
if (!kid) { console.error('no seeded kid agent: restart daemon.sh'); process.exit(2); }
const SUBJECT = 'Which release goes first';
const sent = await call('POST', '/api/mail', { from: kid.id, to: ['human'], subject: SUBJECT, body: 'Two releases are ready. Which goes first?\n\n```pick\nthe billing fix\nthe search fix\n```' });
const tid = sent.thread_id;
const dres = await call('POST', `/api/agents/human/threads/${tid}/defer`);
check('api', dres.deferred === true, 'the server defers a thread that holds a decision', dres);
const decs = await call('GET', '/api/mail/decisions');
check('api', decs.some((d) => d.mail_id === sent.id && !d.deferred), 'the decision is still open, not answered', decs.map((d) => [d.subject, d.deferred]));

const browser = await chromium.launch(chromiumLaunchOptions());
const sizes = [
  { name: '360', ctx: { ...devices['Pixel 7'], viewport: { width: 360, height: 740 } }, tap: true },
  { name: 'desktop', ctx: { viewport: { width: 1280, height: 800 } }, tap: false },
];
for (const size of sizes) {
  const tag = `${size.name}-light`;
  const ctx = await browser.newContext({ ...size.ctx, colorScheme: 'light' });
  if (testHuman) await ctx.route(`${origin}/api/**`, (r) => r.request().method() === 'GET' ? r.continue() : r.continue({ headers: { ...r.request().headers(), 'x-stam-test-human': testHuman } }));
  await ctx.addInitScript(() => { try { localStorage.setItem('stam/theme', 'light'); } catch {} });
  const p = await ctx.newPage();
  p.setDefaultTimeout(10000);
  p.on('pageerror', (e) => check(tag, false, 'no page error', e.message));
  const press = (loc) => (size.tap ? loc.tap() : loc.click());
  await p.goto(origin + '/#token=' + token);
  await p.waitForSelector('#tree .node', { timeout: 20000 });
  const nav = p.locator('[data-nav="mail"]');
  if (await nav.isVisible()) await press(nav);
  const row = p.locator(`#mail-side .mrow[data-thread="${tid}"]`);
  const toggle = (sel) => p.locator(`#mail-side ${sel}`);
  // Inbox: the deferred thread isn't listed, and the Deferred toggle counts it.
  await toggle('.mail-toggle[aria-pressed]').first().waitFor();
  await p.waitForFunction(() => /Deferred \(\d+\)/.test(document.querySelector('#mail-side')?.textContent ?? ''));
  check(tag, (await row.count()) === 0 || !(await row.first().isVisible()), 'the inbox does not list the deferred thread');
  await press(p.locator('#mail-side .mail-toggle', { hasText: /^Deferred/ }));
  await row.first().waitFor();
  check(tag, await row.first().isVisible(), 'Deferred lists the thread');
  const box = await row.first().boundingBox();
  check(tag, !!box && box.x + box.width <= p.viewportSize().width, 'the row fits the width', box);
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${out}/defer-asks-deferred-${tag}.png` });
  await press(p.locator('#mail-side .mail-toggle', { hasText: /^Inbox/ }));
  await press(p.locator('#mail-side [data-to-answer]'));
  await row.first().waitFor();
  check(tag, await row.first().isVisible(), 'To answer still lists the deferred ask');
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${out}/defer-asks-toanswer-${tag}.png` });
  await ctx.close();
}
await browser.close();
console.log(failures ? `${failures} failed` : 'all ok');
process.exit(failures ? 1 : 0);
