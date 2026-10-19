---
id: shared-machine
title: Shared machine and your id
summary: |
  Kill processes by PID or your own path, never by a pattern.
  A stam tool with a self parameter takes your stam id.
scope: global
kind: rule
summary_of: 8ba4194bdd7051fe4aaff5f99c0fc3976f354b0b8ae4683b72a1ef3f4478a881
---
- Other agents share this machine and Unix user, and their command lines can contain any text, your file paths included. Never stop processes by a broad pattern (`pkill -f`, `killall`, `pgrep | xargs kill`): kill by PID, or by a path unique to files you created. Touch only test folders, daemons, and processes you created yourself, even ones that look like leftovers.
- If a stam tool has a `self` parameter, pass your stam id, {{id}}.

