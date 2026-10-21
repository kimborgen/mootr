// The system view (S-458): the w:system world on a fixed fixture of 43 agents and their ITSAs,
// served over the page's own API calls, so the shots are the same on every run and nothing is
// spent. Checks the tree, the cards' rows, the panel and the bottom sheet, folding, and the
// deep link, at phone 360 and 430 and desktop 1440, light and dark. Mail flights (S-459) run on
// fake stream events through the store (stamDebug.live), with the flight token slowed so a shot
// catches sheets in the air; then the stacks at rest, a read, the flight cap, a click on a sheet,
// and (on the desktop, light) reduced motion. Cost, ITSA, spawn and archive motion (S-463) runs
// on fake events too, with --duration-slow ten times longer, so a shot catches each mid-motion
// and a check sees it at rest: a cost's roll and "+$" rise, a status stamp and wash, a done
// sheet up the wire to its parent's roll-up, a spawn growing from its parent, an archive
// shrinking back, the header's spend and meters rolling, and (desktop, light) reduced motion.
// On the desktop, Cards mode (S-460): every card on its orbit with no overlaps, a spoke per
// child, flights down and up the spokes and between teams through the middle caught mid-air, the
// panel, and the mode kept and taken from a link.
// Then Stars mode (S-539): an orb per agent, sized by spend, with no two orbs or labels
// overlapping, a ray per child, flights along the rays and round the hub caught mid-air, the panel.
// On the phone (S-606, S-1067) the Tree branches as on the desktop as full cards on a canvas you pan and zoom, and Cards and Stars stand tall: the switch and Fit
// finger-sized, every name 14 px at fit, a tap opening the sheet, a pinch and a double tap zooming,
// nothing scrolling sideways, and the phone's own mode coming back on a reload.
//   node web/check/system.mjs BASE_URL OUT_DIR [--only=360-light] [--frames] [--agents=300] [--budget]
// --frames also shoots a fold and an unfold mid-motion, with --duration-slow ten times longer
// (the view's timers read it too), to review the motion (fold-N and unfold-N shots).
// --agents=N grows the fixture to N agents (S-540): divisions of quiet teams under one lead, so past 60
// agents the managers start folded, and only the cards near the view mount. --budget instead
// measures the view against its budgets at that size (desktop 1440, light), with the managers as
// they start and with every one unfolded, and prints a table; it fails on a missed budget.
// Needs a test daemon (daemon.sh) for everything the fixture doesn't answer. Prints one line per
// check and exits 1 if any failed. Screenshots: OUT_DIR/<step>-<size>-<theme>.png.
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { mkdirSync } from 'node:fs';
import { findPlaywright } from './find-playwright.mjs';

const [base, out, ...flags] = process.argv.slice(2);
if (!base || !out) { console.error('usage: node system.mjs BASE_URL OUT_DIR [--only=360-light]'); process.exit(2); }
const only = flags.find((f) => f.startsWith('--only='))?.slice(7);
const frames = flags.includes('--frames');
const want = Number(flags.find((f) => f.startsWith('--agents='))?.slice(9) ?? 0);
const budget = flags.includes('--budget');
mkdirSync(out, { recursive: true });
const { chromium } = findPlaywright();
const u = new URL(base);
const token = new URLSearchParams(u.hash.slice(1)).get('token') ?? '';
const origin = u.origin;
const api = (path, method = 'GET', body) => fetch(origin + path, { method, headers: { authorization: 'Bearer ' + token, 'x-stam-human': '1', 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) => r.json());

// ---- The fixture: a seeded, realistic system ----
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const T0 = Date.parse('2026-10-13T08:00:00Z');
const iso = (m) => new Date(T0 + m * 60_000).toISOString();
const MODEL = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', deepseek: 'openrouter/deepseek/deepseek-v4.1-flash', sol: 'gpt-6.1-sol' };
const ACTS = ['Editing web/src/work/columns.tsx', 'Running vitest', 'Reading src/itsa.ts', 'tsc --noEmit', 'Writing test/e2e-mail.sh', 'git rebase main', 'Reading docs/design.md', 'Running test/run.sh m5', 'Editing src/daemon.ts', 'Searching for itsa_fields', 'Drafting PR body', 'Editing web/style.css'];
const TITLES = ['Mail flight stream from the daemon', 'Work columns on cards', 'Phone bottom sheet for agent detail', 'Cost odometer in the header', 'Reduced-motion audit', 'Window share per tree', 'Retry Codex reviewer fallback', 'Ring members across machines', 'Unread count per agent', 'Archive guard for running tests', 'Search across ITSA threads', 'Voice: read mail aloud', 'Merge queue facts on links', 'Deploy rollback on storage', 'Spawn dialog presets', 'Terminal resize on phone', 'Context bar thresholds', 'Decision block buttons'];
const agents = [];
const itsas = [];
let n = 0, key = 446;
const cost = (own, tree = own) => ({ mode: 'api', own: { api: own, five_hour: null, seven_day: null, subscription: null, paid_usd: 0 }, tree: { api: tree, five_hour: null, seven_day: null, subscription: null, paid_usd: 0 } });
function add(name, parent, harness, model, o = {}) {
  const id = 'a' + String(n).padStart(3, '0');
  const a = {
    id, name, harness, model: MODEL[model], lifecycle: o.lifecycle ?? 'active', activity: o.state ?? 'working', activity_detail: o.act ?? pick(ACTS),
    context_tokens: Math.round((o.ctx ?? rnd() * 0.7 + 0.1) * 500000), context_level: (o.ctx ?? 0) > 0.85 ? 1 : 0, cost: cost(o.cost ?? +(rnd() * 6).toFixed(2)),
    machine: 'alpha', cwd: '/home/user/stam2', parents: parent ? [parent.id] : [], created_at: iso(n++), updated_at: iso(n), unread: o.unread ?? 0,
    chief_of_staff: o.chief ? 1 : 0, role: o.role ?? null, view: { can_stream: true, can_send: true, can_interrupt: true, can_approve: true },
  };
  agents.push(a);
  if (o.itsa !== false) {
    const status = o.status ?? pick(['in_progress', 'in_progress', 'in_progress', 'in_review', 'ready_to_merge', 'todo']);
    const tests = status === 'todo' ? null : pick([{ passed: 214, failed: 0 }, { passed: 38, failed: 0 }, { passed: 12, failed: 2 }]);
    const verdict = status === 'in_review' ? 'comment' : status === 'ready_to_merge' ? 'approve' : null;
    itsas.push({
      id: 'i' + key, key: `S-${key++}`, parent_id: null, kind: 'issue', title: o.title ?? pick(TITLES), summary: null, body: null, status, owner: id, thread_id: 'th' + key,
      created_by: 'cos', created_at: iso(0), updated_at: iso(n), closed_at: null, health: o.health ?? pick(['on_track', 'on_track', 'at_risk']),
      links: tests || verdict ? [{ n: 1, system: 'branch', url: `stam/${name}`, label: `stam/${name}`, meta: { ...(tests ? { tests } : {}), ...(verdict ? { review: { verdict } } : {}) } }] : [],
      fields: { stage: status === 'in_review' ? 'review' : status === 'ready_to_merge' ? 'merge' : 'dev' }, participants: [id],
    });
  }
  return a;
}
const cos = add('cos', null, 'claude', 'opus', { chief: true, title: 'stam2 development', status: 'in_progress', cost: 31.4, unread: 4, role: 'chief of staff' });
add('release', cos, 'claude', 'sonnet', { title: 'Merge queue: batch 14', cost: 6.2, unread: 2 });
add('assistant', cos, 'claude', 'haiku', { title: 'Inbox triage', state: 'idle', cost: 1.1 });
const TEAMS = [['system-view', 'opus', 'Epic: a live visual page of the whole system', 4], ['cost', 'sonnet', 'Cost controls: allocations and pacing', 4], ['its', 'sonnet', 'ITSA fields and Work columns', 5],
  ['waiting', 'haiku', 'Waits that survive a restart', 3], ['mail-ui', 'sonnet', 'Mail components: decision and rank', 4], ['voice', 'opus', 'Voice-first composer', 3], ['storage-ops', 'haiku', 'Agents on storage', 3]];
for (const [m, model, title, k] of TEAMS) {
  const mgr = add(m, cos, 'claude', model, { title, status: 'delegated', cost: +(rnd() * 9 + 3).toFixed(2), unread: m === 'system-view' ? 1 : 0 });
  for (let i = 0; i < k; i++) {
    const h = pick(['opencode', 'opencode', 'claude', 'claude']);
    add(`${m}-dev${i + 1}`, mgr, h, h === 'opencode' ? 'deepseek' : 'haiku', { state: pick(['working', 'working', 'working', 'idle', 'waiting']) });
  }
  add(`${m}-review`, mgr, 'codex', 'sol', { title: `Review ${m}`, status: 'in_review', state: pick(['idle', 'working']) });
}
// --real: the live system's shape on top of the fixture (S-705): cos with some twenty more direct children,
// long names among them, so Cards on a phone is shot at the scale and the name lengths it meets.
if (flags.includes('--real')) {
  const LONG = ['sb-motion-settings', 'stam2-android-longpress', 'oss-readme-and-license', 'settings-migrate-to-store', 'reply-system-threads', 'perm-route-parent-agent', 'dev-usage-limits-drill', 'peer-ui-writes-guard', 'mail-dead-session-recovery', 'gate-rules-fresh-clone',
    'work-phone', 'tmux-env-leak-fix', 'withdraw-ask-core', 'saved-202-replies', 'story-c2-system-view', 'delegate-first-spawns', 'inbox-box-sizing', 'human-only-text-audit', 'rt-spawn-migrate-machines', 'wait-for-errors-surface'];
  for (const name of LONG) add(name, cos, pick(['claude', 'opencode']), 'haiku', { state: pick(['working', 'idle', 'waiting']) });
  // A team two deep under one of them, so a row sits four levels in: the widest a phone's column gets.
  const deep = add('sb-motion-dev', agents.find((a) => a.name === 'sb-motion-settings'), 'claude', 'haiku', { state: 'working' });
  add('sb-motion-dev-test-runner', deep, 'opencode', 'deepseek', { state: 'idle' });
}
const by = (name) => agents.find((a) => a.name === name);
Object.assign(by('voice-dev2'), { activity: 'blocked', activity_detail: 'Asked you: which wake word?' });
itsas.find((x) => x.owner === by('voice-dev2').id).status = 'needs_input';
Object.assign(by('storage-ops-dev1'), { activity: 'errored', activity_detail: 'OpenRouter 402: credit exhausted' });
Object.assign(by('waiting-dev3'), { lifecycle: 'paused', activity_detail: 'Paused for the 5 h window' });
Object.assign(by('its-dev2'), { context_tokens: 455000, context_level: 1 });
// --agents: a lead under cos with divisions under it, each of up to eight teams of a manager, six
// developers and a reviewer, until the fixture holds `want` agents. Nobody in them needs the
// human, so they fold; cos's own row stays as wide as at 43 agents.
const DIVS = ['platform', 'clients', 'research', 'infra', 'growth', 'tooling'];
const lead = want > agents.length ? add('divisions', cos, 'claude', 'opus', { title: 'Divisions: the product lines', status: 'delegated', cost: 14.2, unread: 1 }) : null;
for (let d = 0; agents.length < want; d++) {
  const div = add(DIVS[d % DIVS.length] + (d < DIVS.length ? '' : '-' + d), lead, 'claude', 'opus', { title: `Division ${d + 1}: ${pick(TITLES)}`, status: 'delegated', cost: +(rnd() * 20 + 5).toFixed(2), unread: d % 2 });
  for (let t = 0; t < 8 && agents.length < want; t++) {
    const mgr = add(`${div.name}-t${t + 1}`, div, 'claude', 'sonnet', { status: 'delegated', cost: +(rnd() * 9 + 2).toFixed(2) });
    for (let i = 0; i < 6 && agents.length < want; i++) {
      const h = pick(['opencode', 'claude']);
      add(`${mgr.name}-dev${i + 1}`, mgr, h, h === 'opencode' ? 'deepseek' : 'haiku', { state: pick(['working', 'working', 'idle']), unread: i === 0 ? 1 : 0 });
    }
    if (agents.length < want) add(`${mgr.name}-review`, mgr, 'codex', 'sol', { title: `Review ${mgr.name}`, status: 'in_review', state: 'idle' });
  }
}
for (const a of agents) a.cost.tree.api = a.cost.own.api;
for (const a of [...agents].reverse()) for (const p of a.parents) by(agents.find((x) => x.id === p).name).cost.tree.api += a.cost.tree.api;
// Three done today, by agents since archived.
for (let i = 0; i < 3; i++) itsas.push({ ...itsas[3 + i], id: 'd' + i, key: `S-${key++}`, status: 'done', closed_at: iso(60), owner: 'gone' });
// Each agent's ITSA is a child of its parent agent's, so the cards show roll-ups (S-463).
const itsaOf = (a) => itsas.find((x) => x.owner === a.id);
for (const a of agents) { const up = a.parents[0] && itsaOf(agents.find((x) => x.id === a.parents[0])); const own = itsaOf(a); if (up && own) own.parent_id = up.id; }
const STATUSES = [['idea', 'backlog'], ['backlog', 'backlog'], ['todo', 'ready'], ['in_progress', 'active'], ['delegated', 'active'], ['blocked', 'active'], ['needs_input', 'active', true],
  ['in_review', 'review'], ['needs_review', 'review', true], ['ready_to_merge', 'review'], ['done', 'closed'], ['canceled', 'closed']].map(([name, category, human]) => ({ name, category, human: !!human }));
const FIELDS = [{ id: 'f1', key: 'stage', label: 'Stage', type: 'choice', options: [{ value: 'dev', label: 'dev', tone: 'muted' }, { value: 'review', label: 'review', tone: 'accent' }, { value: 'merge', label: 'merge', tone: 'ok' }],
  description: null, hint: null, width: 's', align: 'start', card: 'chip', position: 0 }];
const USAGE = { today: { cost_usd: 193.42, tokens_in: 0, tokens_out: 0 }, subscriptions: [], by_model: [], by_agent: [], note: '',
  accounts: [{ account: 'claude-max', match: { harness: 'claude' }, windows: { five_hour: { used_percentage: 45 }, seven_day: { used_percentage: 46 } } },
    { account: 'codex-pro', match: { harness: 'codex' }, windows: { five_hour: { used_percentage: 88 } } }],
  by_day: [21, 34, 18, 52, 61, 40, 75, 90, 66, 88, 120, 104, 142, 193.42].map((c, i) => ({ day: `2026-10-${String(i).padStart(2, '0')}`, cost_usd: c, tokens_in: 0 })) };
const ROUTES = { '/api/agents': agents, '/api/itsas': itsas, '/api/itsas/statuses': { statuses: STATUSES }, '/api/itsas/fields': FIELDS, '/api/usage': USAGE,
  '/api/itsas/attention': [], '/api/itsas/queue': [], '/api/permissions?status=pending&audience=human': [] };

// Each size starts from the fixture's own unread counts; the flights add to them.
const UNREAD0 = agents.map((a) => a.unread);

// ---- Mail flights (S-459) ----
let mailN = 0;
const live = (p, type, data) => p.evaluate(([t, d]) => window.stamDebug.live(t, d), [type, data]);
// A mail as the daemon reports it: mail.sent, then each recipient's new unread count. The
// fixture's agents take the count too, so a poll agrees with the events.
const sentEvents = (from, to, extra = {}) => {
  const id = 'mx' + ++mailN;
  const evs = [['mail.sent', { id, from: from.id ?? from, to: to.map((a) => a.id ?? a), thread: 'th-' + id, itsa: null, ask: false, subject: 'Check', at: null, ...extra }]];
  for (const a of to) if (a.id) { a.unread++; evs.push(['agent.changed', { id: a.id, unread: a.unread }]); }
  return evs;
};
// Applies the events in one go, in the page, and returns how many sheets are in the air after.
const burst = (p, evs) => p.evaluate((evs) => { for (const [t, d] of evs) window.stamDebug.live(t, d); return document.querySelectorAll('.sv-fly').length; }, evs);
// Where sheets rest (the start, the top of the lift, and the landing, by stamDebug.systemDeck.seek)
// that overlaps a card's visible text: each as "card text" for the report. Measured in one go, before
// the next frame moves them.
const restingOverText = (p) => p.evaluate(() => {
  const texts = [];
  for (const card of document.querySelectorAll('.sv-card[data-card]')) {
    const walk = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const el = n.parentElement;
      if (!n.textContent.trim() || el.closest('.sv-stack') || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const r = document.createRange(); r.selectNodeContents(n);
      // An ellipsised run reports its whole width: only the part inside its element shows.
      const e = el.getBoundingClientRect();
      for (const t of r.getClientRects()) {
        const b = { left: Math.max(t.left, e.left), right: Math.min(t.right, e.right), top: Math.max(t.top, e.top), bottom: Math.min(t.bottom, e.bottom) };
        if (b.right > b.left && b.bottom > b.top) texts.push({ b, what: `${card.querySelector('.sv-nm')?.textContent} "${n.textContent.trim().slice(0, 20)}"` });
      }
    }
  }
  const out = [];
  for (const t of [0, 0.14, 1]) {
    window.stamDebug.systemDeck.seek(t);
    for (const sh of document.querySelectorAll('.sv-fly .sh')) {
      const a = sh.getBoundingClientRect();
      for (const { b, what } of texts) if (a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1) out.push(`t=${t}: ${what}`);
    }
  }
  return out;
});
const stackN = async (p, a) => { const n = p.locator(`.sv-card[data-card="${a.id ?? a}"] .sv-stack .n`); return (await n.count()) ? Number(await n.first().textContent()) : 0; };
async function flights(p, tag, size, theme, shot) {
  const rel = by('release'), asst = by('assistant'), sv = by('system-view'), its = by('its');
  const flightToken = (v) => p.evaluate((v) => document.documentElement.style.setProperty('--duration-flight', v), v);
  // Slow enough that a shot lands mid-air: 9 s at the longest, 4 s at the shortest.
  await flightToken('9000ms');
  await reach(p, size, rel.id);
  const before = await stackN(p, rel);
  const evs = [
    ...sentEvents(cos, [rel]),                                  // down a wire
    ...sentEvents(sv, [cos]),                                   // up a wire
    ...sentEvents(rel, [asst]),                                 // a free arc between siblings
    ...sentEvents(by('voice-dev2'), ['human'], { ask: true }),  // an ask to the human, in the warning hue
    ...sentEvents(cos, [by('its-dev1')]),                       // to a folded subtree on the phone
    // A burst to one card: one sheet and a count.
    ...[1, 2, 3, 4, 5].flatMap(() => sentEvents(cos, [its])),
  ];
  const flying = await burst(p, evs);
  const over = await restingOverText(p);
  check(tag, 'a resting sheet never covers card text', over.length === 0, over.join('; '));
  check(tag, 'mail flies', flying >= 4, `${flying} in the air`);
  const toIts = p.locator('.sv-fly .n', { hasText: /^[5-9]$/ });
  check(tag, 'a burst to one card is one sheet with a count', (await toIts.count()) === 1, await p.locator('.sv-fly .n').allTextContents());
  check(tag, 'an ask flies in the warning hue', (await p.locator('.sv-fly.warn').count()) >= 1);
  check(tag, 'a free arc draws its trail', (await p.locator('.sv-trail:not(.wire)').count()) >= 1);
  check(tag, 'the stack waits for its sheet', (await stackN(p, rel)) === before, `${await stackN(p, rel)} vs ${before}`);
  // Mid-air: past the lift, before the landing.
  await p.waitForTimeout(3000);
  const moved = await p.evaluate(() => [...document.querySelectorAll('.sv-fly')].map((e) => e.style.transform).filter(Boolean).length);
  check(tag, 'sheets move by transform', moved >= 4, moved);
  await p.screenshot({ path: `${out}/flight-${tag}.png` });
  await p.waitForSelector('.sv-fly', { state: 'detached', timeout: 12000 });
  check(tag, 'every sheet lands', true);
  check(tag, 'the stack grows when the sheet lands', (await stackN(p, rel)) === before + 1, `${await stackN(p, rel)} vs ${before + 1}`);
  await reach(p, size, its.id);
  check(tag, 'a burst stacks on its card', (await stackN(p, its)) >= 5, await stackN(p, its));
  await shot('landed');
  // A read: the top sheet slips into the card.
  await reach(p, size, rel.id);
  rel.unread--;
  await burst(p, [['mail.read', { id: 'mx1', by: rel.id, at: null }], ['agent.changed', { id: rel.id, unread: rel.unread }]]);
  await p.waitForSelector(`.sv-card[data-card="${rel.id}"] .sv-stack .sheet.read`, { state: 'attached' });
  check(tag, 'a read slips the top sheet into the card', (await stackN(p, rel)) === before, await stackN(p, rel));
  // The cap: a broadcast to every agent flies at most 24 sheets, the rest land at once.
  await flightToken('');
  const all = agents.filter((a) => a.lifecycle === 'active' && a !== cos);
  const capped = await burst(p, sentEvents(cos, all));
  check(tag, 'at most 24 sheets in the air', capped > 0 && capped <= 24, capped);
  await p.waitForSelector('.sv-fly', { state: 'detached', timeout: 4000 });
  // A sheet opens its thread.
  await flightToken('9000ms');
  await burst(p, sentEvents(cos, [rel]));
  // A panning drag leaves the next click eaten until a finger lands again (as a browser's drag does); this click has no finger.
  await p.evaluate(() => { const st = document.querySelector('.sv-stage'); for (const t of ['pointerdown', 'pointercancel']) st.dispatchEvent(new PointerEvent(t, { bubbles: true, pointerId: 77, pointerType: 'touch' })); });
  const tid = await p.evaluate(() => { const el = document.querySelector('.sv-fly'); el?.click(); return el?.dataset.thread; });
  await p.waitForFunction((t) => window.stamDebug.shell.currentWorld() === 't:' + t, tid);
  check(tag, 'a click on a sheet opens its thread', true);
  await p.evaluate(() => window.stamDebug.shell.showAgentWorld('w:system'));
  await p.waitForFunction(() => window.stamDebug.shell.currentWorld() === 'w:system');
  await p.waitForSelector('.sv-card[data-card]');
  await flightToken('');
  // A click on a stack opens the unread list.
  if (size.name === '1440' && theme === 'light') {
    await p.locator(`.sv-card[data-card="${rel.id}"] .sv-stack`).click();
    await p.waitForFunction((id) => window.stamDebug.shell.currentWorld() === id, rel.id);
    check(tag, 'a click on a stack opens the inbox', true);
    await p.evaluate(() => window.stamDebug.shell.showAgentWorld('w:system'));
    await p.waitForFunction(() => window.stamDebug.shell.currentWorld() === 'w:system');
    await p.waitForSelector('.sv-card[data-card]');
    // Reduced motion: no sheet flies; the card is marked and its stack counts the mail.
    await p.waitForSelector('.sv-fly', { state: 'detached', timeout: 12000 });
    await p.emulateMedia({ reducedMotion: 'reduce' });
    const n0 = await stackN(p, asst);
    const still = await burst(p, sentEvents(cos, [asst]));
    check(tag, 'reduced motion: nothing flies', still === 0, still);
    await p.waitForSelector(`.sv-card[data-card="${asst.id}"].hit`);
    check(tag, 'reduced motion: the card is marked instead', true);
    check(tag, 'reduced motion: the stack counts it', (await stackN(p, asst)) === n0 + 1, `${await stackN(p, asst)} vs ${n0 + 1}`);
    await p.emulateMedia({ reducedMotion: null });
  }
}

// ---- Cost, ITSA, spawn and archive motion (S-463) ----
let spawnN = 0;
// A card's computed transform and opacity: what Motion has it at this frame.
const poseOf = (p, sel) => p.evaluate((sel) => { const e = document.querySelector(sel); if (!e) return null; const cs = getComputedStyle(e); return { t: cs.transform, o: +cs.opacity }; }, sel);
const atRest = (t) => t === 'none' || /^matrix\(1, 0, 0, 1, /.test(t);
const rollOf = (p, sel) => p.evaluate((sel) => { const e = document.querySelector(sel); return e ? { v: +e.dataset.roll, text: e.textContent } : null; }, sel);
async function motion(p, tag, size, theme) {
  const rel = by('release'), asst = by('assistant');
  const card = (a) => `.sv-card[data-card="${a.id ?? a}"]`;
  const saved = itsas.map((x) => x.status);
  // Ten times slower, and a render so the view reads it before the first event.
  await p.evaluate(() => document.documentElement.style.setProperty('--duration-slow', '2200ms'));
  // The phone's canvas is panned, and zoomed out if it must, so cos and the team below it show together (S-1067).
  await reach(p, size, rel.id, cos.id, asst.id);
  await live(p, 'agent.changed', { id: asst.id, context_tokens: asst.context_tokens + 1 });
  await p.waitForTimeout(100);
  // On the desktop, close enough to read the cards round cos's first children.
  if (!size.phone) {
    const b = await p.locator(card(rel)).boundingBox();
    await p.mouse.move(b.x, b.y);
    for (let i = 0; i < 10 && await p.locator('.sv-stage.far').count(); i++) { await p.mouse.wheel(0, -200); await p.waitForTimeout(50); }
    await p.mouse.wheel(0, -150);
    await p.waitForTimeout(200);
  }

  // A cost rolls, with a "+$" rising over it.
  const was = rel.cost.own.api;
  rel.cost_usd = +(was + 2.3).toFixed(2);
  await live(p, 'agent.changed', { id: rel.id, cost_usd: rel.cost_usd });
  await p.waitForTimeout(400);
  const own = `${card(rel)} .sv-cost .own`;
  const mid = await rollOf(p, own);
  const final = '$' + rel.cost_usd.toFixed(1);
  check(tag, 'a cost rolls toward its new value', mid && mid.v === rel.cost_usd && mid.text !== final, JSON.stringify(mid));
  check(tag, 'a "+$" rises over the cost', (await p.locator(`${card(rel)} .sv-rise`).textContent().catch(() => '')) === '+$2.3');
  await p.screenshot({ path: `${out}/cost-${tag}.png` });

  // A status change stamps the ITSA's mark and washes its row.
  const ai = itsaOf(asst);
  ai.status = ai.status === 'in_review' ? 'ready_to_merge' : 'in_review';
  await live(p, 'itsa.changed', { id: ai.id, status: ai.status, owner: asst.id });
  await p.waitForTimeout(120);
  const st = await poseOf(p, `${card(asst)} .sv-stamp`);
  check(tag, 'a status change stamps the mark', st && !atRest(st.t), st?.t);
  check(tag, 'a stamp washes the row', (await p.locator(`${card(asst)} .sv-wash`).count()) === 1);
  await p.screenshot({ path: `${out}/stamp-${tag}.png` });

  // Done: the sheet carries it up the wire, and the parent's roll-up advances when it lands.
  const ri = itsaOf(rel);
  const roll0 = (await rollOf(p, `${card(cos)} .sv-rollup [data-roll]`))?.v;
  ri.status = 'done';
  await live(p, 'itsa.changed', { id: ri.id, status: 'done', owner: rel.id });
  await p.waitForTimeout(150);
  check(tag, 'a done sheet flies up the wire', (await p.locator('.sv-fly.done').count()) === 1);
  check(tag, 'the done card stamps it done', (await p.locator(`${card(rel)} .sv-wash.done`).count()) === 1 && /S-\d+/.test(await p.locator(`${card(rel)} .sv-r2`).textContent()));
  check(tag, 'the roll-up waits for the sheet', (await rollOf(p, `${card(cos)} .sv-rollup [data-roll]`))?.v === roll0, roll0);
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `${out}/done-${tag}.png` });
  await p.waitForSelector('.sv-fly.done', { state: 'detached', timeout: 15000 });
  check(tag, 'the roll-up advances when the sheet lands', (await rollOf(p, `${card(cos)} .sv-rollup [data-roll]`))?.v === roll0 + 1);

  // A burst of completions rides one sheet with a count, and the roll-up waits for all of them;
  // one reopened mid-flight stops counting at once, without holding the others back.
  const trio = ['system-view', 'cost', 'its'].map(by);
  const cosRoll = `${card(cos)} .sv-rollup [data-roll]`;
  const rb = (await rollOf(p, cosRoll)).v;
  for (const a of trio) itsaOf(a).status = 'done';
  await burst(p, trio.map((a) => ['itsa.changed', { id: itsaOf(a).id, status: 'done', owner: a.id }]));
  await p.waitForTimeout(150);
  const doneN = await p.locator('.sv-fly.done .n').allTextContents();
  check(tag, 'a burst of completions rides one sheet with a count', doneN.length === 1 && doneN[0] === '3', doneN);
  check(tag, 'the roll-up waits for the whole burst', (await rollOf(p, cosRoll)).v === rb);
  const back = itsaOf(by('cost'));
  back.status = 'delegated';
  await live(p, 'itsa.changed', { id: back.id, status: back.status });
  await p.waitForTimeout(100);
  check(tag, 'a child reopened mid-flight leaves the sheet', (await p.locator('.sv-fly.done .n').textContent()) === '2');
  check(tag, 'a child reopened mid-flight leaves the roll-up as it was', (await rollOf(p, cosRoll)).v === rb, (await rollOf(p, cosRoll)).v);
  await p.waitForSelector('.sv-fly.done', { state: 'detached', timeout: 15000 });
  check(tag, 'the roll-up counts the burst when it lands', (await rollOf(p, cosRoll)).v === rb + 2, `${(await rollOf(p, cosRoll)).v} vs ${rb + 2}`);

  // A spawn grows out of its parent, and the rest glide to make room.
  const rects = () => p.evaluate(() => Object.fromEntries([...document.querySelectorAll('.sv-card[data-card]')].map((e) => { const r = e.getBoundingClientRect(); return [e.dataset.card, [Math.round(r.x), Math.round(r.y)]]; })));
  const r0 = await rects();
  const kid = add(`spawn-${tag}-${++spawnN}`, cos, 'claude', 'haiku', { state: 'working', act: 'Starting; reading AGENTS.md', cost: 0, status: 'in_progress', title: 'Rolling numbers on the header' });
  itsaOf(kid).parent_id = itsaOf(cos).id;
  kid.cost.tree.api = 0;
  // Made just after the assistant, so it joins cos's children before the managers, which move.
  kid.created_at = new Date(Date.parse(asst.created_at) + 30_000).toISOString();
  await live(p, 'agent.spawned', { id: kid.id, name: kid.name, parent_id: cos.id });
  await p.waitForSelector(card(kid));
  await p.waitForTimeout(250);
  const sp = await poseOf(p, card(kid));
  check(tag, 'a spawn grows in', sp && (sp.o < 1 || /matrix\(0\.9/.test(sp.t)), JSON.stringify(sp));
  const r1 = await rects();
  await p.waitForTimeout(400);
  const r2 = await rects();
  // Most of the way out of its parent, still growing.
  await p.waitForTimeout(700);
  await p.screenshot({ path: `${out}/spawn-${tag}.png` });
  const gliding = Object.keys(r1).filter((id) => r0[id] && r2[id] && (r1[id][0] !== r2[id][0] || r1[id][1] !== r2[id][1])).length;
  check(tag, 'the layout glides to make room', gliding >= 1, gliding);
  await p.waitForTimeout(7000);
  const rest = await poseOf(p, card(kid));
  check(tag, 'a spawn comes to rest', rest && rest.o === 1 && /scale\(1\)|matrix\(1, 0, 0, 1,/.test((await p.locator(card(kid)).getAttribute('style')) + rest.t), JSON.stringify(rest));

  // An archive shrinks back into its parent.
  kid.lifecycle = 'archived';
  await live(p, 'agent.archived', { id: kid.id });
  await p.waitForSelector(card(kid), { state: 'detached' });
  const lv = await poseOf(p, `.sv-card.leave`);
  check(tag, 'an archive shrinks back', !!lv, JSON.stringify(lv));
  await p.waitForTimeout(200);
  await p.screenshot({ path: `${out}/archive-${tag}.png` });
  await p.waitForSelector('.sv-card.leave', { state: 'detached', timeout: 10000 });
  check(tag, 'the archived card is gone', true);

  // A far chip (zoomed out) leaves without the shrink: its name draws at 14 px or more all the way out (S-1030).
  if (!size.phone) {
    const bf = await p.locator(card(rel)).boundingBox();
    await p.mouse.move(bf.x, bf.y);
    for (let i = 0; i < 20 && !(await p.locator('.sv-stage.far').count()); i++) { await p.mouse.wheel(0, 200); await p.waitForTimeout(80); }
    await p.waitForSelector('.sv-stage.far', { timeout: 5000 });
    const fkid = add(`spawn-${tag}-${++spawnN}`, cos, 'claude', 'haiku', { state: 'working', act: 'Starting', cost: 0, status: 'in_progress', title: 'A far chip leaves' });
    itsaOf(fkid).parent_id = itsaOf(cos).id;
    fkid.cost.tree.api = 0;
    fkid.created_at = new Date(Date.parse(asst.created_at) + 30_000).toISOString();
    await live(p, 'agent.spawned', { id: fkid.id, name: fkid.name, parent_id: cos.id });
    await p.waitForSelector(card(fkid));
    // The name as drawn: its font size times how much the transforms above it scale it.
    const namePx = (sel) => p.evaluate((sel) => { const b = document.querySelector(sel + ' .sv-chip .c1 b'); const cs = getComputedStyle(b), laid = parseFloat(cs.width); if (!laid) return null; return +(parseFloat(cs.fontSize) * b.getBoundingClientRect().width / laid).toFixed(2); }, sel);
    await p.waitForTimeout(150);
    const inPx = await namePx(card(fkid));
    check(tag, 'a far chip fades in with its name at 14 px or more', inPx != null && inPx >= 14, inPx);
    await p.waitForTimeout(5000);
    fkid.lifecycle = 'archived';
    await live(p, 'agent.archived', { id: fkid.id });
    await p.waitForSelector('.sv-card.leave');
    const samples = [];
    for (let i = 0; i < 4; i++) { await p.waitForTimeout(250); const px = await namePx('.sv-card.leave'); if (px != null) samples.push(px); }
    check(tag, 'an archived far chip keeps its name at 14 px or more while it exits', samples.length > 0 && samples.every((px) => px >= 14), JSON.stringify(samples));
    await p.screenshot({ path: `${out}/archive-far-${tag}.png` });
    await p.waitForSelector('.sv-card.leave', { state: 'detached', timeout: 10000 });
    // Back in, close enough to read the cards for the checks after.
    for (let i = 0; i < 30 && await p.locator('.sv-stage.far').count(); i++) { await p.mouse.wheel(0, -200); await p.waitForTimeout(80); }
    await p.mouse.wheel(0, -150);
    await p.waitForTimeout(200);
  }

  // The header's spend and meters roll.
  USAGE.today.cost_usd = +(USAGE.today.cost_usd + 12.5).toFixed(2);
  USAGE.accounts[0].windows.five_hour.used_percentage += 17;
  await live(p, 'usage.changed', {});
  await p.waitForFunction((v) => +document.querySelector('.sv-spend [data-roll]')?.dataset.roll === v, USAGE.today.cost_usd);
  await p.waitForTimeout(300);
  const sp0 = await rollOf(p, '.sv-spend [data-roll]');
  check(tag, 'the day\'s spend rolls', sp0.text !== '$' + Math.round(USAGE.today.cost_usd), sp0.text);
  check(tag, 'the day\'s spend rises', (await p.locator('.sv-spend .sv-rise').count()) === 1);
  if (!size.phone) check(tag, 'a window meter rolls', (await rollOf(p, '.sv-meter [data-roll]'))?.v === USAGE.accounts[0].windows.five_hour.used_percentage);
  await p.screenshot({ path: `${out}/usage-${tag}.png` });
  await p.waitForTimeout(5000);
  check(tag, 'the day\'s spend comes to rest', (await rollOf(p, '.sv-spend [data-roll]')).text === '$' + Math.round(USAGE.today.cost_usd));
  check(tag, 'a cost comes to rest', (await rollOf(p, own)).text === final, (await rollOf(p, own)).text);

  // Reduced motion: the same end states, without travel.
  await p.evaluate(() => document.documentElement.style.removeProperty('--duration-slow'));
  if (size.name === '1440' && theme === 'light') {
    await p.emulateMedia({ reducedMotion: 'reduce' });
    await live(p, 'agent.changed', { id: asst.id, context_tokens: asst.context_tokens + 2 });
    await p.waitForTimeout(100);
    ai.status = ai.status === 'in_review' ? 'ready_to_merge' : 'in_review';
    await live(p, 'itsa.changed', { id: ai.id, status: ai.status, owner: asst.id });
    await p.waitForTimeout(60);
    const still = await poseOf(p, `${card(asst)} .sv-stamp`);
    check(tag, 'reduced motion: the stamp doesn\'t move', still && atRest(still.t), still?.t);
    const mi = itsaOf(by('mail-ui'));
    const rollR = (await rollOf(p, `${card(cos)} .sv-rollup [data-roll]`)).v;
    mi.status = 'done';
    await live(p, 'itsa.changed', { id: mi.id, status: 'done', owner: by('mail-ui').id });
    await p.waitForTimeout(60);
    check(tag, 'reduced motion: no done sheet flies', (await p.locator('.sv-fly.done').count()) === 0);
    await p.waitForFunction(([sel, v]) => +document.querySelector(sel)?.dataset.roll === v && document.querySelector(sel)?.textContent === String(v), [`${card(cos)} .sv-rollup [data-roll]`, rollR + 1]);
    check(tag, 'reduced motion: the roll-up advances at once', true);
    const k2 = add(`spawn-${tag}-${++spawnN}`, cos, 'claude', 'haiku', { cost: 0, status: 'in_progress' });
    // Beside the assistant too, so it lands in view: a card far off is culled (S-540).
    k2.created_at = new Date(Date.parse(asst.created_at) + 30_000).toISOString();
    await live(p, 'agent.spawned', { id: k2.id, name: k2.name, parent_id: cos.id });
    await p.waitForSelector(card(k2));
    await p.waitForTimeout(60);
    const k2p = await poseOf(p, card(k2));
    check(tag, 'reduced motion: a spawn appears in place', k2p && k2p.o === 1 && atRest(k2p.t.replace(/matrix\(1, 0, 0, 1, [^)]*\)/, 'none')), JSON.stringify(k2p));
    // A cost jumps to its value, with no rise.
    rel.cost_usd = +(rel.cost_usd + 1.1).toFixed(2);
    await live(p, 'agent.changed', { id: rel.id, cost_usd: rel.cost_usd });
    await p.waitForTimeout(60);
    check(tag, 'reduced motion: a cost jumps to its value', (await rollOf(p, own)).text === '$' + rel.cost_usd.toFixed(1), (await rollOf(p, own)).text);
    check(tag, 'reduced motion: no "+$" rises', (await p.locator('.sv-rise').count()) === 0);
    // The header's spend and a meter jump too.
    USAGE.today.cost_usd = +(USAGE.today.cost_usd + 3.5).toFixed(2);
    USAGE.accounts[0].windows.five_hour.used_percentage += 3;
    await live(p, 'usage.changed', {});
    await p.waitForFunction((v) => +document.querySelector('.sv-spend [data-roll]')?.dataset.roll === v, USAGE.today.cost_usd);
    await p.waitForTimeout(60);
    check(tag, 'reduced motion: the day\'s spend jumps', (await rollOf(p, '.sv-spend [data-roll]')).text === '$' + Math.round(USAGE.today.cost_usd), (await rollOf(p, '.sv-spend [data-roll]')).text);
    const meter = await rollOf(p, '.sv-meter [data-roll]');
    check(tag, 'reduced motion: a window meter jumps', meter.text === Math.round(USAGE.accounts[0].windows.five_hour.used_percentage) + '%', meter.text);
    // An archive leaves at once, and the rest take their places without a glide.
    k2.lifecycle = 'archived';
    await live(p, 'agent.archived', { id: k2.id });
    await p.waitForSelector(card(k2), { state: 'detached' });
    await p.waitForTimeout(60);
    check(tag, 'reduced motion: an archive leaves at once', (await p.locator('.sv-card.leave').count()) === 0);
    const q1 = await rects();
    await p.waitForTimeout(300);
    const q2 = await rects();
    const slid = Object.keys(q1).filter((id) => q2[id] && (q1[id][0] !== q2[id][0] || q1[id][1] !== q2[id][1]));
    check(tag, 'reduced motion: the rest take their places without a glide', slid.length === 0, slid.join(' '));
    // Mail: nothing flies and the stack counts it at once (the flights check above, S-459).
    await p.emulateMedia({ reducedMotion: null });
  }
  if (!size.phone) await p.click('.sv-fit');
  // Back to the fixture as it was, for the flows after and the next size.
  const moved = itsas.filter((x, i) => i < saved.length && x.status !== saved[i]);
  saved.forEach((v, i) => { itsas[i].status = v; });
  delete rel.cost_usd;
  await live(p, 'agent.changed', { id: rel.id, cost_usd: was });
  for (const x of moved) await live(p, 'itsa.changed', { id: x.id, status: x.status });
}

// ---- Cards mode (S-460): the same cards on orbits round cos ----
// Card boxes on screen that overlap, as "a/b" pairs.
const overlapsOnScreen = (p) => p.evaluate(() => {
  const rs = [...document.querySelectorAll('.sv-card[data-card]')].map((e) => [e.dataset.card, e.getBoundingClientRect()]);
  const out = [];
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
    const [ia, a] = rs[i], [ib, b] = rs[j];
    if (a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1) out.push(`${ia}/${ib}`);
  }
  return out;
});
// ---- Mode transitions (S-572): wires fade, nodes travel, wires grow back ----
// Waits for a mode switch's morph to finish: the view drops data-moving when it settles.
const settle = (p) => p.waitForSelector('.sv:not([data-moving])', { timeout: 15000 });
// What a switch shows mid-way: nodes on the morph's overlay, the old wires' ghost, and the new
// wires and orbit guides part grown.
const midway = (p) => p.evaluate(() => {
  const moved = [...document.querySelectorAll('[data-tid]')].filter((e) => e.style.translate && e.style.translate !== '0px 0px' && e.style.translate !== 'none');
  const wires = [...document.querySelectorAll('.sv-wires:not(.sv-ghost *) .sv-wire')].map((w) => parseFloat(w.style.opacity || '1'));
  return { moved: moved.length, ghost: document.querySelectorAll('.sv-ghost').length, hidden: wires.filter((o) => o < 0.99).length, wires: wires.length, leaving: document.querySelectorAll('[data-tid].leave').length };
});
// After a switch: nothing left on the overlay, no ghost.
const morphRest = (p) => p.evaluate(() => ({
  over: [...document.querySelectorAll('[data-tid]')].filter((e) => e.style.translate || e.style.scale).length,
  ghost: document.querySelectorAll('.sv-ghost').length,
  world: document.querySelector('.sv-world')?.style.opacity ?? '',
}));
// A switch caught mid-way, with --duration-slow ten times longer so the shot is steady: held
// `ms` into it by the morph's seek, shot, then let go to settle.
async function morphShot(p, tag, mode, name, ms) {
  await p.evaluate(() => document.documentElement.style.setProperty('--duration-slow', '2200ms'));
  await p.evaluate((m) => [...document.querySelectorAll('.sv-modes button')].find((b) => b.textContent === m).click(), mode);
  await p.waitForSelector(`.sv[data-mode="${mode.toLowerCase()}"][data-moving]`);
  await p.evaluate((t) => window.stamDebug.systemMorph.seek(t), ms);
  const mid = await midway(p);
  await p.screenshot({ path: `${out}/${name}-${tag}.png` });
  await p.evaluate(() => { window.stamDebug.systemMorph.resume(); document.documentElement.style.removeProperty('--duration-slow'); });
  return mid;
}

// Each far chip's measured fit (S-572), by card: none when the view isn't zoomed out.
const chipFits = (p) => p.evaluate(() => document.querySelector('.sv-stage.far') ? Object.fromEntries([...document.querySelectorAll('.sv-card[data-card]')].map((e) => [e.dataset.card, e.style.getPropertyValue('--sv-chip-fit')])) : null);
let treeFits = null;
// Every name drawn that draws under 14 px: its font size times the zoom it is drawn under, as its
// glyphs reach the screen (cos's rule, mf0c3d44), not its line box. The far chips' names in the
// Tree and Cards, the cards' own zoomed in, and the stars' labels.
const smallNames = (p) => p.evaluate(() => {
  const sel = '.sv-star[data-card] .sv-sl .sv-nm, ' + (document.querySelector('.sv-stage.far') ? '.sv-card[data-card] .sv-chip .c1 b' : '.sv-card[data-card] .sv-nm');
  const drawn = [...document.querySelectorAll(sel)].filter((e) => e.offsetWidth && e.checkVisibility({ opacityProperty: true, visibilityProperty: true }));
  // No name drawn at all fails too, rather than passing with nothing measured.
  if (!drawn.length) return [['no names drawn', 0]];
  // The zoom it is drawn under: its drawn width over its laid-out width, taken to the fraction of a
  // pixel (offsetWidth rounds, which reads a short name like "cos" a few percent small).
  const laidW = (e) => {
    const cs = getComputedStyle(e), w = parseFloat(cs.width);
    if (!(w > 0)) return e.offsetWidth;
    const px = (n) => parseFloat(cs[n]) || 0;
    return cs.boxSizing === 'border-box' ? w : w + px('paddingLeft') + px('paddingRight') + px('borderLeftWidth') + px('borderRightWidth');
  };
  return drawn.map((e) => [e.textContent, +(parseFloat(getComputedStyle(e).fontSize) * e.getBoundingClientRect().width / laidW(e)).toFixed(1)]).filter(([, s]) => s < 14);
});

async function cardsMode(p, tag, size, theme, shot) {
  const rel = by('release'), sv = by('system-view');
  if (await p.locator('.sv-panel').count()) await p.locator('.sv-panel .sv-close').click();
  await p.click('.sv-fit');
  await settle(p);
  treeFits = await chipFits(p);
  const treeSmall = await smallNames(p);
  check(tag, 'tree: every name draws at 14 px or more at the fit zoom', treeSmall.length === 0, JSON.stringify(treeSmall.slice(0, 5)));
  // Tree to Cards, caught mid-way: the tree's wires fading on the ghost, cards travelling.
  const half = await morphShot(p, tag, 'Cards', 'morph-cards', 2400);
  check(tag, 'tree to cards: the cards travel mid-way', half.moved > 10, JSON.stringify(half));
  check(tag, 'tree to cards: the old wires fade on a ghost', half.ghost === 1, JSON.stringify(half));
  check(tag, 'tree to cards: the new wires wait to grow back', half.hidden > 0 && half.hidden <= half.wires, JSON.stringify(half));
  await settle(p);
  const rest = await morphRest(p);
  check(tag, 'tree to cards: settles with nothing left on the overlay', rest.over === 0 && rest.ghost === 0, JSON.stringify(rest));
  const cards = await p.locator('.sv-card[data-card]').count();
  const total = agents.filter((a) => a.lifecycle === 'active' || a.lifecycle === 'paused').length + 1;
  // Past 60 agents some managers are folded (S-540): every card laid out is drawn.
  const laid = Number(await p.locator('.sv-world').getAttribute('data-laid'));
  // Fit is zoom 1 (S-705), so only the cards near the view are mounted: every agent is laid out, and some are drawn.
  check(tag, 'cards: every agent has a card, plus the human', cards > 5 && cards <= laid && (total > 61 || laid === total), `${cards} mounted of ${laid} laid out, ${total} agents`);
  check(tag, 'cards: the switch shows Cards on', (await p.locator('.sv-modes button.on').textContent()) === 'Cards');
  check(tag, 'cards: a spoke per shown child', (await p.locator('.sv-wire.spoke').count()) === laid - 1);
  check(tag, 'cards: the orbits are drawn', (await p.locator('.sv-orbit').count()) >= 2);
  const over = await overlapsOnScreen(p);
  check(tag, 'cards: no two cards overlap', over.length === 0, over.join(' '));
  // Cards draws every card in full at any zoom (S-705), so there are no far chips, whatever the fit
  // zoom: the names scale with the cards.
  check(tag, 'cards: every card is drawn in full, none as a far chip', (await p.locator('.sv-stage.far').count()) === 0 && (await p.locator('.sv-card .sv-chip:visible').count()) === 0);
  check(tag, 'cards: a card shows its ITSA row', (await p.locator('.sv-card[data-card] .sv-r2').count()) > 0);
  const box = await p.locator('.sv-world').boundingBox();
  const st = await p.locator('.sv-stage').boundingBox();
  // Fit keeps the names readable: zoom 1, with every name at 14 px or more, and cos in the middle of the stage
  // when the ring is bigger than it. Zooming out is the way to see the whole ring.
  const small = await smallNames(p);
  check(tag, 'cards: every name draws at 14 px or more at the fit zoom', small.length === 0, JSON.stringify(small.slice(0, 5)));
  const c = await p.locator(`.sv-card[data-card="${cos.id}"]`).boundingBox();
  const whole = box.x >= st.x - 1 && box.y >= st.y - 1 && box.x + box.width <= st.x + st.width + 1 && box.y + box.height <= st.y + st.height + 1;
  check(tag, 'cards: fit is zoom 1 and centres on cos, or shows the whole ring', Math.abs(await zoomOf(p) - 1) < 0.01 && (whole || (Math.abs(c.x + c.width / 2 - (st.x + st.width / 2)) < 4 && Math.abs(c.y + c.height / 2 - (st.y + st.height / 2)) < 4)), `${await zoomOf(p)} ${JSON.stringify(c)} in ${JSON.stringify(st)}`);
  const hb = await p.locator('.sv-card[data-card="human"]').boundingBox();
  check(tag, 'cards: the human sits above cos', hb.y < c.y && Math.abs(hb.x - c.x) < 2, `${hb.x},${hb.y} vs ${c.x},${c.y}`);
  await shot('cards');
  // Mail on the orbits: down a spoke, up one, and between teams through the middle.
  await p.evaluate(() => document.documentElement.style.setProperty('--duration-flight', '9000ms'));
  const flying = await burst(p, [...sentEvents(cos, [rel]), ...sentEvents(sv, [cos]), ...sentEvents(by('its-dev1'), [by('voice-dev2')]), ...sentEvents(by('cost-review'), [by('mail-ui')])]);
  check(tag, 'cards: mail flies', flying === 4, flying);
  check(tag, 'cards: mail between teams swings round the hub', (await p.locator('.sv-trail:not(.wire)').count()) === 2);
  const restOver = await restingOverText(p);
  check(tag, 'cards: a resting sheet never covers card text', restOver.length === 0, restOver.join('; '));
  await p.waitForTimeout(3500);
  await p.screenshot({ path: `${out}/cards-flight-${tag}.png` });
  // Through the middle: a cross-team sheet passes near the hub at the midpoint of its flight.
  const mid = await p.evaluate(() => { window.stamDebug.systemDeck.seek(0.5); return [...document.querySelectorAll('.sv-fly')].map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y]; }); });
  const near = mid.filter(([x, y]) => Math.hypot(x - (c.x + c.width / 2), y - (c.y + c.height / 2)) < Math.max(c.width, box.width / 6)).length;
  check(tag, 'cards: a sheet between teams passes through the middle', near >= 1, JSON.stringify(mid));
  await p.waitForSelector('.sv-fly', { state: 'detached', timeout: 12000 });
  await p.evaluate(() => document.documentElement.style.removeProperty('--duration-flight'));
  check(tag, 'cards: every sheet lands', true);
  // The panel opens from a card on the orbits.
  await p.locator(`.sv-card[data-card="${rel.id}"]`).click();
  await p.waitForSelector('.sv-panel');
  check(tag, 'cards: a click opens the panel', (await p.locator('.sv-panel h3').textContent()) === 'release');
  await shot('cards-panel');
  await p.locator('.sv-panel .sv-close').click();
  // The choice is kept in this browser, and a link's mode wins.
  check(tag, 'cards: the mode is kept', (await p.evaluate(() => localStorage.getItem('stam/system-mode'))) === 'cards');
  await p.evaluate(() => { location.hash = 'view=system&mode=tree'; });
  await p.waitForSelector('.sv[data-mode="tree"]');
  check(tag, 'a link\'s #mode=tree switches back', true);
  await p.evaluate(() => { location.hash = 'view=system&mode=cards'; });
  await p.waitForSelector('.sv[data-mode="cards"]');
  check(tag, 'a link\'s #mode=cards switches to Cards', true);
  await p.locator('.sv-modes button', { hasText: 'Tree' }).click();
  await p.waitForSelector('.sv[data-mode="tree"]');
}

// ---- Stars mode (S-539): an orb per agent on rings round cos ----
// Stars whose orb or labels overlap another's on screen, as "a/b" pairs.
const starOverlaps = (p) => p.evaluate(() => {
  // An orb and the label lines drawn under it: its name, and its key and cost unless zoomed out,
  // each its own box, so one star's name may sit beside another's orb. A label hidden for want of
  // room (zoom.ts) takes none.
  const boxes = (e) => [e.querySelector('.sv-orb'), ...e.querySelectorAll('.sv-sl .sv-nm, .sv-sl .l2')].filter((x) => x.checkVisibility({ visibilityProperty: true })).map((x) => x.getBoundingClientRect()).filter((r) => r.width);
  const rs = [...document.querySelectorAll('.sv-star[data-card]')].map((e) => [e.dataset.card, boxes(e)]);
  const hit = (a, b) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
  const out = [];
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
    const [ia, as] = rs[i], [ib, bs] = rs[j];
    if (as.some((a) => bs.some((b) => hit(a, b)))) out.push(`${ia}/${ib}`);
  }
  return out;
});
async function starsMode(p, tag, size, theme, shot) {
  const rel = by('release'), sv = by('system-view');
  if (await p.locator('.sv-panel').count()) await p.locator('.sv-panel .sv-close').click();
  // Cards to Stars, caught mid-way: each card collapsing into its mark as the orb swells from it.
  const half = await morphShot(p, tag, 'Stars', 'morph-stars', 2400);
  check(tag, 'cards to stars: cards and orbs travel together mid-way', half.moved > 10 && half.leaving > 10, JSON.stringify(half));
  await settle(p);
  const rest = await morphRest(p);
  check(tag, 'cards to stars: settles with nothing left on the overlay', rest.over === 0 && rest.ghost === 0, JSON.stringify(rest));
  const stars = await p.locator('.sv-star[data-card]').count();
  const total = agents.filter((a) => a.lifecycle === 'active' || a.lifecycle === 'paused').length + 1;
  const laid = Number(await p.locator('.sv-world').getAttribute('data-laid'));
  check(tag, 'stars: every agent is a star, plus the human', stars === laid && (total > 61 || laid === total), `${stars} of ${laid}, ${total} agents`);
  check(tag, 'stars: no cards left', (await p.locator('.sv-card[data-card]').count()) === 0);
  check(tag, 'stars: a ray per shown child', (await p.locator('.sv-wire.ray').count()) === laid - 1);
  check(tag, 'stars: the rings are drawn', (await p.locator('.sv-orbit').count()) >= 2);
  const over = await starOverlaps(p);
  check(tag, 'stars: no two orbs or labels overlap', over.length === 0, over.join(' '));
  const hid = await p.locator('.sv-star[data-hide]').count();
  console.log(`     [${tag}] stars: labels hidden for want of room at the fit zoom: ${hid} of ${stars}`);
  check(tag, 'stars: most labels show at the fit zoom', hid <= stars / 3, `${hid} of ${stars} hidden`);
  const starSmall = await smallNames(p);
  check(tag, 'stars: every name drawn draws at 14 px or more at the fit zoom', starSmall.length === 0, JSON.stringify(starSmall.slice(0, 5)));
  const box = await p.locator('.sv-world').boundingBox();
  const st = await p.locator('.sv-stage').boundingBox();
  check(tag, 'stars: fit shows every ring', box.x >= st.x - 1 && box.y >= st.y - 1 && box.x + box.width <= st.x + st.width + 1 && box.y + box.height <= st.y + st.height + 1, JSON.stringify(box));
  const orb = (id) => p.locator(`.sv-star[data-card="${id}"] .sv-orb`).boundingBox();
  const c = await orb(cos.id), hb = await orb('human'), d = await orb(by('its-dev1').id);
  check(tag, 'stars: cos sits at the hub', Math.abs(c.x + c.width / 2 - (box.x + box.width / 2)) < box.width * 0.1, JSON.stringify(c));
  check(tag, 'stars: the human sits straight above cos', hb.y < c.y && Math.abs(hb.x + hb.width / 2 - (c.x + c.width / 2)) < 2, `${hb.x},${hb.y} vs ${c.x},${c.y}`);
  check(tag, 'stars: spend sizes the orbs', c.width > d.width && Math.abs(c.width - c.height) < 1, `${c.width} vs ${d.width}`);
  const lbl = await p.locator(`.sv-star[data-card="${cos.id}"] .sv-sl`).textContent();
  check(tag, 'stars: a star is labelled with name, ITSA key and cost', lbl.includes('cos') && lbl.includes(itsas.find((x) => x.owner === cos.id).key) && lbl.includes('$'), lbl);
  check(tag, 'stars: the mark keeps the harness hue in a state ring', (await p.locator(`.sv-star[data-card="${cos.id}"] .sv-orb .glyph .ring`).count()) === 1);
  await shot('stars');
  // Mail among the stars: down a ray, up one, and between teams round the hub.
  await p.evaluate(() => document.documentElement.style.setProperty('--duration-flight', '9000ms'));
  const flying = await burst(p, [...sentEvents(cos, [rel]), ...sentEvents(sv, [cos]), ...sentEvents(by('its-dev1'), [by('voice-dev2')]), ...sentEvents(by('cost-review'), [by('mail-ui')])]);
  check(tag, 'stars: mail flies', flying === 4, flying);
  check(tag, 'stars: mail between teams swings round the hub', (await p.locator('.sv-trail:not(.wire)').count()) === 2);
  await p.waitForTimeout(3500);
  const inAir = await p.locator('.sv-fly').count();
  check(tag, 'stars: a flight is caught mid-air', inAir >= 1, inAir);
  await p.screenshot({ path: `${out}/stars-flight-${tag}.png` });
  await p.waitForSelector('.sv-fly', { state: 'detached', timeout: 12000 });
  await p.evaluate(() => document.documentElement.style.removeProperty('--duration-flight'));
  check(tag, 'stars: every sheet lands', true);
  // The panel opens from a star: its orb is one button, named for the agent.
  check(tag, 'stars: the orb is a button named for its agent', (await p.getByRole('button', { name: 'release: details' }).count()) === 1);
  await p.locator(`.sv-star[data-card="${rel.id}"] .sv-orb`).click();
  await p.waitForSelector('.sv-panel');
  check(tag, 'stars: a click opens the panel', (await p.locator('.sv-panel h3').textContent()) === 'release');
  await shot('stars-panel');
  await p.locator('.sv-panel .sv-close').click();
  check(tag, 'stars: the mode is kept', (await p.evaluate(() => localStorage.getItem('stam/system-mode'))) === 'stars');
  // A switch mid-way retargets: Stars to Tree, and back to Stars before it lands.
  await p.evaluate(() => document.documentElement.style.setProperty('--duration-slow', '2200ms'));
  await p.locator('.sv-modes button', { hasText: 'Tree' }).click();
  await p.waitForTimeout(600);
  await p.evaluate(() => document.documentElement.style.removeProperty('--duration-slow'));
  await p.locator('.sv-modes button', { hasText: 'Stars' }).click();
  await settle(p);
  const back = await starOverlaps(p);
  const rest2 = await morphRest(p);
  check(tag, 'a switch mid-way lands every star in place', back.length === 0 && rest2.over === 0 && (await p.locator('.sv-card[data-tid]').count()) === 0, back.join(' ') + JSON.stringify(rest2));
  // Reduced motion: no travel; the old picture crossfades into the new.
  if (theme === 'light') {
    await p.emulateMedia({ reducedMotion: 'reduce' });
    // Clicked and read in one go: the crossfade lasts --duration-crossfade.
    const fade = await p.evaluate(async () => {
      [...document.querySelectorAll('.sv-modes button')].find((b) => b.textContent === 'Cards').click();
      // React commits a click's update in a microtask.
      await Promise.resolve();
      return { ghost: document.querySelectorAll('.sv-ghost .sv-star').length, world: parseFloat(document.querySelector('.sv-world').style.opacity || '1'),
        moved: [...document.querySelectorAll('[data-tid]')].filter((e) => e.style.translate).length };
    });
    check(tag, 'reduced motion: a mode switch crossfades, with no travel', fade.ghost > 0 && fade.world < 1 && fade.moved === 0, JSON.stringify(fade));
    await settle(p);
    const r = await morphRest(p);
    check(tag, 'reduced motion: the crossfade ends on the new picture', r.ghost === 0 && r.world === '' && (await overlapsOnScreen(p)).length === 0, JSON.stringify(r));
    await p.emulateMedia({ reducedMotion: null });
  }
  await p.locator('.sv-modes button', { hasText: 'Tree' }).click();
  await p.waitForSelector('.sv[data-mode="tree"]');
  await p.waitForSelector('.sv-card[data-card]');
  await settle(p);
  // Back from Stars the cards mount afresh: each far chip gets its fit again, as before. The
  // tree was measured zoomed out, so there are fits to compare.
  check(tag, 'tree to stars to tree: the tree had its far chips fitted', treeFits != null && Object.keys(treeFits).length > 0, JSON.stringify(treeFits)?.slice(0, 80));
  if (treeFits) {
    await p.click('.sv-fit');
    // Fit has drawn the far chips once every one has its fit.
    await p.waitForFunction(() => document.querySelector('.sv-stage.far') && [...document.querySelectorAll('.sv-card[data-card]')].every((e) => e.style.getPropertyValue('--sv-chip-fit')), null, { timeout: 15000 });
    const back = await chipFits(p);
    // Text measures to the sub-pixel, so a fit may round a pixel apart at another zoom.
    const lost = Object.entries(treeFits).filter(([id, v]) => !v || !back?.[id] || Math.abs(parseFloat(back[id]) - parseFloat(v)) > 1).map(([id, v]) => `${id}:${v}->${back?.[id]}`);
    check(tag, 'tree to stars to tree: every far chip keeps its fit', lost.length === 0, lost.slice(0, 5).join(' '));
  }
}

// ---- Cards and Stars on the phone (S-606) ----
// The world layer's zoom, from its transform.
const zoomOf = (p) => p.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector('.sv-world')).transform).a);
// Nothing wider than the screen: the page doesn't scroll sideways.
const sideways = (p) => p.evaluate(() => Math.max(document.scrollingElement.scrollWidth, document.body.scrollWidth) - innerWidth);
// A spot on the stage with no card, orb or label under it, for a double tap.
const emptySpot = (p) => p.evaluate(() => {
  const st = document.querySelector('.sv-stage').getBoundingClientRect();
  for (let y = st.top + 40; y < st.bottom - 40; y += 16) for (let x = st.left + 24; x < st.right - 24; x += 16) {
    // Clear for a finger's reach round it too: a tap snaps to a target near it.
    const clear = [[0, 0], [-30, 0], [30, 0], [0, -30], [0, 30], [-21, -21], [21, -21], [-21, 21], [21, 21]].every(([dx, dy]) => {
      const el = document.elementFromPoint(x + dx, y + dy);
      return el && el.closest('.sv-stage') && !el.closest('[data-card], [data-inbox], [data-thread], [data-fold], button, .sv-sl');
    });
    if (clear) return { x, y };
  }
  return null;
});
async function phoneModes(p, tag, size, theme, shot) {
  const cdp = await p.context().newCDPSession(p);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
  // A pinch about the stage's middle: two fingers moving apart.
  const pinch = async () => {
    const st = await p.locator('.sv-stage').boundingBox(), cx = st.x + st.width / 2, cy = st.y + st.height / 2;
    await touch('touchStart', [[cx - 30, cy], [cx + 30, cy]]);
    for (let i = 1; i <= 8; i++) await touch('touchMove', [[cx - 30 - i * 12, cy], [cx + 30 + i * 12, cy]]);
    await touch('touchEnd', []);
    await p.waitForTimeout(100);
  };
  // As the phone starts: no sheet open, and every manager open (S-705).
  if (await p.locator('.sv-panel').count()) await p.locator('.sv-panel .sv-close').tap();
  // The viewer chose Cards on a wider screen: the phone keeps its own choice, the Tree,
  // and shows the switch.
  check(tag, 'phone: a wider screen\'s mode stays there; the phone opens on the Tree', (await p.locator('.sv[data-mode="tree"]').count()) === 1);
  const hs = await p.locator('.sv-modes button').evaluateAll((bs) => bs.map((b) => b.getBoundingClientRect().height));
  check(tag, 'phone: the switch shows, finger-sized', hs.length === 3 && hs.every((h) => h >= 44), JSON.stringify(hs));
  for (const mode of ['Tree', 'Cards', 'Stars']) {
    const m = mode.toLowerCase();
    await p.locator('.sv-modes button', { hasText: mode }).tap();
    await p.waitForSelector(`.sv[data-mode="${m}"]`);
    await settle(p);
    check(tag, `phone ${m}: the switch shows ${mode} on`, (await p.locator('.sv-modes button.on').textContent()) === mode);
    // The Tree is the phone's start: nothing is stored until it is chosen again (below).
    if (m !== 'tree') check(tag, `phone ${m}: the choice is kept for the phone`, (await p.evaluate(() => localStorage.getItem('stam/system-mode-phone'))) === m);
    const fit = p.locator('.sv-fit');
    check(tag, `phone ${m}: Fit shows, finger-sized`, (await fit.count()) === 1 && (await fit.boundingBox()).height >= 44);
    await fit.tap();
    await p.waitForTimeout(200);
    const box = await p.locator('.sv-world').boundingBox(), st = await p.locator('.sv-stage').boundingBox();
    const whole = box.x >= st.x - 1 && box.y >= st.y - 1 && box.x + box.width <= st.x + st.width + 1 && box.y + box.height <= st.y + st.height + 1;
    // Stars fit whole. Cards on a phone is one column of full cards: Fit fits the width, from the top,
    // and the rest is a pan down (S-705).
    const hub = await p.evaluate(() => { const g = window.stamDebug.systemDeck.geo, m = new DOMMatrix(getComputedStyle(document.querySelector('.sv-world')).transform); return g.laid.hub && { x: m.e + g.laid.hub.x * m.a, y: m.f + g.laid.hub.y * m.a }; });
    const k = await zoomOf(p);
    console.log(`     [${tag}] phone ${m}: fit zoom ${k.toFixed(2)}, ${whole ? 'whole' : 'wide'}`);
    if (m === 'stars') check(tag, 'phone stars: Fit shows the whole picture', whole, `${JSON.stringify(box)} in ${JSON.stringify(st)}`);
    else if (m === 'tree') {
      // S-1067: the Tree branches like the desktop's, as the same full cards as Cards, on a canvas: Fit opens at a
      // readable zoom with cos at the top centre, not the whole tree shrunk into the phone.
      const cos = await p.locator(`.sv-card[data-card="${by('cos').id}"]`).boundingBox();
      check(tag, 'phone tree: Fit opens at zoom 1, names readable', Math.abs(k - 1) < 0.01, k);
      check(tag, 'phone tree: cos sits at the top centre, under the human', !!cos && Math.abs(cos.x + cos.width / 2 - (st.x + st.width / 2)) < 12 && cos.y - st.y < 260, `${JSON.stringify(cos)} in ${JSON.stringify(st)}`);
      check(tag, 'phone tree: the tree branches out wider than the phone', box.width > st.width * 1.2, `${box.width} vs ${st.width}`);
      check(tag, 'phone tree: children branch off their parent on curved wires', (await p.locator('.sv-wire.curve').count()) > 0);
      check(tag, 'phone tree: every card is drawn in full, none as a far chip', (await p.locator('.sv-stage.far').count()) === 0 && (await p.locator('.sv-card .sv-chip:visible').count()) === 0 && (await p.locator('.sv-card[data-card] .sv-r2:visible').count()) > 3);
    } else {
      check(tag, 'phone cards: Fit fits the width, at zoom 1, names readable', box.x >= st.x - 1 && box.x + box.width <= st.x + st.width + 1 && Math.abs(k - 1) < 0.01, `${k} ${JSON.stringify(box)} in ${JSON.stringify(st)}`);
      check(tag, 'phone cards: Fit starts at the top and the layout runs on below', Math.abs(box.y - st.y) < 40 && box.y + box.height > st.y + st.height, `${JSON.stringify(box)} in ${JSON.stringify(st)}`);
      check(tag, 'phone cards: every card is drawn in full, none as a far chip', (await p.locator('.sv-stage.far').count()) === 0 && (await p.locator('.sv-card .sv-chip:visible').count()) === 0 && (await p.locator('.sv-card[data-card] .sv-r2:visible').count()) > 3);
      check(tag, 'phone cards: no hub, no orbits', !hub && (await p.locator('.sv-orbit').count()) === 0);
    }
    const small = await smallNames(p);
    check(tag, `phone ${m}: every name draws at 14 px or more at fit`, small.length === 0, JSON.stringify(small.slice(0, 5)));
    check(tag, `phone ${m}: nothing scrolls sideways`, (await sideways(p)) <= 0, await sideways(p));
    // Every orb, and every card, is a finger's target at the fit: its hit area as drawn.
    const hits = await p.evaluate((m) => {
      const els = [...document.querySelectorAll(m === 'stars' ? '.sv-star[data-card] .sv-orb' : '.sv-card[data-card]')];
      if (!els.length) return [['none drawn', 0]];
      return els.map((e) => { const cs = getComputedStyle(e, '::before'), z = e.getBoundingClientRect().width / e.offsetWidth; const own = m === 'stars' ? Math.min(parseFloat(cs.width), parseFloat(cs.height)) * z : e.getBoundingClientRect().height; return [e.closest('[data-card]').dataset.card, own]; }).filter(([, h]) => !(h >= 43.5));
    }, m);
    check(tag, `phone ${m}: every ${m === 'stars' ? 'orb' : 'card'} takes a 44 px tap at fit`, hits.length === 0, JSON.stringify(hits.slice(0, 5)));
    await shot(`phone-${m}`);
    // A tap on a card or an orb opens the sheet.
    const rel = by('release');
    if (m !== 'stars') await reach(p, size, rel.id);
    await p.locator(m === 'stars' ? `.sv-star[data-card="${rel.id}"] .sv-orb` : `.sv-card[data-card="${rel.id}"]`).tap();
    await p.waitForSelector('.sv-panel.sheet');
    check(tag, `phone ${m}: a tap opens the sheet`, (await p.locator('.sv-panel h3').textContent()) === 'release');
    if (m === 'stars') await shot('phone-stars-sheet');
    await p.locator('.sv-panel .sv-close').tap();
    await p.waitForSelector('.sv-panel', { state: 'detached' });
    // Pinch zooms in, and the page doesn't move.
    const k0 = await zoomOf(p);
    await pinch();
    const k1 = await zoomOf(p);
    check(tag, `phone ${m}: a pinch zooms in`, k1 > k0 * 1.5, `${k0} -> ${k1}`);
    check(tag, `phone ${m}: a pinch scrolls nothing`, (await p.evaluate(() => scrollX + scrollY + document.querySelector('.sv-stage').scrollTop)) === 0);
    // S-705: a pinch as a real phone sends it, with the fingers landing on cards, one after the other,
    // the first already sliding, and a finger-paced double tap on a card.
    await fit.tap();
    await p.waitForTimeout(200);
    const onCards = await p.evaluate((m) => {
      const st = document.querySelector('.sv-stage').getBoundingClientRect();
      const ok = [...document.querySelectorAll(m === 'stars' ? '.sv-star[data-card] .sv-orb' : '.sv-card[data-card]')].map((e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })
        .filter((c) => c.x > st.left + 10 && c.x < st.right - 10 && c.y > st.top + 10 && c.y < st.bottom - 10 && document.elementFromPoint(c.x, c.y)?.closest('[data-card]'));
      return ok.slice(0, 2);
    }, m);
    if (onCards.length === 2) {
      const [a, b] = onCards, k6 = await zoomOf(p);
      // The fingers move apart along the line between them.
      const len = Math.hypot(b.x - a.x, b.y - a.y), ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
      const A = (d) => [a.x - ux * d, a.y - uy * d], B = (d) => [b.x + ux * d, b.y + uy * d];
      await touch('touchStart', [[a.x, a.y]]);
      await p.waitForTimeout(40);
      await touch('touchMove', [A(4)]); await p.waitForTimeout(16);
      await touch('touchMove', [A(14)]); await p.waitForTimeout(16);
      await touch('touchStart', [A(14), B(0)]);
      for (let i = 1; i <= 24; i++) { await touch('touchMove', [A(14 + i * 6), B(i * 6)]); await p.waitForTimeout(16); }
      await touch('touchEnd', []);
      await p.waitForTimeout(150);
      const k7 = await zoomOf(p);
      check(tag, `phone ${m}: a pinch with the fingers on cards, one after the other, zooms`, Math.abs(k7 - k6) > k6 * 0.1, `${k6} -> ${k7}`);
      await p.waitForTimeout(500);
      await fit.tap();
      await p.waitForTimeout(200);
      // Finger pace: 80 ms down, a 90 ms gap. A loaded machine can stretch a wait past the double tap's window,
      // so a miss is tried again; a double tap that is broken misses every time.
      let k8 = 0, k9 = 0;
      for (let tries = 0; tries < 3 && !(k9 > k8 * 1.5); tries++) {
        await fit.tap();
        await p.waitForTimeout(200);
        if (await p.locator('.sv-panel').count()) { await p.locator('.sv-panel .sv-close').tap(); await p.waitForTimeout(200); }
        k8 = await zoomOf(p);
        await touch('touchStart', [[a.x, a.y]]); await p.waitForTimeout(80); await touch('touchEnd', []); await p.waitForTimeout(90);
        await touch('touchStart', [[a.x, a.y]]); await p.waitForTimeout(80); await touch('touchEnd', []); await p.waitForTimeout(400);
        k9 = await zoomOf(p);
      }
      check(tag, `phone ${m}: a finger-paced double tap on a card zooms in`, k9 > k8 * 1.5, `${k8} -> ${k9}`);
      await fit.tap();
      await p.waitForTimeout(200);
    }
    // S-705: the − and + buttons zoom without a gesture, finger-sized, and a hold that raises Android's
    // contextmenu on a card opens no menu over the stage.
    const zb = await p.locator('.sv-zoom .btn').evaluateAll((bs) => bs.map((b) => [b.getAttribute('aria-label'), b.getBoundingClientRect().width, b.getBoundingClientRect().height]));
    check(tag, `phone ${m}: zoom − and + show, finger-sized`, zb.length === 2 && zb.every(([, w, h]) => w >= 44 && h >= 44), JSON.stringify(zb));
    const kz0 = await zoomOf(p);
    await p.locator('.sv-zoom .btn[aria-label="Zoom in"]').tap();
    await p.waitForTimeout(100);
    const kz1 = await zoomOf(p);
    await p.locator('.sv-zoom .btn[aria-label="Zoom out"]').tap();
    await p.waitForTimeout(100);
    check(tag, `phone ${m}: + zooms in by a step and − back out`, Math.abs(kz1 / kz0 - 1.5) < 0.05 && Math.abs((await zoomOf(p)) - kz0) < 0.01, `${kz0} -> ${kz1} -> ${await zoomOf(p)}`);
    const held = await p.evaluate(() => { const st = document.querySelector('.sv-stage').getBoundingClientRect(); for (const c of document.querySelectorAll('.sv-card[data-card]')) { const r = c.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2; if (x > st.left + 10 && x < st.right - 10 && y > st.top + 10 && y < st.bottom - 10 && document.elementFromPoint(x, y)?.closest('[data-card]')) return { x, y }; } return null; });
    if (held) {
      await touch('touchStart', [[held.x, held.y]]);
      await touch('touchMove', [[held.x + 12, held.y + 12]]);
      await p.evaluate(({ x, y }) => { window.__menu = 0; addEventListener('contextmenu', () => window.__menu++); document.elementFromPoint(x, y).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y })); }, held);
      await p.waitForTimeout(150);
      await touch('touchEnd', []);
      check(tag, `phone ${m}: a contextmenu under a finger on the stage opens no menu`, (await p.locator('.menu').count()) === 0 && (await p.evaluate(() => window.__menu)) === 0);
      await fit.tap();
      await p.waitForTimeout(200);
    }
    if (m === 'tree') {
      // A finger's drag pans the canvas sideways, and zooming out goes on until the whole tree fits, still in full cards.
      const x0 = await p.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector('.sv-world')).transform).e);
      const sb = await p.locator('.sv-stage').boundingBox(), py = sb.y + sb.height / 2;
      await touch('touchStart', [[sb.x + sb.width / 2 + 100, py]]);
      for (let i = 1; i <= 10; i++) { await touch('touchMove', [[sb.x + sb.width / 2 + 100 - i * 20, py]]); await p.waitForTimeout(16); }
      await touch('touchEnd', []);
      await p.waitForTimeout(100);
      const x1 = await p.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector('.sv-world')).transform).e);
      check(tag, 'phone tree: a finger drag pans the canvas sideways', x1 < x0 - 100 && (await sideways(p)) <= 0, `${x0} -> ${x1}`);
      await shot('phone-tree-panned');
      for (let i = 0; i < 14; i++) { await p.locator('.sv-zoom .btn[aria-label="Zoom out"]').tap(); await p.waitForTimeout(40); }
      await p.waitForTimeout(150);
      const wb = await p.locator('.sv-world').boundingBox();
      check(tag, 'phone tree: zooming out goes on until the whole tree fits, still in full cards', wb.x >= sb.x - 1 && wb.x + wb.width <= sb.x + sb.width + 1 && wb.y + wb.height <= sb.y + sb.height + 1 && (await p.locator('.sv-stage.far').count()) === 0 && (await p.locator('.sv-card .sv-chip:visible').count()) === 0, `${JSON.stringify(wb)} in ${JSON.stringify(sb)} at ${await zoomOf(p)}`);
      await shot('phone-tree-out');
      await fit.tap();
      await p.waitForTimeout(300);
    }
    if (m === 'cards') {
      // Panning down is a finger's drag; zooming out goes on until the whole layout fits (S-705).
      const y0 = await p.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector('.sv-world')).transform).f);
      const sb = await p.locator('.sv-stage').boundingBox(), px0 = sb.x + sb.width / 2;
      await touch('touchStart', [[px0, sb.y + sb.height - 60]]);
      for (let i = 1; i <= 10; i++) { await touch('touchMove', [[px0, sb.y + sb.height - 60 - i * 30]]); await p.waitForTimeout(16); }
      await touch('touchEnd', []);
      await p.waitForTimeout(100);
      const y1 = await p.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector('.sv-world')).transform).f);
      check(tag, 'phone cards: a finger drag pans down the column', y1 < y0 - 200 && (await sideways(p)) <= 0, `${y0} -> ${y1}`);
      for (let i = 0; i < 14; i++) { await p.locator('.sv-zoom .btn[aria-label="Zoom out"]').tap(); await p.waitForTimeout(40); }
      await p.waitForTimeout(150);
      const wb = await p.locator('.sv-world').boundingBox();
      check(tag, 'phone cards: zooming out goes on until the whole layout fits, still in full cards', wb.x >= sb.x - 1 && wb.x + wb.width <= sb.x + sb.width + 1 && wb.y + wb.height <= sb.y + sb.height + 1 && (await p.locator('.sv-stage.far').count()) === 0 && (await p.locator('.sv-card .sv-chip:visible').count()) === 0, `${JSON.stringify(wb)} in ${JSON.stringify(sb)} at ${await zoomOf(p)}`);
      // S-784: zoomed out, the one column no longer fills the width, so the top-level subtrees
      // pack side by side into it: the world is several columns wide, and its shape nears the pane's.
      const packedCols = Number(await p.locator('.sv-world').getAttribute('data-cols'));
      check(tag, 'phone cards: zoomed out, the subtrees pack side by side into the width', packedCols > 1, `${packedCols} columns`);
      await shot('phone-cards-out');
      await fit.tap();
      await p.waitForTimeout(300);
      check(tag, 'phone cards: Fit goes back to the one readable column', Number(await p.locator('.sv-world').getAttribute('data-cols')) === 1, await p.locator('.sv-world').getAttribute('data-cols'));
      await p.waitForTimeout(200);
    }
    // A double tap on the empty stage zooms in again, and opens nothing.
    await fit.tap();
    await p.waitForTimeout(200);
    const k2 = await zoomOf(p), at = await emptySpot(p);
    // Cards' column of full cards leaves no empty stage at the fit; the card double tap below covers it.
    if (m === 'stars') check(tag, `phone ${m}: there is empty stage to double-tap`, !!at);
    if (at) {
      await p.touchscreen.tap(at.x, at.y);
      await p.touchscreen.tap(at.x, at.y);
      await p.waitForTimeout(150);
      const k3 = await zoomOf(p);
      check(tag, `phone ${m}: a double tap zooms in`, Math.abs(k3 / k2 - 2) < 0.05 || k3 >= 1.99, `${k2} -> ${k3}`);
      check(tag, `phone ${m}: a double tap opens nothing`, (await p.locator('.sv-panel').count()) === 0);
      // At the most zoom a double tap goes back to the fit.
      for (let i = 0; i < 4 && (await zoomOf(p)) < 1.99; i++) { const q = await emptySpot(p); if (!q) break; await p.touchscreen.tap(q.x, q.y); await p.touchscreen.tap(q.x, q.y); await p.waitForTimeout(150); }
      const kMax = await zoomOf(p), q = await emptySpot(p);
      if (q) { await p.touchscreen.tap(q.x, q.y); await p.touchscreen.tap(q.x, q.y); await p.waitForTimeout(150); }
      check(tag, `phone ${m}: a double tap at the most zoom goes back to the fit`, kMax >= 1.99 && Math.abs((await zoomOf(p)) - k2) < 0.01, `${kMax} -> ${await zoomOf(p)}, fit ${k2}`);
    }
    // A double tap on a card low on the screen zooms, though its first tap opens the sheet there.
    await fit.tap();
    await p.waitForTimeout(200);
    const low = await p.evaluate((m) => {
      const st = document.querySelector('.sv-stage').getBoundingClientRect();
      for (const e of document.querySelectorAll(m === 'stars' ? '.sv-star[data-card] .sv-orb' : '.sv-card[data-card]')) {
        const r = e.getBoundingClientRect(), x = r.left + Math.min(r.width, 30) / 2, y = r.top + r.height / 2;
        if (y > st.top + st.height * 0.7 && y < st.bottom - 30 && x > st.left + 10 && x < st.right - 10 && document.elementFromPoint(x, y)?.closest('[data-card]') === e.closest('[data-card]')) return { x, y, id: e.closest('[data-card]').dataset.card };
      }
      return null;
    }, m);
    if (m !== 'tree') check(tag, `phone ${m}: there is a card low on the stage`, !!low);
    if (low) {
      const k4 = await zoomOf(p);
      await p.touchscreen.tap(low.x, low.y);
      await p.touchscreen.tap(low.x, low.y);
      await p.waitForTimeout(400);
      const k5 = await zoomOf(p);
      check(tag, `phone ${m}: a double tap on a card low on the stage zooms in and leaves no sheet`, Math.abs(k5 / k4 - 2) < 0.05 && (await p.locator('.sv-panel').count()) === 0, `${k4} -> ${k5}, ${await p.locator('.sv-panel').count()} sheet`);
    }
    await fit.tap();
    await p.waitForTimeout(200);
  }
  // The phone comes back in the mode last chosen on it.
  await p.reload();
  await p.waitForSelector('.sv[data-mode="stars"]');
  check(tag, 'phone: the mode last chosen on the phone comes back', true);
  await p.locator('.sv-modes button', { hasText: 'Tree' }).tap();
  await p.waitForSelector('.sv[data-mode="tree"]');
  check(tag, 'phone: Tree goes back to the Tree canvas, not an outline', (await p.locator('.sv.outline').count()) === 0 && (await p.locator('.sv-fit').count()) === 1);
  // S-784: the two-column option at Fit, an experiment (`&cardsCols=2`), off by default because two
  // columns of full cards fit 360 px only with names under 14 px. Fit fits their width inside the
  // stage's margin, so no card runs past the edge under the zoom buttons' corner.
  await p.evaluate(() => { location.hash = 'view=system&mode=cards&cardsCols=2'; });
  await p.waitForSelector('.sv[data-mode="cards"]');
  await p.waitForFunction(() => Number(document.querySelector('.sv-world')?.dataset.cols) === 2);
  await p.locator('.sv-fit').tap();
  await p.waitForTimeout(400);
  const two = await p.locator('.sv-world').boundingBox(), st3 = await p.locator('.sv-stage').boundingBox();
  check(tag, 'phone cards: the two-column option packs two columns inside the width at fit',
    Number(await p.locator('.sv-world').getAttribute('data-cols')) === 2 && two.x >= st3.x - 1 && two.x + two.width <= st3.x + st3.width + 1 && two.width > st3.width * 0.75, `${JSON.stringify(two)} in ${JSON.stringify(st3)} at ${await zoomOf(p)}`);
  await shot('phone-cards-2col');
  await p.evaluate(() => { location.hash = 'view=system&mode=tree'; });
  await p.waitForSelector('.sv[data-mode="tree"]');
}

// ---- Find and focus (S-540) ----
async function findAndFocus(p, tag, size, shot) {
  const card = (a) => p.locator(`.sv-card[data-card="${a.id}"]`);
  const tap = (l) => (size.phone ? l.tap() : l.click());
  const inStage = async (a) => {
    const [b, s] = [await card(a).boundingBox(), await p.locator('.sv-stage').boundingBox()];
    return !!b && b.x >= s.x - 1 && b.x + b.width <= s.x + s.width + 1 && b.y >= s.y - 1 && b.y + b.height <= s.y + s.height + 1;
  };
  // A card that just unfolded grows out of its parent: in the stage once it comes to rest.
  const settles = async (a) => { for (let i = 0; i < 20; i++) { if (await inStage(a)) return true; await p.waitForTimeout(150); } return false; };
  const box = () => p.locator('.sv-find input');
  // By name: the box (behind an icon on the phone), a result, and the pick shows the card.
  await tap(p.locator('.sv-find-btn'));
  const target = by('storage-ops-dev2');
  await box().fill('storage dev2');
  await p.waitForSelector('[data-found]');
  check(tag, 'search finds an agent by name', (await p.locator('[data-found]').first().getAttribute('data-found')) === target.id);
  if (!size.phone) {
    // The open box takes the instruments' room, not the mode switch's or Fit's.
    const free = await p.evaluate(() => [...document.querySelectorAll('.sv-modes button, .sv-fit')].every((b) => { const r = b.getBoundingClientRect(); const h = document.querySelector('.sv-head').getBoundingClientRect(); return r.width > 0 && r.right <= h.right && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button') === b; }));
    check(tag, 'the open find box leaves the mode switch and Fit in view', free);
  }
  await shot('search');
  await box().press('Enter');
  await p.waitForSelector('.sv-panel');
  await p.waitForTimeout(300);
  check(tag, 'a pick opens its card and shows it', (await card(target).count()) === 1 && await settles(target), JSON.stringify(await card(target).boundingBox()));
  await p.locator('.sv-panel .sv-close').click();
  // By ITSA key: one in a team that is folded first, so the pick has to unfold it (S-705: managers start open).
  const deep = by('cost-dev3');
  // Bring cost near first: a search pick zooms to its card, and the fold buttons mount only near in (on the desktop too).
  const team = by('cost');
  await tap(p.locator('.sv-find-btn'));
  await box().fill(team.name);
  await p.waitForSelector(`[data-found="${team.id}"]`);
  await tap(p.locator(`[data-found="${team.id}"]`));
  await p.waitForSelector('.sv-panel');
  await p.locator('.sv-panel .sv-close').click();
  await reach(p, size, team.id);
  await p.waitForSelector(`[data-fold="${team.id}"]`);
  await p.evaluate((id) => document.querySelector(`[data-fold="${id}"]`).click(), team.id);
  await p.waitForSelector(`.sv-card[data-card="${deep.id}"]`, { state: 'detached' });
  await tap(p.locator('.sv-find-btn'));
  await box().fill(itsaOf(deep).key);
  await p.waitForSelector(`[data-found="${deep.id}"]`);
  check(tag, 'search finds an agent by its ITSA key', (await p.locator('[data-found]').first().getAttribute('data-found')) === deep.id);
  await tap(p.locator(`[data-found="${deep.id}"]`));
  await p.waitForSelector(`.sv-card[data-card="${deep.id}"]`);
  await p.waitForTimeout(300);
  check(tag, 'a pick unfolds its ancestors', await settles(deep), JSON.stringify([await card(deep).boundingBox(), await p.locator('.sv-stage').boundingBox(), await p.locator('.sv-stage').evaluate((e) => e.scrollTop)]));
  await p.locator('.sv-panel .sv-close').click();
  // Focus: a manager's team alone, the rest folded; Esc (or the chip) brings the tree back.
  const mgr = by('cost'), other = by('voice-dev1');
  await reach(p, size, mgr.id);
  await tap(card(mgr));
  await p.locator('.sv-links .btn', { hasText: 'Focus' }).click();
  await p.waitForSelector('.sv[data-focus]');
  await p.waitForTimeout(400);
  check(tag, 'focus shows the manager\'s team', (await card(by('cost-dev1')).count()) === 1 && await settles(mgr));
  check(tag, 'focus folds the rest', (await card(other).count()) === 0 && Number(await p.locator('.sv-world').getAttribute('data-laid')) < 30);
  await shot('focus');
  if (size.phone) await p.locator('.sv-focus').tap();
  else await p.keyboard.press('Escape');
  await p.waitForSelector('.sv[data-focus]', { state: 'detached' });
  check(tag, size.phone ? 'the chip leaves the focus' : 'Esc leaves the focus', true);
  await p.waitForTimeout(300);
}

// ---- The run ----
// On the phone the Tree opens at a readable zoom, so a card off the screen isn't mounted until the canvas
// is panned to it (useScale): drag the stage with a finger until the card shows, as a person would
// (S-1067), before a tap or a read that needs it. A no-op on the desktop, which fits the whole tree.
const touchers = new WeakMap();
const reach = async (p, size, id, ...more) => {
  if (!size.phone) return
  const ids = [id, ...more];
  const sel = `.sv-card[data-card="${id}"]`
  let cdp = touchers.get(p);
  if (!cdp) touchers.set(p, (cdp = await p.context().newCDPSession(p)));
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i })) });
  // Zoomed out twice at most: past that the cards draw flat, with no rolling numbers to read.
  let outs = 0, settled = false;
  for (let i = 0; i < 40 && !settled; i++) {
    // The cards' box on screen against the stage: inside it with a margin, or the drag that centres it, or too big (zoom out).
    const d = await p.evaluate((ids) => {
      const g = window.stamDebug.systemDeck.geo, st = document.querySelector('.sv-stage').getBoundingClientRect();
      const m = new DOMMatrix(getComputedStyle(document.querySelector('.sv-world')).transform);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const id of ids) { const q = g.laid.pos.get(id); x0 = Math.min(x0, st.x + m.e + q.x * m.a); y0 = Math.min(y0, st.y + m.f + q.y * m.a); x1 = Math.max(x1, st.x + m.e + (q.x + q.w) * m.a); y1 = Math.max(y1, st.y + m.f + (q.y + g.cardH) * m.a); }
      const pad = 16;
      if (x0 > st.left + pad && x1 < st.right - pad && y0 > st.top + pad && y1 < st.bottom - pad) return null;
      const big = x1 - x0 > st.width - 2 * pad - 60 || y1 - y0 > st.height - 2 * pad - 60;
      return { big, dx: st.x + st.width / 2 - (x0 + x1) / 2, dy: st.y + st.height / 2 - (y0 + y1) / 2, cx: st.x + st.width / 2, cy: st.y + st.height / 2, sw: st.width, sh: st.height };
    }, ids);
    if (!d) break;
    if (d.big && ids.length > 1 && outs < 2) { outs++; await p.locator('.sv-zoom .btn[aria-label="Zoom out"]').tap(); await p.waitForTimeout(60); continue; }
    if (d.big) settled = true;
    // One drag moves the stage by at most a half of its size each way.
    const dx = Math.max(-d.sw / 2, Math.min(d.sw / 2, d.dx)), dy = Math.max(-d.sh / 2, Math.min(d.sh / 2, d.dy));
    await touch('touchStart', [[d.cx - dx / 2, d.cy - dy / 2]]);
    for (let s = 1; s <= 6; s++) await touch('touchMove', [[d.cx - dx / 2 + dx * s / 6, d.cy - dy / 2 + dy * s / 6]]);
    await touch('touchEnd', []);
    await p.waitForTimeout(30);
  }
  // Chromium drops the click of the first tap after a drag sent through a second session: a tap on the header's
  // bare strip, which nothing answers, takes that.
  const bare = await p.evaluate(() => { const h = document.querySelector('.sv-head').getBoundingClientRect(); for (let x = h.right - 3; x > h.left; x -= 9) { const y = h.top + 2; if (document.elementFromPoint(x, y)?.classList.contains('sv-head')) return { x, y }; } return null; });
  if (bare) await p.touchscreen.tap(bare.x, bare.y);
  await p.waitForSelector(sel, { state: 'attached' });
}
const browser = await chromium.launch(chromiumLaunchOptions());
const SIZES = [{ name: '360', w: 360, h: 740, phone: true }, { name: '430', w: 430, h: 860, phone: true }, { name: '1440', w: 1440, h: 900 }, { name: '1920', w: 1920, h: 1080 }];
let failed = 0;
const check = (tag, name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} [${tag}] ${name}${detail ? ': ' + String(detail).slice(0, 300) : ''}`); };

// ---- Budgets (S-540, from S-462) ----
// One run per state of the folds, on the desktop: the first paint after the data arrives, frame
// rate while panning and zooming, script time per frame while 24 sheets fly, the most cards
// mounted at once, and the JS heap after a collection.
const BUDGETS = [['First paint after data', 'paint', 300, 'ms', 'max'], ['Pan and zoom', 'fps', 60, 'fps', 'min'], ['Script per frame, zooming', 'zscript', 8, 'ms', 'max'], ['Script per frame, 24 flights', 'script', 4, 'ms', 'max'],
  ['Cards mounted, reading zoom', 'cards', 120, '', 'max'], ['JS heap', 'heap', 40, 'MB', 'max']];
// Frame rate is met within a frame's rounding: 57 fps and up reads as 60.
const FPS_SLACK = 3;
async function budgets() {
  const managers = [...new Set(agents.flatMap((a) => a.parents))];
  const runs = [];
  for (const [mode, folds] of [['tree', 'as they start'], ['tree', 'all unfolded'], ['cards', 'as they start'], ['cards', 'all unfolded']]) {
    const was = await api('/api/layout');
    await api('/api/layout/ops', 'POST', { ops: [...Object.keys(was.agentWorlds).map((world) => ({ op: 'dropWorld', world })), { op: 'current', world: null }] });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    await ctx.route(`${origin}/api/**`, (route) => {
      const hit = route.request().method() === 'GET' ? ROUTES[new URL(route.request().url()).pathname + new URL(route.request().url()).search] : undefined;
      return hit ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(hit) }) : route.continue();
    });
    await ctx.addInitScript(({ mode, open }) => {
      try { localStorage.setItem('stam/theme', 'light'); localStorage.setItem('stam/system-mode', mode); if (open) localStorage.setItem('stam/system-folds', JSON.stringify({ wide: open })); } catch {}
      // When the agents and ITSAs arrive, and when the first card is painted after them.
      const of = window.fetch;
      window.__sv = { data: 0, paint: 0, frames: [], max: 0, on: false };
      window.fetch = (...args) => of(...args).then((r) => { if (/\/api\/(agents|itsas)$/.test(new URL(r.url).pathname)) window.__sv.data = Math.max(window.__sv.data, performance.now()); return r; });
      new MutationObserver((_, o) => {
        if (!document.querySelector('.sv-card')) return;
        o.disconnect();
        requestAnimationFrame(() => { const c = new MessageChannel(); c.port1.onmessage = () => { window.__sv.paint = performance.now(); }; c.port2.postMessage(0); });
      }).observe(document, { childList: true, subtree: true });
      const loop = (t) => { const s = window.__sv; if (s.on) { s.frames.push(t); s.max = Math.max(s.max, document.getElementsByClassName('sv-card').length); } requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    }, { mode, open: folds === 'all unfolded' ? Object.fromEntries(managers.map((id) => [id, false])) : null });
    const p = await ctx.newPage();
    p.setDefaultTimeout(15000);
    p.on('pageerror', (e) => check('budget', 'no page errors', false, e.message));
    const cdp = await ctx.newCDPSession(p);
    await cdp.send('Performance.enable');
    const metric = async (name) => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === name).value;
    await p.goto(base.replace(/#/, '#view=system&'));
    await p.waitForFunction(() => window.__sv.paint > 0);
    const r = { folds: `${mode}, ${folds}`, laid: 0 };
    r.paint = await p.evaluate(() => window.__sv.paint - window.__sv.data);
    await p.waitForTimeout(1000);
    r.laid = Number(await p.locator('.sv-world').getAttribute('data-laid'));
    // Pan and zoom: zoomed in to read the cards, a drag across the tree, then wheel in and out.
    const record = (on) => p.evaluate((on) => { Object.assign(window.__sv, on ? { on, frames: [], max: 0 } : { on }); return on ? null : { frames: window.__sv.frames, max: window.__sv.max }; }, on);
    await p.mouse.move(720, 300);
    for (let i = 0; i < 6; i++) { await p.mouse.wheel(0, -200); await p.waitForTimeout(40); }
    await p.waitForTimeout(300);
    await record(true);
    await p.mouse.down();
    for (let i = 0; i < 90; i++) { await p.mouse.move(720 + (i < 45 ? -i * 14 : (i - 90) * 14), 300 + (i < 45 ? i * 4 : (90 - i) * 4)); await p.waitForTimeout(16); }
    await p.mouse.up();
    const pan = await record(false);
    // Then out to the least zoom and back, where every card in the stage is mounted however many.
    const z0 = await metric('ScriptDuration');
    await record(true);
    // All the way out (Cards' least zoom fits the whole layout), then back.
    for (let i = 0; i < 40; i++) { await p.mouse.wheel(0, i < 20 ? 300 : -300); await p.waitForTimeout(32); }
    const zoom = await record(false);
    r.zscript = ((await metric('ScriptDuration')) - z0) * 1000 / Math.max(1, zoom.frames.length);
    const gapsOf = (f) => f.slice(1).map((t, i) => t - f[i]);
    const gaps = [...gapsOf(pan.frames), ...gapsOf(zoom.frames)];
    const pz = { max: pan.max };
    r.cardsOut = zoom.max;
    r.fps = gaps.length ? 1000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length) : 0;
    r.slow = gaps.filter((g) => g > 1000 / 60 * 1.5).length;
    r.frames = gaps.length;
    r.cards = pz.max;
    // 24 sheets in the air: script time over the frames until they land.
    await p.click('.sv-fit');
    await p.waitForTimeout(500);
    const all = agents.filter((a) => a.lifecycle === 'active' && a !== cos);
    const s0 = await metric('ScriptDuration');
    await record(true);
    const flying = await burst(p, sentEvents(cos, all));
    await p.waitForSelector('.sv-fly', { state: 'detached', timeout: 15000 });
    const fl = await record(false);
    r.script = ((await metric('ScriptDuration')) - s0) * 1000 / Math.max(1, fl.frames.length);
    r.flying = flying;
    r.cardsOut = Math.max(r.cardsOut, fl.max);
    await cdp.send('HeapProfiler.collectGarbage');
    r.heap = (await metric('JSHeapUsedSize')) / 1048576;
    runs.push(r);
    await ctx.close();
  }
  const met = (b, v) => (b[1] === 'fps' ? v >= b[2] - FPS_SLACK : v <= b[2]);
  const fmt = (b, v) => (b[1] === 'fps' || b[1] === 'cards' ? String(Math.round(v)) : v.toFixed(1)) + (b[3] ? ' ' + b[3] : '');
  console.log(`\nBudgets at ${agents.length} agents, desktop 1440 light (${runs.map((r) => `${r.folds}: ${r.laid} cards laid out`).join('; ')})`);
  console.log(`| Budget | Target | ${runs.map((r) => r.folds).join(' | ')} |`);
  console.log(`|---|---|${runs.map(() => '---|').join('')}`);
  for (const b of BUDGETS) console.log(`| ${b[0]} | ${b[4] === 'min' ? '≥' : b[1] === 'cards' ? '≤' : '<'} ${b[2]}${b[3] ? ' ' + b[3] : ''} | ${runs.map((r) => `${fmt(b, r[b[1]])} ${met(b, r[b[1]]) ? '✓' : '✗'}`).join(' | ')} |`);
  console.log(runs.map((r) => `${r.folds}: ${r.frames} frames while panning and zooming, ${r.slow} over 25 ms; ${r.cardsOut} cards mounted at the least zoom; ${r.flying} sheets in the air`).join('\n') + '\n');
  for (const r of runs) for (const b of BUDGETS) check('budget', `${b[0]} (${r.folds})`, met(b, r[b[1]]), fmt(b, r[b[1]]));
}
if (budget) await budgets();

for (const size of SIZES) for (const theme of ['light', 'dark']) {
  const tag = `${size.name}-${theme}`;
  if (budget || (only && only !== tag)) continue;
  agents.forEach((a, i) => { a.unread = UNREAD0[i]; });
  const was = await api('/api/layout');
  await api('/api/layout/ops', 'POST', { ops: [...Object.keys(was.agentWorlds).map((world) => ({ op: 'dropWorld', world })), { op: 'current', world: null }] });
  const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h }, colorScheme: theme, isMobile: !!size.phone, hasTouch: !!size.phone, deviceScaleFactor: size.phone ? 2 : 1 });
  await ctx.route(`${origin}/api/**`, (route) => {
    const p = new URL(route.request().url()).pathname + new URL(route.request().url()).search
    const hit = route.request().method() === 'GET' ? ROUTES[p] : undefined;
    return hit ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(hit) }) : route.continue();
  });
  await ctx.addInitScript((t) => { try { localStorage.setItem('stam/theme', t); } catch {} }, theme);
  // The laid-out cards inside the stage, as drawn now, that aren't in the page (culled when they show).
  await ctx.addInitScript(() => {
    window.__svHoles = () => {
      const g = window.stamDebug.systemDeck.geo, st = document.querySelector('.sv-stage').getBoundingClientRect();
      const m = new DOMMatrix(getComputedStyle(document.querySelector('.sv-world')).transform);
      const out = [];
      for (const [id, q] of g.laid.pos) {
        const x = st.x + m.e + q.x * m.a, y = st.y + m.f + q.y * m.a, r = x + q.w * m.a, b = y + g.cardH * m.a;
        if (r > st.left && x < st.right && b > st.top && y < st.bottom && !document.querySelector(`.sv-card[data-card="${id}"]`)) out.push(id);
      }
      return out;
    };
  });
  // Cards chosen on a wider screen: the phone keeps its own choice, and opens on the Tree (S-606, S-1067).
  if (size.phone) await ctx.addInitScript(() => { try { localStorage.setItem('stam/system-mode', 'cards'); } catch {} });
  if (frames) await ctx.addInitScript(() => document.addEventListener('DOMContentLoaded', () => document.documentElement.style.setProperty('--duration-slow', '2200ms')));
  const p = await ctx.newPage();
  p.setDefaultTimeout(8000);
  p.on('pageerror', (e) => check(tag, 'no page errors', false, e.message));
  const shot = async (step) => { await p.waitForTimeout(500); await p.screenshot({ path: `${out}/${step}-${tag}.png` }); };
  await p.goto(base.replace(/#/, '#view=system&'));
  try {
    await p.waitForSelector('.sv-card[data-card]');
    await p.waitForTimeout(300);
    const cards = await p.locator('.sv-card[data-card]').count();
    // The cards laid out, culled or not.
    const laid = Number(await p.locator('.sv-world').getAttribute('data-laid'));
    const total = agents.filter((a) => a.lifecycle === 'active' || a.lifecycle === 'paused').length + 1;
    // Every manager starts open, at any size and on the phone (S-705): every agent is laid out.
    check(tag, 'no manager starts folded', (await p.locator('[data-fold][aria-expanded="false"]').count()) === 0);
    if (size.phone) check(tag, 'the phone Tree starts with every agent laid out', laid === total, `${laid} laid out`);
    else if (total > 61) check(tag, 'past 60 agents every agent is still laid out', laid === total, `${laid} laid out of ${total}`);
    else check(tag, 'every agent has a card, plus the human', cards === total, `${cards} of ${total}`);
    check(tag, 'only the cards near the view mount', cards <= laid && cards <= 120, `${cards} of ${laid}`);
    check(tag, 'a wire per shown child', (await p.locator('.sv-wire').count()) === laid - 1);
    const cosCard = p.locator(`.sv-card[data-card="${cos.id}"]`);
    // Zoomed out, a card draws only its chip (S-462): the ITSA is the chip's second row.
    const far0 = (await p.locator('.sv-stage.far').count()) > 0;
    check(tag, 'a card shows its ITSA', /S-\d+/.test(await cosCard.locator(far0 ? '.sv-chip .c2' : '.sv-r2').textContent()));
    if (!size.phone) {
      // Zoomed out to the far chips, if the fit isn't already, then back to the fit.
      for (let i = 0; i < 20 && !(await p.locator('.sv-stage.far').count()); i++) { await p.mouse.move(size.w / 2 + 150, size.h / 2); await p.mouse.wheel(0, 200); await p.waitForTimeout(40); }
      check(tag, 'zoomed out, the cards are far', (await p.locator('.sv-stage.far').count()) === 1);
      check(tag, 'a far card draws only its chip, not its hidden rows', (await p.locator('.sv-card[data-card] > .sv-r2').count()) === 0);
      if (!far0) { await p.click('.sv-fit'); await p.waitForFunction(() => !document.querySelector('.sv-stage.far')); }
    }
    if (!far0) check(tag, 'a card shows the Work columns as badges', (await p.locator('.sv-r3 .badge').count()) > 0);
    check(tag, 'unread stacks', (await cosCard.locator('.sv-stack .sheet').count()) === 4);
    await shot('system');
    await flights(p, tag, size, theme, shot);
    await motion(p, tag, size, theme);
    if (!size.phone) {
      check(tag, 'header meters', (await p.locator('.sv-meter').count()) === 3);
      check(tag, 'every mode is enabled', (await p.locator('.sv-modes button:disabled').count()) === 0);
      const box0 = await p.locator('.sv-world').boundingBox();
      check(tag, 'fit shows the whole tree', box0.width <= size.w && box0.height <= size.h, JSON.stringify(box0));
      await shot('fit');
      // At the fit zoom siblings' chips tell them apart (S-572): each drops its parent's words, and
      // none is cut.
      if (await p.locator('.sv-stage.far').count()) {
        const names = await p.evaluate(() => Object.fromEntries([...document.querySelectorAll('.sv-card[data-card] .sv-chip b')].map((b) => [b.closest('[data-card]').dataset.card, { t: b.textContent, cut: b.scrollWidth > b.clientWidth + 1 }])));
        const groups = new Map();
        for (const a of agents) if (names[a.id] && a.parents[0]) groups.set(a.parents[0], [...(groups.get(a.parents[0]) ?? []), names[a.id]]);
        const bad = [...groups.values()].filter((g) => new Set(g.map((x) => x.t)).size !== g.length);
        check(tag, 'at fit, siblings\' names differ', bad.length === 0, JSON.stringify(bad.slice(0, 2)));
        // A shortened name is short enough to show whole; a top-level name may still be cut where
        // its chip has no more room to grow.
        const cut = agents.filter((a) => names[a.id]?.cut && names[a.id].t !== a.name).map((a) => names[a.id].t);
        check(tag, 'at fit, no shortened name is cut', cut.length === 0, cut.join(' '));
        const grown = await p.evaluate(() => [...document.querySelectorAll('.sv-card[data-card] .sv-chip')].filter((c) => c.getBoundingClientRect().width > c.closest('.sv-card').getBoundingClientRect().width + 1).length);
        console.log(`     [${tag}] chips grown to fit: ${grown}`);
        check(tag, 'at fit, a child drops its parent\'s words', names[by('system-view-dev3').id]?.t === 'dev3' && names[by('cost-review').id]?.t === 'review', JSON.stringify([names[by('system-view-dev3').id], names[by('cost-review').id]]));
      }
      await p.mouse.move(size.w / 2, size.h / 2);
      await p.mouse.wheel(0, -600);
      await p.waitForTimeout(100);
      const box1 = await p.locator('.sv-world').boundingBox();
      check(tag, 'the wheel zooms in', box1.width > box0.width * 1.5, `${box0.width} -> ${box1.width}`);
      await shot('zoomed');
      const sb = await p.locator('.sv-stage').boundingBox();
      const centre = async () => p.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
      await p.click('.sv-fit');
      // From zoomed in, where most cards were culled, Fit brings every card in view at once (S-540):
      // on the next frame each laid-out card inside the stage is in the page.
      const holes = await p.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(window.__svHoles()))));
      check(tag, 'after Fit every card in view is mounted on the next frame', holes.length === 0, holes.join(' '));
      await centre();
      // A wheel's zoom mounts what it brings into view in the frame it draws (S-462): the view zooms
      // in its own frame callback, so one asked for after the wheel sees the zoom and the cards.
      const wheelHoles = await p.evaluate(({ x, y }) => new Promise((done) => {
        document.querySelector('.sv-stage').dispatchEvent(new WheelEvent('wheel', { deltaY: 800, clientX: x, clientY: y, bubbles: true, cancelable: true }));
        requestAnimationFrame(() => done(window.__svHoles()));
      }), { x: sb.x + sb.width / 2, y: sb.y + sb.height / 2 });
      check(tag, 'a wheel zoom mounts every card it shows in the same frame', wheelHoles.length === 0, wheelHoles.join(' '));
      await p.waitForSelector('.sv-stage.far');
      check(tag, 'far zoom shows marks and names', await p.locator('.sv-stage.far').count() === 1);
      // The chip's name draws at screen size, however far out.
      const nameBox = await p.locator(`.sv-card[data-card="${cos.id}"] .sv-chip b`).boundingBox();
      check(tag, 'far chips stay readable', nameBox && nameBox.height >= 14, JSON.stringify(nameBox));
      await shot('far');
      await p.click('.sv-fit');
      // Close enough to read the cards, for the fold and the panel.
      await centre();
      for (let i = 0; i < 8 && await p.locator('.sv-stage.far').count(); i++) { await p.mouse.wheel(0, -200); await p.waitForTimeout(50); }
      // Zoomed in to read, every card draws its rows again.
      await p.waitForSelector('.sv-stage:not(.far) .sv-card[data-card] .sv-r3 .badge');
      check(tag, 'a card shows the Work columns as badges', (await p.locator('.sv-r3 .badge').count()) > 0);
    }
    // A manager's fold.
    const mgr = by('its');
    // Every manager starts open (S-705): the fold chip folds it, and a second tap unfolds it.
    if (size.phone) {
      await reach(p, size, mgr.id);
      await p.locator(`[data-fold="${mgr.id}"]`).tap();
            await p.waitForSelector(`.sv-card[data-card="${by('its-dev1').id}"]`, { state: 'detached' });
      check(tag, 'a tap on the fold chip folds a manager', true);
      await shot('folded');
      await p.locator(`[data-fold="${mgr.id}"]`).tap();
      await p.waitForSelector(`.sv-card[data-card="${by('its-dev1').id}"]`);
      check(tag, 'a tap on +N unfolds a manager', true);
      await shot('unfolded');
    } else {
      await p.locator(`.sv-card[data-card="${mgr.id}"]`).hover();
      await p.locator(`[data-fold="${mgr.id}"]`).click();
      await p.waitForSelector(`.sv-card[data-card="${by('its-dev1').id}"]`, { state: 'detached' });
      check(tag, 'folding hides a manager\'s agents', true);
      await shot('folded');
      await p.locator(`[data-fold="${mgr.id}"]`).click();
      await p.waitForSelector(`.sv-card[data-card="${by('its-dev1').id}"]`);
      check(tag, 'unfolding brings a manager\'s agents back', true);
      if (frames) {
        for (const step of ['fold', 'unfold']) {
          // Clicked in the page: Playwright's click returns well after the motion has started.
          await p.evaluate((id) => document.querySelector(`[data-fold="${id}"]`).click(), mgr.id);
          for (const i of [1, 2, 3]) { await p.waitForTimeout(250); await p.screenshot({ path: `${out}/${step}-${i}-${tag}.png`, clip: { x: 560, y: 220, width: 900, height: 620 } }); }
          await p.waitForTimeout(2500);
        }
      }
    }
    // The panel.
    const dev = by(size.phone ? 'its' : 'its-dev2');
    const c = p.locator(`.sv-card[data-card="${dev.id}"]`);
    if (size.phone) { await reach(p, size, dev.id); await c.tap() } else await c.click();
    await p.waitForSelector('.sv-panel');
    check(tag, size.phone ? 'a tap opens the bottom sheet' : 'a click opens the side panel', (await p.locator('.sv-panel.sheet').count()) === (size.phone ? 1 : 0));
    check(tag, 'the panel lists the Work columns', (await p.locator('.sv-facts [data-col]').count()) >= 5);
    await shot('panel');
    await p.locator('.sv-panel .sv-close').click();
    check(tag, 'the panel closes', (await p.locator('.sv-panel').count()) === 0);
    await findAndFocus(p, tag, size, shot);
    // Click-through: the agent's world.
    if (size.phone) { await reach(p, size, dev.id); await c.tap() } else await c.click();
    await p.locator('.sv-links .btn', { hasText: 'Open its world' }).click();
    await p.waitForFunction((id) => window.stamDebug.shell.currentWorld() === id, dev.id);
    check(tag, 'Open its world goes to the agent', true);
    if (!size.phone) {
      await p.evaluate(() => window.stamDebug.shell.showAgentWorld('w:system'));
      await p.waitForSelector('.sv-card[data-card]');
      await cardsMode(p, tag, size, theme, shot);
      await starsMode(p, tag, size, theme, shot);
    } else {
      await p.evaluate(() => window.stamDebug.shell.showAgentWorld('w:system'));
      await p.waitForSelector('.sv-card[data-card]');
      await phoneModes(p, tag, size, theme, shot);
    }
  } catch (e) {
    check(tag, 'flow', false, e.message.split('\n')[0]);
    await p.screenshot({ path: `${out}/error-${tag}.png` }).catch(() => {});
  }
  await ctx.close();
}
await browser.close();
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
