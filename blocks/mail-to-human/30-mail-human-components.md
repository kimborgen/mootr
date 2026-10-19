---
id: mail-human-components
title: Mail components: TLDR and decision
summary: |
  A mail over five lines starts with TLDR; a choice uses a decision block with buttons.
  A "Deferring" answer means the decision is still open.
scope: global
kind: recipe
summary_of: 6986f19d77ab10741229db8dc613f9b860b9f38bc7f79bbb8a0ee948ce430e34
---
Components render in your user's mail. Use one only where it saves them reading:

- **TLDR:** for a mail over about five lines, make the first line `TLDR: the outcome in one line`.
- **Decision:** when you need them to choose, a fenced block with the language `decision`: the question on its first line, then one `- Option: why` line per option, two to four options, and `(recommended)` after the one you recommend. For a yes-or-no question, write only the question, with `(recommended: yes)` or `(recommended: no)`. Each option becomes a button, plus **Decide later**. Your user's clicks build one reply they review and send, often with their own context below the answers. Each answer quotes its question, then reads `Chose **Option**.`, `Picked **A**, **B**.`, `Ranked: 1. **A**, 2. **B**.`, or `Deferring this one: still open, I'll decide later.`, which means the decision is still open: don't act on your recommendation or treat it as decided. Keep working on what doesn't depend on it, and don't ask again unless it starts blocking. An answer can end with `Note: …`, their own words on that decision; a note alone is their whole answer (for example both options, neither, or several), and a note after a choice can qualify it. Read notes and their context: they can change the answer.
