# OpenRouter's credit left: total credits minus usage, from one GET /credits, the balance stam's own
# reader takes (src/llm/openrouter.ts balance, src/credits.ts). Sourced by a live test, which skips its
# OpenCode agent when the credit is gone (test/e2e-reboot.sh).
#
#   openrouter_credit FILE   FILE holds the key as OPENROUTER_API_KEY=...; exits 0 when the credit is
#                            above zero, 1 when it is zero or less, 2 when it can't be read (no key, a
#                            failed or truncated call, an HTTP error, an answer without both figures as
#                            finite JSON numbers). Prints nothing.
#
# The key goes to curl on stdin, never on its command line, and is never printed.
openrouter_credit() {
  _key=$(sed -n 's/^OPENROUTER_API_KEY=//p' "$1" 2>/dev/null | head -1)
  [ -n "$_key" ] || return 2
  # curl's own status counts: a failed, truncated or HTTP-error call (-f) is unreadable, whatever it wrote.
  _body=$(printf 'header = "authorization: Bearer %s"\n' "$_key" |
    curl -sS -f -K - --max-time 10 https://openrouter.ai/api/v1/credits 2>/dev/null) || return 2
  printf '%s' "$_body" | python3 -c '
import json, math, sys
def refuse(_):
    raise ValueError
def number(v):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise ValueError
    return v
try:
    d = json.load(sys.stdin, parse_constant=refuse)["data"]
    left = number(d["total_credits"]) - number(d["total_usage"])
except Exception:
    sys.exit(2)
sys.exit(0 if left > 0 else 1)
'
}
