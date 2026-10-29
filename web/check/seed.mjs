// Sends the human mails that cover every mail component, as the agent given: node seed.mjs URL TOKEN AGENT_ID
// (a test daemon only). Bodies match the parity test's (web/src/mail/mailblocks.test.ts).
import { deflateSync } from 'node:zlib';
const [url, token, from] = process.argv.slice(2);
// A request that names an agent (from, by or agent) goes with that agent's own token (SEED_AGENT_TOKENS, keyed
// by the name or id the seed uses): the shared token can't act as an agent that has one (S-545).
const agentTokens = JSON.parse(process.env.SEED_AGENT_TOKENS || '{}');
const api = async (method, path, body) => {
  const own = agentTokens[body?.from ?? body?.by ?? body?.agent];
  const r = await fetch(url + path, { method, headers: { authorization: 'Bearer ' + (own || token), 'content-type': 'application/json', 'x-stam-human': '1', ...(process.env.STAM_TEST_HUMAN_KEY ? { 'x-stam-test-human': process.env.STAM_TEST_HUMAN_KEY } : {}) }, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: ${JSON.stringify(j)}`);
  return j;
};
const F = '```', E = '\x1b';
// A Markdown table twelve columns wide with long cells: too wide for a phone, so it scrolls in its message.
const wideHead = Array.from({ length: 12 }, (_, i) => `Column ${i + 1}`);
const wideRows = [0, 1, 2].map((r) => Array.from({ length: 12 }, (_, i) => `Row ${r + 1}, cell ${i + 1}: a long line of text that does not wrap`));
const wideTable = [`| ${wideHead.join(' | ')} |`, `| ${wideHead.map(() => '---').join(' | ')} |`, ...wideRows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
const mails = [
  ['Check: decisions and callouts', `TLDR: Pick the token lifetime.

> [!BLOCKED]
> The full run waits on your answer below.

${F}decision
How long should SSO tokens live?
- 1 hour: safest, users re-login daily (recommended)
- **12 hours** — one login per workday
- Never
${F}

${F}yesno
Run the full e2e suite for about $14? (recommended: yes)
${F}

${F}pick
Which checks?
- Lint: fast (recommended)
- Types
- E2E: slow
${F}

${F}rank
Order the work
- Auth: first
- Billing
- Search (recommended)
${F}

> [!DONE]
> Merged **and** deployed.

> [!NOTE]
> Plain note with @helper, and mail m3228ca5.`],
  ['Check: metrics, tables, checklist', `${F}metrics
Tests: 214/214 — all green [success]
Spent: $0.42
Latency: 1.2 s [warning]
${F}

${F}table
title: Agents
name,tokens,cost
lead,"1,200",$1.50 [success]
builder,300,$0.20 [error]
plain,—,-
${F}

${F}csv
n,v
${Array.from({ length: 25 }, (_, i) => `r${i},${i * 3}`).join('\n')}
${F}

${F}checklist
- [x] done thing
- [~] in progress
- [ ] next
- [!] blocked
- [-] skipped
${F}

${F}progress
3/5 Build
60% Review
${F}

${F}timeline
10:02 — started
10:09 | built [success]
10:15 deploy failed [error]
${F}`],
  ['Check: diff, tests, error, spend, terminal', `${F}diff
diff --git a/src/config.ts b/src/config.ts
--- a/src/config.ts
+++ b/src/config.ts
@@ -11,9 +11,13 @@ export const MACHINE
+// Private to the user
 export function agentDir(id: string): string {
-  mkdirSync(dir, { recursive: true });
+  mkdirSync(dir, { recursive: true, mode: 0o700 });
 }
${F}

${F}tests
18 passed
FAIL e2e-codex > spawns
  exited 1: refusing
  at test/e2e-codex.sh:41
PASS e2e-m2 > mails
SKIP later
${F}

${F}error
Message: codex app-server: refusing
Where: \`config.ts\`
Cause: mode 0775.
Fix: use 0700.
${F}

${F}spend
For: Codex e2e
Spent: $4.20
Budget: $10
Estimate: $14
${F}

${F}terminal
$ stat -c '%a %n' agents
${E}[33m775${E}[0m agents
${E}[1;32mquick${E}[0m ${E}[2m(3.1s)${E}[0m
${F}

${F}ts
const x = 1;
${F}`],
  ['Check: charts, math, diagram, embeds, pane', `${F}chart
type: bar
title: Usage
unit: $
Week,Claude Code,Codex
W1,1.5,2
W2,3,1
${F}

${F}chart
type: donut
Model,Spend
opus,3
haiku,1
${F}

Inline \\(a^2+b^2\\) and price $5.

$$
E = mc^2
$$

${F}mermaid
graph TD; A-->B; B-->C
${F}

${F}embed
https://youtu.be/dQw4w9WgXcQ
A video
${F}

${F}pane
helper
${F}

<details><summary>More</summary>

Hidden **text**

</details>`],
  ['Check: S-4 review notes', `TLDR: S-4 is ready for review; S-2 is done.

Read S-4 first, then S-2. \`S-4\` in code stays plain, and so does S-999, which no ITSA has.

${F}
S-4 in a code block is not linked
${F}`],
  ['Check: archive me', ['TLDR: This thread only exists for the archive checks. Nothing to answer here.', ...Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}: long enough that the thread scrolls under the top bar, so the Archive check can see it stay put.`)].join('\n\n')],
  ['Check: a wide table', `TLDR: This table is twelve columns wide, so it scrolls sideways inside its message.\n\n${wideTable}`],
  ['Check: merged PRs', `TLDR: Six PRs merged this week; the tables keep their columns and scroll sideways.\n\n| PR | Title | Author | Status | Merged | Tests | Branch |\n| --- | --- | --- | --- | --- | --- | --- |\n| #118 | Trust a shared-token system sender in both modes | kid | merged | 2026-10-12 | 214 passed | stam/system-sender |\n| #119 | Match as_system on ITSA routes and system on mail only | kid | merged | 2026-10-12 | 214 passed | stam/system-routes |\n| #122 | Retry failed fetches with a backoff in the mail sync | intake | merged | 2026-10-13 | 221 passed | stam/fetch-retry |\n| #123 | Mail flow fix for queued replies to offline peers | mail-fixes | merged | 2026-10-13 | 223 passed | stam/mail-flow-fix |\n| #124 | Human auth on the CLI for system-level writes | wide-tables | merged | 2026-10-13 | 225 passed | stam/human-auth-cli-system |\n| #128 | Ignore node_modules in every worktree and the root | cos | merged | 2026-10-14 | 225 passed | stam/gitignore-node-modules |`],
  ['Check: your mail rules', `TLDR: Seed data for the mail-rules mark.

MAILCHECK:NO Hello there! I hope this message finds you well. I just wanted to reach out and give you a long, rambling preamble before eventually, maybe, getting to a point. Apologies for the length.`],
];
// Mail to the human comes from kid, which runs a model that may mail the human; the helper runs
// claude-haiku-5-5, which may not (Settings › Mail to you), and the tooltip checks read its model.
for (const [subject, body] of mails) await api('POST', '/api/mail', { from: 'kid', to: ['human'], subject, body, new_thread: true });
// A mail the sender sent past the mail gate (S-983): the header shows a mark with the reason.
await api('POST', '/api/mail', { from: 'kid', to: ['human'], subject: 'Check: gate override', body: 'TLDR: Seed data for the override mark.', new_thread: true, override: 'You asked to hear about every restart.' });
// A real image to tap in the viewer checks (S-86): a gradient PNG built here, so no binary
// lives in the repo, shown as an embed, a before/after compare, and an unused attachment.
const pngBase64 = (W, H, alt = false) => {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; for (let x = 0; x < W; x++) { const o = y * (W * 3 + 1) + 1 + x * 3; raw[o] = alt ? 210 - (120 * x / W | 0) : 70 + (120 * x / W | 0); raw[o + 1] = alt ? 120 + (80 * y / H | 0) : 90 + (90 * y / H | 0); raw[o + 2] = alt ? 60 + (120 * x / W | 0) : 180 - (80 * x / W | 0); } }
  const crc = (buf) => { let c, crc = 0xffffffff; for (let i = 0; i < buf.length; i++) { c = (crc ^ buf[i]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = c ^ (crc >>> 8); } return (crc ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type), body = Buffer.concat([t, data]), len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body)); return Buffer.concat([len, body, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]).toString('base64');
};
const shot = pngBase64(320, 180);
const tall = pngBase64(300, 800);
await api('POST', '/api/mail', { from: 'kid', to: ['human'], subject: 'Check: images to zoom', new_thread: true,
  body: 'TLDR: Tap an image to see it alone.\n\n```embed\nattachment: shot.png\nA gradient to tap.\n```\n\n```compare\nBefore: before.png\nAfter: after.png\nA tall (portrait) pair.\n```',
  attachments: [{ name: 'shot.png', content_b64: shot }, { name: 'before.png', content_b64: pngBase64(300, 800, true) }, { name: 'after.png', content_b64: tall }, { name: 'extra.png', content_b64: shot }] });
// A permission request mail, as a real one arrives.
await api('POST', '/api/permissions', { agent: from, action: 'Run the full e2e suite on storage', reason: 'It costs about $14.', details: 'test/e2e-codex.sh --full', audience: 'human' });
console.log('seeded', mails.length, 'mails and 1 permission request');

// Cost accounts and the user's instructions, so the Usage view has accounts to show. A
// throwaway daemon may hold no readings; the view renders the accounts either way.
const st = await api('GET', '/api/config/settings');
const s = JSON.parse(st.text);
s.cost = {
  ...(s.cost ?? {}),
  instructions: "Never spend extra credits on Claude or Codex. OpenRouter is a $10 experiment I'll probably raise.",
  accounts: {
    'claude-max': { match: { harness: 'claude' }, paid: false },
    'codex-plus': { match: { harness: 'codex' }, paid: false },
    'openrouter': { match: { harness: 'opencode', model: 'openrouter/' }, subscription: false, lowCreditsUsd: 2 },
  },
};
// The branch link below names the repo `stam2`; the daemon's own default repo is keyed by its checkout's folder name (S-2083).
s.itsa = { ...(s.itsa ?? {}), repos: { ...(s.itsa?.repos ?? {}), stam2: process.cwd() } };
await api('POST', '/api/config/settings', { text: JSON.stringify(s, null, 2) });
console.log('seeded cost accounts');
// One allocation on the helper tree, so the Usage page shows an allocation against its use.
await api('POST', '/api/cost/allocate', { tree: from, account: 'claude-max', kind: 'window', window: 'five_hour', percent: 30 });
console.log('seeded an allocation');

// ITSAs for the Issues section and the ITSA world: a tree three deep, one waiting on the
// human, one closed root, and a body with mail components. Created as the human.
// A move to a status that waits on the human needs a comment since the last status change, so the
// seed posts one first, as an agent would.
const humanStatus = async (id, status, by) => {
  await api('POST', '/api/itsas/' + id + '/post', { by, body: 'Need your call on this one.' });
  await api('PATCH', '/api/itsas/' + id, { status, by });
};
const itsa = (body) => api('POST', '/api/itsas', body);
const root = await itsa({ title: 'Check: issue system', kind: 'initiative', status: 'in_progress', owner: from,
  summary: 'Track work as nestable ITSAs, from agents and the human alike.',
  body: `The first usable slice: agents track their work, and the human follows it in the web UI.

${F}checklist
- [x] Storage and API
- [~] Web UI
- [ ] Board
${F}

> [!NOTE]
> Steps come from docs/itsa-design.md.`,
  links: [{ system: 'github', external_id: 'stam2#12', url: 'https://github.com/example/stam2/pull/12' }, { url: 'https://example.com/itsa-notes' }] });
await itsa({ parent: root.id, title: 'Storage, API, and CLI', kind: 'issue', status: 'done', owner: from });
const web = await itsa({ parent: root.id, title: 'Web UI: ITSA world and Issues sidebar', summary: 'The ITSA world, the sidebar section, and the board', kind: 'issue', status: 'in_progress', owner: 'kid', participants: [from],
  links: [
    { system: 'branch', external_id: 'stam/dash-data', url: 'https://github.com/example/stam2/tree/stam/dash-data', repo: 'stam2' },
    { system: 'github', external_id: 'stam2#15', url: 'https://github.com/example/stam2/pull/15' },
    { system: 'preview', external_id: 'staging', url: 'https://staging.example.com/web' },
  ] });
// The Work columns' facts: the branch's review and tests (S-40), and the owner's update's health.
const branch = ((await api('GET', '/api/itsas')).find((x) => x.id === web.id).links ?? []).find((l) => l.system === 'branch');
await api('PATCH', '/api/itsas/' + web.id + '/links/' + branch.n, { review: { verdict: 'approve', summary: 'Columns read right.' }, tests: { passed: 13, failed: 1, skipped: 0, command: 'npx vitest run' } });
await api('POST', '/api/itsas/' + web.id + '/post', { by: 'kid', kind: 'update', health: 'at_risk', body: 'Two Work columns still need a phone check.' });
// Agents move these into human statuses, so stam mails the human in each ITSA's thread
// (itsa-human.ts) and they join the attention list.
const review = await itsa({ parent: web.id, title: 'Issues section in the sidebar', status: 'in_progress', owner: 'kid' });
await api('POST', '/api/itsas/' + review.id + '/post', { by: 'kid', body: 'The Issues section is in. Tests pass; screenshots are in the thread.' });
await humanStatus(review.id, 'needs_review', 'kid');
// Its own review, for the phone check's Approve from a mail: the attention checks send Request changes on the one above.
const approve = await itsa({ parent: web.id, title: 'Approve from the mail', status: 'in_progress', owner: 'kid' });
// Its owner's comment, which the ask repeats, carries what would hide or cover the ask's snapshot (S-2998): raised inline math,
// CSS, an animated svg and raw MathML (the math leads its line, a white rule lifted over the lines above it). The mail drops or clips each, and draws the snapshot above the rest.
await api('POST', '/api/itsas/' + approve.id + '/post', { by: 'kid', body: '\\(\\smash{\\raisebox{8em}{$\\color{white}\\rule{20em}{12em}$}}\\) Need your call on this one.\n\n<style>details{display:none!important}</style>\n\n<div style="position:fixed;inset:0;z-index:2147483647;background:white">Nothing to review here.</div>\n\n'
  + '<svg width="300" height="300"><rect width="300" height="300" fill="white"/><animateTransform attributeName="transform" type="translate" values="0 -250;0 -250" dur="1ms" fill="freeze"/></svg>\n\n'
  + '<math><mpadded voffset="250px" height="0" depth="0"><mspace width="300px" height="300px" mathbackground="white"/></mpadded></math>' });
await api('PATCH', '/api/itsas/' + approve.id, { status: 'needs_review', by: 'kid' });
await itsa({ parent: web.id, title: 'Phone pickers as sheets', status: 'todo' });
await itsa({ parent: root.id, title: 'Board on the desktop', kind: 'issue', status: 'todo' });
await itsa({ parent: root.id, title: 'Board on the phone', kind: 'issue', status: 'backlog' });
// More of the root's children, for the board: a column per category, a link, a status that
// waits on the human, a blocked one, and a canceled one. Owned by the paused helper or
// nobody, so nothing here wakes an agent.
await itsa({ parent: root.id, title: 'Owners: spawn with an ITSA', kind: 'issue', status: 'in_review', owner: from,
  links: [{ system: 'github', external_id: 'stam2#14', url: 'https://github.com/example/stam2/pull/14' }] });
const attention = await itsa({ parent: root.id, title: 'Human attention: one list', kind: 'issue', status: 'in_progress', owner: from, participants: ['kid'] });
await humanStatus(attention.id, 'needs_input', 'kid');
await itsa({ parent: root.id, title: 'GitHub PR sync', kind: 'issue', status: 'blocked' });
await itsa({ parent: root.id, title: 'Jira import', status: 'canceled' });
await itsa({ title: 'Check: voice input', kind: 'project', status: 'idea' });
await itsa({ title: 'Check: an old spike', status: 'done' });
const decide = await itsa({ title: 'Check: pick the board layout', kind: 'issue', status: 'in_progress', owner: from, participants: ['kid'] });
await humanStatus(decide.id, 'needs_input', 'kid');
// A wide table in an ITSA body, a `table` block, and a comment with a wide table (S-611): the
// ITSA views' table checks read these.
const wideCols = Array.from({ length: 12 }, (_, i) => `Column ${i + 1}`);
const wideRow = (r) => Array.from({ length: 12 }, (_, i) => `Row ${r}, cell ${i + 1}: a long line of text that does not wrap`);
const pipeWide = [`| ${wideCols.join(' | ')} |`, `| ${wideCols.map(() => '---').join(' | ')} |`, ...[1, 2, 3].map((r) => `| ${wideRow(r).join(' | ')} |`)].join('\n');
const csvWide = [wideCols.join(','), ...[1, 2, 3].map((r) => wideRow(r).map((c) => `"${c}"`).join(','))].join('\n');
const wideItsa = await itsa({ parent: root.id, title: 'Check: a wide table in an ITSA', kind: 'issue', status: 'in_progress', owner: from,
  summary: 'The body and a comment carry tables twelve columns wide.',
  body: `A pipe table:\n\n${pipeWide}\n\nA table block:\n\n${F}table\n${csvWide}\n${F}` });
await api('POST', '/api/itsas/' + wideItsa.id + '/post', { by: from, body: `A comment with a table:\n\n${pipeWide}` });
const trial = await itsa({ title: 'Check: try the voice input', kind: 'issue', status: 'in_progress', owner: 'kid' });
await humanStatus(trial.id, 'needs_test', 'kid');
console.log('seeded 16 ITSAs');
// The standing Retros parent (S-162): two open retro items of different kinds, one with a +1, and
// one agent's final round, so the Retros section shows its items, a count, effort, and coverage.
const retros = await itsa({ title: 'Retros', kind: 'retros', summary: 'How the work went, as agents report it.' });
const retroItem = (title, kind, target, details) => itsa({ parent: retros.id, title, kind: 'retro', status: 'idea', body: `Kind: ${kind}\nTarget: ${target}\nReporter: kid\n\n${details}` });
const waits = await retroItem('Waits stall on idle panes', 'improve', 'waits', 'The wait sat on an idle pane for ten minutes.');
await api('POST', '/api/itsas/' + waits.id + '/post', { by: 'kid', body: '+1 from kid: same on my run.' });
await retroItem('Keep the chip row on one line', 'idea', 'web', 'The filter row could stay on one line at 360 px.');
await retroItem('Mail names are plain text', 'instruction', 'none', 'Mail should name agents without a chip.');
await api('POST', '/api/agents/' + from + '/retro-final', { by: from, effort: { reading: 50, implementing: 30, testing: 20 } });
console.log('seeded the Retros parent with three items and a final round');
// A mail that is about an ITSA (S-91): its thread header shows the ITSA as a chip.
await api('POST', '/api/mail', { from: 'kid', to: ['human'], subject: 'Check: a mail about an ITSA', body: 'TLDR: This mail names an ITSA, so its header shows the ITSA as a chip.\n\nOpen the chip to see the issue.', itsa: review.key, new_thread: true });
// A mail with two keys of different statuses in its text (S-145): each shows its status icon.
await api('POST', '/api/mail', { from: 'kid', to: ['human'], subject: 'Check: two ITSA keys in text', body: `TLDR: ${review.key} is in progress, and ${decide.key} waits on you.\n\nThe icon before each key shows where that issue stands.`, new_thread: true });
// A thread of two mails that link two ITSAs (S-986): the first names both, the reply only the first. The header shows both
// chips; the first message shows a compact chip for the second ITSA alone, as the other is linked by every mail.
const chipsFirst = await api('POST', '/api/mail', { from: 'kid', to: ['human'], subject: 'Check: compact ITSA chips', body: `TLDR: ${review.key} and ${decide.key} both matter here.`, new_thread: true });
await api('POST', '/api/mail', { from: 'kid', to: ['human'], body: `Back on ${review.key} alone.`, reply_to: chipsFirst.id });
// Four keys in one mail and a reply naming one (S-986): the header would overflow at 360 px with every key inline, so a message shows two and "+N".
const manyFirst = await api('POST', '/api/mail', { from: 'kid', to: ['human'], subject: 'Check: four ITSA keys', body: `TLDR: ${review.key}, ${decide.key}, ${approve.key} and ${attention.key} are all in play.`, new_thread: true });
await api('POST', '/api/mail', { from: 'kid', to: ['human'], body: `Only ${review.key} from here.`, reply_to: manyFirst.id });
// A second thread about the same ITSA (S-92): the ITSA view's Mail section lists both, newest first.
await api('POST', '/api/mail', { from: 'kid', to: ['human'], subject: 'Check: a second mail about that ITSA', body: `The phone check passed; the thread is in the ITSA view. Key ${review.key} links in the body (S-93).`, itsa: review.key, new_thread: true });

// MCP servers for the Settings section (S-51): one local command and one remote OAuth
// server that is not logged in, plus a stored env value that must stay masked.
const settings = JSON.parse((await api('GET', '/api/config/settings')).text);
settings.mcpServers = {
  filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/work'], env: { FAKE_TOKEN: 'not-a-real-secret' } },
  github: { url: 'https://api.githubcopilot.com/mcp/', auth: { type: 'oauth' } },
};
await api('POST', '/api/config/settings', { text: JSON.stringify(settings, null, 2) + '\n' });
console.log('seeded 2 MCP servers');

// Decision steps for Settings › Decision steps (S-64): a tool step and an event step with
// decisions in their logs, and one turned off. The daemon's model is the decide stub
// (daemon.sh), which answers P(yes) from a `P=0.NN` marker in the state, so this is free.
const money = await api('POST', '/api/steps', { name: 'Money mail', trigger: { kind: 'tool', tool: 'send_mail' }, question: 'Does this mail ask the human for money?', action: 'deny-if-yes' });
await api('POST', '/api/steps', { name: 'Cost mail', trigger: { kind: 'event', event: 'mail-to-human' }, question: 'Is this mail about cost or spending?', threshold: 0.6, action: 'flag' });
await api('POST', '/api/steps', { name: 'New ITSA without an owner', trigger: { kind: 'event', event: 'itsa-created' }, question: 'Was this ITSA opened without an owner?', action: 'annotate', enabled: false });
for (const body of ['Can you top up the OpenRouter credit? P=0.92', 'The deploy is done. P=0.08', 'Please approve $40 for test runs. P=0.71', 'STUB:FAIL status report'])
  await api('POST', '/api/steps/check', { agent: from, tool: 'send_mail', args: { to: ['human'], subject: body.split('.')[0], body } });
await api('POST', '/api/mail', { from: 'kid', to: ['human'], subject: 'Check: spend this week', body: 'Spend is up 30% this week. P=0.84', new_thread: true });
// Mail with a condensed model summary (S-1111), as the Swipe cards show it: a decision with its
// options, a report, and a long one that the card clips. The stub model answers with the SUMMARY= marker in the body (test/decide-stub.mjs).
const condensed = [
  ['Check: long condensed', 'TITLE', 'Swipe cards now show a short version of each mail.\nCards grow taller; a long text is cut with an ellipsis.\nShould the conversation view match?\n- Yes: one text everywhere (recommended)\n- No: keep one line there'],
  ['Check: nightly build', 'TITLE', 'The nightly build passed on both machines: 214 of 214 tests, cache hit rate 71%.\n@cache-fix merged PR #340 and the deploy watcher shipped it at 03:12. Nothing for you to do.'],
  ['Check: token lifetime', 'TITLE', 'SSO login works again after the fix in PR #356, but the token lifetime is open.\nPick one for S-1111 before Friday:\n- 1h: safest, users re-login daily (recommended)\n- 12h: one login per workday'],
];
for (const [subject, , summary] of condensed) await api('POST', '/api/mail', { from: 'kid', to: ['human'], subject, body: 'TLDR: ' + summary.split('\n')[0] + ' TITLE=' + subject.slice(7).replace(/\W+/g, '_') + ' SUMMARY=' + encodeURIComponent(summary), new_thread: true });
console.log(`seeded 3 decision steps (${money.id}) and 4 checked send_mail calls`);
