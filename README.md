# mootr

mootr is a system for running and coordinating many coding agents (Claude Code, Codex, OpenCode) from one place, with a web UI, mail between agents, and issue tracking. The command-line tool is still named `stam` during the rename to mootr.

> **Work in progress.** Very much so: expect breaking changes, and don't rely on it yet.

## Requirements

- Linux (macOS is untested)
- Node.js 24 or later, git, and tmux
- A C++ toolchain, to build `node-pty`
- At least one harness installed and logged in as the same Unix user that runs the daemon: Claude Code, Codex, or OpenCode (`CLAUDE_CONFIG_DIR` can point Claude Code at another login)

Optional: systemd user units (to run the daemon as a service), `gh` (to open pull requests), and Playwright Chromium (`npm run install:chromium`, for the UI checks).

## Quickstart

1. Clone `https://github.com/kimborgen/mootr` and install the dependencies (root and `web/`):

   ```sh
   npm run setup
   ```

2. Build the web UI:

   ```sh
   npm run build
   ```

3. Put `bin/stam` on your `PATH`, for example `ln -s "$PWD/bin/stam" ~/.local/bin/stam`.

4. Check the machine: `stam doctor` lists what is missing (Node, tmux, git, a harness, `STAM_HOME`, the port) with a fix for each, and works with no daemon running. `--json` prints the same as JSON; it exits 1 when a check fails.
5. Start the daemon from a shell that has your harness CLI (`claude`, `codex`, `opencode`) on its `PATH`; otherwise `stam registry` shows it as `not installed` until you restart the daemon with it on `PATH`. As an alternative, `STAM_CLAUDE_BIN`, `STAM_CODEX_BIN` and `STAM_OPENCODE_BIN` point the daemon at a harness binary directly, by path, instead of looking it up on `PATH`. Run it in the foreground with `npm start`, or in the background with `stam daemon start`. To run it as a systemd user service instead, use `stam daemon install`. The daemon listens on `127.0.0.1:7878`; `STAM_PORT` changes the port, and when Tailscale is present the daemon also binds the Tailscale IP (`STAM_BIND` sets the addresses), and its data lives in `~/.local/share/stam` (`STAM_HOME`). Tailscale is optional; you need it only for several machines or a phone.
6. Print the web UI links and open the first, the login page on `http://127.0.0.1:7878/`:

   ```sh
   stam web
   ```

   Log in as the human with the one-time `sudo` command the page shows, run in your own terminal. Approvals and settings need it; the token links `stam web` prints after it open the UI without it. See [Logging in as the human, locally](docs/guide/README.md#logging-in-as-the-human-locally).

7. Spawn a first agent from the web UI, or from the folder it works in:

   ```sh
   stam spawn first --preset standard "Say hello, then wait."
   ```

   `STAM_TMUX_SOCKET` is the name of the tmux server a home keeps its agents' terminals in: a short name, not a path, `stam` by default. Leave it alone unless you run a second stam home on this machine; then give each home its own name, or its agents land in the first home's tmux server.

   `stam registry` lists the presets, harnesses, and models; `stam ls` lists agents; `stam attach first` opens one's terminal. `stam` with no arguments prints every command.

## Tests

`npm test` runs the deterministic suite. No test calls a real AI: agents run a scripted fake Claude Code (see [`docs/testing.md`](docs/testing.md)).

## More

- [Full guide](docs/guide/README.md): features, web UI, deploy, tests.
- [Design](docs/design.md) and [testing](docs/testing.md).

## License

Apache License 2.0, see LICENSE and NOTICE.
