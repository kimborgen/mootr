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

An optional line, written after `Deploy:` with the other header lines, says where this PR sits in a planned series for its ITSA:

```
PRs: 2/4
```

The watcher reads it the way it reads `ITSA:`: from anywhere in the body, the first header line counts. A header is `PRs` followed by a colon, or by spaces and then a digit, in any case, so `prs 2/4` and `PRs : 2/4` also work. Prose that starts with `PRs` (`PRs that touch the daemon`) is not a header and is ignored. `PRs: N/M` means this is PR N of M planned for the ITSA. The deploy watcher doesn't close the ITSA when it deploys a PR with N < M; the note says `Not closed: PR N of M; M-N more planned`. A line that starts with `PRs` but isn't two whole numbers with N and M at least 1 and N at most M (for example `PRs: x/2` or `PRs 1 of 4`) is malformed: the watcher doesn't close the ITSA and its note says so. A body with no such line closes its ITSA as before.

- `ITSA:` the ITSA the branch delivers.
- `Gates:` the checks the branch needs before merge. Tokens are split on `;` and trimmed. Write `Gates: none` when there are none.
  - `tsc`: root `tsc`
  - `web-tsc`: `npm run typecheck` in `web/`
  - `web-vitest`: vitest in `web/`. The gate drops it when every changed path is under `docs/`, `test/`, `scripts/` (not `scripts/test-slot.sh`), `bin/` or `.github/`, or is a root `*.md` file. Any `src/` path keeps it, because `web/` imports `src/` directly.
  - `run NAME...`: `test/run.sh NAME...`. Takes several names and may repeat.
  - `phone`: `sh web/check/run.sh phone --only=360-light`. Added by the gate for any change under `web/`, and for the `src/` files its rule table names (auth, mail routing, archive and pin). Other `src/` changes don't add it.
  - `flow NAME`: `UI_FLOWS=NAME sh test/e2e-ui.sh`. Takes one name; for several flows write `flow a; flow b`.
  - `stories`: `scripts/story-check.mjs`. A component file you add or change must have a story that lists it in `code`, and a changed component must come with a changed story. See `docs/stories.md`.
  - `build`: `npm run build` in `web/`, on the merged tree.
  - `go`: the Go daemon's build, API-code check, vet and tests in `go/`, then the API contract against the Go daemon, run on a separate server, not the developer's machine.
  - `go` also needs `go test ./...` from `go/`, not only the touched packages: a run of the touched packages alone can pass locally and still fail the gate.
  - `go-mirror`: `go test -count=1 -timeout 20m ./...` in `go/`, on the separate server. Added when a PR changes a TS module the Go tests compare, unless it already selects `go`.
  - `go-e2e NAME...`: the named tests run against the Go daemon on a separate server. Never added by a path.
  - Merge tooling can add gates for the paths a PR touches; list what your change needs anyway.
- `Deploy:` how the branch ships
  - `normal`: batched with other branches
  - `alone`: no batching
  - `migration`: take a DB backup before deploy
  - `staged`: deploy to one machine first and hold

A web PR that changes a component without touching its stories adds one line, anywhere in the body, to say why: `Stories: unchanged, REASON` (the reason is required, for example `a refactor with no visible change`). A Stories line may also name the stories it updated, then the unchanged ones: `Stories: X updated; unchanged for Y, because REASON`.

Below the three lines, write free text: what changed, what was tested and the results, and open questions.

## Opening a PR

The developer calls the `pr_open` tool, from any machine. It runs on the ITSA home, where `gh` is. Write a `--body-file` draft outside the worktree, never in its root: a root `tmp-*.md` is gitignored, but any other draft there can be committed by `git add -A`:

- It takes the branch from where the caller works, pushes it to origin, and opens `gh pr create --base main --head BRANCH`, or, when an open PR already has that head, replaces its body. A storage that has the branch wins over the checkout's own copy; on the home, a branch storage lacks is taken from the checkout (checked out, or only a ref). Every later push to the branch needs `pr_open` again: a push to origin doesn't reach GitHub.
- With `itsa`, it links the PR (system `github`) and the branch (system `branch`) to the ITSA, once each.
- It returns the PR number and url. The developer then `watch_pr`s the PR.

Refused before any push: the base branch itself, a body that doesn't start with its ITSA, Gates, and Deploy lines, and an ITSA the caller may not change. Also refused, before any push, is a branch the merge gate's stories step would fail (checked against the merge base of origin's base branch and the branch, in a few seconds), and one that edits a shipped doc or template without its public port and manifest sha. The refusal names the file and the story, port or test it needs. Also refused is a body that doesn't report each test the gate adds for the branch's files as run (`addPathGates`, S-2250). The one accepted evidence is a token `NAME: PASS` in the free text below the header (NAME may be in backticks, PASS or PASSED in any case; several tokens may share a line, separated by `,` or `;`). A Gates listing, `ran NAME`, counts like `24/24 passed` and a bare mention don't count, a `NAME: FAIL`, `NAME: SKIPPED` or `NAME: NOT RUN` token refuses, and so does a PASS followed by a count (`pass 118`) or on a line that counts failures (`fail 2`) (the refusal quotes the line), and so does a path like `blocks/foo.md` for `blocks`. Other phrasings are refused on purpose; the refusal gives the exact line to add. Run each test with `scripts/test-slot.sh test/run.sh NAME`, rather than leaving it to the gate. Before you write the body, run `pr_open` with `predict: true` (CLI: `stam pr open BRANCH --predict`): a dry run that needs no title or body, pushes nothing to GitHub and opens no PR, and returns the predicted tests (each with its path and rule), which LIGHT ones it ran and passed, and the exact `NAME: PASS` lines the body must carry. It uses the same prediction as the real call, and a prediction that fails or times out is an error, never an empty list. pr_open refuses with the whole predicted set in one message: every test with its reason, and every missing `NAME: PASS` line. The LIGHT tests among them (plain daemon-free `node --test` files, `test/run.sh`'s `LIGHT` list) pr_open runs itself, on the head's tree, through the light test slot under a timeout: a pass counts as evidence, so the body needs no line for it. A failure, a timeout, a skipped run or a run with no result is advisory: pr_open names it in its result and in a `LIGHT advisory` section at the end of the PR body, and the body still needs its `NAME: PASS` line for it.

To fix an existing PR, spawn the developer with `base: origin/stam/X` (X the PR's branch): its worktree is on `stam/X` itself, reset to the base's commit, so it commits there and `pr_open stam/X` updates the PR with no fast-forward. The spawn is refused, naming the fix, when `stam/X` is checked out in another worktree (archive that agent) or a local `stam/X` has commits the base lacks. An archive keeps `stam/X`, the PR's branch. To open a NEW PR stacked on `stam/X` instead, also pass `branch: "new"` (the agent's own `stam/NAME`, or `stam/NAME-2`, `-3` when that name is already taken, S-3486) or a new branch name.

## Merging

The manager or owner who spawned the developer merges, not the developer and not the human. A merge needs the newest `stam/review` status on the PR's head to be success (a reviewer's `pr_review` approval) and the PR's `Gates:` green against the current `main`. A conflict or a red gate goes back to the PR's developer, who rebases and fixes. A stacked PR is retargeted to `main` before it merges. The merge command is project-specific; this snapshot doesn't ship the maintainer's merge script, so merge with `gh pr merge` once those two conditions hold. Where the build has the merge script, merge with the `pr_merge` tool (PR number) instead: it runs the script on the ITSA home and mails the result. Never gate, merge or check out branches in the checkout the deploy runs from. If you add an approval gate for instruction-file edits, count a human's yes to an ask mail that carries the ITSA chip and names the PR or a changed file, newer than the latest request for approval and not followed by a human no, as well as an approval given on the ITSA itself. A later human mail whose whole text is `approved`, `yes` or `ok` does not cancel an approval given on the ITSA itself, unless a human mail after the approval cancelled it. Keep an approval after the ITSA leaves the approval status, bound to the instruction-file changes it covered: record a digest of those changes at every push, and count the approval only when the digest at the ask and at the answer equals the digest of the head being merged.

The `pr_merge` tool runs the merge script from the deploy checkout: the one named by `STAM_DEPLOY_REPO` (otherwise stam uses the checkout it runs from). If that checkout has no merge script, `pr_merge` refuses, names the missing path, and starts nothing. This snapshot doesn't ship the script, so `pr_merge` refuses here until a checkout with the script is set.

## Watching the PR

Once the PR is open, the developer calls `watch_pr` with its number, so its checks, reviews, comments, and pushes reach it. A reviewer watches the PR it reviews the same way. A merge or close ends the watch.

- To wait for CI, `wait_for` on event with subject `github:OWNER/REPO#N` and type `checks.completed`.
- The gates post commit statuses (`stam/gates`, `stam/review`), not check runs; `checks.completed` fires on those too.

## Review

A reviewer reads the PR's title, branches, head sha, body, files changed and checks with the `pr_view` tool, from any machine, so it needs no `gh` to see them. `pr_view` also gives the merge base with the PR's base branch and one `git diff MERGE_BASE HEAD` command: read the diff with that, since a checkout's `origin/main` can lag and a range against it shows unrelated files.

A reviewer gives its verdict on the PR with the `pr_review` tool, from any machine, with `head` the full sha of the commit it reviewed:

```
stam pr review PR_NUMBER approve "SUMMARY" --head SHA
stam pr review PR_NUMBER request_changes "SUMMARY" --head SHA
```

Only a reviewer-type agent, a manager (type `manager` or `coordinator`), the chief of staff and the assistant may post a verdict, and never the agent that owns the PR's branch (the chief of staff and the assistant aren't checked for ownership); an unknown role, or unknown branches, is refused.

It posts a PR comment, `Review (AGENT): approve. SUMMARY`, and sets the `stam/review` status on the PR's head to success (approve) or failure (request_changes). A merge needs the newest `stam/review` status on the head to be success, so a new push needs a new verdict. An unknown verdict is refused. Every agent shares one GitHub account, so `gh pr review --approve` can't approve its own PRs; use the `pr_review` tool instead.

Read a PR against its merge base, `git diff origin/main...HEAD` (three dots): a two-dot diff shows main's later merges as reverts (S-1759).

## Which tools work on this build

This snapshot doesn't ship the maintainer's merge gate, merge script or review script. A tool that needs one refuses before it pushes, posts or merges anything, names the missing file, and says what to do instead.

- `pr_open` works for a repo that declares its own merge flow in a repo config on its main branch: its branch names and `Gates:` line are checked against that config. Any other repo refuses before the push, and you open the PR with `gh pr create --base main --head BRANCH --body-file FILE`, keeping the `ITSA:`, `Gates:` and `Deploy:` lines at the top of the body.
- `pr_review` refuses. Post the verdict by hand: a PR comment with `gh pr comment N --body "Review (AGENT): approve. SUMMARY"`, and the `stam/review` status on the full head sha with `gh api repos/OWNER/REPO/statuses/SHA -f state=success -f context=stam/review` (`state=failure` for request_changes).
- `pr_merge` refuses, as described under Merging; merge with `gh pr merge`.
