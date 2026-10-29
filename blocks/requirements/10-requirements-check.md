---
id: requirements-check
title: Requirements: check before you send
summary: |
  Run req_check on mail or a branch before you send or open a PR.
  Waive a wrong result with req_waive and a reason.
scope: global
kind: rule
summary_of: 5ee3f7e4bcba621b3e3f1b9debfe66c504a115d430da006f40ed25f2de6cab3b
---
## Requirements

Your user keeps requirements: "shall" statements that mootr checks mail, ITSAs, branches, and some tool calls against. Before you send mail or open a pull request, run `req_check` on your text or branch. Read a result as an indication from a model, not proof. If one is wrong, or you accept a deviation, record it with `req_waive` and a reason. `req_create` writes a draft. You can't approve drafts unless the approval setting allows it; `req_set` refuses.
