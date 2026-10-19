# Instruction sources

One row per instruction rule a retro proposal added or changed: the file it lives in, a
grep-able quote of the rule, the retro items behind it, the proposal key, and the date.

The retro steward maintains this map (see `blocks/type-retro-steward/`): it reads a rule's row
to find the item a new item contradicts, then revises or drops that rule, and it adds or updates
a row for each edit in its proposal's diff. So a sentence exists only while an item is behind it,
and a reader can see why a sentence exists.

Quotes are exact substrings of the file, so `grep -F 'QUOTE' FILE` finds the rule. A row is
dropped when its rule no longer exists in the file.

When a block is trimmed to fit its token cap, check that qualifiers which change behaviour survive
the trim; S-1280's trim dropped one and the rule read as its opposite (S-1307).

| File | Rule | Retro items | Proposal | Date |
| --- | --- | --- | --- | --- |
| `CLAUDE.md` | the view switch flow is `sh test/e2e-ui-viewtoggle.sh` | S-183 | S-295 | 2026-10-14 |
| `CLAUDE.md` | Before you call a phone-check failure pre-existing, run it on main: `OWN_VIEW=1 VIEW_TOGGLE=1` | S-182 | S-295 | 2026-10-14 |
| `CLAUDE.md` | A `timeout` around `web/check/phone.mjs` also counts the wait for the Chromium lock | S-199 | S-295 | 2026-10-14 |
| `CLAUDE.md` | Probe the DOM before you rerun a failed check | S-251 | S-295 | 2026-10-14 |
| `CLAUDE.md` | Keep each e2e run in its own command, and don't chain a second after a `UI_FLOWS` run | S-250 | S-295 | 2026-10-14 |
| `CLAUDE.md` | A change to hook behaviour touches both `src/cli.ts` and `bin/stam-fast` | S-191 | S-295 | 2026-10-14 |
| `CLAUDE.md` | Test a UI or data change on a realistic-scale fixture too | S-218 | S-295 | 2026-10-14 |
| `blocks/type-developer/10-developer-change.md` | Commit in small logical commits on the branch you were spawned on (don't make another) | S-179 | S-623 | 2026-10-14 |
| `blocks/type-developer/10-developer-change.md` | check `git status --short` is clean before you report the head | S-361 | S-623 | 2026-10-14 |
| `blocks/type-developer/20-developer-worktree.md` | never switch branches or install in `~/projects/stam2` | S-464 | S-623 | 2026-10-14 |
| `blocks/type-developer/20-developer-worktree.md` | The spawned worktree's `node_modules` is already linked; on a miss, wait for the background fill | S-491 | S-1051 | 2026-10-15 |
| `blocks/type-developer/20-developer-worktree.md` | Tests that depend on the machine set `STAM_MACHINE` explicitly and never use a real machine name | S-409 | S-623 | 2026-10-14 |
| `blocks/type-developer/20-developer-worktree.md` | A new tool or API parameter gets a default (and is logged), never required at first | S-449 | S-623 | 2026-10-14 |
| `blocks/type-developer/20-developer-worktree.md` | Run the full touched-test command green before any push | S-334 | S-623 | 2026-10-14 |
| `blocks/type-manager/20-manager-merge.md` | check it is on the PR's current head | S-553 | S-623 | 2026-10-14 |
| `blocks/type-manager/20-manager-merge.md` | must pass the `phone` gate on its final head even if it touches no UI | S-575, S-598, S-365 | S-623 | 2026-10-14 |
| `blocks/type-manager/30-manager-mail-wait.md` | Before you end a turn with a child still running, `wait_for` it with a `timeout_minutes` | S-193 | S-295 | 2026-10-14 |
| `blocks/type-manager/30-manager-mail-wait.md` | Mail a child in a new thread (`new_thread: true`) | S-283 | S-295 | 2026-10-14 |
| `blocks/type-manager/30-manager-mail-wait.md` | Spawn a reviewer without `itsa` | S-291 | S-295 | 2026-10-14 |
| `blocks/type-manager/30-manager-mail-wait.md` | When you brief a reviewer on another machine, say where the branch lives | S-264 | S-295 | 2026-10-14 |
| `blocks/type-reviewer/10-reviewer-brief.md` | not a range the brief or PR body names | S-792, S-996, S-998 | S-1022 | 2026-10-15 |
| `blocks/type-reviewer/10-reviewer-brief.md` | If you can't fetch the branch, mail your parent at once | S-264 | S-295 | 2026-10-14 |
| `blocks/type-reviewer-opus/10-reviewer-opus-brief.md` | not a range the brief or PR body names | S-792, S-996, S-998 | S-1022 | 2026-10-15 |
| `registry/defaults.json` | Commit on the branch you were spawned on; don't create another | S-179 | S-295 | 2026-10-14 |
| `registry/defaults.json` | elsewhere `git fetch ~/projects/stam2.git refs/pull/N/head:refs/pr/N` (each PR's head is mirrored there) | S-639, S-734 | S-1353 | 2026-10-16 |
| `.claude/skills/system-view-motion/SKILL.md` | A PR that adds or changes motion ships its own real-browser check in its first commit | S-1234 | S-1280 | 2026-10-16 |
| `blocks/retro/10-retro-record.md` | for improve and instruction items | S-1228 | S-1280 | 2026-10-16 |
| `blocks/type-developer/10-developer-change.md` | Rebase onto a freshly fetched | S-767, S-765 | S-1280 | 2026-10-16 |
| `docs/itsa-design.md` | Walk an agent's children or descendants only through `src/tree.ts` (`childrenOf`, `descendantsOf`) | S-1379, S-1405 | S-1391 | 2026-10-17 |
| `blocks/type-reviewer/20-reviewer-checks.md` | A test fixture must reach the changed path | S-1780, S-1904, S-789 | S-2077 | 2026-10-19 |
| `blocks/type-reviewer/20-reviewer-checks.md` | `git grep` every changed name, label, export and state | S-2015, S-2029, S-1649 | S-2077 | 2026-10-19 |
| `blocks/type-reviewer/20-reviewer-checks.md` | trace both directions of the mixed old/new period | S-1878, S-1920, S-1921, S-1865, S-1935 | S-2077 | 2026-10-19 |
| `blocks/type-reviewer/20-reviewer-checks.md` | Read files at the reviewed sha | S-1954 | S-2077 | 2026-10-19 |
| `blocks/type-reviewer/20-reviewer-checks.md` | `git diff MAINTIP HEAD --stat` | S-1733 | S-2077 | 2026-10-19 |
| `blocks/type-manager/30-manager-mail-wait.md` | Brief a reviewer with the PR, branch and full head only | S-1870, S-1998, S-1954 | S-2077 | 2026-10-19 |
| `blocks/type-manager/30-manager-mail-wait.md` | one consistent view (one fd for `fstat` and read) | S-1952, S-2017 | S-2077 | 2026-10-19 |
| `blocks/type-manager/30-manager-mail-wait.md` | require fail-closed parsing | S-1846 | S-2077 | 2026-10-19 |
| `blocks/type-manager/30-manager-mail-wait.md` | names `test/run.sh export` | S-1901 | S-2077 | 2026-10-19 |
| `blocks/type-manager/30-manager-mail-wait.md` | Archive a developer only after its own done mail | S-1787 | S-2077 | 2026-10-19 |
| `blocks/type-developer/40-developer-before-report.md` | Before you call a change local | S-2009, S-1798, S-1821, S-2000 | S-2077 | 2026-10-19 |
| `blocks/type-developer/40-developer-before-report.md` | builds aside, renames, and gitignores each temp name | S-1782, S-1783 | S-2077 | 2026-10-19 |
| `blocks/type-developer/40-developer-before-report.md` | push nothing unless your manager asks | S-1804 | S-2077 | 2026-10-19 |
| `blocks/type-developer/40-developer-before-report.md` | Where the task and this brief differ, the task wins | S-840 | S-2077 | 2026-10-19 |
| `templates/ring-turn.md` | split on whether a residual race blocks | S-1935, S-1882 | S-2077 | 2026-10-19 |
| `templates/ring-turn.md` | names the shell checks it couldn't run | S-1923, S-1912 | S-2077 | 2026-10-19 |
| `docs/pull-requests.md` | Moving or splitting a doc into `docs/` ships it | S-1901, S-1908 | S-2077 | 2026-10-19 |
| `docs/testing.md` | mirrors the production path | S-789, S-1904 | S-2077 | 2026-10-19 |
| `blocks/type-reviewer-opus/20-reviewer-opus-checks.md` | A test fixture must reach the changed path | S-1780, S-1904, S-789 | S-2077 | 2026-10-19 |
| `blocks/type-reviewer-opus/20-reviewer-opus-checks.md` | `git grep` every changed name, label, export and state | S-2015, S-2029, S-1649 | S-2077 | 2026-10-19 |
| `blocks/type-reviewer-opus/20-reviewer-opus-checks.md` | trace both directions of the mixed old/new period | S-1878, S-1920, S-1921, S-1865, S-1935 | S-2077 | 2026-10-19 |
| `blocks/type-reviewer-opus/20-reviewer-opus-checks.md` | Read files at the reviewed sha | S-1954 | S-2077 | 2026-10-19 |
| `blocks/type-reviewer-opus/20-reviewer-opus-checks.md` | `git diff MAINTIP HEAD --stat` | S-1733 | S-2077 | 2026-10-19 |

S-1391 measured (S-1405, S-1447): the predicted effect held for new calls, which went through `src/tree.ts`, and
missed the existing copies. The grep gate covered only the `db.childrenOf(` call, so attribution, activity-summary,
usage-drill, agent-costs and issue-costs kept walking `agent_parents` in raw SQL and still left out peer children.
S-1447 moved them onto `tree.edges` and widened the gate to the table.

## Dropped

- `registry/defaults.json`: the S-295 edit also set `in_review` only once the parent says the
  branch is with release (S-243). That rule is gone from the file, so its row is dropped.
