# mootr

mootr runs and coordinates coding agents (Claude Code, OpenCode, and Codex) in background terminals. Each agent gets an id in a registry, a mailbox, and tracked state. You can enter any agent's terminal from the CLI or a web page, including from a phone. Agents reach the system through one MCP server, and machines join each other as peers.

> **Naming.** The product and its command are called mootr (`bin/mootr`). `stam` (`bin/stam`) still works as an alias with the same behaviour. Paths, environment variables and the MCP server name are still named `stam` (`STAM_HOME`, `~/.local/share/stam`).

The design is in [`docs/design.md`](../design.md).

## Requirements

- Node 24, tmux, and Git.
- Claude Code, OpenCode 2, Codex, or any of them, logged in.
- `npm install` in the repo root. It builds `node-pty`; if npm holds back its install script, approve it with `npm install-scripts approve node-pty`.
- For the web UI from a checkout: `npm install && npm run build` in `web/` (`mootr deploy` does this for releases).

## Quick start

Start the daemon, spawn an agent, and open it:

```sh
bin/mootr deploy               # build HEAD into a release under ~/.local/share/stam/releases
~/.local/share/stam/releases/current/bin/mootr daemon install   # a systemd user service running that release
bin/mootr spawn helper --preset fast "Summarize the README in this folder."
bin/mootr attach helper        # tmux; detach with Ctrl-b d
bin/mootr web                  # links to the web UI; + there adds an agent
```

`mootr web` prints the login page on `http://127.0.0.1:7878/` first. Open it on this machine and log in as the human with the one-time command it shows (see [Logging in as the human, locally](#logging-in-as-the-human-locally)): approvals, settings, and other human-only actions need that. The token links after it open the same UI as an agent's token, so those actions are refused there, and the page offers the login. Tailscale is optional: [several machines](#optional-several-machines) and a phone use it.

Mail it, and read what comes back:

```sh
bin/mootr mail send --to helper --subject "Follow-up" "Mail me the three longest sections."
bin/mootr mail read human
```

`bin/mootr` with no arguments lists every command.

## What it does

- **Spawn** in a directory, a new git worktree, a directory a script prints, or one the agent builds from instructions. A spawn may also take a personal workspace (`--workspace[=NAME]`, or `spawn_agent`'s `workspace`) at `STAM_HOME/workspaces/NAME` — a folder of its own, separate from the working directory and kept when it is archived — and `--standing` to mark a long-lived specialist. Pick a preset, or any harness and model, including models mootr doesn't know yet.
- **Agent types**: saved roles (developer, reviewer, manager, coordinator, advisor) that a manager spawns by name: `stam spawn NAME --type developer --worktree "TASK"`, or `spawn_agent` with `type`. A type brings its harness, model, and effort, its own instructions (template `type-NAME`, under Settings › Instructions), optional default visibility and child notices, and a brief its task is written into (`{{task}}`, `{{parent}}`, `{{name}}`, `{{type}}`, `{{cwd}}`, `{{branch}}`, plus `--var KEY=VALUE`). Edit them under Settings › Agent types, or in `registry.json` under `types` (`null` hides a shipped one). `stam registry` and `registry_info` list them.
- **Mail** between agents and you, with attachments and broadcast to `all`. A working agent sees a notice after its next tool call; an idle agent gets a prompt, without anything typed into its terminal.
- **State** from harness hooks and events: starting, working, blocked, idle, errored, paused, shut down, archived. A hook retries while the daemon restarts, and a Claude Code agent left 'working' at an empty prompt with no hook for `staleWorkingMinutes` (10) is marked idle, so its mail still arrives.
- **Live events**: `GET /api/live` is a server-sent events stream for the web UI (the system view), with the same token auth as the other `/api` routes and a `: ping` every 25 s. Its own path, as the layout's is; `GET /api/events` stays the external-event list. The events: `mail.sent {id, from, to[], thread, itsa, ask, subject, at}` and `mail.read {id, by, at}`; `agent.changed {id, state, activity, context_tokens, cost_usd, unread}` (coalesced to at most four a second per agent), `agent.spawned {id, name, parent_id}`, and `agent.archived {id}`; `itsa.changed {id, key, status, owner, fields}`; and `usage.changed {}`, which only tells the web to refetch `/api/usage`. Tested by `test/e2e-events.sh`.
- **Lifecycle**: pause, shut down, archive (removes the worktree, keeps the branch, and refuses while the branch has commits on no remote unless `force_unpushed`), resume with the conversation intact, restart, harness upgrade, and MCP reconnect. Actions that would cut a working agent off wait for its turn to end.
- **Context**: warning, instruction, and enforcement thresholds, which after a compaction count only once the context has grown `idleCompaction.growthTokens` past its size right after it; `compact_self` for agents; compaction of agents idle past the prompt-cache lifetime.
- **Machines**: list peer daemons in `settings.json`, and agents, mail, and terminals work across them. A peer may carry `start`, a shell command that starts its machine (for example a script that powers on a cloud VM): a spawn on a peer that doesn't answer runs it once (concurrent spawns share the run), polls the peer's `/api/health` every 2 s until it answers, then forwards the spawn. The wait is `STAM_PEER_START_TIMEOUT_MS` (5 minutes by default); a missing or failing command, or the deadline, fails the spawn with the command's last output lines. Tested by `test/e2e-peer-start.sh`. A peer may also carry `deploy`, a shell command that brings it to this daemon's release: a spawn on a peer whose `/api/health` reports another release runs it once (concurrent spawns share the run) with `STAM_RELEASE` (this release) and `STAM_PEER` set, then polls the peer until it reports this release, for `STAM_PEER_DEPLOY_TIMEOUT_MS` (10 minutes by default). A failed or late deploy doesn't stop the spawn: the response carries a `warning`, which the CLI prints to stderr and MCP spawn_agent appends. A spawn on another machine waits up to 16 minutes in all.
- **Permissions**: agents start in auto mode (bypass is the human's choice, in the web UI); `request_permission` sends blocked actions to you, the agent's parents, or the chief of staff.
- **Org structures**: parents and children with limits on whom a child may reach, an optional chief of staff, and rings of agents (rounds, ring of fire, debate) with an optional moderator. A parent chooses how much it hears about a child's finished turns (`childNotices`: `turn`, `tree-idle` the default, or `none`; blockers always reach it), with `stam child-notices AGENT VALUE`.
- **Developer slot cap**: `developerCap` in settings (default 6, per machine, 0 turns it off) limits the active developer-type agents on a machine. A developer spawn over it waits in a first-come-first-served queue instead of failing (S-2053): the reply says "queued, place N" and names the holders, the agent starts by itself when a slot frees, and the caller gets a notice then. `urgent` on `spawn_agent` (`red-main`, `deploy-hold`, `approved-pr` or `incident`; `--urgent` on `stam spawn`) queues it ahead of normal spawns, first come first served within each class. `incident` does so only under an ITSA, or a parent of one, that the chief of staff or the human marked with `itsa_set incident=true` (S-2406); otherwise it is refused, and the mark clears when the ITSA closes. A waiter whose caller is archived, or that waits over 2 hours, is dropped; the queue is saved in `slot-queue.json` and survives a daemon restart. Reviewers, managers and other types are never capped, and the human spawns past it. Spawns in flight count, and an untyped spawn into a worktree counts as a developer; unpause and resume are not checked. Managers are uncapped only while they work in plain directories.
- **Usage**: spend and tokens per agent, model, and day, and Claude's subscription windows, with warnings by mail.
- **Instructions**: each agent learns which instruction files its harness skips; `instructions.md`, skills, and MCP servers reach every harness.
- **Config you can read and edit**: every text mootr sends to agents is a template, editable in the web UI under **Config**, with the settings, registry, instructions, and usage.

## Web UI

The web UI is a React 19 + TypeScript app in `web/` (Vite; see [`docs/design.md`](../design.md), Web UI). The daemon serves its build, `web/dist`; without one, `/` says to build it.

```sh
cd web
npm install
npm run build        # web/dist, which the daemon serves
npm run typecheck    # tsc, strict
npm test             # vitest: mail components (snapshots), Settings, Usage, Details
```

To work on it, run Vite's dev server against a test daemon, never the live one: it proxies `/api`, terminal WebSockets included, to the daemon in `STAM_HOME` and `STAM_PORT`, signs in with that daemon's token, and reloads on save:

```sh
STAM_HOME=/tmp/stam-dev STAM_PORT=7880 npm run dev    # http://127.0.0.1:5173/web/
```

Start that daemon as in Deploy below, or use `web/check/daemon.sh`, which starts a throwaway daemon with an agent and mail in every component; `web/check/shots.mjs` screenshots the UI's states at desktop and phone width in both themes, and `web/check/interactions.mjs` drives the drag and send interactions (tabs, ranking, adding agents, writing to a chief of staff, the assistant) with a real mouse and keyboard and exits 1 if one fails (`test/e2e-ui.sh` runs it on its own daemon). `web/check/phone.mjs` checks the phone layout: every day-to-day flow by touch at 360 and 430 px in both themes, with the keyboard simulated, on such a daemon (it sends a prompt and replies, a few cents of Haiku; restart the daemon before a second run, since it answers the seeded mail). It runs Chromium, or WebKit with `--webkit` and `WEBKIT_EXE` pointing at a launcher for Playwright's WebKit.

### On a phone: the app and notifications

mootr installs as an app and pushes a notification for each mail to you and each permission request, so it needn't stay open. Settings, Notifications:

- **Android (Chrome):** open your Tailscale HTTPS address, which `stam web serve` prints, then Install mootr (or the browser menu's Install app). Turn on for this device, allow notifications, and Send a test. A permission request's notification has Approve and Deny; a tap on any notification opens its thread.
- **iPhone or iPad (iOS 16.4 or later):** in Safari, Share, then Add to Home Screen; open mootr from the home screen, then turn notifications on there (iOS sends them only to the installed app). iOS has no buttons on notifications, so a tap opens the request.
- Each device picks what it gets (mail, permission requests) and can be tested or removed from the list.

The daemon sends them itself with the standard Web Push protocol (payloads encrypted for the device, signed with a VAPID key kept in `STAM_HOME/vapid.json`), through the browser's own push service (Google's for Chrome, Apple's for Safari). Devices are stored per daemon, on the one whose page subscribed. A daemon that stores mail to you tells its peers the mail's id; each fetches that mail back from it, checks it is recent mail to you, writes the notification itself, and pushes each id once, so a forged relay pushes nothing. Approve and Deny on a notification go to the daemon that owns the request.

A phone reaches the daemon over HTTPS, which push needs, so it goes through `tailscale serve`; a browser on the daemon's machine can also use the local login page. Only you manage devices: agents hold the token and can send any header to `127.0.0.1`, so the push routes accept only the human: a local login session, or a request through `tailscale serve` (`tailscaled`, root, owns the connecting socket, its `Tailscale-User-Login` is the machine owner's, and its client isn't this machine or a peer, where agents run). A `stam web` token link's refusal says where to go instead. Test daemons set `STAM_TEST_HUMAN_KEY` to stand in for serve. Mail between agents never pushes. The service worker (`web/public/sw.js`, served at `/sw.js`) caches nothing, so deploys show at the next load as before. Icons come from `node scripts/make-icons.mjs`.

## Deploy

The live system runs from a release, never from a checkout, so a broken merge can't take it down. The daemon, the MCP shim agents launch, their hooks, and the web files all come from `STAM_HOME/releases/current`.

- `stam deploy [REF] [--repo DIR]` builds a committed ref (default `HEAD` of the checkout you run it in; uncommitted changes are left out) into `releases/SHA`. It installs dependencies once per `package-lock.json` and hard-links them into each release, runs `web/`'s `build` script (the React UI into `web/dist`), and checks the release: every module loads, the CLI runs, and a scratch daemon on a temporary home and port answers HTTP. Then it switches `current`, restarts the service, and waits for the new release to answer: 20 s, plus 10 s per whole point of 1-minute load above the CPU count, capped at 90 s. If it doesn't answer in time, or the service stops or restarts while starting, it switches back and restarts again.
- `stam rollback [RELEASE]` switches to the previous release, or a named one, the same way. `stam releases` lists them.
- Deploys keep the five newest releases, plus `current`, `previous`, and any release a running process uses (an agent's MCP shim started before a deploy).
- `stam daemon install` writes the unit to run `releases/current`. Before the first deploy it runs the checkout.

To develop, run a daemon from the checkout on its own home, port, and tmux socket, as `test/e2e-peers.sh` does:

```sh
STAM_HOME=/tmp/stam-dev STAM_PORT=7880 STAM_OPENCODE_PORT=4792 STAM_TMUX_SOCKET=stam-dev STAM_MACHINE=dev STAM_BIND=127.0.0.1 bin/stam daemon run
```

`STAM_SERVICE` names the systemd unit (default `stamd`), so a test instance can have its own.

## Where things live

`STAM_HOME` (default `~/.local/share/stam`) holds `releases/` (deployed code, `current` the live one), `deps/` (installed dependencies by lock file), `stam.db` (registry and mail), `settings.json`, `registry.json`, `templates/` (your template overrides), `agents/ID/` (files generated per agent), `attachments/`, `worktrees/`, `workspaces/` (each agent's personal workspace, kept across archive), `token`, `vapid.json` (the Web Push key), and `daemon.log`.

## Tests

Every test runs against its own throwaway daemon, never the live one: `test/lib.sh` starts one with a temporary `STAM_HOME` (`/tmp/stam-test.OWNER.XXXXXX`, OWNER the calling agent's id or `user`, with an `owner` file; cleanup deletes only its own), free ports for mootr and its OpenCode server, its own tmux socket and machine name, and no peers, and on exit kills its agents and tmux server, stops it, and deletes the folder. Agents still use your harness logins. Tests can run from inside a mootr agent, and side by side.

```sh
test/run.sh                    # the free tests: mail threading, the isolation itself, deploys, web UI drags
test/run.sh --smoke            # also the smoke tests: real harnesses on cheap models, by hand only
test/run.sh --parallel m1 m2   # chosen tests, at once
```


`run.sh` prints pass or fail, time, and spend per test (the cost the test daemons recorded; Codex reports none) next to the estimate. A test that runs past `STAM_TEST_TIMEOUT` seconds (default 600; 0 turns it off) shows as HUNG: its process group is stopped and the rest run on. Without loopback (a Codex sandbox) it stops before it starts. `KEEP=1 test/e2e-m1.sh` leaves the daemon and its folder for a look.


| Test | Covers | Cost |
| --- | --- | --- |
| `test/mail-threading.test.mjs` | Daemon-side mail threading (no daemon) | free |
| `test/openrouter.test.mjs` | OpenRouter credit balance and low-balance warning, stubbed HTTP (no daemon) | free |
| `test/e2e-isolation.sh` | The test helper: no live settings leak in, two daemons, nothing left behind | free |
| `test/e2e-child-notices.sh` | A parent's child-turn notices: `turn`, `tree-idle` (default), `none`, and blocked | free |
| `test/e2e-ui.sh` | Web UI in headless Chromium, real mouse drags: tabs between panes and split edges, agents from the tree, ranking a mail's Rank by drag and arrows, sending it | free |
| `test/e2e-ui-assistant.sh` | Web UI: sending to the executive assistant from the prompt input's button and the Alt+A overlay (Haiku) | about $0.02 |
| `test/e2e-ui-build.sh` | UI flow startup: a failed web build says so, and a daemon that dies still says it didn't start (no Chromium) | free |
| `test/e2e-m1.sh` | Spawn, state, context size (the scripted fake) | free |
| `test/e2e-m2.sh` | Mail between agents, idle push, drafts, notices during a turn (the scripted fake) | free |
| `test/e2e-m5.sh` | Lifecycle and worktrees | about $0.05 |
| `test/e2e-context.sh` | Thresholds, forced compaction once (not again while the agent is still above the thresholds), `compact_self`, idle compaction | about $0.08 |
| `test/e2e-peers.sh` | Two daemons as two machines | about $0.03 |
| `test/e2e-peer-start.sh` | A spawn on a stopped peer starts it once, concurrent spawns share the start, a failing start errors (the scripted fake) | free |
| `test/e2e-org.sh` | Trees, visibility, chief of staff | about $0.10 |
| `test/e2e-ring.sh` | Rings with mixed models | about $0.10 |
| `test/e2e-instructions.sh` | Instructions and skills across harnesses | about $0.05 |
| `test/e2e-codex.sh` | Codex: idle push, drafts, notices, bypass mode, compaction, resume | a few cents |
| `test/e2e-restart-mail.sh` | One push and one turn per mail across a daemon restart (Codex, Claude Code) | about $0.02 |
| `test/e2e-reboot.sh` | All three harnesses resume after a reboot and a tmux crash | a few cents |
| `test/e2e-argv.sh` | No prompt, note, or system prompt on any command line (`ps`) through spawn, resume, and restart, for all three harnesses | about $0.02 |

Set `A_HARNESS`, `B_HARNESS`, or `HARNESS` with a matching model to run them on OpenCode, for example `HARNESS=opencode MODEL=openrouter/~deepseek/deepseek-v4-flash-latest test/e2e-m5.sh`. A new test sources `test/lib.sh` and calls `isolate`; see the top of that file.

## Logging in as the human, locally

Agents run as your Unix user, so a token in a file or URL isn't proof that a person is at the keyboard. The setting `auth.localHuman` adds a login page on `http://127.0.0.1:7878/`. It shows a one-time command, which you run in your own terminal:

```sh
sudo /usr/bin/install -d -m 755 /run/stam-human /run/stam-human/UID && sudo /usr/bin/install -m 644 /dev/null /run/stam-human/UID/N
```

The page fills in `UID` (your user id) and `N` (a one-time name). The daemon accepts the login only if that file is owned by root, which an agent without root can't make. The command runs the system `install`, not `stam`, so the command itself isn't code your user owns. Run it in a fresh terminal you trust, outside mootr, not in a mootr web shell.

A fresh install has it on. An install from before it became the default has `"localHuman": false` written into `auth` in `settings.json` on its next start, so it keeps working as before; set it to `true` there to turn the login on. Through `tailscale serve`, the setting changes nothing.

With passwordless sudo, any agent can run that command itself, so the login keeps no agent out; the login page says so when `sudo -n true` succeeds. Residual risk: this blocks the obvious path, not a compromised shell. An agent running as your user can wrap `sudo` (a function or alias in your shell rc files, or a wrapper earlier on `PATH`) and intercept the command. It can also read the browser's stored session or drive the browser while you're logged in. For real isolation, run the agents as another Unix user.

## Optional: several machines

Run a daemon per machine and list them as `peers` in `settings.json`; each machine's daemon owns its agents, and the agent lists and the human inbox merge across peers. `stam web serve` publishes the web UI over HTTPS on a Tailscale network through `tailscale serve`, so your own devices need no token. See `docs/design.md` for how peers work.

## License

Apache-2.0; see [LICENSE](../../LICENSE) and [NOTICE](../../NOTICE).
