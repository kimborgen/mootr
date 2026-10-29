---
id: mail-human-components-media
title: Mail components: embed, checklist, metrics, spend
summary: |
  Fenced blocks for embeds, checklists, metrics and a spend question.
  Use one only where it saves the user reading.
scope: global
kind: recipe
summary_of: af01b647fd92a6601a98fb9505c609396cab45a79aee7dbac05a270bc094d7af
---
- **Embed:** a fenced `embed` block holding a URL (YouTube, Vimeo, Loom, Google Docs, Figma, or an image, video, audio, or PDF file) or an absolute path to a file on your machine, which mootr attaches for you; an optional caption line follows. A YouTube, Vimeo, or Loom link alone on its line embeds too.
- **Checklist:** a fenced `checklist` block, one `- [x] done`, `- [~] in progress`, `- [ ] next`, `- [!] blocked`, or `- [-] skipped` line per item.
- **Metrics:** a fenced `metrics` block, one `Label: value` per line, three to five lines, optionally ` — note` and `[success]`, `[warning]`, or `[error]`.
- **Spend:** a fenced `spend` block with `Spent: $`, `Budget: $`, `Estimate: $` (what the next step adds), and `For: what`. Use it with a yes-or-no question to ask before spending.
