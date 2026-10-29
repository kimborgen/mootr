# Phase 3 triage: why the daemon e2e tests fail against Go (S-3723)

Part of the Go daemon migration (S-2194, section 6). This report clusters the daemon e2e tests that fail against the Go daemon by root cause, lists what Go lacks, and proposes the order of the phase 3 module PRs.

## Inputs and method

- **Results:** the nightly parity file on storage (`STAM_HOME/go-parity/parity.json`, run 2026-10-22 02:29 UTC on main `ac40343a`): 179 daemon e2e tests, 12 pass and 167 fail. The 5 failing `node` tests aren't daemon tests and are left out. The nightly keeps no logs.
- **Static pass:** every route in the TS route table (`src/daemon.ts`, the `routes` array) against every pattern the Go server registers (`go/internal/server`, `s.handle` and `s.mux.Handle`); the MCP tools in `src/mcp.ts` against `go/internal/mcp/tools.go`; the CLI subcommands in `src/cli.ts` against `go/cmd/stam/main.go`; and the spawn fields the Go server refuses (`go/internal/server/lifecycle.go`, `spawnKeys` and the refusals after it). Then each failing test script, with the helper scripts it runs, is read in order, and its first reference to something Go lacks is its static first failure. A shell function's references count at its first call, not at its definition.
- **Runs:** 46 of the 167 tests, in two batches of 20 and a check of 6 disputed rows on storage under `STAM_DAEMON=go` through `scripts/test-slot.sh` (main `cd913aca`). Batch 1 took the tests the static pass couldn't place plus spot checks; batch 2 checked each other category. Every run confirmed the static cause or replaced it with a better one. Logs stayed in the test log folder; none is committed.
- **Limits:** the static pass sees missing surface (a route, tool, subcommand or spawn field), not wrong behaviour behind a route that exists. So "turns green" below means "has nothing missing left"; a test can still fail on a shape or behaviour gap once its surface lands. The "Needs" column over-counts a little, since a test that names a route only in a negative check (a 404 or 403 it expects) is counted as needing it.
- **Re-triage, 2026-10-25 (S-4081):** every daemon e2e test the 2026-10-25 03:30Z nightly failed (124 of 184, main `37ada76f`) was rerun under `STAM_DAEMON=go`, one at a time through `scripts/test-slot.sh`, on storage, on main `e0f5f43c` (compact-dedupe and compact-restart again on `b75ec1c2`, after #1271 fixed their polls). Each test's first FAIL line and kept log were read, with the test script where the line alone didn't name the cause. Sections 2 and 3 and the headline are from these runs; section 1 is still the 2026-10-22 static pass and over-states what Go lacks.

## Headline

- **77 of 184 daemon e2e tests pass on Go, 107 fail** (re-triage, 2026-10-25): the nightly's 60 passes, not rerun, and 17 of its 124 failures. The 2026-10-22 triage had 12 of 179 passing. Of the 124 the nightly failed, 17 pass now: agent-instructions, agent-types, agents-route, compact-dedupe, cos, cost-instructions, feedback, inventory, itsa-tools, org, registry-home, resource-warn, retro, spawn-usage, stuck-resume, tool-summaries-route, waits.
- **Register is no longer a blocker.** The old section 2 gave register as the first failure of 55 of the tests the nightly still failed; none stops there now. The nightly records pass or fail, not the cause, so those rows had gone stale.
- **Peers and worktrees are the shared blockers now.** Spawning on another machine, an ITSA naming a peer's agent, the merged agent list and permission relays are the first failure of 22 tests; a developer's own worktree (and `worktree`, `workspace`) of 12, five of which then need peers.
- **Six failures are the tests', not Go's** (a test can be wrong: it asserts a TS quirk, not the contract): four wait with a `poll N` that counts CLI calls, which the Go CLI exhausts in seconds (three of them then fail on a real gap as well); one compares JSON as a string; one asserts TS's event-loop stalls. See "Test fixes" in section 3.

| First-failure category | Tests |
|---|---:|
| Behaviour gap behind surface that exists, or a refusal inside a route Go serves | 33 |
| Refused spawn field, harness or machine | 26 |
| Missing route | 20 |
| Missing CLI subcommand | 7 |
| Test fix: the test asserts a TS quirk | 6 |
| Fresh home (no db, tokens or settings.json; the home lock) | 4 |
| Missing loop | 4 |
| Missing MCP tool | 3 |
| Lifecycle gap (the compactor dies with the daemon) | 1 |
| Adapter (OpenCode server) | 1 |
| Test hook (the test-human header) | 2 |
| **Total** | **107** |

Section 1 below is the 2026-10-22 static pass. Much of it has landed since (sections 2 and 3 say what is left); it is kept for the route, tool and subcommand lists of the modules still to come.

## 1. What Go lacks

### 1.1 Routes, by proposed PR

The TS route and its line in `src/daemon.ts`. `:id` stands for any path parameter. The TS table has 303 method and path pairs once alternations such as `(pause|unpause)` and optional parts such as `/api/diff(/file|/repos)?` are expanded, nine of them built by a spread of test reads (`src/daemon.ts:4362-4374`); Go serves 103 of them.

- **Register and test hooks** (32): `POST /api/register` (daemon.ts:3581), `POST /api/test/cost` (daemon.ts:4205), `POST /api/test/read-hold` (daemon.ts:4225), `POST /api/test/statements` (daemon.ts:4245), `POST /api/test/stall` (daemon.ts:4261), `POST /api/test/launch-fail` (daemon.ts:4271), `POST /api/test/itsa-gate` (daemon.ts:4282), `POST /api/test/agent` (daemon.ts:4295), `GET /api/test/switch-retries` (daemon.ts:4303), `GET /api/test/events` (daemon.ts:4307), `GET /api/test/pending-unown` (daemon.ts:4320), `POST /api/test/permission` (daemon.ts:4327), `POST /api/test/wait` (daemon.ts:4340), `POST /api/test/usage` (daemon.ts:4349), `GET /api/test/settings` (daemon.ts:4376), `POST /api/test/set-setting` (daemon.ts:4381), `GET /api/test/token-at-rest` (daemon.ts:4401), `POST /api/test/seed-agents` (daemon.ts:4415), `POST /api/test/mail` (daemon.ts:4439), `POST /api/test/delivery-fail` (daemon.ts:4462), `GET /api/test/kv` (daemon.ts:4474), `POST /api/test/kv` (daemon.ts:4482), `POST /api/test/await` (daemon.ts:4494), `GET /api/test/blockers` (daemon.ts:4364), `GET /api/test/cost-notices` (daemon.ts:4365), `GET /api/test/cost-fallbacks` (daemon.ts:4366), `GET /api/test/mail-pushed` (daemon.ts:4367), `GET /api/test/usage-total` (daemon.ts:4368), `GET /api/test/peer-agents` (daemon.ts:4369), `GET /api/test/req-waivers` (daemon.ts:4370), `GET /api/test/counts` (daemon.ts:4371), `GET /api/test/stam-bin` (daemon.ts:4372)
- **Agent control routes and CLI** (20): `GET /api/agents/:id/files` (daemon.ts:3292), `GET /api/agents/:id/instructions` (daemon.ts:3304), `GET /api/agents/:id/inventory` (daemon.ts:3317), `GET /api/types/:id/inventory` (daemon.ts:3328), `POST /api/agents/:id/permission-mode` (daemon.ts:4144), `POST /api/agents/:id/prompt` (daemon.ts:4786), `POST /api/archive-children` (daemon.ts:5287), `POST /api/agents/:id/pause` (daemon.ts:6033), `POST /api/agents/:id/unpause` (daemon.ts:6033), `POST /api/agents/:id/archive` (daemon.ts:6033), `POST /api/agents/:id/reconnect-mcp` (daemon.ts:6033), `POST /api/agents/:id/adopt` (daemon.ts:6033), `POST /api/agents/:id/set-visibility` (daemon.ts:6033), `POST /api/agents/:id/set-child-notices` (daemon.ts:6033), `POST /api/agents/:id/set-parent` (daemon.ts:6033), `POST /api/agents/:id/rename` (daemon.ts:6033), `PUT /api/agents/:id/default-view` (daemon.ts:6067), `GET /api/agents/:id/usage` (daemon.ts:6085), `POST /api/agents/:id/notice` (daemon.ts:6110), `POST /api/agents/:id/retro-final` (daemon.ts:6121)
- **Mail threads, search and decisions** (23): `POST /api/mail-titles` (daemon.ts:3394), `GET /api/search` (daemon.ts:3506), `GET /api/agents/:id/threads` (daemon.ts:3754), `POST /api/agents/:id/threads/:id/archive` (daemon.ts:3777), `POST /api/agents/:id/threads/:id/unarchive` (daemon.ts:3777), `POST /api/agents/:id/threads/:id/defer` (daemon.ts:3777), `POST /api/agents/:id/threads/:id/undefer` (daemon.ts:3777), `POST /api/agents/:id/threads/:id/unread` (daemon.ts:3826), `GET /api/threads/about/:id` (daemon.ts:3855), `GET /api/mail/linked/:id` (daemon.ts:3866), `GET /api/mail/search` (daemon.ts:3898), `POST /api/mail/:id/title` (daemon.ts:3909), `GET /api/mail/:id/thread` (daemon.ts:3945), `POST /api/mail/:id/withdraw-ask` (daemon.ts:3986), `POST /api/mail/:id/attach` (daemon.ts:4005), `POST /api/mail/archive-resolved` (daemon.ts:4023), `POST /api/mail/resolved` (daemon.ts:4040), `POST /api/mail/withdraw` (daemon.ts:4050), `GET /api/mail/:id/attachments/:id` (daemon.ts:4821), `GET /api/mail/decisions` (daemon.ts:5273), `GET /api/mail/human-waits` (daemon.ts:5275), `GET /api/itsas/:id/incident` (daemon.ts:5325), `GET /api/itsas/:id/about-mails` (daemon.ts:5403)
- **Config, settings, registry, types, templates, secrets, tools** (41): `GET /api/templates` (daemon.ts:3004), `POST /api/templates/:id` (daemon.ts:3006), `POST /api/types/:id` (daemon.ts:3020), `DELETE /api/types/:id` (daemon.ts:3036), `GET /api/config/settings` (daemon.ts:3054), `GET /api/config/registry` (daemon.ts:3054), `GET /api/config/instructions` (daemon.ts:3054), `GET /api/skills` (daemon.ts:3078), `GET /api/skills/updates` (daemon.ts:3085), `POST /api/skills/import` (daemon.ts:3091), `POST /api/skills/update` (daemon.ts:3091), `GET /api/tools` (daemon.ts:3106), `POST /api/config/settings` (daemon.ts:3108), `POST /api/config/registry` (daemon.ts:3108), `POST /api/config/instructions` (daemon.ts:3108), `PATCH /api/config/settings` (daemon.ts:3178), `GET /api/secrets` (daemon.ts:3212), `PUT /api/secrets/:id` (daemon.ts:3217), `POST /api/secrets/:id/test` (daemon.ts:3229), `DELETE /api/secrets/:id` (daemon.ts:3244), `GET /api/config/settings/shared` (daemon.ts:3257), `POST /api/config/settings/sync` (daemon.ts:3272), `POST /api/config/settings/changed` (daemon.ts:3281), `GET /api/config/settings/sync` (daemon.ts:3289), `GET /api/blocks/composing` (daemon.ts:3339), `GET /api/tiny-models` (daemon.ts:3348), `POST /api/tool-summaries` (daemon.ts:3357), `POST /api/tool-names` (daemon.ts:3376), `GET /api/registry` (daemon.ts:3404), `GET /api/onboarding` (daemon.ts:3420), `GET /api/models` (daemon.ts:3436), `GET /api/suggest` (daemon.ts:3517), `GET /api/suggest/rescore` (daemon.ts:3529), `POST /api/mcp/:id/login` (daemon.ts:3586), `POST /api/mcp/parse` (daemon.ts:3637), `POST /api/mcp/:id/test` (daemon.ts:3649), `GET /api/mcp/import` (daemon.ts:3661), `GET /api/mcp/registry` (daemon.ts:3672), `POST /api/mcp/registry/probe` (daemon.ts:3681), `GET /api/permission-modes` (daemon.ts:4157), `POST /api/permission-modes/apply` (daemon.ts:4163)
- **Events, subscriptions and watch state** (6): `POST /api/events` (daemon.ts:5713), `GET /api/events` (daemon.ts:5727), `GET /api/watch/state` (daemon.ts:5752), `GET /api/subscriptions` (daemon.ts:5760), `POST /api/subscriptions` (daemon.ts:5765), `DELETE /api/subscriptions/:id` (daemon.ts:5780)
- **Usage, machines, activity and cost tools** (15): `GET /api/health/db` (daemon.ts:2968), `GET /api/machines` (daemon.ts:2978), `GET /api/cache/agents` (daemon.ts:2989), `POST /api/machines/:id/start` (daemon.ts:2993), `POST /api/slot-queue/:id/cancel` (daemon.ts:4133), `POST /api/slot-queue/:id/duplicate` (daemon.ts:4139), `POST /api/activity/ingest` (daemon.ts:4188), `POST /api/activity/classify` (daemon.ts:4189), `POST /api/activity/classify-model` (daemon.ts:4192), `GET /api/activity/classify-model` (daemon.ts:4193), `GET /api/usage` (daemon.ts:4504), `GET /api/usage/issues` (daemon.ts:4549), `GET /api/usage/series` (daemon.ts:4567), `GET /api/usage/scope` (daemon.ts:4592), `GET /api/activity` (daemon.ts:4641)
- **Worktree and workspace spawn** (1): `POST /api/agents/:id/workspace-share` (daemon.ts:6202)
- **OpenCode adapter and by-session routes** (3): `GET /api/by-session/:id/notice` (daemon.ts:3538), `GET /api/by-session/:id/system` (daemon.ts:3549), `GET /api/by-session/:id/compact-instructions` (daemon.ts:3561)
- **Chief of staff, assistant, voice, push, digest** (22): `GET /api/chief-of-staff` (daemon.ts:4173), `POST /api/chief-of-staff` (daemon.ts:4175), `POST /api/cos/start` (daemon.ts:4954), `POST /api/cos/stop` (daemon.ts:4954), `GET /api/assistant` (daemon.ts:4966), `POST /api/assistant/message` (daemon.ts:4968), `POST /api/assistant/start` (daemon.ts:4968), `POST /api/assistant/replace` (daemon.ts:4968), `POST /api/presence` (daemon.ts:5262), `GET /api/digest` (daemon.ts:5263), `POST /api/digest/dismiss` (daemon.ts:5264), `GET /api/voice` (daemon.ts:5833), `POST /api/voice/transcribe` (daemon.ts:5838), `GET /api/push` (daemon.ts:5859), `POST /api/push/devices` (daemon.ts:5868), `PATCH /api/push/devices/:id` (daemon.ts:5879), `DELETE /api/push/devices/:id` (daemon.ts:5890), `POST /api/push/test` (daemon.ts:5899), `POST /api/push/notify` (daemon.ts:5918), `POST /api/agents/:id/chief-of-staff` (daemon.ts:6033), `POST /api/retros/digest` (daemon.ts:6133), `GET /api/retros` (daemon.ts:6136)
- **Shells, tty, layout, files, diff, view** (20): `GET /api/agents/:id/view` (daemon.ts:4061), `GET /api/agents/:id/view/history` (daemon.ts:4069), `GET /api/agents/:id/view/tools` (daemon.ts:4075), `POST /api/agents/:id/view/prompt` (daemon.ts:4082), `POST /api/agents/:id/view/interrupt` (daemon.ts:4087), `POST /api/agents/:id/view/permission` (daemon.ts:4092), `POST /api/shells/:id/input` (daemon.ts:4806), `GET /api/files/list` (daemon.ts:4845), `GET /api/files/read` (daemon.ts:4845), `GET /api/diff` (daemon.ts:4890), `GET /api/diff/file` (daemon.ts:4890), `GET /api/diff/repos` (daemon.ts:4890), `GET /api/decl` (daemon.ts:4924), `GET /api/shells` (daemon.ts:5008), `POST /api/shells` (daemon.ts:5010), `POST /api/shells/:id/kill` (daemon.ts:5026), `GET /api/layout` (daemon.ts:5795), `GET /api/layout/stream` (daemon.ts:5797), `POST /api/layout/ops` (daemon.ts:5806), `PUT /api/layout` (daemon.ts:5823)
- **PR ops and process tools** (12): `POST /api/pr/open` (daemon.ts:5433), `POST /api/pr/predict` (daemon.ts:5454), `POST /api/pr/open-status` (daemon.ts:5468), `POST /api/pr/merge` (daemon.ts:5479), `POST /api/pr/merge-cancel` (daemon.ts:5490), `POST /api/pr/close` (daemon.ts:5501), `POST /api/pr/view` (daemon.ts:5512), `POST /api/pr/merge-status` (daemon.ts:5523), `POST /api/pr/review` (daemon.ts:5529), `POST /api/pr/push-check` (daemon.ts:5543), `GET /api/pr/github-repo` (daemon.ts:5555), `GET /api/pr/branch-scope` (daemon.ts:5561)
- **Requirements, ring, wait and permission MCP tools** (1): `POST /api/tickets` (daemon.ts:4997)
- **Janitor and misc CLI** (1): `POST /api/janitor` (daemon.ts:4502)
- **Other (no failing test reaches these)** (3): `POST /api/harness/:id/upgrade` (daemon.ts:3570), `GET /oauth/callback` (daemon.ts:3599), `POST /api/itsas/join-pr-reviewer` (daemon.ts:5204)

Outside the table, TS also serves `GET|POST /api/human/login` and `/api/human/logout` (`src/daemon.ts:2506`, `:2518`) and the `/api/agents/:id/tty` and `/api/shells/:id/tty` WebSocket upgrades (`src/daemon.ts:6502`); Go has none of them. Go does serve the peer MCP lease routes outside its table (`go/internal/server/peer_mcp_routes.go`).

### 1.2 MCP tools

Go lists 13 of the 61 tools in `src/mcp.ts`: `whoami`, `register`, `send_mail`, `list_inbox`, `read_mail`, `read_thread`, and the seven `itsa_*` tools. The 48 missing, by proposed PR:

- **Agent CLI and tools:** `agent_control`, `find_agents`, `registry_info`, `spawn_agent`, `compact_self`, `reconnect_mcp`.
- **Mail threads and search:** `search`, `search_mail`, `defer_thread`, `withdraw_ask`, `mail_attach`.
- **Config:** `settings_ask`.
- **Usage and cost:** `usage_info`, `activity_info`, `cost_ack`, `cost_allocate`, `cost_pause`, `cost_switch` (their routes exist in Go; only the tools are missing).
- **Requirements, rings, waits, permissions:** `req_check`, `req_create`, `req_get`, `req_set`, `req_waive`, `ring_create`, `ring_decide`, `ring_submit`, `wait_for`, `wait_done`, `wake_me`, `request_permission`, `answer_permission`, `suggest_input` (most of their routes exist in Go).
- **Events and subscriptions:** `subscribe`, `unsubscribe`, `list_subscriptions`, `watch_pr`, `unwatch_pr`.
- **Chief of staff family:** `feedback`, `retro`.
- **Web UI:** `layout_get`, `layout_arrange`.
- **Worktree and workspace:** `workspace_share`.
- **PR ops:** `pr_open`, `pr_close`, `pr_merge`, `pr_review`, `pr_view`, `process_propose`.

The shim's release follow (`followDeploys`) and the test-home fault switch (`test-faults.json` `extra_tools`) are also missing: `mcp-tools` waits for a tool release B adds after a restart and never sees it.

### 1.3 CLI subcommands

`go/cmd/stam/main.go` handles `hook`, `statusline`, `mcp` (only `lease-rotate`), `daemon`, `spawn`, `mail`, `itsa`, `show`, `events`, `wait`, `kill` and `forget`; anything else prints "X is not ported to the Go CLI yet". `stam mcp logout` (used by mcp-lease-peer) is missing too. Missing, of the case labels in `src/cli.ts`: `activity`, `allocate`, `archive`, `archive-resolved`, `attach`, `authorize`, `cancel`, `child-notices`, `compact`, `cos`, `cost-pause`, `cost-switch`, `deny`, `deploy`, `deps`, `doctor`, `embedder`, `janitor`, `ls`, `mcp-proxy`, `onboarding`, `pause`, `permissions`, `pr`, `prune`, `reconnect-mcp`, `registry`, `releases`, `rename`, `reparent`, `req`, `restart`, `resume`, `retro`, `ring`, `rollback`, `settings`, `shutdown`, `subscribe`, `subscriptions`, `unpause`, `unsubscribe`, `upgrade-harness`, `usage`, `web`. The tests use `ls`, `archive`, `compact`, `restart`, `resume`, `pause`, `unpause`, `shutdown`, `cos`, `embedder`, `janitor`, `req`, `ring`, `retro`, `authorize`, `deny`, `registry`, `settings` and `child-notices`.

### 1.4 Spawn fields and other refusals

`POST /api/agents` in Go (`go/internal/server/lifecycle.go:316-415`) accepts only `machine` (its own), `name`, `harness` (`claude`), `model`, `effort`, `cwd`, `prompt`, `role`, `by`, `from`, `self`, `parent`, `standing`, `visibility`, `child_notices` and `permission_mode`. It answers 501 for:

- a parent while `settings.itsa.required` is on, which is the default: the TS spawn joins the new agent to its parent's open ITSA;
- no name (TS picks a free one), and no harness or model while `spawnDefaults.preset` is set;
- `type`, `preset`, `itsa`, `urgent`, `branch`, `base`, `worktree`, `workspace`, `workspace_script`, `workspace_instructions`, `chief_of_staff`, `vars`;
- `harness` `codex` or `opencode`, and a `machine` other than its own.

The CLI sends every one of these fields (`go/cmd/stam/agents.go`, `spawnSpec`), so the refusal comes from the daemon. Other refusals the tests reach: `stam forget` of an agent that owns ITSAs ("its ITSAs can't be unowned yet"), and a compaction with a prompt after it (`go/internal/server/lifecycle.go:187`). The rest of the "not ported" refusals in `go/internal/server` (decision steps, ITSA watch sync, peer mail forwarding, attachments, the mail check on mail to the human, ring member spawns, process agents) each belong to a PR below.

## 2. Each failing test

Category is the first failure; evidence is the run's FAIL line (`log:`), or the error the log shows above it. "Needs" lists every module the test still needs, the first one first (section 3 keys; `test fix`, `home-init`, `mail-gate`, `decision-steps` and `itsa-queue` are new). A landed module in Needs means a gap left behind it. A first failure marked "inferred" is read from the log and the test script, not proved: the log shows only a crash (`KeyError`, `JSONDecodeError`) or a timeout, and the cause is the step the script was on.

| Test | Category | First failure | Evidence | Needs |
|---|---|---|---|---|
| activity-peers | route | GET /api/activity | log: no route GET /api/activity | usage |
| agent-identity | behaviour | a new agent shares another's workspace | log: FAIL: e2e-id-new shared e2e-id-theirs's workspace | worktree |
| agent-tokens | test | compares /api/test/token-at-rest as a string, so key order counts | log: FAIL: … {"hashed":true,"plain":false} | test fix |
| archive-procs | home-file | a daemon an agent starts in a fresh home never answers: stamd creates no db or tokens | log: FAIL: timed out waiting for: third_up | home-init |
| ask-home-http | behaviour | inferred: an ask with a thread isn't the human's only mail in it | log: FAIL: the ask isn't in thread … as the human's only | mail-threads |
| asks | behaviour | a delegate ask on twin stays on the list before escalation | log: FAIL: timed out waiting for: _absent | req-ring-tools |
| assistant | behaviour | the assistant's prompt lacks the human's view context | log: FAIL: timed out waiting for: prompt_got … The human was looking at | cos |
| assistant-autostart | loop | no assistant agent is started | log: FAIL: timed out waiting for … "kind":"assistant" | cos |
| child-notices | cli | stam authorize | log: stam: authorize is not ported to the Go CLI yet | req-ring-tools |
| claude-view | route | GET /api/agents/:id/view/history | log: no route GET /api/agents/…/view/history | web-ui |
| comms-stats | route | GET /api/stats/comms (an agent token gets 404, not 403) | log: FAIL: amy's token wasn't refused | usage |
| compact-restart | lifecycle | Go kills the held compactor when the daemon stops, so none is left for the restart to stop | log: FAIL: the running compactor wasn't stopped (`:64`, after #1271) | agent-cli |
| compress | behaviour | JSON isn't brotli-compressed when br is accepted | log: FAIL: JSON not brotli when br is accepted | web-ui |
| context | test | count-only `poll`; then the context notice | log: FAIL: notice not delivered | test fix, agent-cli |
| cost | spawn-option | spawn: codex | log: stam: spawn: codex is not ported | codex |
| cost-switch-peer | spawn-option | inferred: spawn on another machine | log: FAIL: kid didn't spawn (KeyError 'id') | peers |
| delegate-ask | cli | stam permissions | log: stam: permissions is not ported to the Go CLI yet | req-ring-tools |
| developer-cap | spawn-option | spawn: a developer's own worktree | log: spawn: a developer's own worktree is not ported | worktree |
| developer-cap-peer | spawn-option | spawn: a developer's own worktree | log: spawn: a developer's own worktree is not ported | worktree, peers |
| diff-api-route | route | GET /api/diff | log: FAIL: file list (KeyError 'files') | web-ui |
| digest | route | POST /api/presence (the shared token gets 404, not 403) | log: FAIL: the shared token wasn't refused on POST /api/presence | cos |
| event-waits | route | inferred: a wait on an external event | log: KeyError 'id' (POST waits/declared on: event; Go refuses it) | events-subs |
| events | route | inferred: the client event stream (agent.spawned on register) | log: FAIL: timed out waiting for: spawned | events-subs |
| exit-context | test | count-only `poll`; then the resume with the compact note (S-4058) | log: FAIL: … not resumed with the compact note | test fix, agent-cli |
| files | behaviour | GET /api/files/list lists the roots for a path | log: FAIL: no path should list the roots | web-ui |
| first-prompt-ghost | loop | inferred: the first prompt never goes in past the fake's placeholder and dropped paste | log: FAIL: the first prompt was not taken: with prompt | agent-control |
| github-poller | route | inferred: a wait on an external event | log: KeyError 'id' (POST waits/declared on: event) | events-subs |
| harness-dialog | cli | stam authorize | log: stam: authorize is not ported to the Go CLI yet | req-ring-tools |
| harness-guard | spawn-option | spawn: codex | log: stam: spawn: codex is not ported | codex |
| home-lock | home-file | a second daemon on a home dies on the port, without naming the holder's pid | log: FAIL: no refusal naming pid …; bind: address already in use | home-init |
| human-relay | behaviour | answering a permission request another machine holds | log: … is not ported to the Go daemon yet | peers |
| human-strict | route | POST /api/shells | log: KeyError 'id' (POST /api/shells) | web-ui |
| human-strict-holder | behaviour | answering a permission request another machine holds | log: … is not ported to the Go daemon yet | peers |
| human-strict-peers | behaviour | the human's mail relayed to a peer is refused | log: FAIL: … only the human mails as the human | peers |
| isolation | adapter | OpenCode server | log: FAIL: no OpenCode server in the test tmux | opencode |
| itsa | behaviour | a remote owner name doesn't resolve | log: FAIL: a remote owner name didn't resolve to its id | peers |
| itsa-fields | behaviour | a field created through the home proxy names an agent of the proxying machine | log: FAIL: … no agent aksfw | peers |
| itsa-incident | spawn-option | spawn: a developer's own worktree | log: spawn: a developer's own worktree is not ported | worktree |
| itsa-incident-peer | behaviour | inferred: an ITSA naming a peer's agent | log: KeyError 'key' | peers |
| itsa-owners | behaviour | spawn --itsa: the system prompt doesn't name the owned ITSA | log: FAIL: the system prompt doesn't name the owned ITSA | spawn-join |
| itsa-owners-peers | behaviour | inferred: an ITSA owned by a peer's agent | log: JSONDecodeError (ITSA create with a peer owner) | peers |
| itsa-post-gate | behaviour | starting a ring spawns its members | log: … starting a ring spawns its members, which is not ported | req-ring-tools |
| itsa-post-gate-peers | spawn-option | spawn: opencode | log: stam: spawn: opencode is not ported | opencode |
| itsa-thread | behaviour | an ITSA post from a proxying machine's agent | log: stam: no agent carol | peers |
| janitor | home-file | a throwaway daemon in a fresh home exits: stamd creates no db or tokens | log: stam: stamd exited; see …/fake/daemon.log | home-init, janitor |
| janitor-tmux | cli | stam janitor | log: stam: janitor is not ported to the Go CLI yet | janitor |
| layout | route | GET /api/layout | log: FAIL: GET /api/layout | web-ui |
| linear-poller | behaviour | an ITSA link starts its watch (watch.syncItsa) | log: … watch.syncItsa, which is not ported | events-subs |
| local-default | home-file | a fresh home's settings.json with auth.localHuman | log: FAIL: a fresh install's settings.json doesn't have auth.localHuman true | web-ui |
| local-human | route | /api/human/login | log: FAIL: login wasn't reported off (KeyError 'enabled') | web-ui |
| m5 | spawn-option | spawn: worktree | log: stam: spawn: worktree is not ported | worktree |
| mail-check | behaviour | the mail check gives no verdict | log: FAIL: no true verdict on … | mail-gate |
| mail-gate | behaviour | the mail check on mail to the human | log: … the mail check on mail to your user is not ported | mail-gate |
| mail-gate-peers | behaviour | inferred: an ITSA naming a peer's agent | log: KeyError 'key' | peers, mail-gate |
| mail-gate-strict | behaviour | the mail check on mail to the human | log: … the mail check on mail to your user is not ported | mail-gate |
| mail-read-cited | behaviour | a reviewer can't read the thread cited in its brief (S-3767) | log: FAIL: the reviewer can't read the thread cited in its brief | mail-threads |
| mail-title-peers | behaviour | the agent list doesn't merge the peer's agents | log: FAIL: main doesn't list far | peers |
| mcp-tools | loop | the shim's release follow (followDeploys) | log: FAIL: timed out waiting for: probed | agent-cli |
| opencode-token | spawn-option | spawn: opencode | log: stam: spawn: opencode is not ported | opencode |
| peer-control | spawn-option | inferred: spawn on another machine | log: FAIL: kid didn't spawn (KeyError 'id') | peers |
| peer-deploy | spawn-option | spawn: a developer's own worktree | log: spawn: a developer's own worktree is not ported | worktree, peers |
| peer-identity | spawn-option | inferred: spawn on another machine | log: FAIL: kid didn't spawn (KeyError 'id') | peers |
| peer-outbox | behaviour | the agent list doesn't merge the peer's agents | log: FAIL: main doesn't list far | peers |
| peer-parent | spawn-option | spawn: worktree | log: spawn: worktree is not ported | worktree, peers |
| peer-permission | spawn-option | inferred: spawn on another machine | log: FAIL: kid didn't spawn (KeyError 'id') | peers |
| peer-queue-start | behaviour | the agent list doesn't merge the peer's agents | log: FAIL: main doesn't list far | peers |
| peer-start | spawn-option | spawn: a developer's own worktree | log: spawn: a developer's own worktree is not ported | worktree, peers |
| peer-ui-writes | route | the web server (`stam web`) a peer's settings name | log: FAIL: timed out waiting for: _web | web-ui |
| peer-wait | behaviour | a wait_for target on another machine | log: FAIL: … no agent haiku-exp | peers |
| peers | behaviour | the agent list doesn't merge the peer's agents | log: FAIL: twin agent missing from merged list | peers |
| personal-workspace | spawn-option | spawn: workspace | log: stam: spawn: workspace is not ported | worktree |
| pr-merge-peers | behaviour | inferred: an ITSA naming a peer's agent | log: KeyError 'key' | peers, pr-ops |
| pr-open-scope-peers | route | POST /api/pr/open | log: no route POST /api/pr/open | pr-ops |
| pr-review-peers | route | POST /api/pr/review | log: no route POST /api/pr/review | pr-ops |
| push | route | GET /api/push | log: FAIL: GET /api/push gives a P-256 public key | cos |
| reboot-fake | spawn-option | spawn: opencode | log: stam: spawn: opencode is not ported | opencode |
| reboot-starting | loop | inferred: a starting agent after a reboot doesn't get one recover event | log: FAIL: rs-idle: no single recover event | agent-control |
| reconcile-quiet | test | count-only `poll 400` (about 70 s on TS) | log: FAIL: the first reconcile tick never ran | test fix |
| reply-archived-peers | behaviour | inferred: an ITSA naming a peer's agent | log: KeyError 'key' | peers |
| reply-peers | spawn-option | spawn: opencode | log: stam: spawn: opencode is not ported | opencode |
| req-check | cli | stam req | log: stam: req is not ported to the Go CLI yet | req-ring-tools |
| requirements | cli | stam req | log: stam: req is not ported to the Go CLI yet | req-ring-tools |
| retro-loop | spawn-option | the steward spawns in a worktree | log: FAIL: no steward was spawned | worktree |
| reviewer-ring | spawn-option | spawn: codex (the holder) | log: stam: no agent holder | codex |
| reviewer-spawn | spawn-option | spawn: codex (the holder) | log: stam: no agent holder | codex |
| ring | cli | stam ring | log: stam: ring is not ported to the Go CLI yet | req-ring-tools |
| ring-peer | spawn-option | spawn: a ring reviewer type | log: spawn: a ring reviewer type is not ported | req-ring-tools |
| sent-copy | behaviour | inferred: mail between machines (main keeps the sent copy) | log: KeyError 'id' | peers |
| session-end | test | count-only `poll`; then the /clear SessionEnd | log: FAIL: e2e-se-a: ready | test fix, agent-control |
| spawn-base | spawn-option | spawn: worktree | log: spawn: worktree is not ported | worktree |
| spawn-cancel-peer | spawn-option | spawn: a developer's own worktree | log: spawn: a developer's own worktree is not ported | worktree, peers |
| stall | test | event-loop stalls in /api/health: Go has no event loop | log: FAIL: timed out waiting for: blocked | test fix |
| steps | behaviour | inferred: decision steps | log: JSONDecodeError (POST /api/steps) | decision-steps |
| strict-system | test-hook | the test-human header (x-stam-test-human) on POST /api/itsas | log: FAIL: … an ITSA action needs an agent (by) or the human | register |
| suggest | behaviour | the embedder doesn't index agents, ITSAs and turns | log: FAIL: timed out waiting for: indexed | mail-threads |
| suggest-input | test-hook | the human's approval with the test-human key (`x-stam-test-human`) is refused, so the wrong-hash check gets 403, not the 409 it asserts; nothing is approved | rerun log: status 403, `{"error":"only the human approves suggested input, from stam's web UI …"}`, the request still pending (`:124`) | register |
| term-size | route | the web server (`stam web`) and its tty | log: FAIL: timed out waiting for: … web0.log | web-ui |
| tmux-crash | spawn-option | spawn: opencode | log: stam: spawn: opencode is not ported | opencode |
| token-scope | route | GET /api/itsas/queue | log: FAIL: the shared token was refused on GET /api/itsas/queue | itsa-queue |
| tools | mcp-tool | the catalogue lists tools Go lacks | log: FAIL: the catalogue and tools/list disagree | req-ring-tools |
| usage-scope | route | GET /api/activity | log: FAIL: activity by itsa as a2 | usage |
| voice | route | GET /api/voice | log: FAIL: the human reads the status | cos |
| waits-mcp | mcp-tool | wait_for | log: Error: unknown tool wait_for | req-ring-tools |
| watch | route | inferred: POST /api/subscriptions | log: JSONDecodeError (POST /api/subscriptions) | events-subs |
| watch-pr | mcp-tool | watch_pr | log: FAIL: the subscription doesn't match the watch | events-subs |
| withdraw-ask-http | spawn-option | spawn: opencode | log: stam: spawn: opencode is not ported | opencode |
| withdraw-peers | behaviour | a permission request doesn't reach the human on both machines | log: FAIL: timed out waiting for: count_is 1 | peers |
## 3. Module PRs: landed, and the order of the rest

"First failure of" counts the failing tests whose first need is the module: the tests it moves on. "Green" counts those whose only remaining need it is: the tests it turns green, an upper bound, since a test can fail on its next behaviour gap. Risky means it touches auth, peers, mail routing or agent lifecycle, and wants an Opus developer and a careful review.

### 3.1 Landed

| Key | Module | ITSA | Left behind it (tests) |
|---|---|---|---|
| register | Register and test hooks | S-3724 | the test-human header: on `POST /api/itsas` (strict-system) and as the trusted human approving suggested input (suggest-input) |
| spawn-join | Spawn gaps | S-3732 | spawn `--itsa` doesn't name the owned ITSA in the system prompt (itsa-owners) |
| agent-control | Agent control routes | S-3746, S-3774 | first prompt past a placeholder and a dropped paste (first-prompt-ghost); one recover event after a reboot (reboot-starting) |
| agent-cli | Agent CLI and tools | S-4057 | the compactor dies with its daemon (compact-restart); the shim's release follow (mcp-tools); a compaction with a prompt after it, S-4058 (exit-context) |
| mail-threads | Mail threads, search, titles | S-3734, S-3735, S-4013 | cited thread grants, S-3767 (mail-read-cited); an ask with a thread (ask-home-http); the embedder's agent, ITSA and turn indexing (suggest) |
| config | Config and registry | S-3782 | none |
| cos | Chief of staff | S-4059 | `/api/voice`, `/api/push`, `/api/presence` and `/api/digest`, the assistant's autostart and its view context (assistant-autostart, assistant, digest, push, voice) |
| usage | Usage module | S-3807 | `GET /api/activity` (activity-peers, usage-scope) and `GET /api/stats/comms` (comms-stats) |

### 3.2 Remaining, in proposed order

| # | Key | PR | First failure of | Green | Depends on | Risky |
|---:|---|---|---:|---:|---|---|
| 1 | worktree | **Worktrees and workspaces:** a developer's own worktree, spawn `worktree`, `branch`, `base`, `workspace`, `workspace_script`, `workspace_instructions`; `/api/agents/:id/workspace-share`; MCP `workspace_share` | 12 | 7 | none | medium: git |
| 2 | peers | **Peers:** spawn on another `machine`, the merged agent list, ITSAs and posts naming a peer's agent, mail between machines, permission relays and answers held on another machine, wait_for targets on a peer | 22 | 20 (+5 after 1) | 1 for five | yes: peers |
| 3 | req-ring-tools | **Requirement, ring, wait and permission tools:** `stam req`, `ring`, `authorize`, `permissions`; ring member and reviewer spawns; MCP `wait_for` and the catalogue's other missing tools; delegate asks | 11 | 11 | none | medium: permissions |
| 4 | web-ui | **Web UI surface:** `/api/shells`, `/api/layout`, `/api/diff`, `/api/files` (roots), `/api/agents/:id/view*`, `/api/human/login`, `stam web`, a fresh home's `settings.json`, brotli JSON | 10 | 10 | none | yes: human auth, PTY |
| 5 | opencode | **OpenCode adapter:** the shared server, SSE, sessions, by-session routes | 7 | 7 | none | yes: lifecycle |
| 6 | events-subs | **Events, subscriptions, watch:** external-event waits, `/api/subscriptions`, the client event stream, `watch.syncItsa`, MCP `watch_pr` | 6 | 6 | none | medium: outward polling |
| 7 | cos | **Chief of staff, the rest:** voice, push, presence, digest, assistant autostart | 5 | 5 | none | low |
| 8 | codex | **Codex adapter** | 4 | 4 | none | yes: lifecycle |
| 9 | mail-gate | **Mail check on mail to the human** (S-3769) | 3 | 3 | none | yes: mail routing |
| 10 | usage | **Usage, the rest:** `/api/activity`, `/api/stats/comms` | 3 | 3 | none | low |
| 11 | mail-threads | **Mail threads, the rest:** cited thread grants, asks in threads, embedder indexing | 3 | 3 | none | medium |
| 12 | home-init | **A fresh home:** stamd creates `stam.db` and the tokens, and refuses a second daemon on its home naming the holder's pid (switch work, S-2194 section 4.4) | 3 | 2 | none | medium: startup |
| 13 | agent-cli, agent-control | **Lifecycle, the rest:** the compactor across a restart, the release follow, the first prompt past a placeholder, recovery after a reboot | 4 | 4 | none | yes: lifecycle |
| 14 | pr-ops | **PR ops:** `/api/pr/*`, MCP `pr_*` | 2 | 2 | 2 | yes: outward pushes |
| 15 | janitor | **Janitor and maintenance CLI** | 1 | 1 | 12 for the janitor test | medium: kills processes |
| 16 | decision-steps | **Decision steps** (`/api/steps`) | 1 | 1 | none | medium |
| 17 | itsa-queue | `GET /api/itsas/queue` | 1 | 1 | none | low |
| 18 | register, spawn-join | **Small leftovers:** the test-human header; spawn `--itsa` in the system prompt | 3 | 3 | none | low |

Notes on the order:

- Worktree comes first: it is the second most common first failure and five of the peer tests need it before they reach a peer gap. Peers then clears the most tests but is the riskiest; split it (spawn and the merged list; ITSAs and mail; permission relays) if it runs over 3k lines.
- 3, 4, 5 and 6 are independent of 1 and 2 and can run alongside them.
- Rerun the parity night after each module: the runs above stop at the first failure, so a module's "Green" is an upper bound.

### 3.3 Test fixes

Each in its own PR, which the TS daemon must still pass; none is made here.

- **Count-only polls:** `poll N` with no pause bounds a wait by N calls of `$STAM`, about 0.18 s each on TS and a few ms on Go, so it runs out before a 5 s reconcile tick or a 60 s sweep on Go. Failing for it: reconcile-quiet (`:44`), context, exit-context, session-end (each fails at a `poll` first, then on a real gap, in Needs). Also present in ring and stuck-resume. #1271 (S-4079) fixed compact-dedupe and compact-restart the same way.
- **agent-tokens** (`:46`) compares the token-at-rest JSON as a string, so the key order counts; compare the parsed values.
- **stall** waits for an event-loop stall in `/api/health`'s `stalls`; Go has no event loop and leaves it empty by design (`go/internal/server/health.go:18`). The check is TS-only.

### 3.4 Green lists

The tests each module would turn green on its own (its only remaining need):

- **worktree** (7): agent-identity, developer-cap, itsa-incident, m5, personal-workspace, retro-loop, spawn-base
- **peers** (20): cost-switch-peer, human-relay, human-strict-holder, human-strict-peers, itsa, itsa-fields, itsa-incident-peer, itsa-owners-peers, itsa-thread, mail-title-peers, peer-control, peer-identity, peer-outbox, peer-permission, peer-queue-start, peer-wait, peers, reply-archived-peers, sent-copy, withdraw-peers
- **req-ring-tools** (11): asks, child-notices, delegate-ask, harness-dialog, itsa-post-gate, req-check, requirements, ring, ring-peer, tools, waits-mcp
- **web-ui** (10): claude-view, compress, diff-api-route, files, human-strict, layout, local-default, local-human, peer-ui-writes, term-size
- **opencode** (7): isolation, itsa-post-gate-peers, opencode-token, reboot-fake, reply-peers, tmux-crash, withdraw-ask-http
- **events-subs** (6): event-waits, events, github-poller, linear-poller, watch, watch-pr
- **cos** (5): assistant, assistant-autostart, digest, push, voice
- **codex** (4): cost, harness-guard, reviewer-ring, reviewer-spawn
- **mail-gate** (3): mail-check, mail-gate, mail-gate-strict
- **usage** (3): activity-peers, comms-stats, usage-scope
- **mail-threads** (3): ask-home-http, mail-read-cited, suggest
- **home-init** (2): archive-procs, home-lock
- **agent-cli** (2): compact-restart, mcp-tools
- **agent-control** (2): first-prompt-ghost, reboot-starting
- **pr-ops** (2): pr-open-scope-peers, pr-review-peers
- **janitor** (1): janitor-tmux
- **decision-steps** (1): steps
- **itsa-queue** (1): token-scope
- **register** (2): strict-system, suggest-input
- **spawn-join** (1): itsa-owners
- **test fix** (3): agent-tokens, reconcile-quiet, stall

Needing two modules: developer-cap-peer, peer-deploy, peer-parent, peer-start and spawn-cancel-peer (worktree, then peers); mail-gate-peers (peers, mail-gate); pr-merge-peers (peers, pr-ops); janitor (home-init, janitor); context and exit-context (test fix, agent-cli); session-end (test fix, agent-control).
