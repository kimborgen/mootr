// The ITSA view's Fields block (S-3834) on a throwaway daemon: three fields are defined, one ITSA holds
// values for all of them and one holds none. Each shows every field as a row, the empty one with no value,
// and the page has no sideways scroll. Screenshots at 360 (phone) and 1500 (desktop).
//   node web/check/itsafields.mjs BASE_URL OUT_DIR [--break]
// It writes to the daemon, so it needs a throwaway daemon (run.sh starts one). Exits 1 when a check fails.
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { mkdirSync } from 'node:fs';
import { findPlaywright } from './find-playwright.mjs';

const [base, out, ...flags] = process.argv.slice(2);
// --break forces a too-wide row, to show the width checks go red (they must fail).
const breakIt = flags.includes('--break');
if (!base || !out) { console.error('usage: node itsafields.mjs BASE_URL OUT_DIR'); process.exit(2); }
mkdirSync(out, { recursive: true });

const { chromium } = findPlaywright();
const u = new URL(base);
const hash = new URLSearchParams(u.hash.slice(1));
const token = hash.get('token') ?? '';
const testHuman = hash.get('testHuman') ?? '';
const origin = u.origin;
const human = { authorization: 'Bearer ' + token, 'x-stam-human': '1', 'x-stam-test-human': testHuman, 'content-type': 'application/json' };
const api = (path, method = 'GET', body) => fetch(origin + path, { method, headers: human, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => null) }));

const results = [];
let failed = 0;
const check = (name, ok, detail = '') => { results.push(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${detail})`}`); if (!ok) failed++; };

const DEFS = [
  { key: 'fx-note', label: 'Fixture note', type: 'text' },
  { key: 'fx-stage', label: 'Fixture stage', type: 'choice', options: [{ value: 'code', label: 'Code' }, { value: 'review', label: 'Review' }] },
  { key: 'fx-link', label: 'Fixture link', type: 'link' },
  { key: 'fx-long', label: 'A fixture label that is far longer than a phone column can hold on one line', type: 'text' },
  { key: 'fx-epic', label: 'Epic only', type: 'text', kinds: ['epic'] },
];
for (const d of DEFS) {
  const have = ((await api('/api/itsas/fields')).body ?? []).find((f) => f.key === d.key);
  if (!have) await api('/api/itsas/fields', 'POST', { ...d, by: 'human' });
}
const mk = async (title) => (await api('/api/itsas', 'POST', { title, kind: 'issue', by: 'human' })).body;
const full = await mk('Check: all fields set');
const empty = await mk('Check: no fields set');
await api(`/api/itsas/${full.id}`, 'PATCH', { fields: { 'fx-note': 'A long note that must wrap on a phone and never scroll the page sideways, however many words it holds', 'fx-stage': 'code', 'fx-link': 'https://example.com/a/very/long/path/for/the/link', 'fx-long': 'x'.repeat(80) }, by: 'human' });

const browser = await chromium.launch(chromiumLaunchOptions());
for (const [size, vp, mobile] of [['360', { width: 360, height: 740 }, true], ['1500', { width: 1500, height: 900 }, false]]) {
  const ctx = await browser.newContext({ viewport: vp, colorScheme: 'light', isMobile: mobile, hasTouch: mobile });
  await ctx.addInitScript(() => { try { localStorage.setItem('stam/theme', 'light') } catch {} });
  const p = await ctx.newPage();
  p.setDefaultTimeout(10000);
  p.on('pageerror', (e) => check(`no page errors at ${size}`, false, e.message));
  await p.goto(`${origin}/#token=${token}&testHuman=${testHuman}`);
  await p.waitForFunction(() => window.stamDebug?.shell, null, { timeout: 20000 });
  if (breakIt) await p.addStyleTag({ content: '.itsa-fields dd { min-width: 900px !important; }' });
  for (const [name, it, expectValues] of [['set', full, true], ['empty', empty, false]]) {
    await p.evaluate((w) => window.stamDebug.shell.showAgentWorld(w), 'w:itsa:' + it.id);
    const sec = p.locator(`.itsa-view[data-itsa="${it.id}"] [data-itsa-fields]`);
    await sec.waitFor();
    const labels = await sec.locator('dt').allTextContents();
    check(`${size} ${name}: every defined field is a row`, DEFS.every((d) => labels.includes(d.label)), labels.join('|'));
    const note = (await sec.locator('[data-field="fx-note"]').textContent()) ?? '';
    check(`${size} ${name}: the note ${expectValues ? 'shows' : 'is empty'}`, expectValues ? note.startsWith('A long note') : note === '', note);
    // The ITSA view scrolls on its own, so the document width proves nothing: measure the view and the rows in it.
    const fit = await p.evaluate((id) => {
      const view = document.querySelector(`.itsa-view[data-itsa="${id}"]`);
      const vr = view.getBoundingClientRect();
      const dl = view.querySelector('[data-itsa-fields] dl').getBoundingClientRect();
      const cells = [...view.querySelectorAll('[data-itsa-fields] dt, [data-itsa-fields] dd')].map((c) => c.getBoundingClientRect().right);
      const wide = [...view.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > vr.right + 1).slice(0, 5).map((e) => e.tagName + '.' + String(e.className).slice(0, 40));
      return { wide, scroll: view.scrollWidth, client: view.clientWidth, dl: dl.right, view: vr.right, cells: Math.max(...cells) };
    }, it.id);
    check(`${size} ${name}: the view has no sideways scroll`, fit.scroll <= fit.client + 1, JSON.stringify(fit));
    check(`${size} ${name}: the fields and their rows end inside the view`, fit.dl <= fit.view + 1 && fit.cells <= fit.view + 1, JSON.stringify(fit));
    const na = (await sec.locator('[data-field="fx-epic"]').textContent()) ?? '';
    check(`${size} ${name}: a field of another kind says it isn't used on issues`, na === 'Not used on issues', na);
    if (mobile) {
      const heights = await sec.locator('dt, dd').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
      const linkRow = await sec.locator('[data-field="fx-link"]').evaluate((e) => e.getBoundingClientRect().height);
      check(`${size} ${name}: every row is a touch row`, heights.every((h) => h >= 43.5), heights.join(','));
      if (expectValues) check(`${size} ${name}: the link row is a touch row`, linkRow >= 43.5, String(linkRow));
    }
    await sec.scrollIntoViewIfNeeded();
    await p.screenshot({ path: `${out}/itsa-fields-${name}-${size}.png` });
    if (expectValues) {
      const events = p.locator(`.itsa-view[data-itsa="${it.id}"] .itsa-events`);
      await events.waitFor();
      const line = (await events.textContent()) ?? '';
      check(`${size} ${name}: the activity line names the fields`, /You set .*Fixture note/.test(line) && line.includes('Fixture stage') && line.includes('Fixture link') && !/You fields/.test(line), line);
      await events.scrollIntoViewIfNeeded();
      await p.screenshot({ path: `${out}/itsa-fields-activity-${size}.png` });
    }
  }
  await ctx.close();
}
await browser.close();
console.log(results.join('\n'));
console.log(`itsafields: ${results.length - failed} ok, ${failed} FAIL`);
process.exit(failed ? 1 : 0);
