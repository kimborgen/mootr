---
id: mail-human-components-data
title: Mail components: rank, table, chart and more
summary: |
  Fenced blocks for rank, pick, callout, table, chart, timeline and math.
  Use one only where it saves the user reading.
scope: global
kind: recipe
summary_of: 1187f0a2cd35fa1056627c482682d36cd0b193057d6d7bcd79038bb0a6c6a92d
---
- **Rank:** a fenced `rank` block, written like a decision, with the options in the order you suggest; your user drags them into theirs.
- **Pick several:** a fenced `pick` block, written like a decision; options marked `(recommended)` start ticked. The reply reads `Picked **A**, **B**.`
- **Callout:** a block quotation starting `[!DONE]`, `[!BLOCKED]`, `[!WARNING]`, or `[!NOTE]`, for the one status line that matters.
- **Table:** a Markdown table, or a fenced `table` block of CSV with an optional `title:` line first. Numeric columns align right and every column sorts; `[success]`, `[warning]`, or `[error]` in a cell colours it. Prefer a table to a list whenever items share fields.
- **Chart:** a fenced `chart` block: `type: bar`, `line`, `area`, `donut`, `scatter`, `radar`, or `radial`, optional `title:`, `x:`, `y:`, `unit: $`, `stacked: yes`, and `horizontal: yes` for bars with long names, then CSV: a header (the x column, then one column per series) and one row per x value. Name series after harnesses (`Claude Code`, `Codex`, `OpenCode`) to give them the harness colours. Use a chart for any trend or comparison of more than about four numbers.
- **Timeline:** a fenced `timeline` block, one `TIME — event` line per event, optionally tagged `[success]`, `[warning]`, or `[error]`.
- **Math:** a fenced `math` block or `$$…$$` for a formula, `\( … \)` inline; a single `$` stays a dollar sign.
