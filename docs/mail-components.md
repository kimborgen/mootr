# Mail components

Visual components agents can put in mail. The human never writes them. Each is plain Markdown, or a fenced code block with a component name, so a mail still reads well as text in an agent's terminal.

The renderer is `web/src/mail/mailblocks.ts` (framework-free; `web/src/mail/ThreadPanel.tsx` mounts it); agents learn the syntax from `templates/mail-to-human.md`. Three tables: what's built, what isn't but is worth building (in recommended order), and what was considered and isn't worth building, with why.

## Built

| Component | Syntax | Notes |
|---|---|---|
| TLDR | First line `TLDR: one line` | Set as the mail's lead; folded messages and inbox rows show it instead of a snippet. |
| Decision | ` ```decision ` block: question lines, then `- Option: why` lines; `(recommended)` marks one | Each option is a button in the thread world. Clicking replies in the thread with `Chose **Option**.` The block then shows the choice. |
| Callout | GitHub alert: `> [!DONE]`, `[!BLOCKED]`, `[!WARNING]`, `[!NOTE]` | Also `[!INFO]`, `[!TIP]`, `[!IMPORTANT]`, `[!SUCCESS]`, `[!CAUTION]`, `[!ERROR]`, `[!FAILED]`. A hairline note with a coloured label, no tinted fill: tinted callouts are banned. |
| Details | `<details><summary>Summary</summary>` … `</details>` | Folded evidence. Markdown works inside with blank lines around it. |
| Diff | ` ```diff ` block, unified diff | One fold per file with `+`/`−` counts; folds when longer than 12 lines. |
| Metrics | ` ```metrics ` block: `Label: value`, optional ` — note`, optional `[success]`, `[warning]`, `[error]` | Three to five numbers side by side, tabular figures. |
| Agent mention | `@name` | The agent's harness mark and name in link ink; opens its world. Mention chips are banned, so it's ink, not a chip. |
| Yes or no | ` ```decision ` or ` ```yesno ` block with only a question; `(recommended: yes)` or `(recommended: no)` | Two buttons; same reply as Decision. |
| Decide later | On every Decision | Replies `Deferring this one: still open, I'll decide later.` The decision stays open (no recommendation is picked). The block then shows "You deferred this; it stays open." |
| Checklist | ` ```checklist `: `- [x]` done, `- [~]` in progress, `- [ ]` next, `- [!]` blocked, `- [-]` skipped | A status icon per line. |
| Test results | ` ```tests `: `212 passed`, `1 skipped`, `FAIL name` with indented output, optional `PASS name` | Counts, a pass and fail bar, failures with their output open, passing tests folded. |
| Spend | ` ```spend `: `Spent:`, `Budget:`, `Estimate:`, `For:` | A bar with the budget marked; over budget turns warning, or error when already spent past it. |
| Error | ` ```error `: `Message:`, `Where:`, `Cause:`, `Fix:` | |
| Terminal excerpt | ` ```terminal ` (also `console`, `log`, `ansi`) | The 16 ANSI colours on stam's terminal palette (`--ansi-*` in `web/tokens-stam.css`); `$ ` lines are commands. 256-colour and RGB codes are dropped. |
| Progress | ` ```progress `: `3/5 Label` or `60% Label` per line | One bar per line. |
| ITSA link | A key such as `S-12` in a mail's body or subject, outside code spans and code blocks | The key in link ink; opens the ITSA's world. A key no ITSA has stays plain text. |
| Thread link | A mail id such as `m3228ca5`, or a link to `#m3228ca5` | Shows the thread's subject and opens its world; through `GET /api/mail/:id/thread`. |
| Code copy | Any other fenced code block | A copy button on hover. |
| Table | Markdown table, or ` ```table ` (also `csv`, `tsv`): optional `title:`, then CSV or TSV with a header row | Numeric columns (80% of cells parse as numbers, money, percentages, or durations) right-aligned in tabular figures; every header sorts on click; tables over 18 rows fold after 15 with **Show all**; `[success]`, `[warning]`, `[error]` colour a cell; wide tables scroll. |
| Chart | ` ```chart ` (also `graph`, `plot`): `type: bar, line, area, donut`, optional `title:`, `caption:`, `x:`, `y:`, `unit:`, `stacked: yes`, `height:`, `min:`, `max:`; then CSV with the x column first and one column per series | SVG drawn at the sheet's width and redrawn when it changes. A hover readout lists every series at that x. Series take `--series-1` to `--series-6`, or a harness's hue when named for it. Empty cells leave gaps in lines. A **Data** fold holds the numbers as a table. |
| Answers | Every button (option, yes or no, pick, rank, Decide later, Approve, Deny) | A click stages an answer and marks it in the mail; clicking again takes it back. Nothing is sent until **Send**. The reply box takes context for the answers, and a rendered preview above it shows exactly what goes out: one reply quoting each question, then the context. **Add a note** on a decision block puts the reply box in note mode for that block (it names the question; its submit button becomes **Add note**, a check): Enter or the button puts the note in the block, under the options, and in the preview; Escape or **×** cancels; the note has **Edit** and **Remove**. The block's answer then ends `Note: TEXT`, after the chosen option or alone, which answers in the human's own words. Permission answers go through the permission API, the text as their note. |
| Rank | ` ```rank ` block, like a decision, options in the suggested order | Rows drag, or move with arrows; any move, or **Keep this order**, stages `Ranked: 1. **A**, 2. **B**.` |
| Timeline | ` ```timeline `: `TIME — event` per line, optional tone tag | A hairline with a dot per event in its tone. |
| Math | ` ```math `, `$$…$$`, `\( … \)` | KaTeX 0.16.11, loaded on first use. A single `$` stays a dollar sign. |
| Embed | ` ```embed ` (also `video`, `audio`, `image`, `file`): a URL or an absolute path, then an optional caption | YouTube (privacy-enhanced), Vimeo, Loom, Google Docs and Drive, and Figma in a sandboxed iframe; image, video, audio, and PDF URLs as players. A path on the sender's machine is attached by their daemon at send time (up to 100 MB) and played or shown from the attachment, which serves ranges and takes the token in its URL. Text files show their first 200 lines, highlighted. A YouTube, Vimeo, or Loom link alone on its line embeds too. |
| Syntax highlighting | A language tag on a fenced code block | highlight.js 11.9.0 on stam's syntax tokens; untagged blocks are guessed only when the guess is confident. |
| More charts | `type: scatter`, `radar`, `radial`, or `horizontal: yes` on bars | Scatter: x against one or more series, or named points from `label, x, y`, with a nearest-point readout. Radar: a spoke per category, a polygon per series. Radial: an arc per category as a share of the max (100 for percentages). Horizontal bars for long names. |
| Diagram redraw | Automatic | A theme change redraws every diagram in the new colours. |
| Pick several | ` ```pick ` block, like Decision; `(recommended)` options start ticked | Checkbox rows and **Send**; replies `Picked **A**, **B**.` Also has Decide later and Add a note. |
| Before and after | ` ```compare `: `Before: NAME`, `After: NAME` (attachment names or image URLs), optional caption | The after image under the before image, clipped at a slider. Images it shows leave the attachment strip. |
| Pane | ` ```pane ` holding an agent's name | The sender's daemon fills in that agent's screen with its colours (`tmux capture-pane -e`, last 40 lines) at send time, so the mail keeps the moment; **Open terminal** opens the agent's world. Agents on another machine stay a link. |
| Diagram | ` ```mermaid ` or ` ```diagram ` | Drawn by Mermaid 11.4.1, loaded on first use, in the design tokens' colours; drawings are cached per theme and source. Source that doesn't parse shows with the reason. |

## Conversation components

Shared React components in `web/src/mail/` that draw an agent's conversation the way mail draws a thread (S-1483), so the conversation view and other mail-like views use one set. Their stories list their states.

| Component | Where | Notes |
|---|---|---|
| Tool call | `ToolCall` in `web/src/mail/ToolGroup.tsx`: `name`, `input`, `result`, `status` | One row: status icon, name, the input's one-line summary (`toolLine`); open, the full input and the result. |
| Tool group | `ToolGroup` in `web/src/mail/ToolGroup.tsx`: `tools`, each a tool call with an `id` | A run of consecutive calls in one drawer, closed by default; the header counts the calls and shows the latest. |
| Conversation mail card | `ConvMailCard` in `web/src/mail/ConvMailCard.tsx`: `m` (a mail-like object: sender, recipients with read times, subject, body, time, thread), optional `self` | Sender and recipients, read state, time, subject, body; a long body previews three lines with Show all; Open thread. A mail `self` sent heads with who it went to. Mail from or to the human (`withHuman`) reads raised, apart from mail between agents. |
| Turn | `TurnFrame` in `web/src/mail/TurnFrame.tsx`: `id`, `kind`, `input`, children | One turn: its input as a card on top, the response full width below; turns separated by a hairline like a thread's messages. `kind` is `turnKind()`: `human`, `human-mail`, `mail`, `notice`, or `start`. |
| Notice line | `NoticeLine` in `web/src/mail/TurnFrame.tsx`: `text`, optional `line` | A stam notice folded to one line (its first, or `line`); a tap or click opens the full text. |

The conversation's turns come from `turns()` in `web/src/views/ownview-model.ts`: each input (the human's message, a mail into the agent, a stam notice) opens a turn that runs until the next input; the notice that only says mail came joins the mail's turn. The input variants' look is one block in `web/style.css` (`.ov-turn`, `.conv-mail`).

## Not built, recommended

In the order to build them. Effort is for one session's work, including a browser check.

| Component | What it does | Why | Effort |
|---|---|---|---|
| Plan approval | An agent's plan as numbered steps; the human keeps or strikes each, then sends once. | Agents propose plans more than anything else, and today the answer is free text. | About an hour |
| Remind me later | Next to Decide later: 1 hour, tonight, or tomorrow. The thread returns to the top of the mail, unread, then. | Lets mail wait without being lost; fits mail only when necessary. | About an hour, daemon included |
| Spawn suggestion | Harness, model, folder, and first prompt filled in, with **Start**. | The assistant's job is spawning agents; this makes it one click. | About an hour |
| Live agent card | An agent's state, current task, context, and spend, updating while open. Also covers a health summary of machines and agents. | Mail goes stale; a live card shows now. | About an hour and a half |
| Listen | Reads a mail aloud through the browser's speech. | A first step toward voice-first. | About 45 minutes |
| Commit card | Hash, message, and files, linking to its diff. | Agents report commits often. | About 45 minutes |
| Inline sparkline | A small line inside a sentence. | Trends without a whole chart. | About 45 minutes |
| Diff file links | File paths in a diff open the file. | Needs a file viewer first, for both machines. | Half a day |
| File preview | A file in the repository, by path, without attaching it. | Embed attaches files; this would show the live file. Shares the diff links' file viewer. | An hour after the viewer |
| Audio clip | A voice note with its transcript folded. | Belongs with voice input, which is later. | With voice input |

## Not recommended

| Idea | Why not |
|---|---|
| Heading, text, inline styles, separator | Markdown already does them. |
| Accordion | Details covers it. |
| Horizontal layout, resizable | Mail is one column and must work on a phone. |
| World block | Pane covers the case that matters, an agent's screen. |
| Artifact embed | Embed covers files from the sender's machine. |
| Cross-reference | Thread links cover references between mails; mail is too short to need numbered figures. |
| Citation | No reference library in stam. |
| Hidden metadata | Agents mail each other directly; nothing to hide from the human. |
| PDF quote | stam has no PDFs. |
| Merged table cells | Complicates tables for a rare case. |
| Spreadsheet table, dataset table | Mail is read, not edited; an agent can attach a CSV. |
| Generated output | Charts and tables from the agent cover it. |
| Approval card | Built differently: a permission request is a mail with Approve and Deny. |
| Action log | Belongs in an agent's details tab, not in mail. |
| Search results | No search subsystem. |
| Yes-or-no free answer box | Add a note does it through the reply box. |
| Run command | A button that runs commands is a security risk; the permission system already covers approvals. |
| Tree | Nested lists and Details do it. |
| Architecture sketch | Diagrams do it. |
| Image gallery | The attachment strip shows several images. |
| Link preview | The server would fetch arbitrary URLs: a privacy and security cost for little gain. Embed shows other links as a plain link card. |
| Glossary, footnote | Mail to the human must be short; a term that needs a definition needs rewriting. |
