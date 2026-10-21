// The lean thread head (S-2556, S-1471 PR 4), in headless Chromium against a seeded test daemon (daemon.sh):
// a long thread with five ITSAs, four agents and a decision ask. On a desktop the head is the subject and the
// people, and the tab carries the ITSAs and agents; a tab chip opens its ITSA; the card's "+N" expands in place.
// At 360 px the head keeps its ITSA row. Run it on a daemon:
//   NO_HELLO=1 sh web/check/daemon.sh     (prints URL=..., stays up until killed)
//   node web/check/threadhead.mjs BASE_URL OUT_DIR
// Screenshots: OUT_DIR/threadhead-*.png.
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { mkdirSync } from 'node:fs';
import { findPlaywright } from './find-playwright.mjs';

const [base, out] = process.argv.slice(2);
if (!base || !out) { console.error('usage: node threadhead.mjs BASE_URL OUT_DIR'); process.exit(2); }
mkdirSync(out, { recursive: true });
const { chromium, devices } = findPlaywright();
const u = new URL(base);
const token = new URLSearchParams(u.hash.slice(1)).get('token') ?? '';
const testHuman = new URLSearchParams(u.hash.slice(1)).get('testHuman') ?? '';
const origin = u.origin;
// An agent that sends mail or owns an ITSA acts with its own token (daemon.sh puts them in the URL's agents=).
const agentTokens = JSON.parse(new URLSearchParams(u.hash.slice(1)).get('agents') || '{}');
const call = (method, path, body) => fetch(origin + path, { method, headers: { authorization: 'Bearer ' + (agentTokens[body?.from ?? body?.by ?? body?.owner] || token),'x-stam-human': '1', 'content-type': 'application/json', ...(testHuman ? { 'x-stam-test-human': testHuman } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${path}: ${JSON.stringify(j)}`); return j; });

let failures = 0;
const check = (tag, ok, what, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} [${tag}] ${what}${ok || detail === undefined ? '' : ` (got ${typeof detail === 'string' ? detail : JSON.stringify(detail)})`}`);
  if (!ok) failures++;
};

// Four agents, five ITSAs, and one long thread among them: each reply names one ITSA, and the last one asks.
const agents = await call('GET', '/api/agents');
const four = ['helper', 'kid', 'cos', 'intake'].map((n) => agents.find((a) => a.name === n));
const kid = four[1];
if (four.some((a) => !a)) { console.error('the four seeded agents are missing: restart daemon.sh'); process.exit(2); }
const itsas = [];
for (let i = 0; i < 5; i++) itsas.push(await call('POST', '/api/itsas', { title: `Head check item ${i + 1}`, kind: 'issue', status: 'in_progress', owner: four[i % 4].name }));
const stamp = Date.now() % 100000;
let prev = await call('POST', '/api/mail', { from: kid.id, to: ['human', ...four.filter((a) => a !== kid).map((a) => a.id)], new_thread: true, subject: `Check: lean thread head ${stamp}`, body: 'TLDR: A long thread to check the lean head.\n\nFive ITSAs and four agents are in it.', itsa: itsas[0].key });
const tid = prev.thread_id;
for (let i = 1; i < 10; i++) {
  
  prev = await call('POST', '/api/mail', { from: kid.id, to: ['human', ...four.filter((a) => a !== kid).map((a) => a.id)], reply_to: prev.id, body: `Message ${i + 1} from kid, on ${itsas[i % 5].key}.\n\nA line of text that carries the thread on.`, itsa: itsas[i % 5].key });
}
prev = await call('POST', '/api/mail', { from: kid.id, to: ['human', ...four.filter((a) => a !== kid).map((a) => a.id)], reply_to: prev.id, body: `TLDR: Which head should the thread keep? All five: ${itsas.map((x) => x.key).join(', ')}.\n\n\`\`\`decision\nWhich head?\n- Keep the subject (recommended)\n- Drop the subject\n\`\`\``, itsa: itsas[4].key });
console.log(`seeded thread ${tid}: 10 mails, 5 ITSAs, 4 agents, 1 decision`);
// A second, short thread for the agent's inbox step, with an ITSA and two attached agents (S-1305). Its own thread, so
// the step's `mail:kid` tab stays out of the long thread's saved world, which the other sizes reuse.
const side = await call('POST', '/api/mail', { from: kid.id, to: ['human', ...four.filter((a) => a !== kid).map((a) => a.id)], new_thread: true, subject: `Check: lean inbox head ${stamp}`, body: 'A short thread with an ITSA and two attached agents.', itsa: itsas[0].key });
// Only a recipient of the mail, or the chief of staff, attaches to it: cos is a recipient.
await call('POST', '/api/mail/' + side.id + '/attach', { by: four[2].id, agents: [four[0].id, four[3].id] });
const sideTid = side.thread_id;

const browser = await chromium.launch(chromiumLaunchOptions());
const sizes = [
  { name: '1440', ctx: { viewport: { width: 1440, height: 900 } }, phone: false },
  { name: '800', ctx: { viewport: { width: 800, height: 800 } }, phone: false },
  { name: '360', ctx: { ...devices['Pixel 7'], viewport: { width: 360, height: 780 } }, phone: true },
];
for (const size of sizes) {
  const tag = size.name;
  const ctx = await browser.newContext({ ...size.ctx, colorScheme: 'light' });
  if (testHuman) await ctx.route(`${origin}/api/**`, (r) => r.request().method() === 'GET' ? r.continue() : r.continue({ headers: { ...r.request().headers(), 'x-stam-test-human': testHuman } }));
  await ctx.addInitScript(() => { try { localStorage.setItem('stam/theme', 'light'); } catch {} });
  const p = await ctx.newPage();
  p.setDefaultTimeout(10000);
  p.on('pageerror', (e) => check(tag, false, 'no page error', e.message));
  await p.goto(origin + '/#token=' + token);
  await p.waitForSelector('#tree .node', { timeout: 20000 });
  const head = p.locator('.thread-view:visible .thread-head');
  if (size.phone) {
    await p.evaluate((t) => window.stamDebug.shell.open('main', 'thread:' + t), tid);
    await p.waitForSelector('.thread-view:visible .thread-head', { timeout: 20000 });
    check(tag, await head.locator('.th-itsas').count() >= 1, 'the phone head keeps its ITSA row');
    check(tag, await head.locator('.th-people').count() === 1, 'the phone head keeps its people toggle');
    await p.screenshot({ path: `${out}/threadhead-${tag}.png` });
  } else {
    await p.evaluate((t) => window.stamDebug.shell.open('main', 'thread:' + t), tid);
    await p.waitForSelector('.thread-view:visible .thread-head', { timeout: 20000 });
    check(tag, await head.locator('h2').count() === 1, 'the head has the subject');
    check(tag, await head.locator('.people').count() === 1, 'the head has the people');
    check(tag, await head.locator('.th-itsas').count() === 0, 'the head has no ITSA row on a desktop');
    check(tag, await head.locator('.th-agents').count() === 0, 'the head has no agent row on a desktop');
    const tabChips = p.locator('.tab.active [data-itsa], .wait-thin [data-itsa]');
    check(tag, await tabChips.count() >= 1, 'the tab or its thin bar carries the ITSA chips');
    const agentMarks = p.locator('.tab.active .agent-marks [data-open-agent], .tab.active .agent-more, .wait-thin [data-open-agent]');
    check(tag, await agentMarks.count() >= 1, 'the tab or its thin bar carries the agent marks', await agentMarks.count());
    await p.screenshot({ path: `${out}/threadhead-${tag}.png` });
    // The message's "+N" expands in place on a desktop and "Fewer" folds it again.
    const more = p.locator('.thread-view:visible [data-more-itsas]').first();
    check(tag, await more.count() > 0, 'a message with more than two ITSAs shows "+N"');
    if (await more.count()) {
      const before = await p.locator('.thread-view:visible .msg-itsas .ichip-mail').count();
      await more.click();
      const after = await p.locator('.thread-view:visible .msg-itsas .ichip-mail').count();
      check(tag, after > before, '"+N" expands the message ITSAs in place', { before, after });
      await p.locator('.thread-view:visible [data-fewer-itsas]').first().click();
      check(tag, await p.locator('.thread-view:visible [data-fewer-itsas]').count() === 0, '"Fewer" folds them again');
    }
    // A tab chip opens its ITSA; a folded pill opens its popover, whose first chip opens the ITSA.
    const chip = p.locator('.tab.active [data-itsa], .wait-thin [data-itsa]').first();
    check(tag, await chip.count() > 0, 'a chip is in the tab or its thin bar');
    if (await chip.count()) {
      const folded = (await chip.getAttribute('data-itsa')) === 'folded';
      await chip.click();
      if (folded) await p.locator('.wait-pop [data-itsa]:not([data-itsa="folded"])').first().click();
      await p.waitForTimeout(300);
      const world = await p.evaluate(() => JSON.stringify(window.stamDebug.shell.currentWorld()));
      check(tag, world.includes('itsa:'), 'a chip opens its ITSA', world);
    }
    // The same thread in the Inbox pane: the head is two lines there too.
    await p.evaluate(() => window.stamDebug.shell.open('main', 'inbox'));
    await p.waitForSelector('#inbox-view:visible [data-inbox-row]', { timeout: 20000 });
    await p.locator('#inbox-view:visible [data-inbox-row]', { hasText: `Check: lean thread head ${stamp}` }).first().click();
    await p.waitForSelector('.thread-view:visible .thread-head', { timeout: 20000 });
    check(tag, await p.locator('.thread-view:visible .thread-head .th-itsas').count() === 0, 'in the Inbox pane the head has no ITSA row');
    await p.screenshot({ path: `${out}/threadhead-${tag}-inbox.png` });
    // An agent's inbox has no tab, so its head keeps the ITSA and agent rows on a desktop (S-2556 review).
    if (tag === '1440') {
      // The agent's own world first: opening its inbox from the long thread's world would add the tab there, and the 800 px step reuses that world.
      await p.evaluate((a) => { window.stamDebug.shell.showAgentWorld(a); window.stamDebug.shell.open('main', 'mail:' + a); }, kid.id);
      await p.locator(`.mail-view [data-thread="${sideTid}"]`).first().click();
      await p.waitForSelector('.mail-read .thread-head', { timeout: 20000 });
      check(tag, await p.locator('.mail-read .thread-head .th-itsas').count() >= 1, 'an agent\'s inbox head keeps its ITSA row on a desktop');
      check(tag, await p.locator('.mail-read .thread-head .th-agents [data-open-agent]').count() === 2, 'an agent\'s inbox head keeps its two attached agents on a desktop');
      await p.screenshot({ path: `${out}/threadhead-${tag}-agent-inbox.png` });
    }
  }
  await ctx.close();
}
await browser.close();
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('threadhead: all checks passed');
