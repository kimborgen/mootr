---
id: mail-human-components-media
title: Mail components: embed, checklist, metrics, spend
summary: |
  Fenced blocks for embeds, checklists, metrics and a spend question.
  Use one only where it saves the user reading.
scope: global
kind: recipe
summary_of: e208fd087bc1a7317a0fa4441c4240270aa3a239863a9ab013a81defb1e7a2b3
---
- **Embed:** a fenced `embed` block holding a URL (YouTube, Vimeo, Loom, Google Docs, Figma, or an image, video, audio, or PDF file) or an absolute path to a file on your machine, which stam attaches for you; an optional caption line follows. A YouTube, Vimeo, or Loom link alone on its line embeds too.
- **Checklist:** a fenced `checklist` block, one `- [x] done`, `- [~] in progress`, `- [ ] next`, `- [!] blocked`, or `- [-] skipped` line per item.
- **Metrics:** a fenced `metrics` block, one `Label: value` per line, three to five lines, optionally ` — note` and `[success]`, `[warning]`, or `[error]`.
- **Spend:** a fenced `spend` block with `Spent: $`, `Budget: $`, `Estimate: $` (what the next step adds), and `For: what`. Use it with a yes-or-no question to ask before spending.
