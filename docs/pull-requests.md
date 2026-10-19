# Pull requests

Each branch gets one pull request on GitHub. The human doesn't merge; the manager or owner who spawned the developer does, once the PR has a reviewer's approval and its gates are green.

## Body format

The three lines are the very first lines of the body. Later steps parse them, so keep the labels and order exactly. Stacked PRs use the same format.

```
ITSA: S-123
Gates: tsc; web-tsc; web-vitest; run NAME NAME; phone; flow NAME
Deploy: normal
```

Allowed `Deploy:` values: `normal`, `alone`, `migration`, `staged`.

- `ITSA:` the ITSA the branch delivers.
- `Gates:` the checks the branch needs before merge. Tokens are split on `;` and trimmed. Write `Gates: none` when there are none.
  - `tsc`: root `tsc`
  - `web-tsc`: `npm run typecheck` in `web/`
  - `web-vitest`: vitest in `web/`
  - `run NAME...`: `test/run.sh NAME...`. Takes several names and may repeat.
  - `phone`: `sh web/check/run.sh phone --only=360-light`
  - `flow NAME`: `UI_FLOWS=NAME sh test/e2e-ui.sh`. Takes one name; for several flows write `flow a; flow b`.
  - `stories`: `scripts/story-check.mjs`. A component file you add or change must have a story that lists it in `code`, and a changed component must come with a changed story. See `docs/stories.md`.
  - `build`: `npm run build` in `web/`, on the merged tree.
  - Merge tooling can add gates for the paths a PR touches; list what your change needs anyway.
- `Deploy:` how the branch ships
  - `normal`: batched with other branches
  - `alone`: no batching
  - `migration`: take a DB backup before deploy
  - `staged`: deploy to one machine first and hold

A web PR that changes a component without touching its stories adds one line, anywhere in the body, to say why: `Stories: unchanged, REASON` (the reason is required, for example `a refactor with no visible change`). A Stories line may also name the stories it updated, then the unchanged ones: `Stories: X updated; unchanged for Y, because REASON`.

Below the three lines, write free text: what changed, what was tested and the results, and open questions.

## Opening a PR

The developer calls the `pr_open` tool, from any machine. It runs on the ITSA home, where `gh` is:

- It takes the branch from where the caller works, pushes it to origin, and opens `gh pr create --base main --head BRANCH`, or, when an open PR already has that head, replaces its body.
- With `itsa`, it links the PR (system `github`) and the branch (system `branch`) to the ITSA, once each.
- It returns the PR number and url. The developer then `watch_pr`s the PR.

Refused before any push: the base branch itself, a body that doesn't start with its ITSA, Gates, and Deploy lines, and an ITSA the caller may not change. Also refused, before any push, is a branch the merge gate's stories step would fail (checked against the merge base of origin's base branch and the branch, in a few seconds), and one that edits a shipped doc or template without its `export/overrides/` port and manifest sha. The refusal names the file and the story or port it needs.

## Merging

The manager or owner who spawned the developer merges, not the developer and not the human. A merge needs the newest `stam/review` status on the PR's head to be success (a reviewer's `pr_review` approval) and the PR's `Gates:` green against the current `main`. A conflict or a red gate goes back to the PR's developer, who rebases and fixes. A stacked PR is retargeted to `main` before it merges. The merge command is project-specific; this snapshot doesn't ship the maintainer's merge script, so merge with `gh pr merge` once those two conditions hold. Never gate, merge or check out branches in the checkout the deploy runs from.

## Watching the PR

Once the PR is open, the developer calls `watch_pr` with its number, so its checks, reviews, comments, and pushes reach it. A reviewer watches the PR it reviews the same way. A merge or close ends the watch.

- To wait for CI, `wait_for` on event with subject `github:OWNER/REPO#N` and type `checks.completed`.
- The gates post commit statuses (`stam/gates`, `stam/review`), not check runs; `checks.completed` fires on those too.

## Review

A reviewer gives its verdict on the PR with the `pr_review` tool, from any machine, with `head` the full sha of the commit it reviewed:

```
stam pr review PR_NUMBER approve "SUMMARY" --head SHA
stam pr review PR_NUMBER request_changes "SUMMARY" --head SHA
```

It posts a PR comment, `Review (AGENT): approve. SUMMARY`, and sets the `stam/review` status on the PR's head to success (approve) or failure (request_changes). A merge needs the newest `stam/review` status on the head to be success, so a new push needs a new verdict. An unknown verdict is refused. Every agent shares one GitHub account, so `gh pr review --approve` can't approve its own PRs; use the `pr_review` tool instead.

Read a PR against its merge base, `git diff origin/main...HEAD` (three dots): a two-dot diff shows main's later merges as reverts (S-1759).
