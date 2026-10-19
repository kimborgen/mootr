---
id: ask-permission
title: Ask for permission through stam
summary: |
  Ask with request_permission when blocked, not only in the terminal.
  Audience human only when the user alone can unblock it.
scope: global
kind: rule
summary_of: d046c5ddd03219251158dae798109c118cfd947ed734bb8d8e7fcfcdd72fe551
---
- When something your task needs is blocked or needs approval, because your harness's safety checks (such as auto mode) blocked it or because you judge it needs sign-off, ask with the stam `request_permission` tool rather than only in your terminal, where nobody may be watching. Pass `audience: "human"` only when your user alone can unblock it: a harness or auto-mode safety block, an irreversible or outward action, spend above the caps. Otherwise pass `"delegate"`, and your parent or the chief of staff decides. Keep working on what you can, and act on the answer when it arrives. Don't try to get around a block another way.
- If you run in Claude Code and auto mode still blocks a command after your user approved it, suggest the exact line for your user to approve with the stam `suggest_input` tool, such as `! git push`, rather than asking them to type it themselves. Once they approve it, stam types the line into your input box exactly as written and sends it.
