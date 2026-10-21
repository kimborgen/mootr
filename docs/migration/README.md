# Go migration: catch-up list and Go-impact gate

Part of the Go daemon migration (S-2194). Two pieces track the TypeScript code that the Go port has not yet caught up with.

## Modules: `docs/migration/modules.json`

A JSON array with one entry per Go module that ports code from `src/`. It starts empty (`[]`). An entry has:

- `name`: the module's name, a lowercase word with dashes. A `Go-impact:` line names it (below).
- `globs`: the `src/` paths the module ports, as git pathspec globs (`**` crosses folders).
- `portSha`: the commit the module was last brought up to date with. Empty or absent means the module is not ported yet, and the catch-up list skips it.

Example entry (not in the file; add it to the array once the module exists):

```json
{
  "name": "mail",
  "globs": ["src/mail*.ts", "src/mail/**"],
  "portSha": "0123456789abcdef0123456789abcdef01234567"
}
```

## Catch-up list: `scripts/go-catchup.mjs`

```
git fetch origin
node scripts/go-catchup.mjs [MODULE]
```

For each module with a `portSha`, it prints the commits on `origin/main` since that SHA that touch its globs, newest first. Merge commits are left out, since the PR's own commits are listed. With `MODULE`, it lists only that module. Read-only: it changes nothing.

## Go-impact gate

A PR that changes `src/` must say which Go module it affects, or none, in a line of its body:

```
Go-impact: mail
Go-impact: none
```

The merge gate refuses a PR whose `src/` change has no such line, or a line that is neither a module name nor `none`. The check is off by default. It turns on with `STAM_GO_IMPACT=required` in the environment of the gate and the merge. It is planned to be turned on after phase 2 of the migration. Until then, a PR with no `Go-impact:` line merges as before.

The check reads only the PR body and the changed paths. It does not yet check that the name is in `modules.json`.

## Nightly parity run: `scripts/go-parity-nightly.mjs`

```
node scripts/go-parity-nightly.mjs --install   # once on storage, after the deploy that has the script
node scripts/go-parity-nightly.mjs --status    # the last run's summary line
```

A systemd user timer (`stam-go-parity.timer`, 03:30 host time, `Persistent=true`, so a missed night runs at the next boot) starts `stam-go-parity.service`, which runs the script from the deployed release (`~/.local/share/stam/releases/current`), so a deploy swaps the code and keeps the timer. `--install` writes both units to `~/.config/systemd/user` and enables the timer; rerun it after a change to the units. Storage only (the run refuses elsewhere).

A run:

1. Takes an exclusive lock (`go-parity/lock`) before anything else. A second run while one is going exits 75 with `another run holds the lock; refused`.
2. Fetches `origin/main` into its own clone (`go-parity/repo`, never `~/projects/stam2`), runs `npm ci` when `package-lock.json` changed, and builds `go/`.
3. Runs `scripts/go-parity.mjs` over the FREE list through `scripts/test-slot.sh` (one slot), with `STAM_DAEMON=go`. `test/lib.sh` creates each Go test home's `stam.db` with the TypeScript schema first (`test/go-seed-db.mjs`, which refuses the live home), because the Go daemon opens a database and doesn't create one.
4. Stops at `STAM_GO_PARITY_TIMEOUT_S` (default 4 h). However the run ends, `test/lib.sh` stops its daemons and tmux servers, a watchdog reaps a killed run, and the script then sweeps what is left by pid and removes its scratch folder. A stopped service takes its cgroup with it.
5. Publishes under `STAM_HOME/go-parity/`: `parity.json` (per-test results, the shape of `docs/migration/parity.json`, each test tagged `kind` and `daemon`), `parity.prev.json` (the night before), and `last-run.json` (state `ok`, `build-failed`, `install-failed`, `timeout` or `run-failed`; shas; counts; newly failing tests; the summary). It posts the one-line summary on S-2194 with `--system go-parity`: `Nightly Go parity (main 01234567): 7 of 9 daemon e2e tests pass (+2 since last night, 300 n/a); newly failing: x, y.` Only names, counts and shas are written; test output and the environment never are.

What counts (`scripts/go-parity.mjs`): a test's `kind` is `node` (a `node --test` file that runs in-process) or `e2e` (a shell script), and `daemon` is true when the script starts a daemon with `daemon_up` or `isolate`, so it can run against `go/bin/stamd` under `STAM_DAEMON=go`. Only those say anything about Go, so the headline is `E of N daemon e2e tests pass`; every other test is `n/a` (it passes or fails the same without Go). The UI flows (`ui*`, `daemon-stub`) start the TypeScript daemon through `web/check/daemon.sh` and are n/a too. A test that prints a line starting `SKIP` and exits 0 ran nothing; `test/run.sh` shows it as `SKIP` (the exit status is unchanged) and parity records `skip`, not `pass`. A failure whose output or kept log (`DIR/NAME.log`, the folder `test/run.sh` names) shows a full disk or quota (`ENOSPC`, `EDQUOT`, `No space left`, `Disk quota exceeded`) is run once more. The run ends with `parity: E of N daemon e2e tests pass, S skipped, M n/a`.

The committed `docs/migration/parity.json` is not touched; a module PR updates it from `parity.json`. Tested by `test/go-parity-nightly.test.mjs` (`go-parity-nightly-unit`, free).
