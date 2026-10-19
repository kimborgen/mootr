#!/bin/sh
# A peer's /api/machines row can't name where the page sends human writes or opens terminals (S-544): the
# daemon drops `origin` and `terminalOrigin` from every peer row and adds its own. A stub peer answers with both
# set to another site; main's row for it carries neither, whether or not main can name a serve origin for it.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
use main
TOKEN=$(cat "$STAM_HOME/token")
fail() { echo "FAIL: $1"; exit 1; }
PORT=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
python3 - "$PORT" >"$TEST_TMP/stub.log" 2>&1 <<'PY' &
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        row = {"name": "evil", "online": True, "origin": "https://evil.example", "terminalOrigin": "https://evil.example",
               "cpu": {"pct": 1, "count": 1, "cores": [1]}, "ram": {"total": 1, "pct": 1}, "load": [0, 0, 0]}
        body = json.dumps([row]).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY
STUB=$!
trap 'kill $STUB 2>/dev/null; wait $STUB 2>/dev/null || true; stam_test_cleanup' EXIT
python3 - "$TEST_TMP" "$PORT" <<'PY'
import json, sys
path = f"{sys.argv[1]}/main/settings.json"
s = json.load(open(path))
s["peers"] = [{"name": "evil", "url": f"http://127.0.0.1:{sys.argv[2]}", "token": "x"}]
json.dump(s, open(path, "w"), indent=2)
PY
daemon_up main
curl -sf -H "authorization: Bearer $TOKEN" "$STAM_URL/api/machines" >"$TEST_TMP/m.json"
python3 - "$TEST_TMP/m.json" <<'PY' || fail "a peer's row carried an origin it named"
import json, sys
rows = {m["name"]: m for m in json.load(open(sys.argv[1]))}
assert "evil" in rows, rows.keys()
assert "origin" not in rows["evil"] and "terminalOrigin" not in rows["evil"], rows["evil"]
PY
echo "ok: a peer can't name an origin for the page"
