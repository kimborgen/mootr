Meant for your user. Forward it only if they need it. Subject: S-2077 Retro edits Oct 19

**retro-steward-1019b needs you:** S-2077 Retro edits Oct 19 · needs approval · Approve, Request changes

Needs Approve. Summary is in the ITSA body; the instruction-text diff follows (uncommitted in my worktree; the reviewer-opus block is a copy of the reviewer one; fixtures, `summary_of` hashes, export manifest/overrides and the 23 `instruction-sources.md` rows are derived or bookkeeping).

```diff
+++ b/blocks/type-reviewer/20-reviewer-checks.md   (same text in blocks/type-reviewer-opus/20-reviewer-opus-checks.md)
+A test fixture must reach the changed path: an order test needs values the comparator reorders, a synthetic event or row must match what the production writer persists, and a jsdom event must fire on the target a browser fires it on (`dragstart` fires on the draggable ancestor). `git grep` every changed name, label, export and state for its readers, tests and agent-facing text, and diff the docs a fix-up edits against its code; a PR that redefines a derived state (busy, idle) or adds a destructive step (kill, rest) owns the loss it causes. For a lock, release or cleanup change, trace both directions of the mixed old/new period (first deploy, every rollback): older deployed code must keep exclusion with the new, and a concurrent activation must not lose its target. A race the PR adds or widens blocks; one main already had doesn't. Read files at the reviewed sha (`git show SHA:path`), not a developer's live worktree. If a re-review's head merges main, `git diff MAINTIP HEAD --stat` against the fix commit's stat shows what the merge added.

+++ b/blocks/type-developer/40-developer-before-report.md
+Before you call a change local, grep tests, `web/check`, `web/src`, docs and readers for every changed name, label, export and state (an activity value's readers include busy counts and tree-idle notices), and run those tests, naming the file from the command `test/run.sh` prints (`retro` is not `retro-unit`). A change that swaps a directory a running agent uses builds aside, renames, and gitignores each temp name. After a reviewer approves, push nothing unless your manager asks: a new head voids the approval. Where the task and this brief differ, the task wins (it may say another agent opens the PR).

--- a/blocks/type-manager/30-manager-mail-wait.md
-When you brief a reviewer on another machine, say where the branch lives and how to fetch it.
+Brief a reviewer with the PR, branch and full head only: its own brief fetches the branch, so don't say how. Briefing a lock, cap, quota or other check-then-act fix, ask for one consistent view (one fd for `fstat` and read) or a slot reserved from the check to the commit, and an interleaving test. Briefing a fix that decides agreement from agent output, require fail-closed parsing: an unreadable or missing verdict blocks. A brief that says "docs only" names `test/run.sh export` when the docs ship in the export. Archive a developer only after its own done mail on the final head, not on a reviewer's approval.

+++ b/templates/ring-turn.md   (before "Submit your contribution")
+If you and a peer split on whether a residual race blocks: it blocks when the change adds the race or widens its window, or breaks exclusion with older deployed code; one the code already had is a follow-up. A member whose sandbox has no network (Codex) names the shell checks it couldn't run, and a member with network runs them for the whole list.

+++ b/docs/pull-requests.md   (before "On host1, a developer may still run")
+Moving or splitting a doc into `docs/` ships it in the public export: before you move it, check `export/exclude.txt` and `test/export.test.mjs` for leaks (a VPN host name, a mention of an excluded test, a test that needs `npm test`), and name `test/run.sh export` in Gates.

+++ b/docs/testing.md   (before "Reproduce a scale or perf bug")
+- A test that inserts database rows or fires DOM events by hand mirrors the production path: use the event names and rows the production writer persists (the daemon broadcasts `agent.archived` and persists archive), and fire a jsdom event on the target a browser fires it on (`dragstart` fires on the draggable ancestor, not its child button) (S-789, S-1904).
```

The export overrides for type-reviewer, type-reviewer-opus, type-manager and type-developer carry the same text (developer and manager without the `web/` and `export` mentions, which the public leak test rejects).