#!/bin/sh
# A web send retried with the same client_id (S-373) reaches the daemon's endpoint once: mail
# lands in the inbox once, and a prompt types into the agent once. Free: a scripted Claude
# Code (test/fake-claude) against its own daemon (test/lib.sh).
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/dedup.json" <<'EOF3'
{ "turns": [ { "match": "hello", "steps": [ { "reply": "DONE" } ] } ] }
EOF3
fake_claude "$TEST_TMP/dedup.json"
isolate
SHARED=$(cat "$STAM_HOME/token")
NAME="e2e-dedup-$(date +%s)"
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
"$STAM" spawn "$NAME" --model claude-haiku-5-5 --cwd "$DIR" "Say hello."
"$STAM" wait "$NAME" --until idle --timeout 60
post() { curl -s -X POST -H "authorization: Bearer $SHARED" -H 'x-stam-human: 1' -H 'content-type: application/json' -d "$2" "$STAM_URL$1"; }
count() { curl -s -H "authorization: Bearer $SHARED" "$STAM_URL/api/agents/$NAME/inbox?limit=50" | python3 -c 'import json, sys; print(sum(1 for m in json.load(sys.stdin) if m["subject"] == sys.argv[1]))' "$1"; }

MAIL='{"from":"human","to":"'$NAME'","subject":"once","body":"retried mail","client_id":"c-mail-1"}'
post /api/mail "$MAIL" >/dev/null
post /api/mail "$MAIL" >/dev/null
[ "$(count once)" = 1 ] || { echo "FAIL: a retried mail arrived $(count once) times"; exit 1; }
# Another id is another message.
post /api/mail '{"from":"human","to":"'$NAME'","subject":"once","body":"retried mail","client_id":"c-mail-2"}' >/dev/null
[ "$(count once)" = 2 ] || { echo "FAIL: a mail with a new client_id was dropped"; exit 1; }
# No client_id: no dedup, as before.
NOID='{"from":"human","to":"'$NAME'","subject":"twice","body":"no id"}'
post /api/mail "$NOID" >/dev/null
post /api/mail "$NOID" >/dev/null
[ "$(count twice)" = 2 ] || { echo "FAIL: mail without a client_id was deduplicated"; exit 1; }

# Two requests at once with one id (a retry while the first is still running): one mail.
CONC='{"from":"human","to":"'$NAME'","subject":"concurrent","body":"at once","client_id":"c-conc-1"}'
for _i in 1 2 3 4 5 6; do post /api/mail "$CONC" >/dev/null & done
wait
[ "$(count concurrent)" = 1 ] || { echo "FAIL: $(count concurrent) copies of a mail sent at once with one client_id"; exit 1; }

prompts() {
  curl -s -H "authorization: Bearer $SHARED" "$STAM_URL/api/agents/$NAME/events" | python3 -c 'import json, sys; print(sum(1 for e in json.load(sys.stdin) if e["type"] == "human:prompt"))'
}
P='{"text":"hello again","client_id":"c-prompt-1"}'
post "/api/agents/$NAME/prompt" "$P" >/dev/null
post "/api/agents/$NAME/prompt" "$P" >/dev/null
[ "$(prompts)" = 1 ] || { echo "FAIL: a retried prompt was typed $(prompts) times"; exit 1; }
echo "ok: client_id dedup"
