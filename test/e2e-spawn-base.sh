#!/bin/sh
# The spawn `base` on POST /api/agents (S-1278), free: a worktree spawn with a base puts "Your branch is cut from REF" in its
# first prompt; a base on a spawn that makes no worktree (worktree false, or a workspace script) is a 400 that leaves no agent,
# no worktree and no branch behind. A fake `claude` stands in, so no model runs. Runs against its own daemon (test/lib.sh).
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
fail() { echo "FAIL: $1"; exit 1; }
trap stam_test_cleanup EXIT
FAKE="$TEST_TMP/fake-bin"
mkdir -p "$FAKE"
printf '#!/bin/sh\n[ "$1" = --version ] && { echo "9.9.9 (Claude Code)"; exit 0; }\nexec sleep 600\n' >"$FAKE/claude"
chmod +x "$FAKE/claude"
PATH="$FAKE:$PATH"
export PATH
daemon_home main
daemon_up main
use main
TOKEN=$(cat "$STAM_HOME/token")
REPO="$(mktemp -d "$TEST_TMP/repo.XXXX")"
git -C "$REPO" init -q -b main
git -C "$REPO" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m init
git -C "$REPO" -c user.name=t -c user.email=t@example.com branch stam-stacked
human() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'x-stam-human: 1' -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
spawn() { curl -s -w '\n%{http_code}' -X POST -H "authorization: Bearer $TOKEN" -H 'x-stam-human: 1' -H 'content-type: application/json' "$STAM_URL/api/agents" -d "$1"; }
worktrees() { git -C "$REPO" worktree list | wc -l; }

echo "-- 1. a worktree spawn with base starts, and its first prompt says where the branch is cut from"
R=$(spawn "{\"name\":\"based1\",\"worktree\":true,\"base\":\"stam-stacked\",\"prompt\":\"do the thing\",\"cwd\":\"$REPO\"}")
[ "$(printf %s "$R" | tail -1)" = 200 ] || fail "worktree spawn with base refused: $R"
[ "$(worktrees)" = 2 ] || fail "expected the repo and one worktree, got $(worktrees)"
human GET /api/agents/based1 | grep -q 'Your branch is cut from stam-stacked, so your PR stacks on it.' || fail "the first prompt has no base line"

echo "-- 2. base with worktree false is a 400 that leaves no agent and no worktree"
R=$(spawn "{\"name\":\"based2\",\"worktree\":false,\"base\":\"stam-stacked\",\"cwd\":\"$REPO\"}")
[ "$(printf %s "$R" | tail -1)" = 400 ] || fail "base with worktree false not refused: $R"
printf %s "$R" | grep -q 'base needs a worktree spawn' || fail "no clear message: $R"
human GET /api/agents | grep -q '"name":"based2"' && fail "the refused spawn registered an agent"
[ "$(worktrees)" = 2 ] || fail "the refused spawn left a worktree ($(worktrees))"

echo "-- 3. base with a workspace script is a 400 that leaves no agent and no worktree"
R=$(spawn "{\"name\":\"based3\",\"workspace_script\":\"printf %s $REPO\",\"base\":\"stam-stacked\",\"cwd\":\"$REPO\"}")
[ "$(printf %s "$R" | tail -1)" = 400 ] || fail "base with workspace_script not refused: $R"
printf %s "$R" | grep -q 'base needs a worktree spawn' || fail "no clear message: $R"
human GET /api/agents | grep -q '"name":"based3"' && fail "the refused spawn registered an agent"
[ "$(worktrees)" = 2 ] || fail "the refused spawn left a worktree ($(worktrees))"
echo "ok: a worktree spawn with base cuts its branch and says so, and base without a worktree is a 400 that leaves nothing"
