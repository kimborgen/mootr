#!/bin/sh
# No mail about a failed message (S-548): the web prompt input used to POST
# /api/outbox/failed-notice, which mailed the human "[stam] Message not sent". The route is gone,
# and a failed row only shows as a red row. Free: a scripted Claude Code (test/fake-claude)
# against its own daemon (test/lib.sh). The route answers 404, and the human's inbox gets no
# "[stam] Message not sent" mail.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/notice.json" <<'EOF3'
{ "turns": [ { "match": "hello", "steps": [ { "reply": "DONE" } ] } ] }
EOF3
fake_claude "$TEST_TMP/notice.json"
isolate
SHARED=$(cat "$STAM_HOME/token")
NAME="e2e-notice-$(date +%s)"
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
"$STAM" spawn "$NAME" --model claude-haiku-5-5 --cwd "$DIR" "Say hello."
"$STAM" wait "$NAME" --until idle --timeout 60
post() { curl -s -o "$TEST_TMP/post.out" -w "%{http_code}" -X POST -H "authorization: Bearer $SHARED" "$@" -H "content-type: application/json" "$STAM_URL/api/outbox/failed-notice"; }
count() { curl -s -H "authorization: Bearer $SHARED" "$STAM_URL/api/agents/human/inbox?limit=50" | python3 -c 'import json, sys; print(sum(1 for m in json.load(sys.stdin) if m["subject"].startswith(sys.argv[1])))' "$1"; }

BODY='{"subject":"Message not sent to helper","body":"first line\n\nwaiting in the prompt input","client_id":"failed-notice:row-1"}'
S=$(post -H "x-stam-human: 1" -d "$BODY"); [ "$S" = 404 ] || { echo "FAIL: the notice route still answers ($S: $(cat "$TEST_TMP/post.out"))"; exit 1; }
[ "$(count '[stam] Message not sent')" = 0 ] || { echo "FAIL: $(count '[stam] Message not sent') 'Message not sent' mails reached the human"; exit 1; }
echo "ok: failed-notice"
