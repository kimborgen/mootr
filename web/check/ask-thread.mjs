// An ask in its home thread (S-3827), in headless Chromium at 360 px (light) and 1280 px (light), against a seeded test
// daemon (daemon.sh). The human writes kid and helper in one thread, helper answers there, and the human writes again; kid
// asks for a permission naming that thread, so the ask joins it among the other mail. The check finds the list row and
// the tab still named for the thread, not the ask, then opens the thread and finds the human's two mails and the ask's
// card with Approve and Deny, once; the reply box says the reply goes to kid alone (helper never saw the ask); and
// nothing is cut off sideways:
//   web/check/run.sh ask-thread
//   node web/check/ask-thread.mjs BASE_URL OUT_DIR   (a daemon from daemon.sh)
// Screenshots: OUT_DIR/ask-thread-{360,1280}-light.png.
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { mkdirSync } from 'node:fs';
import { findPlaywright } from './find-playwright.mjs';

const [base, out] = process.argv.slice(2);
if (!base || !out) { console.error('usage: node ask-thread.mjs BASE_URL OUT_DIR'); process.exit(2); }
mkdirSync(out, { recursive: true });
const { chromium, devices } = findPlaywright();
const u = new URL(base);
const token = new URLSearchParams(u.hash.slice(1)).get('token') ?? '';
const testHuman = new URLSearchParams(u.hash.slice(1)).get('testHuman') ?? '';
const origin = u.origin;
const humanHeaders = testHuman ? { 'x-stam-test-human': testHuman } : {};
// A write that names kid goes with kid's own token (daemon.sh's agents=, S-545).
const agentTokens = JSON.parse(new URLSearchParams(u.hash.slice(1)).get('agents') || '{}');
const call = (method, path, body) => {
  const own = agentTokens[body?.agent ?? body?.from];
  return fetch(origin + path, { method, headers: { authorization: 'Bearer ' + (own || token), ...(own ? {} : { 'x-stam-human': '1', ...humanHeaders }), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
};

let failures = 0;
const check = (tag, ok, what, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} [${tag}] ${what}${ok || detail === undefined ? '' : ` (got ${typeof detail === 'string' ? detail : JSON.stringify(detail)})`}`);
  if (!ok) failures++;
};

const agents = await call('GET', '/api/agents');
const kid = agents.find((a) => a.name === 'kid');
const helper = agents.find((a) => a.name === 'helper');
if (!kid || !helper) { console.error('no seeded kid or helper agent: restart daemon.sh'); process.exit(2); }
const first = await call('POST', '/api/mail', { from: 'human', to: [kid.id, helper.id], subject: 'Release branch cleanup', body: 'Which release branches can go? Keep anything with an open PR.', new_thread: true });
await call('POST', '/api/mail', { from: 'helper', to: ['human', kid.id], subject: 'Re: Release branch cleanup', body: 'release/2026-08 still has an open PR.', reply_to: first.id });
await call('POST', '/api/mail', { from: 'human', to: [kid.id, helper.id], subject: 'Re: Release branch cleanup', body: 'Also leave release/2026-10 alone, ops still deploys from it.', reply_to: first.id });
const ask = await call('POST', '/api/permissions', { agent: kid.id, action: 'Delete 14 merged release branches on origin', reason: 'Pushing deletions is an outward action auto mode blocks.', details: 'git push origin --delete release/2026-07 release/2026-08 …', audience: 'human', thread: first.id });
const tid = first.thread_id ?? first.id;
const thread = await call('GET', `/api/threads/${tid}`);
check('api', thread.length === 4 && thread.filter((m) => m.permission_id === ask.id).length === 1, 'the ask joined the thread with the two mails', thread.map((m) => m.subject));

const browser = await chromium.launch(chromiumLaunchOptions());
for (const [tag, phone] of [['360-light', true], ['1280-light', false]]) {
  const ctx = await browser.newContext(phone ? { ...devices['Pixel 7'], viewport: { width: 360, height: 740 }, colorScheme: 'light' } : { viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
  if (testHuman) await ctx.route(`${origin}/api/**`, (r) => r.request().method() === 'GET' ? r.continue() : r.continue({ headers: { ...r.request().headers(), 'x-stam-test-human': testHuman } }));
  await ctx.addInitScript(() => { try { localStorage.setItem('stam/theme', 'light'); } catch {} });
  const p = await ctx.newPage();
  p.setDefaultTimeout(15000);
  p.on('pageerror', (e) => check(tag, false, 'no page error', e.message));
  await p.goto(origin + '/#token=' + token);
  await p.waitForSelector('#tree .node', { timeout: 20000 });
  if (phone) await p.locator('[data-nav="mail"]').tap();
  const row = p.locator(`${phone ? '#inbox-view' : '#mail-side'} .mrow[data-thread="${tid}"]`).first();
  await row.waitFor();
  // An ask doesn't rename its thread (S-3827): the row and the tab keep the thread's own subject.
  // The row's name: the thread's short title chip, else its subject (the line under it may quote the ask, its latest mail).
  const rowName = (await row.locator('.chip.mtitle, .s').first().innerText()).trim();
  check(tag, /Release branch/.test(rowName) && !/Permission/.test(rowName), "the list row keeps the thread's name", rowName);
  await (phone ? row.tap() : row.click());
  await p.waitForSelector('.thread-view:visible .perm.pending [data-approve="1"]');
  const tab = (await p.locator('.pane .tab.active').first().innerText()).trim();
  check(tag, /Release branch/.test(tab) && !/Permission/.test(tab), "the thread's tab keeps its name", tab);
  const view = p.locator('.thread-view:visible');
  const text = await view.innerText();
  check(tag, /Keep anything with an open PR/.test(text) && /ops still deploys from it/.test(text), "the thread shows the human's two mails", text.slice(0, 300));
  check(tag, (await view.locator('.perm.pending').count()) === 1, 'one pending ask card in the thread');
  check(tag, (await view.locator('.perm.pending [data-approve="1"]').count()) === 1 && (await view.locator('.perm.pending [data-approve="0"]').count()) === 1, 'the card offers Approve and Deny');
  check(tag, /Delete 14 merged release branches/.test(text), 'the card names the action');
  // The reply box names whom a free-text reply goes to: under the ask, kid alone, not helper (S-3827).
  // The composer's target line: the thread's own on a phone, the bottom world's on a desktop.
  const target = (await p.locator(`${phone ? '.thread-view:visible' : '#w-bottom'} .cmp-target`).first().textContent()) ?? '';
  const replyTo = target.replace(/\s+/g, ' ').match(/Reply to (.*)$/)?.[1]?.trim() ?? target;
  check(tag, replyTo === 'kid', 'the reply box says the reply goes to the asker alone', replyTo);
  const wide = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(tag, wide <= 0, 'no sideways scroll', wide);
  await p.screenshot({ path: `${out}/ask-thread-${tag}.png` });
  await ctx.close();
}
await browser.close();
console.log(failures ? `${failures} failed` : 'all ok');
process.exit(failures ? 1 : 0);
