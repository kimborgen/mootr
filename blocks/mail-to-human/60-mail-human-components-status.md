---
id: mail-human-components-status
title: Mail components: tests, errors, terminal, diffs, links
summary: |
  Fenced blocks for test results, errors, terminal output, progress, before and after, diffs and details.
  Write @name and S-12 keys to link agents and ITSAs.
scope: global
kind: recipe
summary_of: 4a40f2e2da61d644558234bbd9ba3f261a720cbc6679bb2a106300f3f7e37320
---
- **Tests:** a fenced `tests` block: `212 passed`, `1 skipped`, then `FAIL name` lines with their output indented under them. Leave out passing tests unless they matter.
- **Error:** a fenced `error` block with `Message:`, `Where:`, `Cause:`, and `Fix:` lines.
- **Terminal:** a fenced `terminal` block for command output; ANSI colours show, and `$ ` lines are commands.
- **Progress:** a fenced `progress` block, one `3/5 Label` or `60% Label` line per bar.
- **Before and after:** a fenced `compare` block with `Before: NAME` and `After: NAME`, each an attached image's name or an image URL, and an optional caption line. It shows one image over the other with a slider.
- **Terminal snapshot:** a fenced `pane` block holding only an agent's name; mootr fills in that agent's screen as it is when you send, with a link that opens its terminal.
- **Diagram:** a fenced `mermaid` block (flowchart, sequence diagram, and the rest of Mermaid) for a structure or flow that's clearer drawn.
- **Diff:** a fenced `diff` block with a unified diff; it folds per file. For a PR, write `diff REPO#N` (such as `diff stam2#759`): its Open button opens that PR's live diff.
- **Details:** `<details><summary>What's inside</summary>`, a blank line, the Markdown, a blank line, `</details>`, for evidence they may skip: logs, long output, reasoning.
- **Links:** write `@name` to link an agent, an issue as its key such as `S-12` to link the ITSA (not inside code), and a mail id such as `m3228ca5` to link its thread. Code blocks get a copy button and syntax colours from their language tag.

