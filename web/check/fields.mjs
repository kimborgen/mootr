// The Fields tab on a throwaway daemon (S-3181, S-1438 PR 5): a field limited to issue is added from
// Settings › Fields and cards, shows in the Table tab and in the Work table on issue rows only; its kinds
// are edited to All kinds, and it shows on every row; then it is removed. Screenshots of the tab and the
// form at 1440 and at 360 and 430 phone widths.
//   node web/check/fields.mjs BASE_URL OUT_DIR [--only=1440,360,430]
// BASE_URL carries the token and the test human key (daemon.sh prints one). It writes to the daemon, so it
// needs a throwaway daemon. Exits 1 when a check fails.
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { mkdirSync } from 'node:fs';
import { findPlaywright } from './find-playwright.mjs';

const [base, out, ...flags] = process.argv.slice(2);
if (!base || !out) { console.error('usage: node fields.mjs BASE_URL OUT_DIR'); process.exit(2); }
mkdirSync(out, { recursive: true });
const only = flags.find((f) => f.startsWith('--only='))?.slice(7).split(',') ?? ['1440', '360', '430'];

const { chromium } = findPlaywright();
const u = new URL(base);
const hash = new URLSearchParams(u.hash.slice(1));
const token = hash.get('token') ?? '';
const testHuman = hash.get('testHuman') ?? '';
const origin = u.origin;
const human = { authorization: 'Bearer ' + token, 'x-stam-human': '1', 'x-stam-test-human': testHuman, 'content-type': 'application/json' };
const api = (path, method = 'GET', body) => fetch(origin + path, { method, headers: human, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => null) }));

const FIELD = 'Review note';
const KEY = 'review-note';
const ISSUE_TITLE = 'Check: fields kinds issue';
const PROJECT_TITLE = 'Check: fields kinds project';
const results = [];
let failed = 0;
const check = (name, ok, detail = '') => {
  results.push(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${detail})`}`);
  if (!ok) failed++;
};

// Two ITSAs, one of each kind, on the throwaway daemon; the field's old copy (from an earlier run) goes first.
const fieldsBefore = (await api('/api/itsas/fields')).body ?? [];
for (const f of fieldsBefore.filter((x) => x.key === KEY)) await api('/api/itsas/fields/' + f.id, 'DELETE');
const all = (await api('/api/itsas')).body ?? [];
const ensure = async (title, kind) => {
  const have = all.find((x) => x.title === title);
  if (have) return have;
  const made = await api('/api/itsas', 'POST', { title, kind, by: 'human' });
  if (!made.ok || !made.body?.id) throw new Error(`creating ITSA "${title}" failed: ${made.status} ${JSON.stringify(made.body)}`);
  return made.body;
};
const issue = await ensure(ISSUE_TITLE, 'issue');
const project = await ensure(PROJECT_TITLE, 'project');

const browser = await chromium.launch(chromiumLaunchOptions());
const SIZES = {
  1440: { viewport: { width: 1440, height: 900 } },
  // The Work table drops a field column below a pane width (withFieldFit), so its steps run wider than 1440.
  1920: { viewport: { width: 1920, height: 1000 } },
  360: { viewport: { width: 360, height: 740 }, mobile: true },
  430: { viewport: { width: 430, height: 860 }, mobile: true },
};
const pageFor = async (size, hashPart) => {
  const ctx = await browser.newContext({ ...SIZES[size], colorScheme: 'light', isMobile: !!SIZES[size].mobile, hasTouch: !!SIZES[size].mobile });
  await ctx.addInitScript(() => { try { localStorage.setItem('stam/theme', 'light') } catch {} })
  const p = await ctx.newPage();
  p.setDefaultTimeout(8000);
  p.on('pageerror', (e) => check(`no page errors at ${size}`, false, e.message));
  await p.goto(`${origin}/#token=${token}&testHuman=${testHuman}&${hashPart}`);
  return { ctx, p };
};

// The Work table: the text of a row's cell in a column, by the column's place in the header. The page's search
// filters to the ITSA's title first, so its row draws whatever the grouping; a row that never draws fails the check.
const workCell = async (p, title, itsaId, col) => {
  const search = p.locator('input[placeholder="Search all columns"]');
  await search.fill(title);
  const row = p.locator(`.w-row[data-itsa="${itsaId}"]`);
  if (!(await row.first().waitFor({ timeout: 8000 }).then(() => true, () => false))) {
    const rows = await p.locator('.w-row').count();
    return `NO ROW (${rows} rows drawn)`;
  }
  return p.evaluate(([id, c]) => {
    const heads = [...document.querySelectorAll('.w-head [role=columnheader]')].map((h) => h.getAttribute('data-col'));
    const i = heads.indexOf(c);
    const r = document.querySelector(`.w-row[data-itsa="${id}"]`);
    return i < 0 || !r ? null : (r.children[i]?.textContent ?? '');
  }, [itsaId, col]);
};

// The shell reaches Settings and the Work page the way a deep link does (`#cfg=`, `#view=`).
let fieldId = null;
{
  // A deep link to the Table tab opens on it, with no click (S-3181 review): the hash is read at boot.
  const { ctx, p } = await pageFor('1440', 'cfg=fields/table');
  await p.waitForSelector('.wcol-tabs', { timeout: 20000 });
  check('#cfg=fields/table opens on the Table tab', await p.locator('.wcol-tabs [role=tab][aria-selected=true]').textContent() === 'Table');
  await ctx.close();
}

{
  const { ctx, p } = await pageFor('1440', 'cfg=fields/fields');
  await p.waitForSelector('.wcol-tabs', { timeout: 20000 });
  check('the section opens on the Fields tab from #cfg=fields/fields', await p.locator('.wcol-tabs [role=tab][aria-selected=true]').textContent() === 'Fields');
  await p.locator('#add-field').click();
  await p.locator('input[name=label]').fill(FIELD);
  await p.locator('input[name="kind-add"]').fill('issue');
  await p.locator('.wcol-kind-add .btn').click();
  await p.locator('input[name="kind-issue"]').check();
  await p.locator('.wcol-form button[type=submit]').click();
  await p.waitForSelector(`.fld-row[aria-label="Edit ${FIELD}"]`);
  const row = await p.locator(`.fld-row[aria-label="Edit ${FIELD}"]`).textContent();
  check('the new field lists Applies to: issue', row.includes('Applies to: issue'), row);
  check('the new field lists Shown in: Table', row.includes('Shown in: Table'), row);
  fieldId = (await api('/api/itsas/fields')).body.find((f) => f.key === KEY)?.id;
  // Values are set once the field exists: the daemon drops a value for a field it doesn't know.
  await api(`/api/itsas/${issue.id}`, 'PATCH', { fields: { [KEY]: 'issue value' }, by: 'human' });
  await api(`/api/itsas/${project.id}`, 'PATCH', { fields: { [KEY]: 'project value' }, by: 'human' });
  check('the field is saved with kinds [issue]', JSON.stringify((await api('/api/itsas/fields')).body.find((f) => f.key === KEY)?.kinds) === '["issue"]');
  if (only.includes('1440')) await p.screenshot({ path: `${out}/fields-1440.png` });
  await p.locator(`.fld-row[aria-label="Edit ${FIELD}"]`).click();
  await p.waitForSelector('.wcol-form');
  if (only.includes('1440')) await p.screenshot({ path: `${out}/fields-form-1440.png` });
  await ctx.close();
}

{
  const { ctx, p } = await pageFor('1920', 'view=work');
  await p.waitForSelector('.w-table', { timeout: 20000 });
  const col = `field:${fieldId}`;
  await p.waitForSelector(`.w-head [data-col="${col}"]`, { timeout: 8000 }).catch(() => {});
  check('the Work table has the field column', await p.locator(`.w-head [data-col="${col}"]`).count() === 1);
  check('the field shows on the issue row', (await workCell(p, ISSUE_TITLE, issue.id, col)).includes('issue value'), await workCell(p, ISSUE_TITLE, issue.id, col));
  if (only.includes('1440')) await p.screenshot({ path: `${out}/work-issue-row-1920.png` });
  const onProject = await workCell(p, PROJECT_TITLE, project.id, col);
  check('the field does not show on the project row (its cell is empty)', onProject === '', onProject);
  if (only.includes('1440')) await p.screenshot({ path: `${out}/work-issue-only-1920.png` });
  await ctx.close();
}

{
  const { ctx, p } = await pageFor('1440', 'cfg=fields/table');
  await p.waitForSelector('.wcol-tabs', { timeout: 20000 });
  await p.locator('.wcol-tabs [role=tab]:has-text("Table")').click();
  check('the Table tab lists the field, shown', await p.locator(`.wcol-row[data-col="field:${fieldId}"] input[type=checkbox]`).isChecked());
  await ctx.close();
}

{
  const { ctx, p } = await pageFor('1440', 'cfg=fields/fields');
  await p.waitForSelector(`.fld-row[aria-label="Edit ${FIELD}"]`, { timeout: 20000 });
  await p.locator(`.fld-row[aria-label="Edit ${FIELD}"]`).click();
  await p.waitForSelector('.wcol-form');
  await p.locator('input[name="kind-all"]').check();
  await p.locator('.wcol-form button[type=submit]').click();
  await p.waitForSelector(`.fld-row[aria-label="Edit ${FIELD}"]:has-text("Applies to: All kinds")`);
  check('the field is saved as All kinds', (await api('/api/itsas/fields')).body.find((f) => f.key === KEY)?.kinds === null);
  // The daemon keeps a value only on a kind the field applies to, so the project's value is written now.
  await api(`/api/itsas/${project.id}`, 'PATCH', { fields: { [KEY]: 'project value' }, by: 'human' });
  await ctx.close();
}

{
  const { ctx, p } = await pageFor('1920', 'view=work');
  await p.waitForSelector('.w-table', { timeout: 20000 });
  const col = `field:${fieldId}`;
  await p.waitForSelector(`.w-head [data-col="${col}"]`, { timeout: 8000 }).catch(() => {});
  check('All kinds: the field shows on the project row too', (await workCell(p, PROJECT_TITLE, project.id, col)).includes('project value'), await workCell(p, PROJECT_TITLE, project.id, col));
  check('All kinds: the field still shows on the issue row', (await workCell(p, ISSUE_TITLE, issue.id, col)).includes('issue value'), await workCell(p, ISSUE_TITLE, issue.id, col));
  await ctx.close();
}

// Shots of the tab and the form on the phone widths, after the field has All kinds.
for (const size of ['360', '430']) {
  if (!only.includes(size)) continue;
  const { ctx, p } = await pageFor(size, 'cfg=fields/fields');
  await p.waitForSelector(`.fld-row[aria-label="Edit ${FIELD}"]`, { timeout: 20000 });
  await p.screenshot({ path: `${out}/fields-${size}.png` });
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  check(`no sideways scroll at ${size} on the Fields tab`, !overflow);
  await p.locator(`.fld-row[aria-label="Edit ${FIELD}"]`).click();
  await p.waitForSelector('.wcol-form');
  await p.screenshot({ path: `${out}/fields-form-${size}.png` });
  check(`no sideways scroll at ${size} on the form`, !(await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)));
  await ctx.close();
}

// Removes the field: the confirm dialog accepts, and the field leaves the list and the Work table.
{
  const { ctx, p } = await pageFor('1440', 'cfg=fields/fields');
  await p.waitForSelector(`.fld-row[aria-label="Edit ${FIELD}"]`, { timeout: 20000 });
  await p.locator(`.fld-row[aria-label="Edit ${FIELD}"]`).click();
  await p.waitForSelector('.wcol-form');
  p.once('dialog', (d) => d.accept());
  await p.locator('.wcol-form .btn.danger').click();
  const gone = await p.waitForFunction((label) => !document.querySelector(`.fld-row[aria-label="Edit ${label}"]`), FIELD, { timeout: 8000 }).then(() => true, () => false);
  check('the removed field leaves the Fields list', gone);
  check('the field is gone from the daemon', !(await api('/api/itsas/fields')).body.some((f) => f.key === KEY));
  await ctx.close();
}

await browser.close();
for (const r of results) console.log(r);
console.log(failed ? `${failed} check(s) failed` : `all ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
