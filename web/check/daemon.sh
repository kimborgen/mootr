#!/bin/sh
# A throwaway daemon serving the freshly built web/dist, seeded for UI comparison:
#   web/check/daemon.sh          prints "URL=http://127.0.0.1:PORT/#token=TOKEN&testHuman=KEY", then stays up until killed
# It never touches the live daemon: test/lib.sh gives it its own home, ports, and tmux socket,
# and tears them down on exit. Its agents run the fake Claude Code (docs/testing.md), so no
# model runs and nothing is spent.
# OWN_VIEW=1 also runs the fake OpenCode (test/fake-opencode) and adds an OpenCode agent,
# oc, with a seeded conversation for stam's own view of it (web/check/seed-view.mjs).
# VIEW_TOGGLE=1 (with OWN_VIEW=1) also runs the fake Codex (test/fake-codex/codex) and adds a
# Codex agent, cx, with a seeded thread, and a Claude Code agent, cc, whose fake turn runs a
# tool and replies, for the terminal and conversation switch (web/check/viewtoggle.mjs).
# It exits on its own after DAEMON_MAX_LIFE seconds (default 7200); the janitor (S-175, S-195) stops
# it sooner when its owner agent is no longer active.
# SEED_ACTIVITY=1 adds the realistic activity fixture (seed-activity.mjs) for the Activity tab.
# SKIP_BUILD=1 reuses the existing web/dist. NO_HELLO=1 gives helper no prompt and pauses it,
# so mail sent to it by a check is held, not answered; no spend either way.
set -e
HERE="$(dirname "$(readlink -f "$0")")"
STAM_TEST_ROOT="$(cd "$HERE/../.." && pwd)"
export STAM_TEST_ROOT
. "$STAM_TEST_ROOT/test/lib.sh"
# run.sh sets CHECK_PIDS, a file outside this folder, and this script records what it starts there:
# "pid N", "pane N" (a fake agent's pane), "tmux N" (the test tmux server), "home PATH" (this run's
# temporary folder). run.sh kills those by PID after this exits and removes the home (S-965).
note() { [ -z "$CHECK_PIDS" ] || printf '%s %s\n' "$1" "$2" >>"$CHECK_PIDS"; }
note home "$TEST_TMP"
# A failed build leaves BUILD_FAILED=1 in the log, after the build's own output, so the callers
# say the build failed, not that the daemon didn't start (S-2162).
if [ -z "$SKIP_BUILD" ] && ! (cd "$STAM_TEST_ROOT/web" && npm run build >&2); then
  echo "BUILD_FAILED=1" >&2
  exit 1
fi
# The human's own routes (notification devices) want a request through tailscale serve;
# this key stands in for it, and the URL carries it for the checks (testHuman=).
STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
# The mail check (settings.decisions.mailCheck) runs against a stub decisions endpoint, so
# the seeded mails to the human get verdicts for the UI checks. Free, no live model.
STUB="$TEST_TMP/stub"
mkdir -p "$STUB"
node "$STAM_TEST_ROOT/test/decide-stub.mjs" "$STUB" >&2 &
STUB_PID=$!
note pid "$STUB_PID"
keep=
REGISTRY_PID=
# Everything this script started goes with it: on any exit, and on INT, TERM and HUP (which exit,
# so the EXIT trap runs). The daemon and temp folder go through lib.sh's cleanup (S-668).
# The fake agents' panes, recorded for run.sh (S-965). Called once the agents exist, and again on exit.
note_panes() { for p in $(tmux -L "$STAM_TMUX_SOCKET" list-panes -a -F '#{pane_pid}' 2>/dev/null); do note pane "$p"; done; }
daemon_exit() {
  set +e
  kill $keep $REGISTRY_PID $STUB_PID 2>/dev/null
  note_panes
  stam_test_cleanup
}
trap daemon_exit EXIT
trap 'exit 130' INT TERM HUP
for _i in $(seq 1 50); do [ -s "$STUB/url" ] && break; sleep 0.2; done
[ -s "$STUB/url" ] || { echo "the decide stub didn't start" >&2; exit 1; }
export STAM_OPENROUTER_URL="$(cat "$STUB/url")"
# A fixture home for the MCP import scan (S-52): the daemon reads these harness configs
# instead of the user's own, so the check is the same on every machine. `filesystem` matches
# the seeded stam server (already added), `github` differs from it, and the rest are new.
HARNESS_HOME="$TEST_TMP/harness-home"
mkdir -p "$HARNESS_HOME/.codex" "$HARNESS_HOME/.config/opencode"
cat >"$HARNESS_HOME/.claude.json" <<'JSON'
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/work"], "env": { "FAKE_TOKEN": "not-a-real-secret" } },
    "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/" },
    "linear": { "type": "sse", "url": "https://mcp.linear.app/sse" },
    "stam": { "command": "stam", "args": ["mcp"] }
  },
  "projects": { "/work/proj": { "mcpServers": { "project-docs": { "command": "docs-server" } } } }
}
JSON
cat >"$HARNESS_HOME/.codex/config.toml" <<'TOML'
[mcp_servers.codex-notes]
command = "codex-notes"
args = ["--stdio"]
TOML
cat >"$HARNESS_HOME/.config/opencode/opencode.jsonc" <<'JSONC'
{
  // OpenCode's user config
  "mcp": { "oc-tools": { "type": "remote", "url": "https://oc.example/mcp" } },
}
JSONC
export STAM_HARNESS_HOME="$HARNESS_HOME"
# The agents run the scripted fake Claude Code, not a model: helper's hello gets one line and
# Stop, the assistant's checks get the word they ask it to repeat, and anything else gets "ok".
cat >"$TEST_TMP/fake.json" <<'JSON'
{
  "turns": [
    { "match": "Say hi in one line", "steps": [
      { "status": { "rate_limits": {
          "five_hour": { "used_percentage": 37, "resets_at": FIVE_RESET },
          "seven_day": { "used_percentage": 12, "resets_at": WEEK_RESET } } } },
      { "reply": "Hi." } ] },
    { "match": "/Reply with exactly the word (\\S+)/", "steps": [{ "reply": "${1}" }] },
    { "match": "Is the release branch ready to tag?", "steps": [
      { "tool": "Bash", "input": { "command": "git log --oneline main..release | head -3", "description": "Commits on release not on main" }, "output": "a41c2e9 Fix the login redirect\n7be03d1 Bump the version to 2.4.0" },
      { "reply": "Yes. `release` is two commits ahead of `main`: the login redirect fix and the version bump.\n\n> [!DONE]\n> Ready to tag as `v2.4.0`." } ] }
  ],
  "default": { "steps": [{ "reply": "ok" }] }
}
JSON
# The windows reset two hours and three days from now, so the readings are current on every run.
sed -i "s/FIVE_RESET/$(($(date +%s) + 7200))/; s/WEEK_RESET/$(($(date +%s) + 259200))/" "$TEST_TMP/fake.json"
fake_claude "$TEST_TMP/fake.json"
# A fake MCP registry for the browser checks (S-53), so no check touches the network.
REGISTRY_PORT=$(free_port)
REGISTRY_READY="$TEST_TMP/registry.ready"
REGISTRY_PORT=$REGISTRY_PORT REGISTRY_READY=$REGISTRY_READY node "$STAM_TEST_ROOT/test/mcp-registry-fake.mjs" &
REGISTRY_PID=$!
note pid "$REGISTRY_PID"
for _i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do [ -s "$REGISTRY_READY" ] && break; sleep 0.1; done
export STAM_MCP_REGISTRY_URL="http://127.0.0.1:$REGISTRY_PORT/v0.1/servers"
# A fixed reading for the machine meters (S-127): this machine's /proc files are read from a
# fixture, so the CPU, RAM, and swap fills don't move with the load of the machine running the
# check. The counters never change, so the CPU reads 0 and RAM 50%, swap 25%, on every run.
PROC_DIR="$TEST_TMP/proc"
mkdir -p "$PROC_DIR"
printf 'cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0 0 0\ncpu1 50 0 50 400 0 0 0 0 0 0\n' >"$PROC_DIR/stat"
printf 'MemTotal:       8000000 kB\nMemAvailable:   4000000 kB\nSwapTotal:      2000000 kB\nSwapFree:       1500000 kB\n' >"$PROC_DIR/meminfo"
printf '0.50 0.40 0.30 1/200 1234\n' >"$PROC_DIR/loadavg"
export STAM_PROC_DIR="$PROC_DIR"
daemon_home ui
stub_key ui
use ui
[ -z "$OWN_VIEW" ] || export STAM_OPENCODE_BIN="$STAM_TEST_ROOT/test/fake-opencode/opencode"
if [ -n "$VIEW_TOGGLE" ]; then
  export STAM_CODEX_BIN="$STAM_TEST_ROOT/test/fake-codex/codex"
  export STAM_FAKE_CODEX_THREAD="$TEST_TMP/codex-thread.json"
  cat >"$STAM_FAKE_CODEX_THREAD" <<'JSON'
{ "turns": [ { "id": "turn-1", "status": "completed", "startedAt": 1000, "items": [
  { "id": "u-1", "type": "userMessage", "content": [{ "type": "text", "text": "Why does the login test fail?", "text_elements": [] }] },
  { "id": "r-1", "type": "reasoning", "summary": ["Run the login tests alone first."], "content": [] },
  { "id": "c-1", "type": "commandExecution", "command": "npm test -- login", "cwd": "/work/app", "status": "completed", "aggregatedOutput": "11 passed\n1 failed: login redirects to /home\n", "exitCode": 1, "source": "agent", "commandActions": [] },
  { "id": "m-1", "type": "agentMessage", "text": "One test fails: the redirect after login goes to `/` instead of `/home`.\n\n```tests\n11 passed\nFAIL login redirects to /home\n  expected \"/home\", got \"/\"\n```\n\nThe route changed in `a41c2e9`; I can update the test or the route." }
] } ] }
JSON
fi
# SEED_ACTIVITY=1: S-1009's realistic activity fixture (700 agents over 7 days; SEED_ACTIVITY_AGENTS
# overrides) for the Activity tab at scale (seed-activity.mjs). It goes in before the daemon starts, so
# the activity summary folds it at start-up as it does live items.
[ -z "$SEED_ACTIVITY" ] || node "$HERE/seed-activity.mjs" $SEED_ACTIVITY_AGENTS >&2
daemon_up ui
# The stam daemon and its tmux server, recorded as soon as they run, so a daemon.sh killed hard
# still leaves them for run.sh (S-965).
note pid "$(cat "$STAM_HOME/daemon.pid" 2>/dev/null)"
note tmux "$(tmux -L "$STAM_TMUX_SOCKET" display-message -p '#{pid}' 2>/dev/null)"
# The tmux socket's name, for run.sh's KEEP stop command to remove its file (S-1225).
note socket "$STAM_TMUX_SOCKET"
# The desktop flows were written for the terminal tabs (agent:ID); the conversation default (S-173)
# is checked by the viewtoggle run (VIEW_TOGGLE=1).
# The assistant (started by the first message to it) takes the model's name for its label;
# the fake answers, so no model runs. Mail titles (S-297) come from the stub too, from each subject.
# The diff view's PR (S-1531): a small git repo with a refs/pull/7/head, named `fixture` in itsa.repos (seed-diff.sh).
DIFF_CHECKOUT="$(sh "$HERE/seed-diff.sh" "$TEST_TMP/diff-git")"
export DIFF_CHECKOUT
# The checkout's origin reads as the GitHub repo `fixture/repo`, so a GitHub PR URL maps to the `fixture` repo (S-1533), and the
# diff cache rewrites that URL back to the local bare repo it fetches from.
git -C "$DIFF_CHECKOUT" remote set-url origin https://github.com/fixture/repo.git
mkdir -p "$STAM_HOME/cache/diff"
git init -q --bare "$STAM_HOME/cache/diff/fixture.git"
git -C "$STAM_HOME/cache/diff/fixture.git" config "url.$TEST_TMP/diff-git/origin.git.insteadOf" https://github.com/fixture/repo.git
node -e 'const f=process.argv[1],s=JSON.parse(require("fs").readFileSync(f));s.itsa={...(s.itsa||{}),repos:{fixture:process.env.DIFF_CHECKOUT}};s.assistant={harness:"claude",model:"claude-haiku-5-5",effort:null,cwd:""};s.mail={titles:{model:"stub/title-model"}};s.decisions={mailGate:false};if(!process.env.VIEW_TOGGLE)s.agentView={default:"terminal"};require("fs").writeFileSync(f,JSON.stringify(s,null,2))' "$STAM_HOME/settings.json"
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
id() { "$STAM" show "$1" | grep -m1 '"id"' | cut -d'"' -f4; }
if [ -n "$NO_HELLO" ]; then
  "$STAM" spawn helper --harness claude --model claude-haiku-5-5 --cwd "$DIR" --role "UI check helper." >&2
else
  "$STAM" spawn helper --harness claude --model claude-haiku-5-5 --cwd "$DIR" --role "UI check helper." "Say hi in one line." >&2
fi
# The child gets no prompt.
"$STAM" spawn kid --type manager --harness claude --model claude-sonnet-5-5 --cwd "$DIR" --parent helper --role "Child of helper." >&2
# A chief of staff with its own assistant, intake (the role names the assistant, as the Assistant
# tab's switch finds it), idle with no prompt. interactions.mjs and phone.mjs set the chief themselves.
"$STAM" spawn cos --harness claude --model claude-haiku-5-5 --cwd "$DIR" --chief-of-staff --role "UI check chief of staff." >&2
"$STAM" spawn intake --harness claude --model claude-haiku-5-5 --cwd "$DIR" --parent cos --role "cos's intake assistant: triages the ideas and notes it gets." >&2
note_panes
"$STAM" wait helper --until idle --timeout 90 >&2
[ -z "$NO_HELLO" ] || "$STAM" pause helper >&2
if [ -n "$OWN_VIEW" ]; then
  "$STAM" spawn oc --harness opencode --cwd "$DIR" --role "OpenCode agent for the conversation view check." >&2
  node "$HERE/seed-view.mjs" "$STAM_OPENCODE_PORT" "$("$STAM" show oc | grep -m1 '"session_id"' | cut -d'"' -f4)" "$STAM_HOME/stam.db" "$(id oc)" "$(id cos)" >&2
  if [ -n "$VIEW_TOGGLE" ]; then
    "$STAM" spawn cx --harness codex --cwd "$DIR" --role "Codex agent for the view switch check." >&2
    "$STAM" spawn cc --harness claude --model claude-haiku-5-5 --cwd "$DIR" --role "Claude Code agent for the view switch check." "Is the release branch ready to tag?" >&2
    "$STAM" wait cc --until idle --timeout 60 >&2
  fi
fi
# Each agent's own token, from its tmux session: the shared token can't act as an agent that has one (S-545).
token_of() { tmux -L "$STAM_TMUX_SOCKET" show-environment -t "$(id "$1")" STAM_TOKEN 2>/dev/null | cut -d= -f2-; }
AGENT_TOKENS="{$(for a in helper kid cos intake; do printf '"%s":"%s","%s":"%s",' "$a" "$(token_of $a)" "$(id $a)" "$(token_of $a)"; done | sed 's/,$//')}"
SEED_AGENT_TOKENS="$AGENT_TOKENS" node "$HERE/seed.mjs" "$STAM_URL" "$(cat "$STAM_HOME/token")" "$(id helper)" >&2
# Closed issues with spend, for the Usage page's Issues fold (seed-issues.mjs).
node "$HERE/seed-issues.mjs" "$STAM_HOME/stam.db" >&2
# SEED_DRILL=1: trees, a project ITSA with child ITSAs and many agents, with spend, for the Usage drill-down (seed-drill.mjs).
[ -z "$SEED_DRILL" ] || node "$HERE/seed-drill.mjs" "$STAM_HOME/stam.db" >&2
# SEED_PHONE_LIST=1: 26 live agents in three trees 4 to 5 deep, five stopped and forty archived, across two machines (seed-phone-list.mjs, S-3281).
[ -z "$SEED_PHONE_LIST" ] || node "$HERE/seed-phone-list.mjs" "$STAM_HOME/stam.db" >&2
# Wait until the seeded mails to the human have their verdicts, so the checks find the marks.
for _i in $(seq 1 50); do
  curl -sf -H "authorization: Bearer $(cat "$STAM_HOME/token")" "$STAM_URL/api/agents/human/threads?limit=60" | grep -q '"follows":true' && break
  sleep 0.2
done
# Wait until the hello turn's statusline reading has reached the usage API with its window
# shares, so the worth check starts from the same state every run. The reading is posted by
# the statusline command with a timeout that drops it silently, so this waits on the result
# rather than assuming it landed.
# (NO_HELLO has no hello turn, so no reading to wait for.)
if [ -z "$NO_HELLO" ]; then
for _i in $(seq 1 50); do
  curl -sf -H "authorization: Bearer $(cat "$STAM_HOME/token")" "$STAM_URL/api/usage" | grep -q '"shares":{"five_hour":' && break
  sleep 0.2
done
curl -sf -H "authorization: Bearer $(cat "$STAM_HOME/token")" "$STAM_URL/api/usage" | grep -q '"shares":{"five_hour":' || { echo "the claude windows never got their shares" >&2; exit 1; }
fi
# A wait gap the Time and cost block can show (S-2334): the ITSA's wait rows come from helper's gaps
# between turns, and a gap under 0.5 s rounds to zero seconds and drops its row. A mail from kid after
# two quiet seconds ends a gap well above that, whatever the machine's speed. (NO_HELLO pauses helper.)
# It goes before the waits below: a mail from kid clears helper's declared wait on kid.
if [ -z "$NO_HELLO" ]; then
  sleep 2
  stops() { "$STAM" events helper --type 'hook:Stop' --limit 200 | grep -c 'hook:Stop'; }
  before=$(stops)
  curl -sf -X POST -H "authorization: Bearer $(token_of kid)" -H 'content-type: application/json' -d '{"from":"kid","to":["helper"],"subject":"Check: a quiet moment","body":"Nothing to do; this only ends helper'"'"'s wait."}' "$STAM_URL/api/mail" >/dev/null
  # helper's turn on the mail ends with a Stop; wait for it.
  turn_ok=
  for _i in $(seq 1 150); do
    if [ "$(stops)" -gt "$before" ]; then turn_ok=1; break; fi
    sleep 0.2
  done
  [ -n "$turn_ok" ] || { echo "helper never took a turn on the quiet-moment mail" >&2; exit 1; }
fi
# Waits for the tree, the world's line, and details: helper waits for kid's reply and a
# timer, kid for the human and a background job.
wait_on() { curl -sf -X POST -H "authorization: Bearer $(cat "$STAM_HOME/token")" -H 'x-stam-human: 1' -H 'content-type: application/json' -d "$2" "$STAM_URL/api/agents/$(id "$1")/waits" >/dev/null; }
wait_on helper "{\"kind\":\"agent\",\"target\":\"$(id kid)\",\"source\":\"declared\"}"
wait_on helper "{\"kind\":\"timer\",\"until\":\"$(date -u -d '+14 min' +%FT%TZ)\",\"detail\":\"timer */15 * * * *\",\"source\":\"hook\"}"
wait_on kid '{"kind":"human","detail":"your reply on the deploy","source":"declared"}'
wait_on kid '{"kind":"job","target":"b1","detail":"Bash \"npm test\"","source":"hook"}'
# Two suggested harness inputs (S-422, S-429) for the input card checks: each agent suggests for
# itself, with its own token, as it would. helper's is denied by the attention check, kid's approved
# there; a newer suggestion would withdraw an older one, so each agent suggests once. Only with
# INPUT_SEED=1: each one mails the human, which the mail checks (phone.mjs and others) count.
suggest_as() { [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $(token_of "$1")" -H 'content-type: application/json' -d "$2" "$STAM_URL/api/suggest-input")" = 200 ] || { echo "the suggestion from $1 was refused" >&2; exit 1; }; }
if [ -n "$INPUT_SEED" ]; then suggest_as helper '{"text":"! cp ~/.local/share/stam/registry.json ~/.local/share/stam/registry.json.bak && stam registry migrate-reviewers --apply","reason":"Back up the registry, then migrate the reviewer settings (S-412)."}'
suggest_as kid '{"text":"! git status --short","reason":"See what changed before the commit."}'
fi
# agents= carries helper's and kid's own tokens, for the checks that act as them (S-545).
echo "URL=http://127.0.0.1:$STAM_PORT/#token=$(cat "$STAM_HOME/token")&testHuman=$STAM_TEST_HUMAN_KEY&agents=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$AGENT_TOKENS")"
# Stay up until killed, or for DAEMON_MAX_LIFE seconds (two hours by default, S-195) so a check left
# running can't outlive its use; the trap from lib.sh stops the daemon and removes the temp folder.
# The sleep is ours to stop on the way out (daemon_exit), or it outlives us holding inherited descriptors.
END=$(( $(date +%s) + ${DAEMON_MAX_LIFE:-7200} ))
while [ "$(date +%s)" -lt "$END" ]; do left=$((END - $(date +%s))); [ "$left" -ge 1 ] || left=1; sleep $((left < 60 ? left : 60)) & keep=$!; wait $keep; done
