# Gives each peer entry a test wrote with only a token that daemon's peerToken (S-1064: the shared token
# is not a peer). Usage: wire-peer-tokens.py TEST_TMP DAEMON. Called by daemon_up in test/lib.sh.
import json, os, re, sys

tmp, name = sys.argv[1:3]
path = f"{tmp}/{name}/settings.json"
try:
    s = json.load(open(path))
except Exception:
    sys.exit(0)
tokens = {}
for d in os.listdir(tmp):
    try:
        m = re.search(r"STAM_URL=(\S+)", open(f"{tmp}/{d}/test.env").read())
        tokens[m.group(1)] = open(f"{tmp}/{d}/peer-token").read().strip()
    except Exception:
        pass
changed = False
for p in s.get("peers") or []:
    url = p.get("url", "").rstrip("/")
    if not p.get("peerToken") and url in tokens:
        p["peerToken"] = tokens[url]
        changed = True
if changed:
    json.dump(s, open(path, "w"), indent=2)
