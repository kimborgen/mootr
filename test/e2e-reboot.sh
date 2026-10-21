#!/bin/sh
# Reboot test. Agents on Claude Code, OpenCode, and Codex come back with their
# conversations after a simulated reboot (daemon stopped, tmux server killed, daemon
# started) and after the tmux server crashing under a running daemon, and still answer
# mail through stam's MCP. A paused agent stays paused and resumes on unpause; an agent
# whose own harness exited stays shut down. After the crash, no stale Codex app-server is
# left beside the resumed one. Runs against its own daemon (test/lib.sh), whose tmux
# server it kills. Costs about $0.10.
# The OpenCode agent is skipped, with one "skipped: ..." line and none of its steps, when
# STAM_SMOKE_SKIP_OPENCODE=1, or when OpenRouter's credit (total minus usage) reads 0 or less,
# or can't be read (test/openrouter-credit.sh). Claude Code and Codex run either way.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
. "$(dirname "$(readlink -f "$0")")/openrouter-credit.sh"
# A live test: it calls OpenRouter, so it gets the real key (lib.sh).
STAM_TEST_REAL_KEY=1
isolate
OPENCODE=1
# An OpenCode server that outlived the killed tmux server names only its port.
trap 'stam_test_cleanup; [ -n "$KEEP" ] || [ -z "$OPENCODE" ] || pkill -f "serve --hostname 127.0.0.1 --port $STAM_OPENCODE_PORT" 2>/dev/null' EXIT
SOCK="$STAM_TMUX_SOCKET"
T=$(date +%s); DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
C="rb-claude-$T"; O="rb-opencode-$T"; X="rb-codex-$T"; P="rb-paused-$T"; E="rb-exited-$T"
fail() { echo "FAIL: $1"; "$STAM" ls; exit 1; }
field() { "$STAM" show "$1" | grep "\"$2\"" | head -1 | sed 's/.*: //; s/^"//; s/",*$//; s/,$//'; }
recovered() { "$STAM" events "$1" | grep -c ' recover ' || true; }
codex_procs() { pgrep -f "unix://$STAM_HOME/agents/$(field "$X" id)/codex.sock" | wc -l; }
wait_human() { for i in $(seq 1 60); do "$STAM" mail inbox human | grep -q "$1" && return 0; sleep 3; done; fail "no mail '$1' in the human inbox"; }

if [ "$STAM_SMOKE_SKIP_OPENCODE" = 1 ]; then
  OPENCODE=; echo "skipped: STAM_SMOKE_SKIP_OPENCODE=1"
else
  credit_rc=0; openrouter_credit "$STAM_HOME/opencode.env" || credit_rc=$?
  case "$credit_rc" in
    0) ;;
    1) OPENCODE=; echo "skipped: no OpenRouter credit" ;;
    *) OPENCODE=; echo "skipped: OpenRouter credit unreadable" ;;
  esac
fi
# The agents this run has, in order; the OpenCode one only when it runs. Each remembers its code word.
AGENTS="$C $X"; WORDS="PLUM-$T SLATE-$T"
if [ -n "$OPENCODE" ]; then AGENTS="$C $O $X"; WORDS="PLUM-$T FERN-$T SLATE-$T"; fi
remember() { echo "Remember the code word $1 for later. Reply with just: ok"; }
"$STAM" spawn "$C" --model claude-haiku-5-5 --cwd "$DIR" --role "Reboot test agent." "$(remember "PLUM-$T")"
if [ -n "$OPENCODE" ]; then
  "$STAM" spawn "$O" --harness opencode --model openrouter/~deepseek/deepseek-v4-flash-latest --cwd "$DIR" --role "Reboot test agent." "$(remember "FERN-$T")"
fi
"$STAM" spawn "$X" --harness codex --model gpt-6-luna --effort low --cwd "$DIR" --role "Reboot test agent." "$(remember "SLATE-$T")"
"$STAM" spawn "$P" --model claude-haiku-5-5 --cwd "$DIR" --role "Reboot test agent." "Reply with just: ok"
"$STAM" spawn "$E" --model claude-haiku-5-5 --cwd "$DIR" --role "Reboot test agent."
for n in $AGENTS "$P" "$E"; do "$STAM" wait "$n" --until idle --timeout 120; done

echo "-- one harness exiting while the tmux server lives keeps today's behaviour"
EID=$(field "$E" id)
pkill -TERM -g "$(tmux -L "$SOCK" list-panes -t "=$EID:" -F '#{pane_pid}')"
"$STAM" wait "$E" --until shut_down --timeout 20
test "$(field "$E" activity_detail)" = "harness exited" || fail "$E: $(field "$E" activity_detail)"
"$STAM" pause "$P"

echo "-- reboot: daemon stopped, tmux server killed, daemon started"
"$STAM" daemon stop
tmux -L "$SOCK" kill-server
daemon_up main
for n in $AGENTS; do "$STAM" wait "$n" --until idle --timeout 180 || fail "$n not back"; done
for n in $AGENTS; do test "$(recovered "$n")" = 1 || fail "$n: no recover event"; done
"$STAM" events "$C" | grep ' tmux-lost ' || fail "no tmux-lost event"
test "$(field "$P" lifecycle)" = paused || fail "$P not paused"
field "$P" activity_detail | grep -q "unpause to resume" || fail "$P: $(field "$P" activity_detail)"
test "$(field "$E" lifecycle)" = shut_down || fail "$E came back"
test "$(recovered "$E")" = 0 || fail "$E was resumed"

echo "-- resumed agents answer mail from their resumed conversation"
for n in $AGENTS; do
  "$STAM" mail send --to "$n" --subject "word" "Mail human with subject 'word-$n' and, as the body, the code word you were asked to remember at the start. Answer from memory; don't read any file."
done
for n in $AGENTS; do wait_human "word-$n"; done
BODIES="$("$STAM" mail read human)"
for w in $WORDS; do echo "$BODIES" | grep -q "$w" || fail "conversation lost: no $w"; done
echo "all resumed agents recalled their code words"

echo "-- unpausing the paused agent resumes it"
"$STAM" unpause "$P"
"$STAM" wait "$P" --until idle --timeout 120 || fail "$P not back after unpause"

echo "-- tmux server crash under a running daemon"
for n in $AGENTS; do "$STAM" wait "$n" --until idle --timeout 120; done
tmux -L "$SOCK" kill-server
sleep 1
echo "Codex processes left on its socket after the crash: $(codex_procs)"
for n in $AGENTS; do
  for i in $(seq 1 60); do [ "$(recovered "$n")" = 2 ] && break; sleep 2; done
  test "$(recovered "$n")" = 2 || fail "$n not resumed after the crash"
  "$STAM" wait "$n" --until idle --timeout 180 || fail "$n not idle after the crash"
done
test "$(codex_procs)" -le 2 || { pgrep -af "codex.sock"; fail "stale Codex processes beside the resumed one"; }
for n in $AGENTS; do
  "$STAM" mail send --to "$n" --subject "again" "Mail human with subject 'again-$n' and, as the body, the code word you were asked to remember at the start, from memory."
done
for n in $AGENTS; do wait_human "again-$n"; done
BODIES="$("$STAM" mail read human)"
for w in $WORDS; do echo "$BODIES" | grep -q "$w" || fail "conversation lost after the crash: no $w"; done
echo "all resumed agents recalled their code words again"
"$STAM" ls
echo "PASS e2e-reboot"
