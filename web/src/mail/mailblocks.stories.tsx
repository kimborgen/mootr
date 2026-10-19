// S-650: one story per mail block (docs/mail-components.md), each rendered through the same
// path as a mail body (mailblocks.renderMail, then the finishers ThreadPanel runs) from Markdown
// fixtures, with the Markdown shown under it. Every fixture is invented.
import { useLayoutEffect, useMemo, useRef } from 'react'
import { glyphHtml } from '../Glyph'
import { itsaKeyLink } from '../itsa/itsa'
import { esc } from '../format'
import { AGENTS } from '../stories/fixtures'
import { resetDiffRepos } from '../diff/diffRepos'
import { ds, type Story, type StoryState } from '../stories/types'
import type { Itsa } from '../types'
import * as mb from './mailblocks'
import s2077Diff from './s2077-diff.fixture.md?raw'
import { Rendered } from './Rendered'
import { registerAppRefResolvers } from './refResolvers'

// "@name" and "S-12" resolve against the fixtures, as in the app (main.tsx).
mb.configure({
  mention: (name) => {
    const a = AGENTS.find((x) => x.name.toLowerCase() === name.toLowerCase() || x.id === name)
    return a ? `<a href="#" class="mention" data-open-agent="${a.id}">${glyphHtml(a)}${esc(a.name)}</a>` : null
  },
  itsa: itsaKeyLink,
})

registerAppRefResolvers() // "#494" and "Settings › Spending", as in the app (main.tsx)

const T = '2026-10-01T09:00:00.000Z'
const itsa = (n: number, status: string, title: string): Itsa => ({ id: `fx-itsa-${n}`, key: `S-${n}`, parent_id: null, kind: 'issue', title, summary: null, body: null, status, owner: null, thread_id: null, created_by: 'human', created_at: T, updated_at: T, closed_at: null })
const ITSAS = [itsa(12, 'in_progress', 'Fixture: rename the sync job'), itsa(13, 'done', 'Fixture: drop the old index'), itsa(14, 'blocked', 'Fixture: wait for the vendor')]

const fence = (name: string, body: string) => '```' + name + '\n' + body.replace(/\n$/, '') + '\n```'
// A body drawn like a mail's, then finished in place; `thread` holds the human's replies, which
// mark a decision answered. The Markdown is shown under it in a code block.
function Mail({ md, thread = [], answer = false, source = true }: { md: string; thread?: string[]; answer?: boolean; source?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const html = useMemo(() => mb.renderMail(md), [md])
  const src = useMemo(() => (source ? mb.renderMail('````md\n' + md.replace(/\n$/, '') + '\n````') : ''), [md, source])
  useLayoutEffect(() => {
    const el = ref.current!
    mb.resolveCompare(el, () => null)
    mb.resolveEmbeds(el, () => null, () => Promise.reject())
    mb.renderDiagrams(el)
    mb.highlight(el)
    mb.renderMath(el)
    mb.renderCharts(el)
    mb.markDecisions(el, { created_at: T }, thread.map((body) => ({ from_id: 'human', created_at: '2026-10-02T09:00:00.000Z', body })), answer)
  }, [html])
  return <div className="story-pad">
    <div className="md" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />
    {source && <div className="md" dangerouslySetInnerHTML={{ __html: src }} />}
  </div>
}
const st = (name: string, md: string, o: { thread?: string[]; answer?: boolean; source?: boolean; data?: StoryState['data']; tall?: boolean } = {}): StoryState =>
  ({ name, data: { itsas: ITSAS, ...o.data }, render: () => o.tall ? <div style={{ minHeight: 640 }}><Mail md={md} thread={o.thread} answer={o.answer} source={o.source} /></div> : <Mail md={md} thread={o.thread} answer={o.answer} source={o.source} /> })

const MAIL = '[`docs/mail-components.md`](https://github.com/kimborgen/mootr/blob/main/docs/mail-components.md)'
const SRC = 'web/src/mail/mailblocks.ts'
const common = [
  'Mail components are apparatus, not cards: a hairline, quiet ink and tabular figures, never a tinted fill or a shadow (' + ds('In stam') + ').',
  'Every block is plain Markdown or a fenced block, so the mail still reads as text in an agent terminal (' + MAIL + ').',
  'A view that draws a mail outside the thread panel (the ITSA thread, S-1508) gives `Rendered` a `resolve` step, so the mail\'s embedded and compared attachments fill in there too.',
]
const block = (name: string, what: string, when: string, code: string[], rules: string[], states: StoryState[]): Story =>
  ({ name, group: 'Mail blocks', what, when, code: code.map((c) => (c.includes('#') ? c : `${SRC}#${c}`)), rules: [...rules, ...common], fit: 'actual', states })

const Q = 'Which token lifetime should SSO use?'
const DEC = fence('decision', `${Q}\n- 1 hour: safest, users sign in daily (recommended)\n- 12 hours: one sign-in per workday\n- 7 days: least friction, longest exposure`)

export const stories: Story[] = [
  block('TLDR', 'The mail\'s one-line outcome, set larger than the body as its lead.',
    'The first line of a mail, `TLDR: the outcome in one line`. Folded messages and inbox rows show it instead of a snippet.', ['splitTldr', 'preview'],
    ['`--type-chrome-lg` at `--weight-medium` in primary ink; no box, no fill.', 'Only the first line counts: a `TLDR:` anywhere else is plain text.'],
    [st('With a body', 'TLDR: The SSO fix works; pick the token lifetime.\n\nThe fixture login now returns `200` for valid tokens.\n\n- Tests pass\n- One decision is open'),
     st('Not the first line', 'Fixture note.\n\nTLDR: this is plain text.')]),
  block('Decision', 'A question with two to four options, each a button. An answer is staged, then sent with the reply. The recommended option is marked.',
    'In a mail when an agent needs one choice from the human. Its body is a `decision` fence: the question, then one `- Option: why` line per option; `(recommended)` marks one.',
    ['decision', 'markDecisions', 'parseDecision', 'web/src/mail/Rendered.tsx#Rendered'],
    ['Options are buttons at `--size-hit-touch` on a phone. A block with no recommendation marks none.', '`Rendered` (an ITSA body, stam\'s own view of an agent) draws the same blocks read-only: decisions are shown, never answered.', 'Every decision has **Decide later** and **Add a note**; a deferral leaves the block open (S-353).', 'The reply quotes the question, then `Chose **Option**.`'],
    [st('Undecided', '```decision\n' + `${Q}\n- 1 hour: safest, users sign in daily (recommended)\n- 12 hours: one sign-in per workday\n- 7 days: least friction, longest exposure\n` + '```', { answer: true }),
     st('Decided', DEC, { thread: [`> ${Q}\n\nChose **1 hour**.`], answer: true }),
     st('Deferred, still open', DEC, { thread: [`> ${Q}\n\nDeferring this one: still open, I'll decide later.`], answer: true }),
     st('Answered with a note', DEC, { thread: [`> ${Q}\n\nNote: Use 4 hours, matching the VPN.`], answer: true }),
     { name: 'Read-only (as in an ITSA body)', data: { itsas: ITSAS }, render: () => <div className="story-pad"><Rendered text={DEC} /></div> }]),
  block('Yes or no', 'A decision with only a question: two buttons. A recommendation reads `(recommended: yes)` or `(recommended: no)`.',
    'A `yesno` fence (or a `decision` fence with only a question) in a mail that needs a yes or a no.', ['decision'],
    ['Same reply, deferral and note as a Decision.', 'Without a recommendation neither button is marked.'],
    [st('Recommended yes', fence('yesno', 'Merge the fixture migration today? (recommended: yes)'), { answer: true }),
     st('Recommended no', fence('yesno', 'Run the full suite on the second machine? (recommended: no)'), { answer: true }),
     st('Answered', fence('yesno', 'Merge the fixture migration today? (recommended: yes)'), { thread: ['> Merge the fixture migration today?\n\nChose **Yes**.'], answer: true })]),
  block('Rank', 'A set of options the human puts in order. Rows drag, or move with arrows; any move or **Keep this order** stages the ranking.',
    'A `rank` fence, written like a decision, with the options in the order the agent suggests.', ['rank', 'rankText', 'setRankOrder'],
    ['A row\'s drag handle is a full-height target; arrows work from the keyboard.', 'The reply reads `Ranked: 1. **A**, 2. **B**.`'],
    [st('Unanswered', fence('rank', 'Which fixture work goes first?\n- Fix the sync job: blocks two agents\n- Add retries: nice to have\n- Rename the config keys: cosmetic'), { answer: true }),
     st('Ranked', fence('rank', 'Which fixture work goes first?\n- Fix the sync job: blocks two agents\n- Add retries: nice to have\n- Rename the config keys: cosmetic'), { thread: ['> Which fixture work goes first?\n\nRanked: 1. **Add retries**, 2. **Fix the sync job**, 3. **Rename the config keys**.'], answer: true })]),
  block('Pick several', 'A decision where any number of options can be ticked, then sent together.',
    'A `pick` fence, written like a decision; `(recommended)` options start ticked.', ['decision', 'pickText'],
    ['Checkbox rows with a **Send** button; the reply reads `Picked **A**, **B**.`', 'Also has Decide later and Add a note.'],
    [st('Unanswered', fence('pick', 'Which checks run on the branch?\n- Types: fast (recommended)\n- Unit tests: needs a minute (recommended)\n- Browser flow: slow'), { answer: true }),
     st('Answered', fence('pick', 'Which checks run on the branch?\n- Types: fast (recommended)\n- Unit tests: needs a minute (recommended)\n- Browser flow: slow'), { thread: ['> Which checks run on the branch?\n\nPicked **Types**, **Browser flow**.'], answer: true })]),
  block('Callout', 'A short note with a coloured label and a hairline, in place of a tinted box.',
    'A GitHub alert in a block quote: `> [!DONE]`, `[!BLOCKED]`, `[!WARNING]` or `[!NOTE]`. Also `INFO`, `TIP`, `IMPORTANT`, `SUCCESS`, `CAUTION`, `ERROR`, `FAILED`.', ['callouts'],
    ['Tinted callouts are banned: the label carries the tone, the box has no fill.', 'Use one per mail for the single status line that matters.'],
    [st('Done and blocked', '> [!DONE]\n> The fixture import finished; 4,200 rows loaded.\n\n> [!BLOCKED]\n> Waiting for the fixture vendor to renew the key.'),
     st('Warning and note', '> [!WARNING]\n> The next run deletes the fixture cache.\n\n> [!NOTE]\n> The job runs at 02:00 UTC on example.com.'),
     st('Every tone', ['INFO', 'TIP', 'IMPORTANT', 'SUCCESS', 'CAUTION', 'ERROR', 'FAILED'].map((t) => `> [!${t}]\n> A ${t.toLowerCase()} callout.`).join('\n\n'), { source: false })]),
  block('Table', 'A table with numeric columns aligned, every header sortable, long tables folded.',
    'A Markdown table, or a `table` (also `csv`, `tsv`) fence: an optional `title:`, then CSV or TSV with a header row.', ['table', 'enhanceTable', 'num'],
    ['Columns where 80% of cells are numbers, money, percentages or durations right-align in tabular figures.', 'Tables over 18 rows fold after 15 with **Show all**; wide tables scroll sideways inside the block.', '`[success]`, `[warning]`, `[error]` in a cell colour it.'],
    [st('Markdown table', '| Job | Duration | Status |\n|---|---:|---|\n| Types | 0:42 | passed |\n| Unit tests | 3:10 | passed |\n| Browser flow | 11:05 | failed |'),
     st('CSV with tones', fence('table', 'title: Fixture runs\nJob,Duration,Cost,Status\nTypes,0:42,$0.10,passed [success]\nUnit tests,3:10,$0.40,flaky [warning]\nBrowser flow,11:05,$1.20,failed [error]')),
     st('Long, folded', fence('csv', 'Run,Files,Seconds\n' + Array.from({ length: 24 }, (_, i) => `fixture-${i + 1},${10 + i * 3},${20 + i * 7}`).join('\n'))),
     st('Wide', fence('table', 'Fixture,Region,Owner,Queue,Retries,Last run,Next run,Notes\nsync,eu,fixture-dev,default,3,2026-10-01,2026-10-02,Re-runs on failure\nbackup,us,fixture-ops,slow,1,2026-09-30,2026-10-03,Needs 20 GB free'))]),
  block('Chart', 'A line, area, bar or donut chart drawn as SVG at the sheet width, with a hover readout and a data table folded under it.',
    'A `chart` (also `graph`, `plot`) fence: `type:`, optional `title:`, `caption:`, `x:`, `y:`, `unit:`, `stacked: yes`, `horizontal: yes`, `height:`, `min:`, `max:`; then CSV with the x column first and one column per series.', ['chart', 'renderCharts'],
    ['Series take `--series-1` to `--series-6` in order and repeat; a colour means what the legend says and nothing else.', 'A series named for a harness (`Claude Code`, `Codex`, `OpenCode`) takes that harness\'s hue, so one hue never means two things (' + ds('In stam') + ').', 'Empty cells leave gaps in lines. The numbers sit in a **Data** fold for anyone who needs them.'],
    [st('Line', fence('chart', 'type: line\ntitle: Fixture requests per hour\nx: Hour\ny: Requests\nHour,Web,Worker\n09,120,40\n10,180,55\n11,150,90\n12,210,70')),
     st('Area, stacked', fence('chart', 'type: area\nstacked: yes\ntitle: Fixture memory\nunit: GB\nDay,Cache,Heap\nMon,2,4\nTue,3,4\nWed,3,6\nThu,4,5')),
     st('Bar', fence('chart', 'type: bar\ntitle: Fixture failures by job\nJob,Failures\nTypes,1\nUnit,4\nBrowser,9')),
     st('Horizontal bar, long names', fence('chart', 'type: bar\nhorizontal: yes\ntitle: Fixture time per step\nunit: s\nStep,Seconds\nInstall dependencies,92\nBuild the web bundle,61\nRun the unit tests,43\nRun the browser flows,188')),
     st('Donut', fence('chart', 'type: donut\ntitle: Fixture spend by harness\nunit: $\nHarness,Spend\nClaude Code,12\nCodex,5\nOpenCode,2')),
     st('Scatter', fence('chart', 'type: scatter\ntitle: Fixture size against time\nx: Files\ny: Seconds\nlabel,x,y\nsync,12,30\nbackup,40,95\nindex,25,50\nexport,8,14')),
     st('Radar', fence('chart', 'type: radar\ntitle: Fixture scores\nArea,Before,After\nSpeed,3,5\nCost,4,4\nClarity,2,5\nSafety,5,5')),
     st('Radial', fence('chart', 'type: radial\ntitle: Fixture coverage\nunit: %\nArea,Done\nTypes,100\nUnit,82\nBrowser,35')),
     st('Harness-named series', fence('chart', 'type: line\ntitle: Fixture turns per hour\nHour,Claude Code,Codex,OpenCode\n09,6,3,2\n10,8,4,3\n11,5,6,4\n12,9,5,5')),
     st('Gaps and many series', fence('chart', 'type: line\ntitle: Fixture latency\nunit: ms\nDay,A,B,C,D,E,F,G\n1,10,12,14,16,18,20,22\n2,11,,15,17,19,21,23\n3,12,14,,18,20,22,24\n4,13,15,17,19,21,23,25'))]),
  block('Timeline', 'Events along a hairline, each with a dot in its tone.',
    'A `timeline` fence: one `TIME — event` per line, optionally tagged `[success]`, `[warning]` or `[error]`.', ['timeline'],
    ['The line is a hairline; only the dot carries colour, and the event text stays in ink.'],
    [st('Mixed tones', fence('timeline', '09:00 — Fixture deploy started\n09:12 — Cache warmed [success]\n09:40 — Queue backed up [warning]\n10:05 — Worker crashed [error]\n10:20 — Worker restarted [success]'))]),
  block('Metrics', 'Three to five numbers side by side, with an optional note and tone.',
    'A `metrics` fence: `Label: value`, optionally ` — note` and `[success]`, `[warning]` or `[error]`.', ['metrics'],
    ['Figures are tabular; labels stay in secondary ink. More than five lines is a table.'],
    [st('Three tones', fence('metrics', 'Tests: 214/214 [success]\nSpent: $0.42\nQueue: 38 — above the usual 20 [warning]\nFailures: 2 [error]')),
     st('Plain', fence('metrics', 'Files: 12\nLines: +340 −90\nTime: 4 min'))]),
  block('Spend', 'A bar for spend against a budget, with the budget marked.',
    'A `spend` fence: `Spent:`, `Budget:`, `Estimate:` (what the next step adds), `For:`. Usually paired with a yes or no.', ['spend'],
    ['Over budget turns the bar warning; already spent past it turns it error.', 'Money is tabular figures; the bar has a text value too, so colour is not the only signal.'],
    [st('Within budget', fence('spend', 'Spent: $3.20\nBudget: $10\nEstimate: $2.50\nFor: the fixture browser run')),
     st('Estimate goes over', fence('spend', 'Spent: $8.00\nBudget: $10\nEstimate: $4.00\nFor: the fixture full suite')),
     st('Already over', fence('spend', 'Spent: $12.00\nBudget: $10\nEstimate: $1.00\nFor: the fixture re-run'))]),
  block('Test results', 'Counts, a pass and fail bar, failures with their output open, passing tests folded.',
    'A `tests` fence: `212 passed`, `1 skipped`, `FAIL name` lines with their output indented under them, optional `PASS name`.', ['tests'],
    ['Failures start open; passing tests start folded.', 'The bar and the counts agree; `--status-success` and `--status-error` colour only the bar and the label.'],
    [st('All passed', fence('tests', '214 passed\n1 skipped')),
     st('With failures', fence('tests', '212 passed\n1 skipped\n2 failed\nFAIL sync retries the upload\n  expected 3 calls, got 1\n  at sync.test.ts:42\nFAIL export names the file\n  expected "fixture.csv", got "export.csv"\nPASS index builds')),
     st('Long output', fence('tests', '10 passed\n1 failed\nFAIL browser flow\n' + Array.from({ length: 14 }, (_, i) => `  step ${i + 1}: waited for the fixture selector`).join('\n')))]),
  block('Error', 'One failure laid out as message, where, cause and fix.',
    'An `error` fence with `Message:`, `Where:`, `Cause:` and `Fix:` lines.', ['error'],
    ['Labels in secondary ink, values in ink and mono for paths; the only tone is the error label.', 'A line left out is left out of the block.'],
    [st('Full', fence('error', 'Message: Test fails: expected 200, got 401\nWhere: `web/src/auth.test.ts:42`\nCause: the request is missing the `Authorization` header\nFix: add the header in `fixtures.ts`')),
     st('Message only', fence('error', 'Message: The fixture daemon is unreachable'))]),
  block('Terminal excerpt', 'Command output with the 16 ANSI colours on stam\'s terminal palette.',
    'A `terminal` (also `console`, `log`, `ansi`) fence; lines that begin with `$ ` are commands.', ['terminal', 'ansi'],
    ['Colours are `--ansi-*` from `web/tokens-stam.css`; 256-colour and RGB codes are dropped, so a mail never brings its own palette.', 'Mono type at `--type-code`; long lines scroll sideways inside the block.'],
    [st('Commands and colours', fence('terminal', '$ npm test\n\u001b[32m✓\u001b[0m types\n\u001b[33m!\u001b[0m 1 skipped\n\u001b[31m✗\u001b[0m export names the file\n\u001b[2mdone in 4.2 s\u001b[0m')),
     st('Long line', fence('log', '2026-10-01T09:00:00Z INFO fixture-worker started with a very long argument list --queue default --retries 3 --timeout 300 --region example-1'))]),
  block('Progress', 'One bar per line, for steps done out of steps, or a percentage.',
    'A `progress` fence: `3/5 Label` or `60% Label`, one per line.', ['progress'],
    ['The bar has its value in text beside it.'],
    [st('Fractions and percentages', fence('progress', '3/5 Fixture migrations\n60% Fixture index rebuild\n0/4 Fixture checks\n100% Fixture export'))]),
  block('Checklist', 'A status icon per line for done, in progress, next, blocked and skipped.',
    'A `checklist` (also `status`) fence: `- [x]` done, `- [~]` in progress, `- [ ]` next, `- [!]` blocked, `- [-]` skipped.', ['checklist'],
    ['The icon carries the state, never colour alone; the same shapes as the ITSA statuses where they apply.'],
    [st('Every state', fence('checklist', '- [x] Write the fixture\n- [~] Run the checks\n- [ ] Open the pull request\n- [!] Wait for the vendor key\n- [-] Skip the browser flow'))]),
  block('Details', 'A fold for evidence the reader may skip: logs, long output, reasoning.',
    'HTML `<details><summary>Summary</summary>` … `</details>`, with blank lines around the Markdown inside.', ['renderMail'],
    ['Collapsed by default; the chevron turns on open, with no animation beyond the token duration (' + ds('Motion') + ').'],
    [st('Closed, with Markdown inside', '<details><summary>What the logs show</summary>\n\n- Seven retries\n- One timeout, at `09:41`\n\n```\nretry 7 failed\n```\n\n</details>'),
     st('Open', '<details open><summary>The decision log</summary>\n\nWe kept the old index because the new one is **slower** on example.com.\n\n</details>')]),
  block('Diff', 'A unified diff with one fold per file and +/− counts.',
    'A `diff` (also `patch`) fence holding a unified diff.', ['diff'],
    ['Added and removed lines take the `--status-success-bg` and `--status-error-bg` fills with the matching `-fg` ink; hunk headers are `--text-muted`.', 'Rows wrap (`pre-wrap`, `overflow-wrap: anywhere`) and never scroll sideways. The `+`, `-` or space marker is the row\'s first character, so copying gives back the patch lines. Continuations hang `--diff-hang` past the code\'s own indent (a tab counts 4), capped at `--diff-ind-max`; the tint covers every visual line.','A header row reads `N files · +a −d`, with a hidden Open slot at its right; it is a sibling of the folds, never inside a summary. The folds sit in one vertical scroller, capped at `--size-diff-cap` (32 lines, `--size-diff-cap-phone` 18 on a phone) and at 50dvh, with no overscroll containment, so a swipe at its end moves the page; it takes focus with the keyboard.', 'Every file opens when the whole diff is 18 rows or fewer; otherwise only the first does. A file summary shows a muted folder that ellipsizes first, the file name in semibold, and its `+` and `−` counts, and stays at the scroller\'s top while its file scrolls; under touch it is `--size-hit-touch` high.', 'In a list card\'s clipped preview the block is inert: a tap opens the mail. In an open mail and an ITSA comment a click inside the block never reaches the card.'],
    [st('Two files', fence('diff', 'diff --git a/src/sync.ts b/src/sync.ts\n--- a/src/sync.ts\n+++ b/src/sync.ts\n@@ -1,4 +1,5 @@\n export function sync() {\n-  upload(file)\n+  retry(3, () => upload(file))\n+  log("synced")\n }\ndiff --git a/src/new.ts b/src/new.ts\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,2 @@\n+export const fixture = true\n+export const retries = 3')),
     st('Deep indent', fence('diff', 'diff --git a/src/deep.ts b/src/deep.ts\n--- a/src/deep.ts\n+++ b/src/deep.ts\n@@ -1,2 +1,3 @@\n function walk() {\n-\t\t\t\tif (node.children.length > 0 && node.children.every((child) => visited.has(child.id))) return done(node)\n+\t\t\t\tif (node.children.length > 0 && node.children.every((child) => visited.has(child.id)) && !node.pending) return done(node)\n }')),
     st('Long identifier', fence('diff', 'diff --git a/src/id.ts b/src/id.ts\n--- a/src/id.ts\n+++ b/src/id.ts\n@@ -1 +1 @@\n-const a = 1\n+const aVeryLongGeneratedIdentifier_' + 'abcdefghij'.repeat(40) + ' = 2')),
     st('Unicode', fence('diff', 'diff --git a/docs/ø.md b/docs/ø.md\n--- a/docs/ø.md\n+++ b/docs/ø.md\n@@ -1 +1 @@\n-Blåbærsyltetøy på brød\n+Blåbærsyltetøy 🫐 på brød — 日本語のテキストもここで折り返されます')),
     st('Headerless', fence('diff', '@@ -3,3 +3,4 @@\n keep\n-old line\n+new line\n+another line that is long enough to wrap on a phone screen at three hundred sixty pixels')),
     st('S-2077 comment', s2077Diff),
     st('Many files', fence('diff', Array.from({ length: 9 }, (_, i) => `diff --git a/web/src/area${i}/module${i}.ts b/web/src/area${i}/module${i}.ts\n--- a/web/src/area${i}/module${i}.ts\n+++ b/web/src/area${i}/module${i}.ts\n@@ -1,3 +1,4 @@\n const a${i} = ${i}\n-const b = 1\n+const b = 2\n+const c = 3`).join('\n')), { tall: true }),
     st('One huge file', fence('diff', 'diff --git a/src/huge.ts b/src/huge.ts\n--- a/src/huge.ts\n+++ b/src/huge.ts\n@@ -1,0 +1,120 @@\n' + Array.from({ length: 120 }, (_, i) => `+const line${i + 1} = ${i + 1}`).join('\n')), { source: false, tall: true }),
     { name: 'In a card preview, inert', data: { itsas: ITSAS }, render: () => <div className="story-pad"><div className="mc-text md" dangerouslySetInnerHTML={{ __html: mb.renderMail(fence('diff', 'diff --git a/src/huge.ts b/src/huge.ts\n--- a/src/huge.ts\n+++ b/src/huge.ts\n@@ -1,0 +1,40 @@\n' + Array.from({ length: 40 }, (_, i) => `+const line${i + 1} = ${i + 1}`).join('\n'))) }} /></div> },
     { name: 'In an ITSA comment', data: { itsas: ITSAS }, render: () => <div className="story-pad" style={{ minHeight: 640 }}><div className="comment-fixture" style={{ background: 'var(--surface-pane)', ['--mb-surface' as string]: 'var(--surface-pane)' }}><Rendered text={s2077Diff} /></div></div> },
     st('Long, folded', fence('diff', 'diff --git a/src/long.ts b/src/long.ts\n--- a/src/long.ts\n+++ b/src/long.ts\n@@ -1,0 +1,20 @@\n' + Array.from({ length: 20 }, (_, i) => `+const line${i + 1} = ${i + 1}`).join('\n')))]),
  block('Code block', 'Any other fenced block: a copy button on hover and syntax highlighting from stam\'s tokens.',
    'A fenced block, with a language tag for highlighting. Untagged blocks are guessed only when the guess is confident.', ['highlight', 'handleCopy'],
    ['Colours come from the syntax tokens (' + ds('In stam') + '), light and dark; the copy button is `--size-control`, shown on hover or keyboard focus.', 'Long lines scroll inside the block; the page never scrolls sideways.'],
    [st('TypeScript', fence('ts', 'export function retry<T>(n: number, f: () => T): T {\n  for (let i = 0; i < n - 1; i++) {\n    try { return f() } catch {}\n  }\n  return f()\n}')),
     st('Shell and JSON', fence('bash', 'npm test -- --run && npm run build') + '\n\n' + fence('json', '{ "fixture": true, "retries": 3 }')),
     st('Untagged, and an inline `code` span', fence('', 'plain text, no language') + '\n\nUse `npm ci` in `web/` first.')]),
  block('Math', 'Formulas typeset by KaTeX, loaded the first time one appears.',
    'A `math` fence, `$$…$$` on its own lines, or `\\( … \\)` inline. A single `$` stays a dollar sign.', ['renderMath'],
    ['KaTeX 0.16.11 in the text ink; a formula that fails to typeset shows its source.', 'Prices like $5 and $10 are not math.'],
    [st('Block and inline', 'The variance is \\( \\sigma^2 = E[(X-\\mu)^2] \\) and the total is:\n\n' + fence('math', '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}') + '\n\nIt costs $5 or $10.')]),
  block('Mermaid diagram', 'A flow, sequence or other Mermaid diagram, drawn in the design tokens\' colours.',
    'A `mermaid` (also `diagram`) fence. Mermaid 11.4.1 loads the first time one appears.', ['diagram', 'renderDiagrams'],
    ['A theme change redraws every diagram; drawings are cached per theme and source.', 'Source that does not parse shows with the reason.'],
    [st('Flowchart', fence('mermaid', 'flowchart LR\n  A[Fixture agent] --> B{Tests pass?}\n  B -- yes --> C[Open the PR]\n  B -- no --> D[Fix and retry]')),
     st('Sequence', fence('mermaid', 'sequenceDiagram\n  Dev->>Reviewer: PR ready\n  Reviewer-->>Dev: Two comments\n  Dev->>Reviewer: Fixed')),
     st('Broken source', fence('mermaid', 'flowchart LR\n  A --> -->'))]),
  block('Embed', 'A file or a link shown in place: an image, a video, audio, a PDF, a text file, or a card for any other link.',
    'An `embed` (also `video`, `audio`, `image`, `file`) fence: a URL, `attachment: name`, or an absolute path on the sender\'s machine, then an optional caption. YouTube, Vimeo and Loom links alone on a line embed too.', ['embed', 'embedUrl', 'resolveEmbeds'],
    ['Only `http:` and `https:` URLs embed or link; any other scheme (`javascript:`, `data:`) draws nothing (S-1529). A PDF is never put in an iframe: an attached one is a card with Open PDF (the file view) and Download, a linked one a card with an Open PDF link; their links are `--size-hit-touch` high on a phone.', 'YouTube (privacy-enhanced), Vimeo, Loom, Google Docs and Drive and Figma open in a sandboxed iframe. This page draws none of them, so it makes no outside request.', 'An image, video or audio URL becomes a player; text files show their first 200 lines, highlighted.', 'A path that was not attached shows as missing, never as a broken player.', 'An attached file\'s Download link has no token in its URL (S-1600): a click saves it through the app\'s authenticated fetch (`resolveEmbeds`).'],
    [st('Image', fence('embed', 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22320%22 height=%22120%22%3E%3Crect width=%22320%22 height=%22120%22 fill=%22%23888%22/%3E%3C/svg%3E\nA fixture screenshot'), { source: false }),
     st('Link card', fence('embed', 'https://example.com/fixture/report.html\nThe fixture report')),
     st('Not attached', fence('embed', '/home/fixture/report.log\nThe fixture log') + '\n\n' + fence('embed', 'attachment: fixture.png'))]),
  block('Before and after', 'Two images with the after image under the before, clipped at a slider.',
    'A `compare` fence: `Before: NAME`, `After: NAME` (attachment names or image URLs), then an optional caption.', ['compare', 'resolveCompare'],
    ['The slider is a native range input: keyboard, touch and pointer all drive it.', 'Images it shows leave the attachment strip.', 'An image that is not attached shows a missing note, not a broken image.'],
    [st('Missing images', fence('compare', 'Before: fixture-before.png\nAfter: fixture-after.png\nThe fixture header, narrow')),
     st('Two images', fence('compare', 'Before: data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22320%22 height=%22120%22%3E%3Crect width=%22320%22 height=%22120%22 fill=%22%23999%22/%3E%3C/svg%3E\nAfter: data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22320%22 height=%22120%22%3E%3Crect width=%22320%22 height=%22120%22 fill=%22%23ccc%22/%3E%3C/svg%3E\nGrey before, lighter after'), { source: false })]),
  block('Pane', 'An agent\'s terminal as it was when the mail was sent, with a link to open the live one.',
    'A `pane` fence holding an agent\'s name. The sender\'s daemon adds `captured:` and the screen after `---` at send time.', ['pane'],
    ['Same palette as a Terminal excerpt. An agent on another machine stays a link, with no screen.', 'The age reads from the capture time ("2 min ago").'],
    [{ name: 'Captured', data: { itsas: ITSAS }, render: () => <Mail md={fence('pane', `fixture-dev\ncaptured: ${new Date(Date.now() - 120000).toISOString()}\n---\n$ npm test\n\u001b[32m✓\u001b[0m 214 passed\n\u001b[33m!\u001b[0m 1 skipped`)} /> },
     st('Link only', fence('pane', 'fixture-review')),
     st('Unknown agent', fence('pane', 'fixture-nobody'))]),
  block('Agent and ITSA mentions', 'An agent\'s mark and name in link ink, and an ITSA key with its live status, each opening its world.',
    '`@name` for an agent; a key such as `S-12` in the body or subject, outside code. A key no ITSA has stays plain text.', ['mentions', 'linkItsaKeys', 'itsaLinks', 'threadLinks', 'resolveThreadLinks'],
    ['Mention chips are banned: it is ink, not a chip.', 'The agent mark is the same as everywhere (' + ds('In stam') + '); the ITSA key carries its status glyph.'],
    [st('Mentions', 'Ask @fixture-dev about S-12, which @fixture-review closed after S-13. S-99 is unknown, and `S-12` in code is left alone.'),
     st('Each harness', '@fixture-dev (Claude Code), @fixture-review (Codex), @fixture-ops (OpenCode), and @fixture-nobody, who does not exist.'),
     { name: 'Thread link', data: { itsas: ITSAS }, routes: { 'GET /api/mail/m3228ca5/thread': [{ thread_id: 'fx-thread', subject: 'Re: Fixture: the earlier thread' }] }, render: () => <div className="story-pad"><Rendered text="See m3228ca5 for the earlier thread." /></div> }]),
  block('Reference links', 'A reference in running text becomes a link: a number such as #494 opens the pull request or issue on GitHub, and an in-app page name such as Settings › Spending opens that page. A reference with several matches is one link with a small arrow that opens a picker listing them.',
    '`#N` outside code, links and headings, when an ITSA carries that pull request or issue; `Settings › Section` with a Settings section\'s name. A number no ITSA carries (`#1 priority`, a colour) stays plain text. Resolvers are pluggable: `registerRefResolver` adds a kind (`refs.ts`, the app\'s in `refResolvers.ts`).', ['web/src/mail/refs.ts#refLinks', 'web/src/mail/refs.ts#refHtml', 'web/src/mail/refs.ts#registerRefResolver'],
    ['A reference link is link ink and medium weight, like an ITSA key; the picker is the app\'s context menu, a sheet on a phone (' + ds('Density') + ').', 'The arrow marks a link with a choice, so the mark never relies on colour alone.'],
    [{ name: 'A number and a page', data: { itsas: [{ ...ITSAS[0], links: [{ n: 1, system: 'github', external_id: '494', url: 'https://github.com/other/repo/pull/494' }] }] }, render: () => <div className="story-pad"><Rendered text="The fix is in #494; spending limits live under Settings › Spending. `#494` in code is left alone." /></div> },
     { name: 'A number with several matches', data: { itsas: [{ ...ITSAS[0], links: [{ n: 1, system: 'github', external_id: '494', url: 'https://github.com/example/repo/pull/494' }] }] }, render: () => <div className="story-pad"><Rendered text="Delivered by #494, which carries S-12." /></div> }]),
  block('PR links', 'A GitHub pull-request URL for a repo the diff API serves opens the diff view in the app (S-1533), the way a file path opens the file view. "GitHub" beside it opens the PR page.',
    'A link to `https://github.com/OWNER/REPO/pull/N` in mail text or an agent\'s conversation text, when `GET /api/diff/repos` lists that GitHub repo. `Rendered` and a mail body finish it once the repos are known.', ['web/src/mail/prLinks.ts#linkPrUrls', 'web/src/mail/prLinks.ts#prLinkClick', 'web/src/diff/diffRepos.ts#prUrlTarget'],
    ['A plain click opens `diff:REPO#N`; Ctrl-, Cmd- or Shift-click and the "GitHub" link open the PR page. The link\'s title says which.', 'A PR of another repo, an issue, another host, and a link in a code span or block stay plain links. A bare `#N` reference is the reference resolver\'s (see Reference links).', 'On a phone "GitHub" is a small muted word whose touch area is widened to a full target (`--size-hit-touch`) without changing the line height.'],
    [{ name: 'A served PR URL', setup: () => resetDiffRepos([{ name: 'fixture', github: 'fixture/repo' }], true), render: () => <div className="story-pad"><Rendered text="Review https://github.com/fixture/repo/pull/901 and [the second one](https://github.com/fixture/repo/pull/902)." /></div> },
     { name: 'Other repos, issues and code stay plain', setup: () => resetDiffRepos([{ name: 'fixture', github: 'fixture/repo' }], true), render: () => <div className="story-pad"><Rendered text={'Not served: https://github.com/other/thing/pull/12. An issue: https://github.com/fixture/repo/issues/3. In code: `https://github.com/fixture/repo/pull/901`.'} /></div> }]),
  block('File path links', 'A file path in running text becomes a link that opens the file view at its line (S-1529): `src/daemon.ts:3613`, `/home/fixture/app/web/src/App.tsx:12`, `web/src/files/open.ts`.',
    'A path in mail text and in an agent\'s conversation text, outside code blocks and links (inline code is linked); the link opens `file:HOST:PATH#Lline`. `Rendered` takes a `base` (the writer\'s machine and cwd) or reads the enclosing `FileBaseCtx` provider; a mail card uses its sender\'s.', ['web/src/files/pathLinks.ts#linkFilePaths', 'web/src/files/pathLinks.ts#findPaths', 'web/src/files/pathLinks.ts#fileLinkClick', 'web/src/files/fileBase.ts#useFileBase', 'web/src/mail/Rendered.tsx#Rendered'],
    ['A path links only with a known extension or project folder (`src`, `web`, `docs`, `test`, `scripts`, `bin`, and the like), or an absolute `/home/` path; a URL, a domain (`docs.github.com/…`, `bun.sh`), `Node.js` and `and/or` never link.', 'A relative path resolves in the writer\'s cwd on its machine; with no cwd it stays text. `~/x` stays text.', 'It is an inline link in link ink that wraps with the text, so the line height and the text flow do not change on a phone.'],
    [{ name: 'Paths in text and code', render: () => <div className="story-pad"><Rendered text="Fixed in `/home/fixture/app/src/daemon.ts:3613` and /home/fixture/app/web/src/App.tsx:12. See https://example.com/src/a.ts, which stays a plain link, and Node.js." base={{ host: 'fixture-machine', cwd: '/home/fixture/app' }} /></div> },
     { name: 'Relative path with a cwd', render: () => <div className="story-pad"><Rendered text="Edit web/src/files/open.ts, then notes/todo.md." base={{ host: 'fixture-machine', cwd: '/home/fixture/app' }} /></div> },
     { name: 'Relative path without a cwd stays text', render: () => <div className="story-pad"><Rendered text="Edit web/src/files/open.ts, or /home/fixture/app/notes/todo.md." base={{ host: 'fixture-machine' }} /></div> }]),
]
