// The Deferred group (S-353), in headless Chromium at 360 px light and on desktop, against a seeded
// test daemon (daemon.sh). The agent kid mails the human a pick block; the human defers it in the
// thread ("Decide later"). The check finds the row under the collapsed Decide later group, muted and
// off the pinned rows, screenshots the group collapsed and open at both sizes, then has kid mail
// again in the thread and checks the row is back among the pinned rows:
//   web/check/run.sh deferred
//   node web/check/deferred.mjs BASE_URL OUT_DIR   (a daemon from daemon.sh)
// Screenshots: OUT_DIR/deferred-*.png.
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { mkdirSync } from 'node:fs';
import { findPlaywright } from './find-playwright.mjs';

const [base, out] = process.argv.slice(2);
if (!base || !out) { console.error('usage: node decision-mail.mjs BASE_URL OUT_DIR'); process.exit(2); }
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

// kid is a seeded agent (seed.mjs). Its decision mail asks the human to pick, so it waits on them.
const agents = await call('GET', '/api/agents');
const kid = agents.find((a) => a.name === 'kid');
if (!kid) { console.error('no seeded kid agent: restart daemon.sh'); process.exit(2); }
const SUBJECT = 'Which release goes first';
const DEFER = "Deferring this one: still open, I'll decide later. Keep working on what doesn't depend on it.";
const sent = await call('POST', '/api/mail', { from: kid.id, to: ['human'], subject: SUBJECT, body: 'Two releases are ready. Which goes first?\n\n```pick\nthe billing fix\nthe search fix\n```' });
await call('POST', '/api/mail', { from: 'human', to: [kid.id], subject: 'Re: ' + SUBJECT, body: '> Which release goes first?\n\n' + DEFER, reply_to: sent.id });
const decisions = await call('GET', '/api/mail/decisions');
const dec = decisions.find((d) => d.mail_id === sent.id);
check('api', !!dec && dec.deferred === true, 'the deferred decision mail is listed as deferred', decisions.map((d) => [d.subject, d.deferred]));

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
  // The deferred row sits under the collapsed group, not among the pinned rows.
  const group = p.locator('#mail-side details.mail-deferred');
  await group.waitFor();
  const summary = group.locator('summary');
  check(tag, (await summary.innerText()).includes('Decide later (1)'), 'the group is labelled Decide later (1)', await summary.innerText());
  check(tag, !(await group.evaluate((el) => el.open)), 'the group is collapsed at first');
  const inGroupRow = group.locator(`.mrow[data-thread="${dec.thread_id}"]`);
  // A closed details keeps its rows in the DOM; the row is hidden, not absent.
  check(tag, (await inGroupRow.count()) === 1 && !(await inGroupRow.isVisible()), 'the row is hidden while the group is collapsed');
  await p.waitForTimeout(200);
  await p.screenshot({ path: `${out}/deferred-collapsed-${tag}.png` });
  await press(summary);
  await inGroupRow.waitFor();
  check(tag, (await p.locator(`#mail-side .mail-side-list > .mrow-wrap .mrow[data-thread="${dec.thread_id}"]`).count()) === 0, 'the deferred row is not among the pinned rows');
  check(tag, (await inGroupRow.locator('.s').innerText()) === SUBJECT, 'the row shows the subject', await inGroupRow.locator('.s').innerText());
  const box = await inGroupRow.boundingBox();
  check(tag, !!box && box.x + box.width <= p.viewportSize().width, 'the row fits the width', box);
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${out}/deferred-open-${tag}.png` });
  // The agent mails again in the thread: the row is pinned again, and the group is gone.
  if (tag === 'desktop-light') {
    await call('POST', '/api/mail', { from: kid.id, to: ['human'], subject: 'Re: ' + SUBJECT, body: 'Still waiting on the billing numbers.', reply_to: sent.id });
    await p.waitForFunction((tid) => document.querySelector(`#mail-side .mail-side-list > .mrow-wrap .mrow[data-thread="${tid}"]`) && !document.querySelector('#mail-side details.mail-deferred'), dec.thread_id, { timeout: 15000 });
    const cleared = (await call('GET', '/api/mail/decisions')).find((d) => d.mail_id === sent.id)?.deferred === false;
    check(tag, cleared, 'an agent mail clears the deferral');
  }
  await ctx.close();
}
await browser.close();
console.log(failures ? `${failures} failed` : 'all ok');
process.exit(failures ? 1 : 0);
