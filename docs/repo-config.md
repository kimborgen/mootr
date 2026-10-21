# Repo config: gates and merges by `.stam/repo.json`

A repo's merge flow lives in one file, `.stam/repo.json`, at the root of the repo. It names the gates a pull request runs, the statuses a merge needs, how it merges, and what deploys it. Two shipped scripts read it: `scripts/repo-gate.mjs` and `scripts/repo-merge.mjs`. `pr_open` reads it too, to check a PR's `Gates:` line before anything is pushed. Change your flow by editing this file, not stam.

The scripts read the file from the main branch as fetched at that moment, never from the PR's branch or a working tree. A PR that edits `.stam/repo.json` changes nothing about its own gates or merge; the change applies to PRs after it merges.

## Schema

| Key | Default | Meaning |
| --- | --- | --- |
| `github` | `null` | The GitHub repo, `OWNER/NAME`. Unset, `gh` takes it from the checkout's `origin`. |
| `mainBranch` | `main` | The branch PRs merge into. It must agree with the trusted main branch (see below). |
| `branchPrefix` | `stam/` | `pr_open` refuses a branch that doesn't start with it. `""` allows any name. |
| `gates` | `[]` | The checks, each `{ "name", "command", "when" }`. |
| `requiredStatuses` | `["stam/review"]` | Commit status contexts that must be `success` on the PR's current head before a merge. |
| `merge` | `{ "method": "merge", "command": null }` | `method` is `merge`, `squash` or `rebase`. `command` replaces the `gh pr merge` call. |
| `deploy` | `null` | A shell command run after the merge. |
| `home` | `null` | The machine that merges. Unset, any machine may. |

Unknown keys, malformed values, and duplicate gate names are refused, with every problem named. A file over 256 KB, a symlink, or a file git can't read is an error, never "no config".

### Gates

- `name`: letters, digits, `_` and `-`. `none` and `auto` are reserved.
- `command`: run with `sh -c` at the root of the merged tree, with `STAM_GATE=1` set (see [Isolation](#isolation) for the rest of its environment). Exit 0 passes.
- `when`: which PRs run the gate.
  - Unset or `null`: every PR.
  - A path glob, or a list of them: a PR that changes a matching path.
  - `[]`: only a PR whose `Gates:` line names the gate.

Globs match repo-relative paths. Supported: `*` within a path segment, `**` across segments, `?`, a class `[abc]`, `[a-z]` or `[!a]`, and one level of braces `{a,b}`. Refused: an empty glob, a leading `/`, a `.` or `..` segment, a backslash, an unclosed or empty class, a nested or unclosed brace, and a stray `]` or `}`.

The PR body's `Gates:` line names gates by name, separated by `;`. `Gates: auto` (or `Gates: none`) names none, so only the gates picked by `when` run. An unknown name is refused when the PR opens.

### Settings fallback

`settings.itsa.repoConfig` maps a repo name (as in `settings.itsa.repos`) to an object with the same keys. It fills the keys the file leaves out, and a repo with no file uses it alone. `merge` merges per field. A repo with neither keeps stam's built-in flow.

### Trusted main branch

The branch a PR must target is taken from something the PR can't change: the fallback's `mainBranch`, else `origin`'s default branch. The config is read only from that branch, so a PR aimed at a branch it controls can't bring its own config. A file whose `mainBranch` names another branch is an error.

`pr_open` uses the same branch: it reads the config there, and opens the PR against it. A repo with no config keeps `settings.itsa.mainBranch`.

## Example

```json
{
  "github": "acme/widgets",
  "branchPrefix": "stam/",
  "gates": [
    { "name": "typecheck", "command": "npm ci && npm run typecheck" },
    { "name": "unit", "command": "npm test", "when": ["src/**", "test/**", "package*.json"] },
    { "name": "docs", "command": "npx markdownlint-cli2 'docs/**/*.md'", "when": "docs/**" },
    { "name": "e2e", "command": "npm run e2e", "when": [] }
  ],
  "requiredStatuses": ["stam/review", "ci/build"],
  "merge": { "method": "squash" },
  "deploy": "./scripts/deploy.sh"
}
```

A PR that changes `src/app.ts` with `Gates: auto` runs `typecheck` and `unit`; with `Gates: e2e` it runs `e2e` as well.

## The gate

```sh
node scripts/repo-gate.mjs PR_NUMBER
```

It fetches the main branch and the PR head, makes a scratch clone at main, merges the head onto it, and runs the gates the config picks, one after another. It then posts the commit status `stam/gates` on the PR head, with a description that ends in `; base SHA` (the main commit it tested on), and comments on the PR with each gate's result and the tail of a failing gate's output.

- One run at a time per cache folder: a run holds `flock` on `gate.lock` there. A second run waits for it, up to `STAM_REPO_GATE_LOCK_WAIT_MIN` minutes (default 120), then fails without posting. The kernel frees the lock of a run that dies.
- Each gate gets `STAM_REPO_GATE_TIMEOUT_MIN` minutes (default 60). A gate past it is stopped and fails with "timed out".
- Each gate runs in its own process group, which is stopped (TERM, then KILL after 5 seconds) when the gate ends, so a server or background job it starts doesn't outlive it. A SIGINT, SIGTERM or SIGHUP to the run stops the running gate's group first, starts no later gate, and posts nothing.
- Each run has its own scratch clone and its own log folder, `logs/pr-N/RUN/`, which is removed after 7 days.
- Fork PRs aren't supported: a PR whose head is in another repo fails with that message, and no gate runs.

Exit statuses: 0 every gate passed; 1 a gate failed or the gates could not run; 2 usage; 130 a signal stopped the run.

### Isolation

Gates run the PR's code, so the gate keeps them apart from the runner's environment:

- A gate gets only `PATH`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LANGUAGE`, `TERM`, `TMPDIR`, `TZ` and `LC_*` from the runner, plus the names listed in `STAM_REPO_GATE_ENV` (comma-separated). `HOME` is a scratch folder of the run's own, and `STAM_GATE=1` is set. Tokens such as `GH_TOKEN`, `GITHUB_TOKEN` and stam's own are not passed.
- The tree is a `git clone --shared` with no remote, not a worktree of the checkout, so a gate can't move the checkout's branches or change its git config.

This scrubs the environment only. A gate still runs as the runner's Unix user, so it can read whatever that user can, such as `~/.config/gh`, stam's state, and `.env` files. Gate only PRs you trust, or run the gate as a user that has no such access.

## The merge

```sh
node scripts/repo-merge.mjs PR_NUMBER
```

It merges only when all of these hold, in order:

1. The PR is open and targets the trusted main branch.
2. The main branch has a config (file or fallback), and this machine is its `home`, if one is set.
3. The PR isn't from a fork, doesn't conflict, and its head hasn't moved since it was read.
4. Every context in `requiredStatuses` is `success` on the current head (the newest status per context counts).
5. `stam/gates` is `success` on the head against the current main. When it isn't, the merge runs the gate itself, and refuses if it fails, or if it ran on another head (the PR moved meanwhile).
6. Main hasn't moved since the gates ran.

Then it merges with `gh pr merge --METHOD --match-head-commit HEAD`, or runs `merge.command` instead.

The merge takes no lock. Two merges at once are kept apart only by step 6 and `--match-head-commit`: a head that moved is refused by GitHub, and a main that moved after the gates ran stops the merge with exit 1. A main that moves in the moment between step 6 and the merge call is not caught, so the merged tree may be one the gates never ran on. Run one merge at a time per repo when that matters. The command replaces only that call: the checks above always run first. It runs with `sh -c` in the checkout, with `STAM_PR`, `STAM_PR_HEAD`, `STAM_BASE_SHA` and `STAM_MERGE_METHOD` set. Last, it runs `deploy` the same way, with `STAM_MERGE_SHA` too, and prints the merge commit's sha.

Exit statuses:

| Exit | Meaning |
| --- | --- |
| 0 | Merged, and deployed when `deploy` is set. |
| 1 | Something went wrong that says nothing about the PR: a `gh` or `git` failure, main or the head moved, the wrong machine, a failed `merge.command`, or another gate run held the lock too long. Run it again. |
| 2 | Usage. |
| 3 | A verdict on the PR: not open, from a fork, wrong base, a conflict, a required status missing, gates failed, or a config error. It goes back to its developer. |
| 4 | Merged, but `deploy` failed. |

## Environment

Both scripts read:

- `STAM_GATE_REPO`: the git checkout to work in (default: the current directory). Its `origin` is the GitHub repo.
- `STAM_GH`: the `gh` binary (default `gh`). Every `gh` call goes through it.
- `STAM_REPO_CONFIG`: the settings fallback, as JSON.
- `STAM_REPO_GATE_CACHE`: the folder for the lock, scratch clones, logs and comments (default `~/.cache/stam-repo-gate`).
- `STAM_REPO_GATE_TIMEOUT_MIN`: each gate's time limit in minutes (default 60).
- `STAM_REPO_GATE_LOCK_WAIT_MIN`: how long a run waits for another to finish, in minutes (default 120).
- `STAM_REPO_GATE_ENV`: extra variable names, comma-separated, that gates get from the runner.
- `STAM_MACHINE`: this machine's name, for `home` (default: the hostname).
