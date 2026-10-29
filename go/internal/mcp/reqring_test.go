package mcp

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

// reqOnInStub is what the stub daemon's GET /api/req-enabled says; false answers 404, as a daemon that never answers.
var reqOnInStub = false

// reqringRoutes answers the permission, ring, wait and requirement routes for the stub daemon.
func reqringRoutes(w http.ResponseWriter, r *http.Request, body any) bool {
	b, _ := body.(map[string]any)
	path := r.URL.Path
	switch {
	case r.Method == "GET" && path == "/api/req-enabled" && reqOnInStub:
		io.WriteString(w, `{"enabled":true}`)
	case r.Method == "POST" && path == "/api/permissions" && b["action"] == "nope":
		w.WriteHeader(403)
		io.WriteString(w, `{"error":"no such ITSA S-999 you can read"}`)
	case r.Method == "POST" && path == "/api/permissions" && b["thread"] == nil:
		io.WriteString(w, `{"id":"p1","hint":"Pass itsa next time."}`)
	case r.Method == "POST" && path == "/api/permissions":
		io.WriteString(w, `{"id":"p2"}`)
	case r.Method == "POST" && path == "/api/suggest-input":
		io.WriteString(w, `{"id":"s1"}`)
	case r.Method == "POST" && path == "/api/permissions/p1/answer":
		io.WriteString(w, `{"id":"p1","status":"approved"}`)
	case r.Method == "POST" && path == "/api/permissions/self/answer":
		w.WriteHeader(403)
		io.WriteString(w, `{"error":"you can't answer your own request"}`)
	case r.Method == "POST" && path == "/api/rings":
		io.WriteString(w, `{"id":"r9","name":"`+strings.ReplaceAll(stringOf(b["name"]), `"`, "")+`"}`)
	case r.Method == "POST" && path == "/api/rings/r9/submit":
		io.WriteString(w, `{"result":"Submitted for round 1."}`)
	case r.Method == "POST" && path == "/api/rings/r9/decide":
		io.WriteString(w, `{"result":"Ring r9 ended."}`)
	case r.Method == "POST" && strings.HasPrefix(path, "/api/rings/"):
		w.WriteHeader(409)
		io.WriteString(w, `{"error":"no ring gone"}`)
	case r.Method == "POST" && path == "/api/agents/a1/waits/declared" && b["on"] == "human":
		io.WriteString(w, `{"id":"w1","kind":"human","detail":"your user","target":"p1","until":"2026-10-26T04:00:00.000Z"}`)
	case r.Method == "POST" && path == "/api/agents/a1/waits/declared":
		io.WriteString(w, `{"id":"w2","kind":"agent","detail":"boss"}`)
	case r.Method == "POST" && path == "/api/agents/a1/waits/done":
		io.WriteString(w, `{"cleared":`+map[bool]string{true: "true", false: "false"}[b["id"] == "w1"]+`}`)
	case r.Method == "POST" && path == "/api/agents/a1/waits/wake":
		io.WriteString(w, `{"id":"w3","until":"2026-10-26T05:00:00.000Z"}`)
	case r.Method == "POST" && path == "/api/requirements" && b["title"] == "cos":
		io.WriteString(w, `{"key":"R-2","title":"cos","approval":{"itsa":"S-9","to":"chief of staff"}}`)
	case r.Method == "POST" && path == "/api/requirements" && b["title"] == "err":
		io.WriteString(w, `{"key":"R-3","title":"err","approval":{"error":"no thread"}}`)
	case r.Method == "POST" && path == "/api/requirements":
		io.WriteString(w, `{"key":"R-1","title":"plain"}`)
	case r.Method == "GET" && path == "/api/requirements/R-7":
		io.WriteString(w, `{"key":"R-7","title":"Tidy","status":"in_force","severity":"major","mode":"enforce","threshold":0.80,"version":2,"rev":5,"owner":null,`+
			`"text":"Source shall be tidy.","rationale":"why","source":"CLAUDE.md:58","verification":[{"method":"decision"},{"method":"test","detail":"npm test"}],`+
			`"scope":{"paths":["src/**"]},"precision":{"violates":8,"false_positives":3,"rate":0.375,"max_rate":0.5,"accepted_deviations":1},`+
			`"parent_chain":[{"key":"R-1","title":"Root"}],"children":[{"key":"R-8","title":"Leaf","status":"draft"}],`+
			`"links":[{"id":4,"role":"implements","target_kind":"itsa","target":"S-3"}],`+
			`"verdicts":[{"id":11,"subject":"branch:r/x","verdict":"violates","p_violates":0.125,"req_version":2,"waiver":{"kind":"false_positive","reason":null}},{"id":12,"subject":"mail:m1","verdict":"conforms","p_violates":null,"req_version":1}]}`)
	case r.Method == "GET" && path == "/api/requirements/R-6":
		io.WriteString(w, `{"key":"R-6","title":"Bare","status":"draft","precision":{"violates":0}}`)
	case r.Method == "GET" && path == "/api/requirements" && r.URL.RawQuery == "":
		io.WriteString(w, `[{"key":"R-1","status":"draft","severity":"minor","mode":"observe","title":"A"},{"key":"R-2","status":"in_force","severity":"major","mode":"enforce","title":"B","parent_id":"x"}]`)
	case r.Method == "GET" && path == "/api/requirements":
		io.WriteString(w, `[]`)
	case r.Method == "PATCH" && path == "/api/requirements/R-7":
		io.WriteString(w, `{"requirement":{"key":"R-7"},"changes":{"status":{"from":"draft","to":"in_force"},"scope":{"from":null,"to":{"paths":["a"]}}}}`)
	case r.Method == "PATCH" && path == "/api/requirements/R-5":
		io.WriteString(w, `{"requirement":{"key":"R-5"},"changes":{}}`)
	case r.Method == "POST" && path == "/api/requirements/R-7/links":
		io.WriteString(w, `{"id":5,"role":"verifies","target_kind":"test","target":"`+stringOf(b["target"])+`"}`)
	case r.Method == "DELETE" && strings.HasPrefix(path, "/api/requirements/R-7/links/"):
		io.WriteString(w, `{}`)
	case r.Method == "POST" && path == "/api/requirements/check" && b["text"] == "none":
		io.WriteString(w, `{"subject":"text","results":[]}`)
	case r.Method == "POST" && path == "/api/requirements/check":
		io.WriteString(w, `{"subject":"text","results":[{"key":"R-7","verdict":"violates","p_violates":0.875,"id":11,"cached":true},{"key":"R-8","verdict":"odd","p_violates":null,"id":null}]}`)
	case r.Method == "POST" && strings.HasSuffix(path, "/preview"):
		io.WriteString(w, `{"key":"R-7","note":"3 skipped","rows":[{"subject":"mail:m1","summary":"hi","verdict":"violates","p_violates":0.9},{"subject":"mail:m2","summary":"yo","error":"timed out"},{"subject":"mail:m3","summary":"ok","verdict":"na"}]}`)
	case r.Method == "POST" && path == "/api/requirements/waivers":
		io.WriteString(w, `{"verdict_id":11,"kind":"false_positive","reason":"`+stringOf(b["reason"])+`"}`)
	default:
		return false
	}
	return true
}

func stringOf(v any) string {
	s, _ := v.(string)
	return s
}

// The permission, ring and wait tools send the daemon what src/mcp.ts sends (self dropped, by the caller, an argument
// not passed left out) and say what it says, a refusal and the argument checks too.
func TestReqringToolsMatchTS(t *testing.T) {
	lines := []string{
		call(1, "request_permission", `{"action":"push","reason":"ship","audience":"human","itsa":"S-1"}`),
		call(2, "request_permission", `{"action":"push","reason":"ship","details":null,"thread":"m1","override":"x"}`),
		call(3, "request_permission", `{"action":"nope","reason":"r","details":"d","thread":"m1"}`),
		call(4, "suggest_input", `{"text":"! git push","reason":"blocked","thread":"m1"}`),
		call(5, "answer_permission", `{"id":"p1","note":"ok"}`),
		call(6, "answer_permission", `{"id":"p1","decision":"approve","note":"ok"}`),
		call(7, "answer_permission", `{"id":"p1","decision":"escalate","note":"yours"}`),
		call(8, "answer_permission", `{"id":"p1","approve":false,"note":"no"}`),
		call(9, "answer_permission", `{"id":"self","decision":"approve","note":"mine"}`),
		call(10, "ring_create", `{"name":"design","topic":"db","format":"rounds","self":"a1","members":["w1"],"by":"spoof","max_rounds":2}`),
		call(11, "ring_submit", `{"ring":"r9","text":"I agree.","agree":true,"verdict":"approve","round":1}`),
		call(12, "ring_submit", `{"ring":"r9","body":"x","agree":true}`),
		call(13, "ring_submit", `{"ring":"r9","text":" \n ","agree":false}`),
		call(14, "ring_submit", `{"ring":"gone","text":"t","agree":false}`),
		call(15, "ring_decide", `{"ring":"r9","continue":false,"text":"Decision: Go."}`),
		call(16, "wait_for", `{"on":"human","thread":"m1","timeout_minutes":30,"note":"the answer"}`),
		call(17, "wait_for", `{"on":"agent","target":"boss","rest":true}`),
		call(18, "wait_for", `{"on":"agent"}`),
		call(19, "wait_for", `{"on":"agent","target":"boss","from":"x","when":1}`),
		call(20, "wait_done", `{"id":"w1"}`),
		call(21, "wait_done", `{"id":"w9"}`),
		call(22, "wake_me", `{"in_minutes":30,"note":"check CI","self":"a1"}`),
	}
	ts, g := both(t, map[string]string{"STAM_AGENT_ID": "a1"}, lines, len(lines), 0, "")
	for id, want := range ts.byID {
		if g.byID[id] != want {
			t.Errorf("id %s differs\n ts: %s\n go: %s", id, want, g.byID[id])
		}
	}
	if len(g.byID) != len(ts.byID) || len(ts.byID) != len(lines) {
		t.Errorf("go answered %d calls, ts %d, want %d", len(g.byID), len(ts.byID), len(lines))
	}
	// ring_create sends the process's cwd, which differs by process; the rest of the body is the same.
	for _, l := range [][]seen{ts.calls, g.calls} {
		for i := range l {
			if l[i].Path == "/api/rings" {
				if !cwdMember.MatchString(l[i].Raw) {
					t.Errorf("ring_create sent no cwd: %s", l[i].Raw)
				}
				l[i].Raw = cwdMember.ReplaceAllString(l[i].Raw, "")
			}
		}
	}
	sameCalls(t, ts.calls, g.calls)
	for _, want := range []string{"Request p1 sent.", "It found no home thread", "Request p1 is escalated to the human.", "you can't answer your own request",
		"Ring design (r9) started.", "ring_submit has no parameter body", "text is required", "Waiting (w1) for your user, timing out at", "needs target",
		"wait_for has no parameter 'from', 'when'", "Cleared wait w1.", "No wait w9 of yours to clear.", "Wake-up (w3) set for"} {
		found := false
		for _, a := range g.byID {
			found = found || strings.Contains(a, want)
		}
		if !found {
			t.Errorf("no answer says %q", want)
		}
	}
}

// The requirement tools, called while requirements are off (they are callable, only unlisted) and on.
func TestReqToolsMatchTS(t *testing.T) {
	lines := []string{
		call(1, "req_create", `{"title":"plain","text":"shall","threshold":0.5,"scope":null}`),
		call(2, "req_create", `{"title":"cos"}`),
		call(3, "req_create", `{"title":"err"}`),
		call(4, "req_get", `{"key":" R-7 "}`),
		call(5, "req_get", `{"key":"R-6"}`),
		call(6, "req_get", `{}`),
		call(7, "req_get", `{"status":"draft","text":"a b","parent":""}`),
		call(8, "req_set", `{"key":"R-7","status":"in_force","if_rev":"5","add_links":[{"target":"t.sh","target_kind":"test","role":"verifies"}],"remove_links":[4,"x"]}`),
		call(9, "req_set", `{"key":"R-5","title":"same"}`),
		call(10, "req_set", `{"key":"R-7"}`),
		call(11, "req_set", `{"key":"  "}`),
		call(12, "req_check", `{"text":"draft mail","keys":["R-7"]}`),
		call(13, "req_check", `{"text":"none"}`),
		call(14, "req_check", `{"preview":true,"keys":["R-7"],"n":5}`),
		call(15, "req_check", `{"preview":true}`),
		call(16, "req_waive", `{"verdict_id":11,"kind":"false_positive","reason":"wrong"}`),
	}
	for _, on := range []bool{false, true} {
		reqOnInStub = on
		ts, g := both(t, map[string]string{"STAM_AGENT_ID": "a1"}, lines, len(lines), 0, "")
		reqOnInStub = false
		for id, want := range ts.byID {
			if g.byID[id] != want {
				t.Errorf("on=%v id %s differs\n ts: %s\n go: %s", on, id, want, g.byID[id])
			}
		}
		if len(g.byID) != len(ts.byID) || len(ts.byID) != len(lines) {
			t.Errorf("go answered %d calls, ts %d, want %d", len(g.byID), len(ts.byID), len(lines))
		}
		sameCalls(t, ts.calls, g.calls)
	}
}

// tools/list carries the requirement tools only while the daemon says requirements are on, in TS's order and bytes.
func TestReqToolsListedOnlyWhileOn(t *testing.T) {
	list := []string{session[0], `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`}
	for _, on := range []bool{false, true} {
		reqOnInStub = on
		ts, g := both(t, map[string]string{"STAM_AGENT_ID": "a1"}, list, 2, 0, "")
		reqOnInStub = false
		if p := ported(t, ts.byID["2"]); p != ported(t, g.byID["2"]) {
			t.Errorf("on=%v: tools/list differs for the ported tools\n ts: %s\n go: %s", on, p, ported(t, g.byID["2"]))
		}
		has := strings.Contains(g.byID["2"], `"name":"req_check"`)
		if has != on || strings.Contains(ts.byID["2"], `"name":"req_check"`) != on {
			t.Errorf("on=%v: go lists req_check %v", on, has)
		}
		var want []string
		for _, n := range toolNames(t, ts.byID["2"]) {
			if portedTool(n) {
				want = append(want, n)
			}
		}
		if got := toolNames(t, g.byID["2"]); strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("on=%v: go lists %v, ts order is %v", on, got, want)
		}
	}
}
