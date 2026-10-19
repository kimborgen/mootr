# Testing with the fake Claude Code

Tests never depend on a real model: they must be deterministic. A test that needs a Claude Code agent runs `test/fake-claude/claude`, a scripted stand-in for the `claude` binary, instead of Claude Code.

The real claude adapter (`src/adapters/claude.ts`) launches the fake unchanged, through `STAM_CLAUDE_BIN`. So the adapter's paths are what the test exercises: the hook and statusline commands in `--settings`, the mootr MCP server and its channel from `--mcp-config`, the transcript, typing the first prompt into the pane, and mail pushed over the channel.

Temporary folders (test daemons, screenshots, run logs) go under `STAM_TEST_TMPDIR`. When unset, that is `/tmp`, or `${XDG_CACHE_HOME:-$HOME/.cache}/stam-test` when `/tmp` is a tmpfs (RAM); see `test/tmpdir.sh`. Passing runs delete them; a named `OUT` (`OUT=dir sh web/check/run.sh NAME`) keeps screenshots. `KEEP=1` also keeps the check's daemon running, and prints the PIDs and home to stop it with.

## Write a test

1. Write the script, a JSON file, into the test's temporary folder.
2. Call `fake_claude SCRIPT` before the daemon starts (`isolate`), so the daemon, and through it every agent's tmux pane, inherits `STAM_FAKE_CLAUDE_SCRIPT`. Every test daemon already runs the fake (`STAM_CLAUDE_BIN`, set in `test/lib.sh`), and `daemon_up` refuses to start one on another binary unless the run is `--smoke` (S-176).
3. Spawn agents as usual. Each prompt runs one turn from the script.

`test/e2e-m1.sh` is the smallest example:

```sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/m1.json" <<'EOF'
{ "turns": [
  { "match": "echo hi", "steps": [
    { "tool": "Bash", "input": { "command": "echo hi" }, "output": "hi" },
    { "reply": "DONE" } ] } ] }
EOF
fake_claude "$TEST_TMP/m1.json"
isolate
"$STAM" spawn worker --cwd "$TEST_TMP" "Run the shell command 'echo hi', then reply with exactly DONE."
"$STAM" wait worker --until idle --timeout 60
```

A turn's steps run one after another, each when the previous one has finished. Nothing waits on a timer, so a turn takes milliseconds: to check a state in the middle of a turn, hold the turn with an `await`, `permission`, or `ask` step, check, then release it. Don't poll for a state the turn passes through (`stam wait --until working`); check `stam events` for the hooks afterwards.

To wait for a scripted reply that a turn's own mail can wake a second turn to replace, don't read `stam show`'s last message; `said NAME PATTERN` in `test/lib.sh` checks the transcript, which keeps every turn's text (`test/e2e-req-tools.sh`).

## Script format

```json
{
  "turns": [ TURN, ... ],
  "agents": { "AGENT_NAME": { "turns": [ TURN, ... ] } },
  "default": TURN
}
```

- `turns`: tried in order for every prompt; the first that matches runs.
- `agents`: turns for one agent, by name, tried before `turns`. The fake asks mootr `whoami` for its name only when `agents` is set.
- `default`: the turn when none matches. Without it, the fake replies `ok` and stops.

A script can also be an `.mjs` module whose default export is the same object.

A turn has these fields:

- `match`: a substring of the prompt, or a regex written `"/.../flags"`. Without it, the turn matches any prompt. Regex groups become `${1}`, `${2}`, and so on. A mail prompt lists only the subjects (`from the human: SUBJECT`), so match mail by subject; a turn that doesn't `read_mail` leaves its mail unread, and later notices list it again.
- `source`: only prompts from `typed` (the pane, including the first prompt) or `channel` (pushed mail and notices).
- `once`: true to use the turn at most once, for a sequence of different answers to the same prompt.
- `steps`: the list of steps.

A prompt from the channel looks as Claude Code shows it: `<channel source="stam" kind="mail">TEXT</channel>`. Match mail with `"/kind=\"mail\"/"` or a word from the notice.

## Steps

| Step | What the fake does |
|---|---|
| `{ "reply": "TEXT" }` | Writes an assistant message; the last one is the Stop hook's `last_assistant_message`. |
| `{ "tool": "NAME", "input": {}, "output": "TEXT" }` | A tool use: PreToolUse, transcript rows, PostToolUse. Nothing runs. |
| `{ "shell": "CMD", "save": ... }` | Runs CMD with `sh -c` in the agent's cwd, as its Bash tool would, wrapped in Pre/PostToolUse as `Bash`; the output is the tool result, and an exit code other than 0 is an error. `save` takes the output as below. |
| `{ "mcp": "TOOL", "args": {}, "save": ..., "expect": "..." }` | Calls the mootr MCP tool for real, wrapped in Pre/PostToolUse as `mcp__stam__TOOL`. A tool the server didn't list fails, as in Claude Code; the fake lists again on `tools/list_changed`. |
| `{ "permission": "NAME", "input": {}, "output": "TEXT", "options": ["Yes", "No"] }` | PreToolUse, PermissionRequest (the agent goes `blocked`), then a dialog in the pane; `options` defaults to Yes, No, and an answer that doesn't start with Yes denies. For Claude Code's real menu for a read outside the working directories, give its four options: "Yes, and keep allowing any reads outside the working directories", "No, and block reads outside the working directories from now on", "No, and ask again next time", "Yes, but ask again next time" (`test/e2e-harness-dialog.sh`). |
| `{ "ask": "QUESTION", "options": ["A", "B"] }` | AskUserQuestion: the same, with the options; the agent shows `blocked question`. |
| `{ "await": "MATCH" }` | Holds the turn until a prompt (typed, or a channel message) matches; `true` takes any. |
| `{ "status": { "context_tokens": 50000, "context_window": 200000, "cost": 0.01, "output_tokens": 100 } }` | Changes what the statusline and transcript usage report, and runs the statusline. `rate_limits` (`{ "five_hour": { "used_percentage": 37, "resets_at": EPOCH_SECONDS } }`) is passed on in the statusline payload as Claude Code sends it. |
| `{ "hook": "EVENT", "payload": {} }` | Runs any hook, for rare events such as Notification or PreCompact. |
| `{ "stop": { "background_tasks": [], "session_crons": [] } }` | Ends the turn now with these fields in the Stop payload, which become hook waits. |
| `{ "fail": "rate_limit", "details": "..." }` | Ends the turn with StopFailure and that error class instead of Stop. |
| `{ "lost_stop": true }` | Ends the turn without running Stop, as when the hook couldn't reach the daemon: mootr still thinks the agent is working. |
| `{ "exit": true }` | Runs SessionEnd and exits, as if the human quit. |
| `{ "exit": "hang" }` | Runs SessionEnd and stops its MCP servers, but doesn't exit: a harness that hangs on its way out, with its pane still live. |

A turn that ends without `stop`, `fail`, or `exit` runs Stop with empty `background_tasks` and `session_crons`, then the statusline.

Answer a dialog by typing into the agent's pane, as a human would: `1`, `2`, and so on picks an option, Enter the first, Esc cancels. The pane logs the option it closed with as `⎿ OPTION` (`⎿ cancelled` for Esc). Text mootr types into an idle agent's input, such as "I authorize: ..." after an approved `request_permission`, arrives as a typed prompt. The answer is `${answer}`. A denied permission runs no PostToolUse.

`save` keeps a tool result for later steps (MCP or `shell`), and the values also go into the session's transcript, so a `--resume SESSION` gets them back before its first turn. `save` keeps an MCP result for later steps: `"save": "NAME"` keeps the whole text as `${NAME}`, and `"save": { "NAME": "REGEX" }` keeps the regex's first group. For example, `{ "mcp": "read_mail", "save": { "mid": "(m[0-9a-f]{7})" } }` then `{ "mcp": "send_mail", "args": { "to": ["human"], "body": "done", "reply_to": "${mid}" } }`. When `expect` (a substring or `/regex/`) doesn't match the result, the turn ends with the reply `FAKE-CLAUDE EXPECT FAILED: ...`, which a test can check in `stam show`.

## Variables

Strings in steps take `${...}`: `${self}` (the agent's id), `${name}` (its name, only with `agents`), `${session}`, `${prompt}` (this turn's prompt), `${input}` (what the last `await` took), `${answer}`, `${result}` (the last MCP result), saved names, regex groups, and `${env:VAR}`.

## Compaction

`claude -p --resume ID` (mootr's compaction, which sends `/compact INSTRUCTIONS` on stdin) is answered with a JSON result and exit 0. The fake keeps the instructions as the session's summary, in `fake-compaction-SESSION.txt` in the mootr home, and the resumed session reads it as `${summary}`. So a test can check that what it asked the summary to keep is still known after compaction. The compaction appends a summary row to the session's transcript, written in two parts, so a compactor killed mid-run leaves it half-written. Each compactor's session is appended to `fake-compact-runs` in the mootr home, with an `OVERLAP` line when another still runs on the same session. `fake-compact-hold` holds a compaction open and `fake-compact-fail` makes it fail.

## What the agent was started with

The fake writes the argv the adapter passed to `argv.json` in the agent's folder, on each start (a resume too). Every input submitted with Enter is appended, exactly as submitted and before trimming, to `typed.jsonl` there, one JSON string per line (`test/e2e-suggest-input.sh`). Under its box the pane draws a rule and a footer showing `-- INSERT --` (always in vim's insert mode, as Claude Code with vim keys); a backspace deletes one grapheme; and its box has Claude Code's bash mode (a `!` typed into an empty box becomes the box's mark; a backspace in the empty box leaves it) and a completion menu (under the footer, after a blank line) while its text is `/word` or ends in `@word`: Enter then submits `/menu-pick` or `@menu-pick`, and one Esc closes it until the text changes (text with `@@` opens one Esc doesn't close). A bash-mode prompt is recorded in the transcript as Claude Code records it, `<bash-input>TEXT AFTER THE !</bash-input>`. A number in a `drop-bs` file there makes that many backspaces do nothing, so a test can leave part of mootr's typing in the box (`test/e2e-suggest-input.sh`). A script's top-level `placeholder` (a string) draws faint text in the empty box, as Claude Code draws a placeholder or a prompt suggestion, which typing replaces; `dropPastes` (a number) loses that many bracketed pastes per launch, as a Claude Code still resuming does; `holdPastes` holds that many back until the next paste, which they land just before, as a stalled Claude Code does; while the file `holdPromptHook` names exists, the UserPromptSubmit hook waits, as on a stalled daemon; while the file `holdEnter` names exists, Enter does nothing and is logged to that path plus `.dropped`; and `boxRows` shows a taller box as a window of its last rows, as Claude Code does (`test/e2e-first-prompt-ghost.sh`). A paste shows once it ends; one of over 800 characters or more than two lines shows as one `[Pasted text #N +M lines]` token, which one backspace deletes, as in Claude Code; and a box that wraps is drawn again with its footer under it. A script's top-level `rewrite` (`{"FROM": "TO"}`) changes a typed prompt before it is submitted, as if the harness had. A test reads it to check mootr's inputs to Claude Code, such as `--append-system-prompt-file` and `--plugin-dir` (`test/e2e-instructions.sh`).

## What the fake leaves out

Interrupting with Esc and the spinner line, compaction beyond the summary above, background jobs that finish by themselves (a test types the `<task-notification>` prompt instead), MCP servers other than mootr, permission modes, and Claude Code's launch dialogs. The transcript is `transcript-SESSION.jsonl` in the agent's folder in the mootr home, not under `~/.claude`.

Assumed, not checked against Claude Code: a channel message starts a turn with UserPromptSubmit, and channel messages and typed prompts that arrive during a turn wait for it to end, unless an `await` step takes them.

## The fake OpenCode

`test/fake-opencode/opencode` stands in for the `opencode` binary (`STAM_OPENCODE_BIN`) where a check needs an OpenCode agent's conversation: `serve` runs a scripted server (`server.mjs`) with sessions, stored messages paged as OpenCode pages them, the event stream, prompts (each answered "Got it: TEXT"), permission replies, and interrupts; any other call is a TUI that only waits. `POST /__fake/seed {session, messages, permissions, active}` loads a conversation. `OWN_VIEW=1 web/check/daemon.sh` uses it to add the agent `oc` with the conversation from `web/check/seed-view.mjs`.

## Test slots (S-692, S-1288)

`scripts/test-slot.sh` limits heavy test commands to max(1, nproc/4) at once per machine (`STAM_TEST_SLOTS`). `test/run.sh NAME...` with only plain unit tests (the `LIGHT` list in `test/run.sh`: a `node --test` file with no daemon, tmux or browser) takes a separate light pool (`--light`, `STAM_TEST_LIGHT_SLOTS`) and skips the suite lock, so it never queues behind phone checks; `test/e2e-test-slot.sh` proves it. `test/light-list.test.mjs` checks each `LIGHT` entry is such a file (S-1768); a new daemon-free test is added to `LIGHT` too. A single plain `node --test` file runs through `scripts/test-slot.sh --light node --test test/X.test.mjs`, not the heavy slot.

## Chromium checks

`web/check/chromium-lock.mjs` (imported first by each Chromium check) runs one check at a time under a machine-wide flock (`/tmp/stam-chromium.lock`, `STAM_CHROMIUM_LOCK` for a test's own lock, `STAM_CHROMIUM_NOLOCK=1` to skip). A waiting check names the holder from `$LOCK.owner` (script, cwd, start, pid) and repeats "still waiting" every minute. To limit a check, set `STAM_CHROMIUM_TIMEOUT=SECONDS`: it counts from when the check gets the lock and exits 124 on expiry. Use it, not `timeout N`, around a check, because `timeout` counts the wait too. `test/e2e-chromium-lock.sh` (free) proves both.

A check flow that depends on which agents exist starts and archives its own named agents, as `web/check/interactions.mjs` does for the assistant and `ccpick`, because the gate's fixture differs from a local one (S-1359).

When a gate check fails on a PR whose diff can't reach it, rerun that check locally on main and on main+PR before you bisect; a pass on both points to timing, not the PR (S-1385).

The merge gate runs capped at one CPU (S-2107): a systemd scope with `CPUQuota=100%`, `nice -n 10` and one vitest worker; `STAM_GATE_CPU_QUOTA` tunes the quota (`off` removes the scope). Without a user systemd it runs niced only.

## The full suite (S-1073)

The full-suite runner and its failure triage (`scripts/full-suite.mjs`, `scripts/triage-failures.mjs`) run on the home machine only; they are not in the public export.

## Proving a new test

The developer proves each new test before it reports, and says how in the PR body. Reviewers read the proof and run nothing; a doubt goes to the developer as "I doubt X because Y".

- In a scratch clone, never a shared worktree, check out only the fixed files that exist on main at the old head (`git checkout ORIGIN_MAIN_SHA -- FILES`), run only the new tests and see them fail for the bug's reason, not on a missing ref or a setup error (S-1301), then restore with `git checkout HEAD -- FILES`. Skip this when the old code acts on real state (deploy, restart, kill); then run only the cases that hit stubs. For a fail-fast shell test, remove the earlier checks one at a time, so each later check is shown to fail on its own (S-1192).
- When a PR copies a validator, replay the real inputs it will see through it, such as past PR bodies (S-1293).
- Re-approving a rebased stacked PR: `git range-diff OLD_BASE..OLD_HEAD NEW_BASE..NEW_HEAD` (S-1162).
- Before approving a change to text, grep `test/` for the removed text (S-1232).
- After a rebase or merge that changes `package-lock.json`, run `stam deps relink` in the worktree (S-1662); `stam deps check` reports, and `pr_open` relinks by itself when `node_modules` is stale or a symlink outside the worktree (S-1706), then tells you to rerun your tests.
- A `--reference` scratch clone with an unchanged lockfile can symlink the worktree's `node_modules` instead of installing (S-1229).
- When a review sandbox can read but not write the linked `node_modules` (EROFS on `.vite-temp` or `.tmp`), replace the link with a copy: `rm CLONE/node_modules`, then `cp -a --reflink=auto "$(readlink -f LINKED_NODE_MODULES)" CLONE/node_modules` (S-1340).
- When a symlinked `node_modules` lacks a dep the branch adds (tsc gives TS2307 in files unchanged from main), hardlink-copy it (`rm WT/node_modules`, then `cp -al LINKED_NODE_MODULES WT/node_modules`), `npm install DEP --no-save` for that one dep, and first confirm the error is environmental with `git diff --stat main SHA -- FAILING_FILES` (empty) (S-831).
- A mutation proof of a `web/check` assertion must keep `tsc -b` clean: change a value (`[0]` to `[99]`) rather than deleting code, or the check daemon's build fails before the assertion runs (S-1370).
- When proving a test, mutate the call site, not only the pure helper: the helper's tests can pass with the wiring removed (S-1273).
- To prove a browser checker, extract it into a small Chromium fixture rather than rerunning the full flow (S-1386).
- To prove that something is absent (a network call, a spawn), log the commands it gets, such as a git wrapper on `PATH`, and assert the log; a time bound passes when the call fails fast (S-1425).
- A widened matcher needs a negative case the old code would wrongly accept; a narrowed allowlist needs a case for each form it newly skips that the old code caught (S-1119, S-1690). A positive case alone passes on both.
- A test with a time or deadline bound must fail on the old code, not just finish inside its timeout. Assert an elapsed-time bound well under the runner's timeout, since vitest's 5 s let a 3 s quadratic regex pass (S-1705), and revert the fix to check that it fails for the bug's reason. For a hang, write `$$` to a file from the hanging command and assert `kill(pid, 0)` throws ESRCH, because a deadline alone can't see a leaked child (S-1672). An absence assertion after an unmount or teardown needs its presence case shown once, or it can never fail (S-1680).
- For UI that renders text as links or chips: allow only http(s) schemes in the `href`; give each new element at least `--size-hit-touch` (44 px) at phone width, checked in `web/check/phone.mjs`; and run the text matcher on one long pathological line under the elapsed bound from the bullet above, with a negative example such as `docs.github.com` that must not link as a path (S-1700, S-1703).
- Before a mutation proves a guard, check the fixture reaches the guarded line: a membership-only case passes with the guard removed. Give the member out-of-scope work that enters the answer (an out-of-scope closed issue they worked), then confirm the mutation fails (S-1715).
- A test that inserts database rows or fires DOM events by hand mirrors the production path: use the event names and rows the production writer persists (the daemon broadcasts `agent.archived` and persists archive), and fire a jsdom event on the target a browser fires it on (`dragstart` fires on the draggable ancestor, not its child button) (S-789, S-1904).
- Reproduce a scale or perf bug on a synthetic db built with `src/db.ts`, not a copy of the live `stam.db`: auto mode blocks copies of the live db, and a synthetic one at real scale reproduced a 674 ms root count against the logged 680 ms (S-1740).

## Block and template text (S-1371)

Editing a block (`blocks/`) or a registry type's brief (`registry/defaults.json`) changes files derived from it. Run `node scripts/refresh-derived.mjs` in the same change, then commit what it writes:

- each block's `summary_of` (the sha256 of its body, `blockHash`), checked by `run blocks`;
- `test/fixtures/templates/NAME.md`, the text `template(NAME)` gives, checked by `run template-blocks`;
- `test/golden/briefs-dev-change.json`, the briefs `renderBrief` gives with `test/golden/briefs-vars.mjs`, checked by `run process-briefs`;
- `export/overrides/manifest.json`, the hashes `export/apply-overrides.mjs` checks before it writes the public tree.

A template or type whose manifest hash changed also needs its generic text edited by hand in `export/overrides/templates/NAME.md` or `export/overrides/registry-types.json`. The script prints the block diff (or the brief) to port, from the last commit that had the recorded text. Without the hand edit the public export ships the old generic text, so the port belongs in the same PR.

`node scripts/refresh-derived.mjs --check` writes nothing: it lists the stale files and exits 1. It runs in `test/refresh-derived.test.mjs` on this tree and on a temp copy, where a block edit makes it stale until the refresh is run. The script always uses a throwaway `STAM_HOME`, so a user's template override never changes what it writes.

## Leftovers (S-428)

Unit tests make their `STAM_HOME` with `tempHome()` (`test/tmphome.mjs`): the stub embedder, so no 475 MB model copy lands in the home, and the folder removed on every exit path. Shell tests get the same from `test/lib.sh`. `node scripts/sweep-test-homes.mjs [--dry-run] [--hours N]` removes `/tmp/stam-*` and `~/.cache/stam-test/stam-test.*` homes older than N hours (default 2) that no process uses (cwd, open files, environment, command line); it kills nothing. It also removes review leftovers (S-1235) older than `--review-hours` (default 6) that no process uses and no live agent's cwd, workspace, name or first prompt names: folders under `~/.cache/stam-review` (clones and `.tmp-*`), non-`stam-test.*` folders under `~/.cache/stam-test`, and `~/.cache/review-*`; a worktree goes by `git worktree remove`, and unreadable agents keep them all. `--install` writes a systemd user service and timer for it (hourly) and enables the timer. The live daemon's janitor also stops leaked test daemons (`orphanTestDaemons`, `src/orphan-procs.ts`, S-1294): a `daemon run` whose `STAM_HOME` is under `stam-test.*`, older than an hour, with a deleted cwd, or reparented to PID 1 with no live test-slot holder covering its cwd and no live owner shell (the pid in the home's `owner` file); a legacy home with neither marker nor owner file also needs age (12 hours) and positive provenance in the daemon's own env (`STAM_TEST_TMPDIR`, `STAM_TMUX_SOCKET` matching the home path, a fake `STAM_CLAUDE_BIN`); it stops the daemon's whole process tree. Archiving an agent also stops the processes whose cwd or command line lies in its worktree (`dirProcesses`, `src/proctree.ts`). The prefixes it sweeps are derived at run time from the folders `test/*.mjs` makes (`testPrefixes` in `scripts/sweep-test-homes.mjs`), so a unit test that gives its temporary folder a new prefix is swept with no list to keep in step.
