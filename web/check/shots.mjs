// Screenshots of the web UI states, for comparing builds: light and dark, at 1500x900 and 420x860.
//   node web/check/shots.mjs BASE_URL OUT_DIR [--write] [--only=1500-light,420-dark]
// BASE_URL carries the token: http://127.0.0.1:PORT/#token=TOKEN (daemon.sh prints one). Without
// --write nothing is clicked that writes, so it is safe on a live daemon; --write also clicks a
// Decision option (staging an answer in the composer) and needs a test daemon.
// Output: OUT_DIR/<state>-<width>-<theme>.png. A state that can't be reached is reported, and the
// run exits 1 when an agent-dependent state was skipped. The layout is the daemon's, shared by
// every browser, so it is reset before each context (S-337).
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { mkdirSync } from 'node:fs';
import { findPlaywright } from './find-playwright.mjs';
import { PROCESSES } from './process-fixture.mjs';
import { routeFiles } from './files-fixture.mjs';

const [base, out, ...flags] = process.argv.slice(2);
if (!base || !out) { console.error('usage: node shots.mjs BASE_URL OUT_DIR [--write]'); process.exit(2); }
const write = flags.includes('--write');
const only = flags.find((f) => f.startsWith('--only='))?.slice(7).split(',');
const CONTEXTS = ['1500-light', '1500-dark', '420-light', '420-dark'];
if (only && (only.some((c) => !CONTEXTS.includes(c)))) { console.error(`--only needs names from ${CONTEXTS.join(', ')}; got "${only.join(',')}"`); process.exit(2); }
mkdirSync(out, { recursive: true });

const { chromium } = findPlaywright();

const u = new URL(base);
const token = new URLSearchParams(u.hash.slice(1)).get('token') ?? '';
const testHuman = new URLSearchParams(u.hash.slice(1)).get('testHuman') ?? '';
const origin = u.origin;
// The layout reset below drops every saved agent world, so it runs only on a throwaway daemon.
// The daemon decides that: its human-only routes accept the test key only when STAM_TEST_HUMAN_KEY
// is set and the home isn't the live one (S-422). A read-only human-only GET proves it before any
// write; a bogus key, a live daemon, or no key gets 403 and nothing is touched.
const keyed = { 'x-stam-test-human': testHuman };
const verified = testHuman ? await fetch(origin + '/api/mcp/registry?search=stam-check-preflight', { headers: { authorization: 'Bearer ' + token, ...keyed } }).then((r) => r.status !== 403 && r.status !== 401, () => false) : false;
if (!verified) { console.error('shots.mjs resets the daemon\'s shared layout: it needs a throwaway daemon (daemon.sh) that accepts the #testHuman=KEY in the URL; this one doesn\'t, so refusing to touch it'); process.exit(2); }
const api = (path) => fetch(origin + path, { headers: { authorization: 'Bearer ' + token, 'x-stam-human': '1' } }).then((r) => r.json());
const post = (path, body) => fetch(origin + path, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'x-stam-human': '1', ...keyed, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then((r) => r.json());
const agents = await api('/api/agents');
const target = agents.find((a) => a.name === 'helper') ?? agents.find((a) => a.kind !== 'assistant' && (a.lifecycle === 'active' || a.lifecycle === 'paused')) ?? agents[0];
const threads = await api('/api/agents/human/threads?limit=60');
const checkThread = threads.find((t) => /^Check:/.test(t.mails[0]?.subject ?? '') && /```decision/.test(t.mails[0].body)) ?? threads.find((t) => /```decision/.test(t.mails[0]?.body ?? ''));
const archThread = threads.find((t) => /^Check: archive me/.test(t.mails[0]?.subject ?? ''));
const imgThread = threads.find((t) => /^Check: images to zoom/.test(t.mails[0]?.subject ?? ''));
const itsas = await api('/api/itsas').catch(() => []);
console.log(`agent: ${target?.name ?? 'none'}; thread: ${checkThread?.mails[0].subject ?? 'none'}; ITSAs: ${itsas.length}`);

const SIZES = [{ w: 1500, h: 900 }, { w: 420, h: 860, phone: true }];
const THEMES = ['light', 'dark'];
const browser = await chromium.launch(chromiumLaunchOptions());
let failures = 0;
const AGENT_STEPS = new Set(['prompt-mail', 'prompt-draft', 'itsa', 'itsa-status', 'itsa-owner', 'usage']);
const agentSkips = [];
// One layout for the whole daemon: a context would load the panes the one before left, with the
// focus somewhere other than the agent. Drop every world and show the home again.
const resetLayout = async () => {
  const l = await api('/api/layout');
  const ops = [...Object.keys(l.agentWorlds ?? {}).map((world) => ({ op: 'dropWorld', world })), { op: 'current', world: null }];
  await post('/api/layout/ops', { ops, by: 'shots' });
};

for (const size of SIZES) for (const theme of THEMES) {
  if (only && !only.includes(`${size.w}-${theme}`)) continue;
  await resetLayout();
  const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h }, colorScheme: theme, isMobile: !!size.phone, hasTouch: !!size.phone });
  // The MCP import route proves the human (tailscale serve in real use); the check's key stands in.
  if (testHuman) await ctx.route(`${origin}/api/push**`, (route) => route.continue({ headers: { ...route.request().headers(), 'x-stam-test-human': testHuman } }));
  if (testHuman) await ctx.route(`${origin}/api/mcp/import**`, (route) => route.continue({ headers: { ...route.request().headers(), 'x-stam-test-human': testHuman } }));
  if (testHuman) await ctx.route(`${origin}/api/mcp/registry**`, (route) => route.continue({ headers: { ...route.request().headers(), 'x-stam-test-human': testHuman } }));
  // The Process view (S-873) draws a stubbed `GET /api/processes`: a fixed answer keeps the
  // drawing the same on every run. STAM_PROCESS_REAL=1 draws the repo's own processes instead.
  await routeFiles(ctx, origin);
  if (!process.env.STAM_PROCESS_REAL) await ctx.route(`${origin}/api/processes**`, (route) => route.fulfill({ json: PROCESSES }));
  await ctx.addInitScript((t) => { try { localStorage.setItem('stam/theme', t); localStorage.removeItem('stam/settings-section'); localStorage.removeItem('stam/settings-item'); } catch {} }, theme);
  const p = await ctx.newPage();
  p.setDefaultTimeout(6000);
  const tag = `${size.w}-${theme}`;
  p.on('pageerror', (e) => console.log(`[${tag}] pageerror: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') console.log(`[${tag}] console: ${m.text()}`); });
  p.on('dialog', (d) => d.dismiss());
  const shot = async (state) => { await p.waitForTimeout(500); await p.screenshot({ path: `${out}/${state}-${tag}.png` }); };
  const step = async (state, fn, wait = 1200) => {
    try { await fn(); await p.waitForTimeout(wait); await shot(state); }
    catch (e) { failures++; if (AGENT_STEPS.has(state)) agentSkips.push(`${tag} ${state}`); console.log(`[${tag}] ${state}: skipped (${e.message.split('\n')[0]})`); }
  };
  const node = () => p.locator(`#tree .node:has(.name:text-is("${target.name}"))`).first();
  const menu = async (label) => { await node().click({ button: 'right' }); await p.getByRole('menuitem', { name: label }).first().click(); };
  // On a phone the sidebar is an overlay: open it when the tree isn't showing.
  const sideTab = async (id) => { const t = p.locator(`#side-panes [role=tab][data-tab="${id}"]`); if (!size.phone && (await t.count()) && (await t.getAttribute('aria-selected')) !== 'true') { await t.click(); await p.waitForTimeout(300); } };
  const phoneLeft = async () => { await sideTab('agents'); if (size.phone && !(await p.locator('#tree .node').first().isVisible())) { await p.locator('[data-nav="left"]').first().tap(); await p.waitForTimeout(500); } };
  // The mail list has its own tab in the phone's navigation.
  const phoneMail = async () => { if (size.phone && !(await p.locator('#mail-side').isVisible())) { await p.locator('[data-nav="mail"]').first().tap(); await p.waitForTimeout(500); } };

  await p.goto(origin + '/#token=' + token);
  await p.waitForSelector('#tree .node', { timeout: 20000 }).catch(() => {});
  await p.waitForTimeout(2500);
  await step('home', async () => {});
  if (size.phone) await step('sidebar', async () => { await phoneLeft(); }, 600);
  if (size.phone) await step('mail', async () => { await phoneMail(); }, 600);
  // The Machines section: one line per computer with its meters, and the popover open.
  await step('machines', async () => {
    await phoneLeft();
    await sideTab('machines');
    const row = p.locator('#machines-side .machine-row').first();
    await row.waitFor();
    if (size.phone) await row.tap(); else await row.hover();
    await p.waitForSelector('.machines-pop');
  }, 600);
  await p.keyboard.press('Escape');
  // The Cost tab (S-1423): the subscription entries, then one entry's details open. Desktop only; the phone has no panes.
  if (!size.phone) {
    await step('cost', async () => {
      await sideTab('cost');
      await p.locator('#cost-side .csd-row, #cost-side .csd-empty').first().waitFor();
      const row = p.locator('#cost-side .csd-row').first();
      if (await row.count()) { await row.hover(); await p.waitForSelector('.csd-pop'); }
    }, 600);
    await p.keyboard.press('Escape');
  }

  // An agent with a conversation view opens on it; the prompt input this step needs is in the terminal.
  await step('agent', async () => {
    await phoneLeft(); await node().locator('.name').waitFor(); await node().locator('.name').click();
    const toTerminal = p.locator('#w-main .pane.focused .view-switch[data-to="terminal"]');
    if (await toTerminal.isVisible()) await toTerminal.click();
  }, 3500);
  if (!size.phone) {
    await step('tree', async () => { await p.keyboard.press('Alt+1'); }, 3500);
    await p.keyboard.press('Alt+0');
  }
  // The prompt input's Direct/Mail toggle on the focused agent's pane. A click on Mail writes
  // only to localStorage, so this is safe on a live daemon too; Direct is put back after, and
  // the focus goes with it, since a focused prompt input raises the phone's keyboard.
  // The box's starting mode, before any click: the setting's default (S-523).
  await step('prompt-default', async () => {}, 400);
  // The phone has one button that holds the mode and switches it (.cmp-mode-one).
  const modeBtn = (label) => size.phone ? p.locator('#w-bottom .cmp-mode-one') : p.locator(`#w-bottom .cmp-mode button:has-text("${label}")`);
  // Click only when the box isn't in the wanted mode: the default may be either (promptDefaultMode).
  const setMode = async (label) => {
    const mailNow = (await p.locator(size.phone ? '#w-bottom .cmp-mode-one' : '#w-bottom .cmp-mode button:has-text("Mail")').first().getAttribute('aria-pressed')) === 'true';
    if (mailNow !== (label === 'Mail')) await modeBtn(label).click();
  };
  await step('prompt-mail', async () => { await setMode('Mail'); }, 400);
  await setMode('Direct').catch(() => {});
  // A typed draft with its clear button. Only the browser's sessionStorage keeps it, and the
  // clear button after the shot removes it again.
  await step('prompt-draft', async () => { await p.locator('#w-bottom .composer textarea').fill('Draft kept per agent'); }, 400);
  await p.locator('#w-bottom .cmp-clear').click().catch(() => {});
  await p.evaluate(() => document.activeElement?.blur?.());
  await step('details', async () => { await phoneLeft(); await menu('Details'); }, 1500);
  await step('instructions', async () => {
    await phoneLeft(); await menu('Instructions');
    await p.waitForSelector('.instructions .inst-part');
  }, 1500);
  await step('inbox', async () => { await phoneLeft(); await menu('Inbox'); }, 1500);

  await step('thread', async () => {
    await phoneMail();
    await p.locator(`[data-thread="${checkThread.thread_id}"]`).first().click();
    await p.waitForSelector('.msg', { timeout: 10000 });
  }, 6000);
  // S-86: a tall (portrait) mail image capped on a desktop, and the full-screen viewer
  // opened from an image in mail.
  if (imgThread) {
    await step('mail-tall-image', async () => {
      await phoneMail();
      await p.locator(`[data-thread="${imgThread.thread_id}"]`).first().click();
      await p.waitForSelector('.msg .mb-compare', { timeout: 10000 });
      await p.locator('.msg .mb-compare').first().scrollIntoViewIfNeeded();
      await p.mouse.move(2, 2);
    }, 600);
    await step('viewer', async () => {
      await p.locator('.msg .mb-embed.image img').first().click();
      await p.waitForSelector('#img-view');
    }, 800);
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);
  }
  // A mail whose body and subject name issues by key: the keys are links.
  const linkThread = threads.find((t) => /^Check: S-4 review notes/.test(t.mails[0]?.subject ?? ''));
  if (linkThread) await step('itsa-link', async () => {
    await phoneMail();
    await p.locator(`[data-thread="${linkThread.thread_id}"]`).first().click();
    await p.waitForSelector('.msg a[data-open-itsa]', { timeout: 10000 });
  }, 1500);
  // A mail about an ITSA: its header shows the ITSA as a chip.
  const chipThread = threads.find((t) => /^Check: a mail about an ITSA/.test(t.mails[0]?.subject ?? ''));
  if (chipThread) await step('itsa-chip', async () => {
    await phoneMail();
    await p.locator(`[data-thread="${chipThread.thread_id}"]`).first().click();
    await p.waitForSelector('.thread-head .ichip-mail', { timeout: 10000 });
  }, 1500);
  // ITSAs: the Issues list (the navigation's Issues tab on a phone), an ITSA's world, its
  // status and owner pickers, and its board. Nothing is picked, so this is safe on a live daemon too.
  const phoneIssues = async () => { await sideTab('issues'); if (size.phone && !(await p.locator('#issues-side').isVisible())) { await p.locator('[data-nav="issues"]').first().tap(); await p.waitForTimeout(500); } };
  const itsaRoot = itsas.find((x) => x.title === 'Check: issue system') ?? itsas.find((x) => !x.parent_id && itsas.some((y) => y.parent_id === x.id)) ?? itsas[0];
  if (itsaRoot) {
    if (size.phone) await step('issues', async () => { await phoneIssues(); }, 600);
    await step('issues-open', async () => {
      await phoneIssues();
      const row = p.locator(`#issues-side .irow[data-itsa="${itsaRoot.id}"]`);
      if ((await row.getAttribute('aria-expanded')) === 'false') await row.locator('.chev').click();
    }, 600);
    await step('itsa', async () => {
      await phoneIssues();
      await p.locator(`#issues-side .irow[data-itsa="${itsaRoot.id}"] .ititle`).click();
      await p.waitForSelector(`.itsa-view[data-itsa="${itsaRoot.id}"] .itsa-head`);
    }, 1500);
    await step('itsa-status', async () => { await p.locator(`.itsa-view[data-itsa="${itsaRoot.id}"] [data-prop="status"]`).click(); await p.waitForSelector('.menu'); }, 600);
    await p.keyboard.press('Escape');
    await step('itsa-owner', async () => { await p.locator(`.itsa-view[data-itsa="${itsaRoot.id}"] [data-prop="owner"]`).click(); await p.waitForSelector('.menu'); }, 600);
    await p.keyboard.press('Escape');
    // The board, on the desktop (step 7 adapts it for the phone): the ITSA's children by
    // category, then its whole subtree by status. Only the view's own settings change.
    if (!size.phone) {
      const board = () => p.locator(`.board-view[data-board="${itsaRoot.id}"]`);
      await step('board', async () => {
        await p.locator('.tab', { hasText: 'board' }).first().click();
        await board().locator('[data-mode-btn="category"]').click();
        await board().locator('[data-scope-btn="children"]').click();
        await p.mouse.move(2, 2);
      }, 800);
      await step('board-status', async () => {
        await board().locator('[data-mode-btn="status"]').click();
        await board().locator('[data-scope-btn="subtree"]').click();
        // The busy middle: from todo on, where the seed has most cards.
        await board().locator('.board-cols').evaluate((el) => { const c = el.querySelector('.bcol[data-col="todo"]'); if (c) el.scrollLeft = c.offsetLeft - el.offsetLeft - 20; });
        await p.mouse.move(2, 2);
      }, 800);
      await board().locator('[data-mode-btn="category"]').click().catch(() => {});
      await board().locator('[data-scope-btn="children"]').click().catch(() => {});
    }
  }
  if (write) {
    await step('thread-staged', async () => {
      await p.locator('.mb-decision:not(.multi):not(.rank):not(.yesno) .mb-opt').first().click();
    }, 1000);
  }
  // The archived mail list, on a throwaway daemon: archive the seeded thread, show it in
  // the Archived entry, then put it back.
  if (write && archThread) {
    await step('mail-archived', async () => {
      await phoneMail();
      await post(`/api/agents/human/threads/${archThread.thread_id}/archive`);
      // The list polls every 8 s; wait for it to pick the change up.
      await p.waitForTimeout(9000);
      await p.locator('.mail-toggle').first().click();
    }, 600);
    await post(`/api/agents/human/threads/${archThread.thread_id}/unarchive`);
    await p.waitForTimeout(9000);
    await p.locator('.mail-toggle').first().click();
  }

  // The Swipe view (S-1003): the inbox as a stack of cards; on a desktop the top card pulled left
  // by the mouse, then let go short of where it fires, so nothing is archived.
  await step('swipe', async () => { await phoneMail(); await p.locator('[data-swipe-toggle]').first().click(); await p.waitForSelector('.swipe-view:visible .swipe-top'); }, 600);
  if (!size.phone) {
    const cardAt = async () => { const b = await p.locator('.swipe-view:visible .swipe-top').boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
    const at = await cardAt().catch(() => null);
    await step('swipe-pull', async () => { await p.mouse.move(at[0], at[1]); await p.mouse.down(); await p.mouse.move(at[0] - 100, at[1] + 4, { steps: 8 }); }, 300);
    if (at) { await p.mouse.move(at[0], at[1], { steps: 4 }); await p.mouse.up(); }
  }

  // Rapid-fire mode (S-1004): the agent's conversation as mail cards, then the newest one picked
  // (the prompt input follows up in its thread), then Esc unpicks it. Picking writes nothing.
  await step('rapid', async () => {
    await phoneLeft(); await node().locator('.name').click(); await p.waitForTimeout(800);
    // Earlier states leave another of its tabs on top (its inbox): show the agent itself.
    await p.locator(`#w-main .tab[data-key="view:${target.id}"], #w-main .tab[data-key="agent:${target.id}"]`).first().click();
    if (size.phone) {
      const toConv = p.locator('#w-main .pane.focused .view-switch[data-to="conversation"]');
      if (await toConv.isVisible()) { await toConv.click(); await p.waitForTimeout(500); }
      await p.locator('#w-main .pane.focused .rapid-switch').click();
    } else await p.locator('#w-main .pane.focused .view-switch [data-view="rapid"]').click();
    await p.waitForSelector('.rf:visible .rf-list');
  }, 800);
  await step('rapid-picked', async () => { await p.locator('.rf:visible .rf-list > li .mail-card').last().click(); await p.waitForSelector('#w-bottom .rf-target[data-rf="reply"]'); }, 600);
  if (!size.phone) {
    await p.keyboard.press('Escape');
    const back = await p.locator('#w-bottom .rf-target[data-rf="new"]').count();
    if (!back) { failures++; console.log(`[${tag}] rapid: Esc did not unpick the card`); }
    await p.locator('#w-main .pane.focused .view-switch [data-view="conversation"]').click().catch(() => {});
  } else await p.locator('#w-main .pane.focused .rapid-switch').click().catch(() => {});

  // Adding an agent: the quick menu, a harness's models, and the panel with an option menu
  // open. Nothing is added, so this is safe on a live daemon too.
  const item = (name) => p.locator('.menu [role^=menuitem]').filter({ hasText: name }).first();
  await step('spawn-menu', async () => { await phoneLeft(); await p.locator('#new-agent').click(); await p.waitForSelector('.menu'); }, 600);
  await step('spawn-models', async () => { await item('Claude Code…').click(); }, 600);
  await step('spawn-panel', async () => { await p.keyboard.press('Escape'); await p.locator('#new-agent').click(); await item('More options…').click(); await p.waitForSelector('.spawn-panel'); }, 600);
  await step('spawn-option', async () => { await p.locator('.spawn-panel [data-pick="Permissions"]').click(); await p.waitForSelector('.menu'); }, 600);
  await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
  if (size.phone) await p.locator('[data-nav="main"]').first().tap().catch(() => {});
  await step('settings', async () => { await phoneLeft(); await p.locator('#open-config').first().click(); await p.waitForSelector('.settings-view'); }, 1500);
  await step('settings-mail', async () => { await p.locator('[data-sec="mail"], .settings-nav .item:has-text("Mail to you")').first().click(); }, 600);
  await step('settings-prompt-mode', async () => { await p.locator('text=Prompt input starts in').first().scrollIntoViewIfNeeded(); }, 600);
  await step('settings-sidebar', async () => { await p.locator('.settings-nav .item:has-text("Sidebar")').first().click(); await p.waitForSelector('.sidebar-set'); }, 600);
  await step('settings-context', async () => { await p.locator('[data-sec="context"], .settings-nav .item:has-text("Context")').first().click(); }, 600);
  await step('settings-spend', async () => { await p.locator('.settings-nav .item:has-text("Spending")').first().click(); }, 600);
  await step('settings-tools', async () => { await p.locator('.settings-nav .item:has-text("Tools")').first().click(); await p.waitForSelector('.tools-card'); }, 800);
  await step('settings-tools-args', async () => { await p.locator('.tools-card details.tool').filter({ hasText: 'send_mail' }).first().locator('summary').click(); }, 800);
  // Decision steps: the list, the add form (not saved), a step's log, and, with --write (it
  // asks the decision model), its test on recent examples.
  await step('settings-tiny', async () => { await p.locator('.settings-nav .item:has-text("Tiny models")').first().click(); await p.waitForSelector('.tiny-item'); }, 600);
  await step('settings-tiny-page', async () => { await p.locator('.tiny-item:has-text("Tool summary")').first().click(); await p.waitForSelector('textarea.tiny-instr'); }, 600);
  await step('settings-steps', async () => { await p.locator('.settings-nav .item:has-text("Decision steps")').first().click(); await p.waitForSelector('.steps-card'); }, 800);
  await step('settings-steps-add', async () => {
    await p.locator('#add-step').click();
    await p.locator('select[name=trigger]').selectOption('tool:send_mail');
    await p.locator('textarea[name=question]').fill('Does this mail ask the human for money?');
    await p.evaluate(() => document.activeElement?.blur());
  }, 600);
  // The form's end: its buttons clear of the phone's bottom navigation.
  await step('settings-steps-add-end', async () => { await p.locator('.settings-body').evaluate((el) => { el.scrollTop = el.scrollHeight; }); }, 600);
  await step('settings-steps-log', async () => {
    await p.locator('.step-form .type-back').click();
    const money = p.locator('.step-row', { hasText: 'Money mail' });
    await ((await money.count()) ? money : p.locator('.step-row').first()).locator('.step-open').click();
    await p.waitForSelector('.step-log');
    await p.locator('.step-log').scrollIntoViewIfNeeded();
  }, 800);
  if (write) await step('settings-steps-test', async () => {
    await p.locator('#step-test').click();
    await p.waitForSelector('.step-ex, .step-note');
    await p.locator('.step-test').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  }, 800);
  await step('settings-instructions', async () => { await p.locator('.settings-nav .item:has-text("Instructions")').first().click(); await p.waitForSelector('.tpl-layout'); }, 800);
  await step('settings-instructions-item', async () => { await p.locator('.tpl-list .item:has-text("Chief of staff")').first().click(); }, 800);
  // MCP servers: the list of servers (one local, one remote OAuth) and the Add preview of a
  // pasted config. Nothing is added, so this is safe on a live daemon too.
  await step('settings-mcp', async () => {
    await p.locator('.settings-nav .item:has-text("MCP servers")').first().click();
    await p.waitForSelector('.mcp-row');
  }, 800);
  await step('settings-mcp-add', async () => {
    await p.locator('.mcp-add textarea').fill('{"mcpServers": {"linear": {"type": "sse", "url": "https://mcp.linear.app/sse", "headers": {"Authorization": "Bearer lin_xxx"}}, "notes": {"command": "npx", "args": ["-y", "notes-mcp"]}}}');
    // A DOM click: on a phone the fixed bottom bar can cover the button's centre.
    await p.locator('.mcp-add button:has-text("Preview")').evaluate((b) => b.click());
    await p.waitForSelector('.mcp-preview');
    await p.locator('.mcp-preview').scrollIntoViewIfNeeded();
    // The textarea took the focus, which raises the phone's keyboard; put it away so the
    // next step can tap the bottom navigation.
    await p.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  }, 800);
  await step('settings-mcp-import', async () => {
    await p.locator('.mcp-tools button:has-text("Import from harnesses")').evaluate((b) => b.click());
    await p.waitForSelector('.mcp-import-row');
    await p.locator('#mcp-import').scrollIntoViewIfNeeded();
  }, 800);
  // The public registry: search results, and the add form for a server that needs a token.
  await step('settings-mcp-registry', async () => {
    await p.locator('.mcp-tools button:has-text("Browse registry")').evaluate((b) => b.click());
    await p.waitForSelector('.mcp-reg-row');
    await p.locator('#mcp-registry').scrollIntoViewIfNeeded();
  }, 800);
  await step('settings-mcp-registry-add', async () => {
    await p.locator('.mcp-reg-row[data-registry="com.example/needs-token"] button:has-text("Add")').evaluate((b) => b.click());
    await p.waitForSelector('#mcp-reg-add');
    await p.locator('#mcp-reg-add').scrollIntoViewIfNeeded();
  }, 800);
  await step('usage', async () => { await phoneLeft(); await p.locator('#open-usage').first().click(); await p.waitForSelector('.usage .lim-card'); }, 1500);
  const usageTab = (name) => async () => { await p.locator(`.usage-tabs [role=tab]:has-text("${name}")`).first().click(); await p.waitForSelector(`.usage-tabs [aria-selected=true]:has-text("${name}")`); };
  await step('usage-trees', async () => { await usageTab('Trees')(); await p.waitForSelector('.usage .tree-totals .tnode'); }, 800);
  await step('usage-issues', async () => { await usageTab('Issues')(); await p.waitForSelector('.usage .usage-configs table'); }, 800);
  await step('usage-models', async () => { await usageTab('Models')(); await p.waitForSelector('.usage .usage-models table.data'); }, 800);
  await step('usage-agents', async () => { await usageTab('Agents')(); await p.waitForSelector('.usage .usage-agents table.data'); }, 800);
  await step('usage-days', async () => { await usageTab('Days')(); await p.waitForSelector('.usage .usage-days table.data'); }, 800);
  await step('usage-activity', async () => { await usageTab('Activity')(); await p.waitForSelector('.usage .activity-tab .ax-tiles'); }, 800);
  // Agent types (S-1491): the first two types after All by position (the types present depend on the fixture), in Time mode, then Cost mode with the same selection, then All.
  const usageType = (i) => async () => { const b = p.locator('.usage-types button[aria-pressed]').nth(i); const name = (await b.textContent()).replace(/\s\d+$/, '').trim(); await b.click(); await p.waitForFunction((n) => document.querySelector('.activity-tab .ax-scope .ax-filter')?.textContent.includes(n), name); await p.waitForSelector('.usage .activity-tab .ax-tiles, .usage .activity-tab .ax-none'); };
  await step('usage-activity-type', usageType(1), 800);
  await step('usage-activity-types', usageType(2), 800);
  const usageMode = (name) => async () => { await p.locator(`.activity-tab button[aria-pressed]:text-is("${name}")`).first().click(); await p.waitForSelector(`.activity-tab button[aria-pressed=true]:text-is("${name}")`); await p.waitForSelector('.usage .activity-tab .ax-tiles'); };
  await step('usage-activity-cost', usageMode('Cost'), 800);
  await step('usage-activity-time', usageMode('Time'), 300);
  await step('usage-activity-all', async () => { await p.locator('.usage-types button:text-is("All")').click(); await p.waitForSelector('.usage .activity-tab .ax-tiles, .usage .activity-tab .ax-none'); }, 300);
  // The Files world and the file view (S-1526), over the stubbed Files API.
  await step('files', async () => {
    await p.evaluate(() => { location.hash = 'view=files'; });
    await p.locator('.fl-row', { hasText: '/fx/projects' }).first().click();
    await p.waitForSelector('.fl-row:has-text("long.ts")');
  }, 600);
  await step('file', async () => {
    await p.locator('.fl-row', { hasText: 'long.ts' }).first().click();
    await p.waitForSelector('.codeview .cm-line');
  }, 600);
  // The PDF viewer (S-1528): a page drawn by the real engine, from the stubbed Files API.
  await step('pdf', async () => {
    await p.locator('.fv-crumb:visible').first().click();
    await p.locator('.fl-row', { hasText: 'sample.pdf' }).first().click();
    await p.waitForSelector('[data-testid=pdf-page-image-0]', { timeout: 30000 });
  }, 600);
  // An image over the cap (S-1915): the too-large note with Download.
  await step('image-too-big', async () => {
    await p.locator('.fv-crumb:visible').first().click();
    await p.locator('.fl-row', { hasText: 'huge.png' }).first().click();
    await p.waitForSelector('[data-testid=image-too-big]');
  }, 600);
  // The Process view (S-873): a process drawn read-only, and a node's ITSAs in a sheet.
  await step('process', async () => {
    await phoneLeft();
    await p.locator('#open-process').click();
    await p.waitForSelector('.proc .react-flow .react-flow__node');
    await p.mouse.move(2, 2);
  }, 1500);
  await step('process-node', async () => {
    // The task node is off the first lane on a phone's top-to-bottom drawing; its own click opens
    // the sheet in either layout.
    await p.locator('.proc-node[data-node=code] .proc-hit').evaluate((el) => el.click());
    await p.waitForSelector('.proc-sheet .proc-itsa');
    await p.mouse.move(2, 2);
  }, 800);
  // The Process editor (S-1083): the edit mode with a node's panel open, and the YAML review.
  await step('process-edit', async () => {
    await p.locator('.proc-sheet .proc-close').evaluate((el) => el.click());
    await p.locator('.proc [data-act=edit]').evaluate((el) => el.click());
    await p.waitForSelector('.proc.editing .proc-bar');
    await p.locator('.proc-node[data-node=code] .proc-hit').evaluate((el) => el.click());
    await p.waitForSelector('.proc-edit[data-panel=node]');
    await p.mouse.move(2, 2);
  }, 800);
  await step('process-edit-review', async () => {
    await p.locator('.proc-bar [data-edit=add]').evaluate((el) => el.click());
    await p.waitForSelector('.proc-edit[data-panel=add]');
    await p.locator('[data-kind-pick=script]').evaluate((el) => el.click());
    await p.locator('.proc-edit input[aria-label=Label]').fill('Notify the channel');
    await p.locator('[data-act=add-node]').evaluate((el) => el.click());
    await p.waitForSelector('.proc-edit[data-panel=node]');
    await p.locator('.proc-edit select[data-act=connect]').selectOption('merge');
    await p.locator('.proc-bar [data-edit=review]').evaluate((el) => el.click());
    await p.waitForSelector('.proc-diff');
    await p.mouse.move(2, 2);
  }, 800);
  // Save as proposal (S-1084): the summary under the diff, and the card that names the proposal (the daemon's answer is stubbed).
  await step('process-save', async () => {
    await p.route('**/api/processes/*/proposal', (route) => route.fulfill({ json: { key: 'S-1201', id: 'fixture-s-1201', pr: { number: 412, url: 'https://github.com/example/stam2/pull/412' }, branch: 'process/dev-change-x' } }));
    await p.locator('.proc-edit textarea[aria-label=Summary]').fill('Add a step that tells the channel after a merge');
    await p.mouse.move(2, 2);
  }, 800);
  await step('process-saved', async () => {
    await p.locator('.proc-edit [data-act=save-proposal]').evaluate((el) => el.click());
    await p.waitForSelector('.proc-saved');
    await p.mouse.move(2, 2);
  }, 800);
  // The Work page: the pinned Needs-you group above the issue trees (S-134).
  await step('work', async () => {
    if (size.phone) {
      if (!(await p.locator('#issues-side').isVisible())) await p.locator('[data-nav="issues"]').first().tap();
      await p.locator('#issues-work').tap();
    } else {
      await phoneLeft();
      await sideTab('issues');
      await p.locator('#issues-work').click();
    }
    await p.waitForSelector('.work-view:visible .w-needs');
  }, 700);
  if (!size.phone) await step('assistant', async () => { await p.keyboard.press('Alt+a'); }, 1500);
  // Waiting on the human: the pinned attention list, an ITSA in a human status with its
  // action bar, and (with --write) an action staged. Nothing is sent.
  const waiting = await api('/api/itsas/attention').catch(() => []);
  const asked = Array.isArray(waiting) ? waiting.find((x) => x.status === 'needs_review') ?? waiting[0] : undefined;
  if (asked) {
    await step('attention', async () => {
      // Nothing open over the list: close the assistant overlay the step before left up.
      if (await p.locator('#top-close').isVisible().catch(() => false)) await p.locator('#top-close').click();
      await phoneMail();
    }, 600);
    await step('itsa-ask', async () => {
      await phoneMail();
      await p.locator(`#mail-side .mrow[data-att-itsa="${asked.id}"]`).click();
      await p.waitForSelector(`.itsa-view[data-itsa="${asked.id}"] .itsa-ask`);
    }, 1500);
    if (write) await step('itsa-ask-staged', async () => {
      await p.locator(`.itsa-view[data-itsa="${asked.id}"] .itsa-ask [data-act]`).last().click();
      await p.locator('#w-bottom textarea').fill('Please change this before it goes on.');
    }, 800);
  }

  await ctx.close();
}
await browser.close();
console.log(failures ? `${failures} state(s) skipped` : 'all states captured');
if (agentSkips.length) { console.error(`agent-dependent states skipped: ${agentSkips.join(', ')}`); process.exit(1); }
