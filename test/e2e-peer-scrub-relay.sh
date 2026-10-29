#!/bin/sh
# A peer's refusal relayed as bytes reaches the human redacted (S-3994), free: one daemon whose peer is a stub that
# refuses every read with the bearer it got and this daemon's own shared token in the text. Checks, through the routes:
#   - the Files API forwarded to the peer (peerRaw, piped on) answers the refusal's status with [redacted] for each token
#     and no stale content-length
#   - the declaration lookup forwarded to the ITSA home (peerRaw, parsed and answered as JSON) does the same, with the
#     bearer escaped in the peer's JSON (\u0073tub-...), which the relay decodes
#   - a declaration refusal with the escaped bearer and 20,000 nested arrays, too deep to redact, is the fixed refusal
#   - a success's bytes pass as the peer sent them, a token in them included
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
daemon_home main
MAIN_TOKEN=$(cat "$TEST_TMP/main/token")
STUB_TOKEN=stub-shared-secret-token
STUB_PEER=stub-peer-secret-token
STUB_PORT=$(free_port)
# The stub: 403 echoing what it got, except a success at /api/files/read?path=/ok.
node -e '
const [port, own] = process.argv.slice(1);
require("node:http").createServer((req, res) => {
  req.resume();
  if (req.url === "/api/health") return res.writeHead(200, { "content-type": "application/json" }).end("{\"ok\":true}");
  const text = `refused: ${req.headers.authorization} and ${own}`;
  if (req.url.startsWith("/api/files/read?path=%2Fok")) return res.writeHead(200, { "content-type": "text/plain" }).end(text);
  // A declaration lookup is refused with the first letter of the bearer escaped, as a JSON encoder may write it.
  let body = req.url.startsWith("/api/decl") ? JSON.stringify({ error: text }).replace("Bearer s", "Bearer \\u0073") : JSON.stringify({ error: text });
  if (req.url.startsWith("/api/decl?q=deep")) body = body.replace(/}$/, ",\"n\":" + "[".repeat(20000) + "]".repeat(20000) + "}");
  res.writeHead(403, { "content-type": "application/json", "content-length": Buffer.byteLength(body) }).end(body);
}).listen(Number(port), "127.0.0.1");
' "$STUB_PORT" "$MAIN_TOKEN" &
STUB_PID=$!
trap stam_test_cleanup EXIT
python3 - "$TEST_TMP/main/settings.json" "http://127.0.0.1:$STUB_PORT" "$STUB_TOKEN" "$STUB_PEER" <<'PY'
import json, sys
path, url, tok, peer = sys.argv[1:5]
s = json.load(open(path))
s["peers"] = [{"name": "stub", "url": url, "token": tok, "peerToken": peer}]
s["itsa"] = {"home": "stub"}
json.dump(s, open(path, "w"), indent=2)
PY
printf '%s\n' '{ "turns": [] }' >"$TEST_TMP/scrub.json"
fake_claude "$TEST_TMP/scrub.json"
fail() { echo "FAIL: $1"; exit 1; }
stub_up() { curl -s -m 2 "http://127.0.0.1:$STUB_PORT/api/health" | grep -q ok; }
wait_until stub_up
daemon_up main
MAIN_URL=$(on main sh -c 'echo "$STAM_URL"')
# get PATH: as the human; prints the headers, then the body.
get() { curl -s -D - -H "authorization: Bearer $MAIN_TOKEN" -H 'x-stam-human: 1' -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" "$MAIN_URL$1"; }
clean() {
  case "$2" in *"$STUB_PEER"* | *"$STUB_TOKEN"* | *"$MAIN_TOKEN"*) fail "$1 holds a token: $2" ;; esac
  printf '%s' "$2" | grep -q '^HTTP/1.1 403' || fail "$1 isn't the peer's 403: $2"
  printf '%s' "$2" | grep -q 'refused: Bearer \[redacted\] and \[redacted\]' || fail "$1 isn't the redacted refusal: $2"
}
out=$(get "/api/files/read?host=stub&path=%2Fx")
clean "the file relay" "$out"
# The body changed size: a forwarded content-length would cut it or hang the client.
printf '%s' "$out" | python3 -c '
import re, sys
head, _, body = sys.stdin.read().replace("\r\n", "\n").partition("\n\n")
m = re.search(r"(?im)^content-length: *(\d+)", head)
sys.exit(1 if m and int(m.group(1)) != len(body.encode()) else 0)' || fail "the file relay's content-length isn't its body's: $out"
clean "the declaration lookup" "$(get "/api/decl?q=x")"
deep=$(get "/api/decl?q=deep" || true)
case "$deep" in *"$STUB_PEER"* | *"$MAIN_TOKEN"*) fail "the deep declaration refusal holds a token: $(printf '%s' "$deep" | head -c 300)" ;; esac
printf '%s' "$deep" | grep -q '^HTTP/1.1 403' || fail "the deep declaration refusal isn't a 403: $(printf '%s' "$deep" | head -c 300)"
printf '%s' "$deep" | grep -q 'stub refused with 403; its answer was too long or too slow to show safely' || fail "the deep declaration refusal isn't the fixed refusal: $(printf '%s' "$deep" | head -c 300)"
# A success is the peer's bytes, untouched.
get "/api/files/read?host=stub&path=%2Fok" | grep -q "refused: Bearer $STUB_PEER" || fail "a success's bytes changed"
echo "PASS: peer-scrub-relay"
